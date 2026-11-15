// Member photos in the app (migration 014). Photos stay inside the app: they are shown from
// short-lived signed URLs kept only in memory, never stored in the browser, and never drawn on
// the welcome card, member card, receipts or anything shared to WhatsApp.
// A photo is only taken after the member taps "I agree" themselves.
import { apiClient } from "../api/apiClient.js";
import { openModal, closeModal, onModalClose } from "../components/modal.js";
import { toast } from "../components/toast.js";
import { escapeHTML } from "../utils.js";
import { getMember, consentHistory } from "../state.js";
import { mountPhotoFlow } from "../photoCapture.js";

const URL_MARGIN_MS = 5 * 60 * 1000;
// memberId -> { url, expiresAt } for approved photos; null when the member has none.
const urlCache = new Map();
// memberId -> { status, url, consent, ... } for the profile (pending photos included).
export const profilePhotos = {};

export function photosAvailable() {
    return true;
}

export function initials(name) {
    const words = String(name || "").trim().split(/\s+/).filter(Boolean);
    const letters = words.length > 1 ? `${words[0][0]}${words[words.length - 1][0]}` : (words[0] || "?").slice(0, 1);
    return letters.toUpperCase();
}

/**
 * A round avatar: initials now, the photo once its signed URL arrives (hydratePhotos).
 * status "unknown" asks the server; "none" never does.
 */
export function avatarHtml({ id, name, photoStatus = "unknown" }, className = "member-avatar") {
    const wanted = photosAvailable() && (photoStatus === "approved" || photoStatus === "unknown");
    return `<span class="${className} photo-avatar"${wanted ? ` data-photo-member="${escapeHTML(id)}"` : ""} aria-hidden="true">${escapeHTML(initials(name))}</span>`;
}

function cachedUrl(memberId) {
    const entry = urlCache.get(memberId);
    if (entry === null) return null;
    if (entry && entry.expiresAt - URL_MARGIN_MS > Date.now()) return entry.url;
    return undefined;
}

export function forgetPhoto(memberId) {
    urlCache.delete(memberId);
    delete profilePhotos[memberId];
}

function insertImage(element, url) {
    if (!element.isConnected || element.querySelector("img")) return;
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => {
        image.remove();
        element.classList.remove("has-photo");
    }, { once: true });
    image.src = url;
    element.classList.add("has-photo");
    element.append(image);
}

let pendingHydrate = null;
/** Fills every avatar under `root` that should show a photo. One request per 100 members. */
export function hydratePhotos(root = document) {
    if (!photosAvailable()) return;
    const elements = [...root.querySelectorAll("[data-photo-member]")];
    if (!elements.length) return;
    const missing = [];
    for (const element of elements) {
        const url = cachedUrl(element.dataset.photoMember);
        if (url) insertImage(element, url);
        else if (url === undefined) missing.push(element.dataset.photoMember);
    }
    const ids = [...new Set(missing)];
    if (!ids.length) return;
    const run = async () => {
        for (let index = 0; index < ids.length; index += 100) {
            const part = ids.slice(index, index + 100);
            try {
                const response = await apiClient.post("/api/member-photos/urls", { ids: part });
                const urls = response?.data || {};
                for (const id of part) {
                    const entry = urls[id];
                    urlCache.set(id, entry?.url ? { url: entry.url, expiresAt: Date.parse(entry.expires_at) || Date.now() + 3600000 } : null);
                }
            } catch {
                // Initials stay; the next render tries again.
                return;
            }
        }
        document.querySelectorAll("[data-photo-member]").forEach((element) => {
            const url = cachedUrl(element.dataset.photoMember);
            if (url) insertImage(element, url);
        });
    };
    pendingHydrate = (pendingHydrate || Promise.resolve()).then(run, run);
}

// ---------- Talking to the server ----------

async function fetchPhotoState(memberId) {
    const response = await apiClient.get(`/api/members/${memberId}/photo`);
    return response?.data || null;
}

