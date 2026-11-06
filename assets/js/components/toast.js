export function toast(message, type = "success") {
    const region = document.querySelector("#toast-region");
    const element = document.createElement("div");
    element.className = `toast ${type === "error" ? "toast-error" : ""}`;
    element.innerHTML = `<span class="toast-icon">${type === "error" ? "!" : "✓"}</span><span></span>`;
    element.querySelector("span:last-child").textContent = message;
    region.append(element);
    window.setTimeout(() => element.remove(), 3800);
}
