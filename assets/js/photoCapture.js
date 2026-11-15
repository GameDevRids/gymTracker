// Taking a member photo, shared by the app and the entrance poster page (no app imports).
// The member agrees first ("I agree"), then a photo is taken with the camera or chosen from the
// gallery, cropped to a square, resized to 512×512 and compressed to about 50–100 KB on the
// phone. Drawing it onto a canvas and re-encoding removes EXIF data such as GPS location.
// Nothing is uploaded here: the caller gets the finished JPEG Blob.

export const PHOTO_CONSENT_TEXT = "Your photo is kept only inside this gym's app, to confirm it's you at check-in. It's never shared.";
export const PHOTO_SIZE = 512;
const TARGET_BYTES = 100 * 1024;
const QUALITIES = [0.85, 0.78, 0.7, 0.62, 0.55, 0.48, 0.4];
const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
const VIEW_SIZE = 280;
const MAX_ZOOM = 3;

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

// ---------- Decoding, cropping and compressing ----------

/** Decodes the picked file upright (EXIF orientation applied). */
export async function decodeImage(file) {
    if (!file || !/^image\//.test(file.type || "image/")) throw new Error("Choose a photo (JPEG, PNG or WebP).");
    if (file.size > MAX_SOURCE_BYTES) throw new Error("This photo is too large. Choose another one.");
    if (typeof createImageBitmap === "function") {
        try {
            return await createImageBitmap(file, { imageOrientation: "from-image" });
        } catch {
            // Fall back to an <img>, which also applies the orientation in current browsers.
        }
    }
    const url = URL.createObjectURL(file);
    try {
        const image = new Image();
        image.decoding = "async";
        image.src = url;
        await image.decode();
        return image;
    } catch {
        throw new Error("This photo can't be opened here. Try another one, or take a new photo.");
    } finally {
        URL.revokeObjectURL(url);
    }
}

function sourceSize(image) {
    return { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height };
}

/** The largest centred square, as a crop { x, y, size } in source pixels. */
export function centreCrop(width, height) {
    const size = Math.min(width, height);
    return { x: (width - size) / 2, y: (height - size) / 2, size };
}

/** Keeps a crop inside the image. */
export function clampCrop({ x, y, size }, width, height) {
    const side = Math.max(1, Math.min(size, width, height));
    return { x: Math.min(Math.max(0, x), width - side), y: Math.min(Math.max(0, y), height - side), size: side };
}

function canvasToBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The photo could not be prepared."))), "image/jpeg", quality);
    });
}

/** Draws the crop at 512×512 and lowers JPEG quality until it is at most ~100 KB. */
export async function renderSquareJpeg(image, crop, { size = PHOTO_SIZE } = {}) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot prepare photos.");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, size, size);
    context.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, size, size);
    let blob = null;
    for (const quality of QUALITIES) {
        blob = await canvasToBlob(canvas, quality);
        if (blob.size <= TARGET_BYTES) return blob;
    }
    return blob;
}

// ---------- Picking a file ----------

/** Opens the camera (capture) or the gallery. Must run inside the user's tap. */
export function pickPhotoFile(source, facing = "environment") {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        // "environment" = the back camera (staff photographing a member), "user" = a selfie.
        if (source === "camera") input.setAttribute("capture", facing === "user" ? "user" : "environment");
        input.hidden = true;
        let settled = false;
        const finish = (file) => {
            if (settled) return;
            settled = true;
            input.remove();
            resolve(file || null);
        };
        input.addEventListener("change", () => finish(input.files?.[0] || null), { once: true });
        input.addEventListener("cancel", () => finish(null), { once: true });
        document.body.append(input);
        input.click();
    });
}

// ---------- The flow, drawn into any container ----------

/**
 * Runs consent → camera or gallery → crop inside `container`.
 * - needsConsent: show the "I agree" step first (skipped when the member already agreed).
 * - onConsent(): called when the member taps "I agree"; may be async (e.g. recording it).
 * - onPhoto(blob): called with the finished 512×512 JPEG; may be async (e.g. uploading).
 * - onCancel(): the member chose not to continue.
 * - cameraFacing: "environment" (back camera, staff at the desk) or "user" (selfie, poster page).
 * Returns { destroy }.
 */
