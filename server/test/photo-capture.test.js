// The member photo flow (assets/js/photoCapture.js) with a small fake DOM: after "I agree", and
// after a photo is picked, the next step's buttons must respond. Regression test for the live
// bug where "Take photo", "Choose from gallery" and "Skip" did nothing after consent.
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---------- A fake DOM, just enough for mountPhotoFlow ----------

class FakeElement {
    constructor(attributes = {}, text = "") {
        this.attributes = attributes;
        this.dataset = {};
        for (const [name, value] of Object.entries(attributes)) {
            if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
        }
        this.textContent = text;
        this.disabled = false;
        this.hidden = "hidden" in attributes;
    }
    closest(selector) {
        const name = /^\[([\w-]+)\]$/.exec(selector)?.[1];
        return name && name in this.attributes ? this : null;
    }
    focus() {}
    addEventListener() {}
    removeEventListener() {}
    getBoundingClientRect() { return { width: 280, height: 280 }; }
    getContext() { return { clearRect() {}, drawImage() {} }; }
}

class FakeContainer {
    constructor() {
        this.elements = [];
        this.handlers = new Map();
    }
    set innerHTML(html) {
        this.elements = [];
        // Every tag with attributes; buttons keep their text for readable failures.
        for (const match of html.matchAll(/<(button|p|canvas|input)\b([^>]*)>([^<]*)/g)) {
            const attributes = {};
            for (const attribute of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attributes[attribute[1]] = attribute[2] ?? "";
            const element = new FakeElement(attributes, match[3]);
            element.tag = match[1];
            this.elements.push(element);
        }
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
        if (selector === "button") return this.elements.filter((element) => element.tag === "button");
        const match = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
        if (!match) return [];
        return this.elements.filter((element) => match[1] in element.attributes && (match[2] === undefined || element.attributes[match[1]] === match[2]));
    }
    addEventListener(type, handler) { this.handlers.set(type, handler); }
    removeEventListener(type, handler) { if (this.handlers.get(type) === handler) this.handlers.delete(type); }
    button(step) {
        const button = this.querySelector(`[data-photo="${step}"]`);
        assert.ok(button, `the "${step}" button is on screen (have: ${this.elements.filter((e) => e.tag === "button").map((e) => e.dataset.photo).join(", ")})`);
        return button;
    }
    /** A tap: the click reaches the container's delegated handler, as in a browser. */
    async tap(step) {
        const button = this.button(step);
        assert.equal(button.disabled, false, `"${button.textContent}" is enabled`);
        await this.handlers.get("click")?.({ target: button });
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

let opened;
let pickedFile;
const saved = {};

beforeEach(() => {
    opened = [];
    pickedFile = null;
    for (const name of ["document", "window", "createImageBitmap"]) saved[name] = globalThis[name];
    globalThis.window = { devicePixelRatio: 1 };
    globalThis.createImageBitmap = async () => ({ width: 800, height: 600, close() {} });
    // pickPhotoFile: records the file input it opens and answers with pickedFile.
    globalThis.document = {
        body: { append() {} },
        createElement(tag) {
            assert.equal(tag, "input");
            const listeners = {};
            const input = {
                attributes: {},
                setAttribute(name, value) { this.attributes[name] = value; },
                getAttribute(name) { return this.attributes[name] ?? null; },
                addEventListener(type, handler) { listeners[type] = handler; },
                remove() {},
                click() {
                    opened.push({ accept: this.accept, capture: this.getAttribute("capture") });
                    this.files = pickedFile ? [pickedFile] : [];
                    queueMicrotask(() => (pickedFile ? listeners.change?.() : listeners.cancel?.()));
                }
            };
            return input;
        }
    };
});

afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete globalThis[name];
        else globalThis[name] = value;
    }
});

const { mountPhotoFlow } = await import("../../assets/js/photoCapture.js");

test("after I agree, Take photo opens the back camera from the tap", async () => {
    const container = new FakeContainer();
    let consented = 0;
    mountPhotoFlow(container, { onConsent: async () => { consented += 1; }, onPhoto() {} });
    await container.tap("agree");
    assert.equal(consented, 1);
    await container.tap("camera");
    assert.deepEqual(opened, [{ accept: "image/*", capture: "environment" }]);
});

test("after I agree, Choose from gallery opens the picker without the camera", async () => {
    const container = new FakeContainer();
    mountPhotoFlow(container, { onConsent: async () => {}, onPhoto() {} });
    await container.tap("agree");
    await container.tap("gallery");
    assert.deepEqual(opened, [{ accept: "image/*", capture: null }]);
});

test("after I agree, Skip closes the flow", async () => {
    const container = new FakeContainer();
    let cancelled = 0;
    mountPhotoFlow(container, { onConsent: async () => {}, onPhoto() {}, onCancel: () => { cancelled += 1; }, cancelLabel: "Skip" });
    await container.tap("agree");
    await container.tap("cancel");
    assert.equal(cancelled, 1);
});

test("after a photo is picked, Choose again and Skip on the crop step respond", async () => {
    const container = new FakeContainer();
    let cancelled = 0;
    mountPhotoFlow(container, { needsConsent: false, onPhoto() {}, onCancel: () => { cancelled += 1; } });
    pickedFile = { type: "image/jpeg", size: 1000 };
    await container.tap("gallery");
    container.button("use");
    await container.tap("retake");
    container.button("camera");
    pickedFile = { type: "image/jpeg", size: 1000 };
    await container.tap("camera");
    await container.tap("cancel");
    assert.equal(cancelled, 1);
    assert.equal(opened.length, 2);
});

test("a failed consent save keeps the consent buttons usable", async () => {
    const container = new FakeContainer();
    let attempts = 0;
    mountPhotoFlow(container, { onConsent: async () => { attempts += 1; if (attempts === 1) throw new Error("offline"); }, onPhoto() {} });
    await container.tap("agree");
    assert.equal(container.querySelector("[data-photo-error]").textContent, "offline");
    await container.tap("agree");
    await container.tap("camera");
    assert.equal(opened.length, 1);
});