async function agreeToPhoto(memberId) {
    const response = await apiClient.post(`/api/members/${memberId}/photo-consent`, { agree: true });
    applyPhotoState(memberId, response?.data);
    delete consentHistory[memberId];
}

async function uploadPhoto(memberId, blob) {
    const response = await apiClient.request(`/api/members/${memberId}/photo`, { method: "PUT", body: blob, timeoutMs: 30000 });
    forgetPhoto(memberId);
    applyPhotoState(memberId, response?.data);
    return response?.data;
}

function applyPhotoState(memberId, data) {
    const member = getMember(memberId);
    if (!member || !data) return;
    member.photoStatus = data.status || "none";
    member.photoConsent = data.consent === true;
    member.photoConsentAt = data.consent_at || "";
    member.photoUpdatedAt = data.updated_at || "";
}

/** The profile's photo, pending included (staff review it there). */
export async function loadProfilePhoto(memberId, onChange = () => {}) {
    if (!photosAvailable()) return;
    profilePhotos[memberId] = { status: "loading" };
    try {
        const data = await fetchPhotoState(memberId);
        profilePhotos[memberId] = { ...data, state: "ready" };
        applyPhotoState(memberId, data);
        if (data?.status === "approved" && data.url) urlCache.set(memberId, { url: data.url, expiresAt: Date.parse(data.expires_at) || Date.now() + 3600000 });
    } catch (error) {
        profilePhotos[memberId] = { state: "error", message: error.message || "The photo could not be loaded." };
    }
    onChange();
}

// ---------- Adding a photo for an existing member (profile, check-in card) ----------

/**
 * Opens the photo dialog. Members who have not agreed yet are asked first ("I agree", source
 * 'desk'); members who already agreed go straight to the camera.
 */
export async function openPhotoDialog(memberId, { name = "", onDone = () => {}, onClose = () => {} } = {}) {
    openModal({ title: "Member photo", body: `<div class="empty-state" role="status">Loading…</div>`, footer: `<button class="button button-secondary" type="button" data-action="close-modal">Close</button>` });
    let photoState;
    try {
        photoState = await fetchPhotoState(memberId);
    } catch (error) {
        openModal({ title: "Member photo", body: `<div class="empty-state" role="alert"><p>${escapeHTML(error.message || "The photo could not be loaded.")}</p></div>`, footer: `<button class="button button-secondary" type="button" data-action="close-modal">Close</button>` });
        onModalClose(onClose);
        return;
    }
    const memberName = name || getMember(memberId)?.name || "this member";
    const needsConsent = !photoState?.consent;
    openModal({
        title: photoState?.status === "none" ? "Add photo" : "Change photo",
        subtitle: needsConsent ? `Ask ${escapeHTML(memberName)} to read this and tap "I agree" themselves.` : `For ${escapeHTML(memberName)}. Kept only inside this gym's app.`,
        body: `<div id="photo-dialog-flow"></div>`
    });
    let flow = null;
    onModalClose(() => {
        flow?.destroy();
        onClose();
    });
    flow = mountPhotoFlow(document.querySelector("#photo-dialog-flow"), {
        needsConsent,
        cancelLabel: "Cancel",
        onConsent: () => agreeToPhoto(memberId),
        onPhoto: async (blob) => {
            await uploadPhoto(memberId, blob);
            toast("Photo saved.");
            closeModal();
            onDone();
        },
        onCancel: () => closeModal()
    });
}

function confirmRemove(memberId) {
    openModal({
        title: "Remove photo?",
        body: `<p class="confirm-copy">The photo is deleted. The member's agreement stays, so you can take a new photo without asking again.</p>`,
        footer: `<button class="button button-secondary" type="button" data-action="close-modal">Cancel</button><button class="button button-danger" type="button" data-action="photo-remove-confirm" data-id="${escapeHTML(memberId)}">Remove photo</button>`
    });
}

