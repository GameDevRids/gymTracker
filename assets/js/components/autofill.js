// Chrome offered the owner's own name and email in member fields. Every field in a dialog (member,
// quick add, enquiry, payment, renew, hold, assign plan) has autofill turned off, including fields
// a dialog adds after it opens. Sign-in and password fields keep normal autofill: anything that is a
// password field, or is marked as a username or password, is left alone.

const KEEP = new Set(["username", "current-password", "new-password", "one-time-code"]);
const FIELDS = "input, select, textarea";

/** True for a field that should keep the browser's autofill (sign-in and password fields). */
export function keepsAutofill(field) {
    const type = String(field?.type || field?.getAttribute?.("type") || "").toLowerCase();
    const token = String(field?.getAttribute?.("autocomplete") || "").trim().toLowerCase();
    return type === "password" || KEEP.has(token);
}

/** Turns autofill off on every field inside root (and on its forms), except sign-in fields. */
export function turnOffAutofill(root) {
    if (!root?.querySelectorAll) return;
    const fields = [...(root.matches?.(FIELDS) ? [root] : []), ...root.querySelectorAll(FIELDS)];
    for (const field of fields) {
        if (keepsAutofill(field) || ["hidden", "submit", "button", "checkbox", "radio", "file"].includes(field.type)) continue;
        if (field.getAttribute("autocomplete") !== "off") field.setAttribute("autocomplete", "off");
    }
    for (const form of [...(root.matches?.("form") ? [root] : []), ...root.querySelectorAll("form")]) {
        if (![...form.querySelectorAll(FIELDS)].some(keepsAutofill)) form.setAttribute("autocomplete", "off");
    }
}

/** Watches the dialog area, so fields a dialog adds later are covered too. */
export function watchDialogAutofill(root = typeof document !== "undefined" ? document.querySelector("#modal-root") : null) {
    if (!root || typeof MutationObserver === "undefined") return null;
    turnOffAutofill(root);
    const observer = new MutationObserver((changes) => {
        for (const change of changes) change.addedNodes.forEach((node) => { if (node.nodeType === 1) turnOffAutofill(node); });
    });
    observer.observe(root, { childList: true, subtree: true });
    return observer;
}
