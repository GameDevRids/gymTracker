// A small fake DOM for testing the browser-side photo code in Node: enough for the photo flow
// (assets/js/photoCapture.js) and the edit form's photo row to be mounted, drawn and tapped.

export class FakeElement {
    constructor(tag, attributes = {}, text = "") {
        this.tag = tag;
        this.attributes = attributes;
        this.dataset = {};
        for (const [name, value] of Object.entries(attributes)) {
            if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
        }
        this.classList = new Set((attributes.class || "").split(/\s+/).filter(Boolean));
        this.textContent = text;
        this.disabled = false;
        this.hidden = "hidden" in attributes;
        this.isConnected = true;
    }
    matches(selector) {
        if (selector.startsWith(".")) return this.classList.has(selector.slice(1));
        const match = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
        if (match) return match[1] in this.attributes && (match[2] === undefined || this.attributes[match[1]] === match[2]);
        return this.tag === selector;
    }
    closest(selector) {
        return this.matches(selector) ? this : null;
    }
    focus() {}
    addEventListener() {}
    removeEventListener() {}
    getBoundingClientRect() { return { width: 280, height: 280, x: 0, y: 0 }; }
    getContext() { return { clearRect() {}, drawImage() {} }; }
}

/** An element whose innerHTML is parsed into shallow children, with delegated click handlers. */
export class FakeContainer extends FakeElement {
    constructor(tag = "div", attributes = {}) {
        super(tag, attributes);
        this.elements = [];
        this.handlers = new Map();
    }
    set innerHTML(html) {
        this.elements = [];
        for (const match of html.matchAll(/<(button|p|canvas|input|span|div)\b([^>]*)>([^<]*)/g)) {
            const attributes = {};
            for (const attribute of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attributes[attribute[1]] = attribute[2] ?? "";
            this.elements.push(new FakeElement(match[1], attributes, match[3]));
        }
    }
    get innerHTML() {
        return this.elements.map((element) => element.textContent).join("");
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) { return this.elements.filter((element) => element.matches(selector)); }
    addEventListener(type, handler) { this.handlers.set(type, handler); }
    removeEventListener(type, handler) { if (this.handlers.get(type) === handler) this.handlers.delete(type); }
    /** The buttons on screen now, by their data-<name> value. */
    buttonValues(name) {
        return this.elements.filter((element) => element.tag === "button").map((element) => element.attributes[`data-${name}`]).filter(Boolean);
    }
    button(selector) {
        const button = this.querySelector(selector);
        if (!button) throw new Error(`no button for ${selector}; on screen: ${this.elements.filter((e) => e.tag === "button").map((e) => e.textContent).join(", ")}`);
        return button;
    }
    /** A tap: the click reaches the delegated handler, as it would in a browser. */
    async tap(selector) {
        const button = this.button(selector);
        if (button.disabled) throw new Error(`"${button.textContent}" is disabled`);
        await this.handlers.get("click")?.({ target: button });
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

/**
 * Installs the globals the photo code needs. `opened` collects every file picker that was
 * opened; set `file` to what the next pick returns (null = the member cancelled).
 */
export function installPhotoDom() {
    const saved = {};
    for (const name of ["document", "window", "createImageBitmap", "fetch", "URL"]) saved[name] = globalThis[name];
    const state = { opened: [], file: null };
    globalThis.window = { devicePixelRatio: 1 };
    globalThis.createImageBitmap = async () => ({ width: 800, height: 600, close() {} });
    globalThis.fetch = async () => { throw new Error("no network in tests"); };
    class FakeURL extends saved.URL {}
    FakeURL.createObjectURL = () => "blob:fake";
    FakeURL.revokeObjectURL = () => {};
    globalThis.URL = FakeURL;
    globalThis.document = {
        body: { append() {} },
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
        removeEventListener() {},
        createElement(tag) {
            if (tag !== "input") return new FakeElement(tag);
            const listeners = {};
            return {
                attributes: {},
                setAttribute(name, value) { this.attributes[name] = value; },
                getAttribute(name) { return this.attributes[name] ?? null; },
                addEventListener(type, handler) { listeners[type] = handler; },
                remove() {},
                click() {
                    state.opened.push({ accept: this.accept, capture: this.getAttribute("capture") });
                    this.files = state.file ? [state.file] : [];
                    queueMicrotask(() => (state.file ? listeners.change?.() : listeners.cancel?.()));
                }
            };
        }
    };
    return {
        opened: state.opened,
        pick(file = { type: "image/jpeg", size: 1000 }) { state.file = file; },
        restore() {
            for (const [name, value] of Object.entries(saved)) {
                if (value === undefined) delete globalThis[name];
                else globalThis[name] = value;
            }
        }
    };
}