function confirmWithdraw(memberId) {
    openModal({
        title: "Withdraw photo consent?",
        body: `<p class="confirm-copy">Use this when the member no longer wants a photo kept. <strong>The photo is deleted</strong> and the withdrawal is kept in their consent history. They will be asked again before any new photo.</p>`,
        footer: `<button class="button button-secondary" type="button" data-action="close-modal">Cancel</button><button class="button button-danger" type="button" data-action="photo-withdraw-confirm" data-id="${escapeHTML(memberId)}">Withdraw and delete photo</button>`
    });
}

async function runPhotoChange(element, request, message, onChange) {
    const memberId = element.dataset.id;
    element.disabled = true;
    try {
        const response = await request();
        forgetPhoto(memberId);
        applyPhotoState(memberId, response?.data);
        delete consentHistory[memberId];
        closeModal();
        toast(message);
        await loadPendingPhotos();
        onChange(memberId);
    } catch (error) {
        toast(error.message || "The photo could not be updated.", "error");
        if (element.isConnected) element.disabled = false;
    }
}

// ---------- Photos sent from the entrance poster page ----------

export const pendingPhotos = { status: "idle", rows: [], message: "" };

export async function loadPendingPhotos() {
    if (!photosAvailable()) {
        pendingPhotos.rows = [];
        return false;
    }
    const before = pendingPhotos.rows.map((row) => row.member_id).join();
    try {
        const response = await apiClient.get("/api/member-photos", { params: { status: "pending" } });
        // The desk refreshes every few seconds: keep a still-valid URL so the image is not reloaded.
        const previous = new Map(pendingPhotos.rows.map((row) => [`${row.member_id}|${row.submitted_at}`, row]));
        pendingPhotos.rows = (Array.isArray(response?.data) ? response.data : []).map((row) => {
            const old = previous.get(`${row.member_id}|${row.submitted_at}`);
            return old?.url && Date.parse(old.expires_at) - URL_MARGIN_MS > Date.now() ? { ...row, url: old.url, expires_at: old.expires_at } : row;
        });
        pendingPhotos.status = "ready";
    } catch (error) {
        pendingPhotos.status = "error";
        pendingPhotos.message = error.message || "Photos waiting for approval could not be loaded.";
    }
    return before !== pendingPhotos.rows.map((row) => row.member_id).join();
}

/** The photo a waiting phone sent, with its own Approve / Reject. */
export function pendingPhotoBlock(row) {
    return `<div class="pending-photo">${row.url ? `<img src="${escapeHTML(row.url)}" alt="Photo sent by ${escapeHTML(row.member?.full_name || "the member")}" referrerpolicy="no-referrer" decoding="async">` : `<span class="member-avatar">${escapeHTML(initials(row.member?.full_name))}</span>`}
        <div><small>Photo sent from the poster page</small><span class="button-row"><button class="button button-primary button-small" type="button" data-action="photo-approve" data-id="${escapeHTML(row.member_id)}">Approve photo</button><button class="button button-secondary button-small" type="button" data-action="photo-reject" data-id="${escapeHTML(row.member_id)}">Reject photo</button></span></div></div>`;
}

// ---------- Profile ----------

function consentDate(value) {
    return value ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "";
}

/** The large photo in the profile header. */
export function profilePhotoHtml(member) {
    const photo = profilePhotos[member.id];
    const url = photo?.url;
    const badge = photo?.status === "pending" ? `<span class="photo-badge">Waiting for approval</span>` : "";
    return `<span class="profile-large profile-photo${url ? " has-photo" : ""}">${escapeHTML(initials(member.name))}${url ? `<img src="${escapeHTML(url)}" alt="Photo of ${escapeHTML(member.name)}" referrerpolicy="no-referrer" decoding="async">` : ""}${badge}</span>`;
}