export function mountPhotoFlow(container, { needsConsent = true, onConsent = () => {}, onPhoto, onCancel = () => {}, cancelLabel = "Not now", consentText = PHOTO_CONSENT_TEXT, cameraFacing = "environment" } = {}) {
    let image = null;
    let crop = null;
    let destroyed = false;
    let busy = false;
    const listeners = [];

    function listen(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        listeners.push(() => target.removeEventListener(type, handler, options));
    }

    function clearListeners() {
        while (listeners.length) listeners.pop()();
    }

    function problem(message) {
        const box = container.querySelector("[data-photo-error]");
        if (box) {
            box.textContent = message;
            box.hidden = !message;
        }
    }

    function setBusy(value, label = "") {
        busy = value;
        container.querySelectorAll("button").forEach((button) => { button.disabled = value; });
        const status = container.querySelector("[data-photo-status]");
        if (status) {
            status.textContent = label;
            status.hidden = !label;
        }
    }

    function view(html) {
        clearListeners();
        container.innerHTML = `<div class="photo-flow">${html}<p class="photo-flow-status" data-photo-status role="status" hidden></p><p class="photo-flow-error" data-photo-error role="alert" hidden></p></div>`;
        listen(container, "click", onClick);
    }

    function showConsent() {
        view(`<p class="photo-flow-consent">${escapeHTML(consentText)}</p>
            <div class="photo-flow-actions"><button class="button button-primary" type="button" data-photo="agree">I agree</button><button class="button button-secondary" type="button" data-photo="cancel">${escapeHTML(cancelLabel)}</button></div>`);
        container.querySelector('[data-photo="agree"]')?.focus();
    }

    function showChoose() {
        view(`<div class="photo-flow-actions photo-flow-sources"><button class="button button-primary" type="button" data-photo="camera">Take photo</button><button class="button button-secondary" type="button" data-photo="gallery">Choose from gallery</button><button class="button button-secondary" type="button" data-photo="cancel">${escapeHTML(cancelLabel)}</button></div>`);
    }

    function draw() {
        const canvas = container.querySelector("[data-photo-canvas]");
        if (!canvas || !image) return;
        const context = canvas.getContext("2d");
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, canvas.width, canvas.height);
    }

    function showCrop() {
        const scale = Math.min(2, window.devicePixelRatio || 1);
        view(`<p class="helper-text">Drag to move the face into the circle. Use the slider to zoom.</p>
            <div class="photo-crop" style="width:${VIEW_SIZE}px"><canvas data-photo-canvas width="${Math.round(VIEW_SIZE * scale)}" height="${Math.round(VIEW_SIZE * scale)}" aria-label="Photo crop preview"></canvas><span class="photo-crop-ring" aria-hidden="true"></span></div>
            <label class="photo-zoom"><span>Zoom</span><input type="range" min="1" max="${MAX_ZOOM}" step="0.01" value="1" data-photo-zoom aria-label="Zoom"></label>
            <div class="photo-flow-actions"><button class="button button-primary" type="button" data-photo="use">Use photo</button><button class="button button-secondary" type="button" data-photo="retake">Choose again</button><button class="button button-secondary" type="button" data-photo="cancel">${escapeHTML(cancelLabel)}</button></div>`);
        const canvas = container.querySelector("[data-photo-canvas]");
        const zoom = container.querySelector("[data-photo-zoom]");
        const { width, height } = sourceSize(image);
        const full = Math.min(width, height);
        let drag = null;
        listen(canvas, "pointerdown", (event) => {
            drag = { x: event.clientX, y: event.clientY, crop: { ...crop } };
            canvas.setPointerCapture?.(event.pointerId);
        });
        listen(canvas, "pointermove", (event) => {
            if (!drag) return;
            const perPixel = crop.size / canvas.getBoundingClientRect().width;
            crop = clampCrop({ x: drag.crop.x - (event.clientX - drag.x) * perPixel, y: drag.crop.y - (event.clientY - drag.y) * perPixel, size: crop.size }, width, height);
            draw();
        });
        const endDrag = () => { drag = null; };
        listen(canvas, "pointerup", endDrag);
        listen(canvas, "pointercancel", endDrag);
        listen(zoom, "input", () => {
            const size = full / Number(zoom.value);
            const centreX = crop.x + crop.size / 2;
            const centreY = crop.y + crop.size / 2;
            crop = clampCrop({ x: centreX - size / 2, y: centreY - size / 2, size }, width, height);
            draw();
        });
        draw();
    }

    async function choose(source) {
        problem("");
        const file = await pickPhotoFile(source, cameraFacing);
        if (destroyed || !file) return;
        setBusy(true, "Opening photo…");
        try {
            image?.close?.();
            image = await decodeImage(file);
            const { width, height } = sourceSize(image);
            crop = centreCrop(width, height);
            if (!destroyed) showCrop();
        } catch (error) {
            setBusy(false);
            problem(error.message || "This photo can't be opened.");
        }
    }

    async function onClick(event) {
        const button = event.target.closest("[data-photo]");
        if (!button || busy) return;
        const step = button.dataset.photo;
        if (step === "cancel") {
            destroy();
            onCancel();
            return;
        }
        if (step === "agree") {
            setBusy(true, "Saving…");
            try {
                await onConsent();
                if (!destroyed) showChoose();
            } catch (error) {
                setBusy(false);
                problem(error.message || "Your agreement could not be saved. Please try again.");
            }
            return;
        }
        // The file picker opens straight from the tap, so phones allow it.
        if (step === "camera" || step === "gallery") return choose(step);
        if (step === "retake") return showChoose();
        if (step === "use") {
            setBusy(true, "Saving photo…");
            try {
                const blob = await renderSquareJpeg(image, crop);
                await onPhoto(blob);
                if (!destroyed) setBusy(false);
            } catch (error) {
                if (destroyed) return;
                setBusy(false);
                problem(error.message || "The photo could not be saved. Please try again.");
            }
        }
    }

    function destroy() {
        destroyed = true;
        clearListeners();
        image?.close?.();
        image = null;
    }

    if (needsConsent) showConsent();
    else showChoose();
    return { destroy };
}
