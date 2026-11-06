const root = document.querySelector("#modal-root");
let returnFocusTarget = null;

export function openModal({ title, subtitle = "", body, footer = "", wide = false }) {
    returnFocusTarget = document.activeElement;
    root.innerHTML = `
        <section class="modal ${wide ? "modal-wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
            <header class="modal-header">
                <div><h2 id="modal-title">${title}</h2>${subtitle ? `<p>${subtitle}</p>` : ""}</div>
                <button class="modal-close" type="button" aria-label="Close dialog" data-action="close-modal">×</button>
            </header>
            <div class="modal-body">${body}</div>
            ${footer ? `<footer class="modal-footer">${footer}</footer>` : ""}
        </section>`;
    root.querySelector(".modal-close").focus();
}

export function closeModal() {
    root.replaceChildren();
    if (returnFocusTarget instanceof HTMLElement && returnFocusTarget.isConnected) returnFocusTarget.focus();
    returnFocusTarget = null;
}

root?.addEventListener("click", (event) => {
    if (event.target === root) closeModal();
});
document.addEventListener("keydown", (event) => {
    if (!root?.childElementCount) return;
    if (event.key === "Escape") {
        closeModal();
        return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...root.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
});