/** Add / Change / Remove photo, pending review, and photo consent with its history. */
export function renderPhotoSection(member) {
    if (!photosAvailable() || !member.memberCode) return "";
    const photo = profilePhotos[member.id];
    const status = photo?.status || member.photoStatus || "none";
    const consent = photo?.consent ?? member.photoConsent;
    const id = escapeHTML(member.id);
    let actions;
    if (status === "pending") {
        actions = `<p class="helper-text">The member sent this photo from the entrance poster page. Approve it only if it is clearly them.</p><span class="button-row"><button class="button button-primary button-small" type="button" data-action="photo-approve" data-id="${id}">Approve photo</button><button class="button button-secondary button-small" type="button" data-action="photo-reject" data-id="${id}">Reject photo</button></span>`;
    } else if (status === "approved") {
        actions = `<span class="button-row"><button class="button button-secondary button-small" type="button" data-action="photo-add" data-id="${id}">Change photo</button><button class="button button-secondary button-small" type="button" data-action="photo-remove" data-id="${id}">Remove photo</button></span>`;
    } else {
        actions = `<button class="button button-secondary button-small" type="button" data-action="photo-add" data-id="${id}">Add photo</button>`;
    }
    const history = consentHistory[member.id];
    const events = history?.status === "ready" ? history.events.filter((event) => event.channel === "photo") : [];
    const list = events.length
        ? events.map((event) => `<div class="activity-row consent-event"><span class="activity-dot consent-${escapeHTML(event.action)}"></span><span><p><strong>${event.action === "granted" ? "Agreed" : "Withdrawn"}</strong> · ${event.source === "poster_page" ? "Poster page" : "At the desk"}</p><small>${escapeHTML(consentDate(event.created_at))}</small></span></div>`).join("")
        : "";
    const current = consent
        ? `<span class="status status-active">Agreed</span>${photo?.consent_at || member.photoConsentAt ? `<small>since ${escapeHTML(consentDate(photo?.consent_at || member.photoConsentAt))}</small>` : ""}`
        : `<span class="status status-inactive">Not asked yet</span>`;
    return `<section class="card profile-section" id="member-photo"><div class="card-header"><div><h2>Photo</h2><p class="consent-current">${current}</p></div></div>
        <div class="card-body">${photo?.state === "error" ? `<p class="helper-text" role="alert">${escapeHTML(photo.message)}</p>` : ""}${actions}<p class="helper-text">Kept only inside this app to confirm it's them at check-in. Never shared.</p>
        ${consent ? `<button class="text-button" type="button" data-action="photo-withdraw" data-id="${id}">Member withdraws consent</button>` : ""}</div>
        ${list ? `<div class="activity-list">${list}</div>` : ""}</section>`;
}

// ---------- Add-member forms: an optional photo step ----------

// form -> { blob, previewUrl, agreed }. Held in memory only until the member is saved.
const formPhotos = new WeakMap();

export function photoFormField(prefix) {
    if (!photosAvailable()) return "";
    return `<div class="field full photo-field" id="${prefix}-photo-field"><span class="field-label">Photo (optional)</span><div data-photo-slot><button class="button button-secondary button-small" type="button" data-form-photo="start">Add photo</button><span class="helper-text">Kept only inside this app to confirm it's them at check-in. The member agrees first.</span></div></div>`;
}

function showFormPhotoIdle(slot) {
    slot.innerHTML = `<button class="button button-secondary button-small" type="button" data-form-photo="start">Add photo</button><span class="helper-text">Kept only inside this app to confirm it's them at check-in. The member agrees first.</span>`;
}

function showFormPhotoPreview(slot, url) {
    slot.innerHTML = `<span class="form-photo-preview"><img src="${escapeHTML(url)}" alt="New member photo"></span><button class="text-button" type="button" data-form-photo="remove">Remove photo</button><span class="helper-text">Saved when you add the member.</span>`;
}

/** Wires the optional photo step inside the add-member form (the form is itself a dialog). */
export function mountFormPhoto(form) {
    const field = form?.querySelector(".photo-field");
    if (!field) return;
    const slot = field.querySelector("[data-photo-slot]");
    let flow = null;
    field.addEventListener("click", (event) => {
        const button = event.target.closest("[data-form-photo]");
        if (!button) return;
        if (button.dataset.formPhoto === "remove") {
            const current = formPhotos.get(form);
            if (current?.previewUrl) URL.revokeObjectURL(current.previewUrl);
            formPhotos.delete(form);
            showFormPhotoIdle(slot);
            return;
        }
        if (button.dataset.formPhoto !== "start") return;
        const agreed = formPhotos.get(form)?.agreed === true;
        flow?.destroy();
        flow = mountPhotoFlow(slot, {
            needsConsent: !agreed,
            // Recorded on the server as soon as the member exists (it does not exist yet).
            onConsent: () => { formPhotos.set(form, { ...(formPhotos.get(form) || {}), agreed: true, agreedAt: new Date().toISOString() }); },
            onPhoto: (blob) => {
                const previous = formPhotos.get(form);
                if (previous?.previewUrl) URL.revokeObjectURL(previous.previewUrl);
                const previewUrl = URL.createObjectURL(blob);
                formPhotos.set(form, { ...previous, agreed: true, blob, previewUrl });
                flow?.destroy();
                showFormPhotoPreview(slot, previewUrl);
            },
            onCancel: () => {
                const current = formPhotos.get(form);
                if (current && !current.blob) formPhotos.delete(form);
                showFormPhotoIdle(slot);
            }
        });
    });
    onModalClose(() => {
        flow?.destroy();
        const current = formPhotos.get(form);
        if (current?.previewUrl) URL.revokeObjectURL(current.previewUrl);
        formPhotos.delete(form);
    });
}

/**
 * After the new member is saved: records the member's "I agree", then uploads the photo.
 * A failure never undoes the member; staff are told to add the photo from the profile.
 */
export async function saveFormPhoto(form, memberId) {
    const pending = formPhotos.get(form);
    if (!pending?.blob || !pending.agreed) return;
    formPhotos.delete(form);
    try {
        await agreeToPhoto(memberId);
        await uploadPhoto(memberId, pending.blob);
    } catch (error) {
        toast(`Member saved, but the photo was not: ${String(error.message || "please try again").replace(/\.+$/, "")}. Add it from the member's profile.`, "error");
    } finally {
        if (pending.previewUrl) URL.revokeObjectURL(pending.previewUrl);
    }
}

// ---------- Actions ----------

/** Handles photo buttons. onChange(memberId) redraws what shows the photo. Returns true when handled. */
export function handlePhotoAction(action, element, onChange = () => {}, { beforeAdd = () => () => {} } = {}) {
    const memberId = element.dataset.id;
    switch (action) {
        case "photo-add": {
            const resume = beforeAdd(element) || (() => {});
            openPhotoDialog(memberId, {
                name: element.dataset.name || "",
                onDone: () => { loadPendingPhotos(); onChange(memberId); },
                onClose: resume
            });
            return true;
        }
        case "photo-remove": confirmRemove(memberId); return true;
        case "photo-remove-confirm":
            runPhotoChange(element, () => apiClient.delete(`/api/members/${memberId}/photo`), "Photo removed.", onChange);
            return true;
        case "photo-withdraw": confirmWithdraw(memberId); return true;
        case "photo-withdraw-confirm":
            runPhotoChange(element, () => apiClient.post(`/api/members/${memberId}/photo-consent`, { agree: false }), "Consent withdrawn and photo deleted.", onChange);
            return true;
        case "photo-approve":
            runPhotoChange(element, () => apiClient.post(`/api/members/${memberId}/photo/approve`, {}), "Photo approved.", onChange);
            return true;
        case "photo-reject":
            runPhotoChange(element, () => apiClient.post(`/api/members/${memberId}/photo/reject`, {}), "Photo rejected and deleted.", onChange);
            return true;
        default:
            return false;
    }
}
