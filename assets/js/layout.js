// Small layout helpers shared by the app shell: the city or area under the gym's name in the menu,
// and the top bar title, shown only once the page's own big title has scrolled out of view.

// The last part of an Indian address is often the state or "India"; the city or area is before it.
const SKIP = new Set(["india", "andhra pradesh", "arunachal pradesh", "assam", "bihar", "chhattisgarh", "goa", "gujarat", "haryana", "himachal pradesh", "jharkhand", "karnataka", "kerala", "madhya pradesh", "maharashtra", "manipur", "meghalaya", "mizoram", "nagaland", "odisha", "punjab", "rajasthan", "sikkim", "tamil nadu", "telangana", "tripura", "uttar pradesh", "uttarakhand", "west bengal", "delhi ncr", "jammu and kashmir", "ladakh", "puducherry", "chandigarh"]);

/**
 * "12 MG Road, Indiranagar, Bengaluru, Karnataka 560038" → "Bengaluru". The last part that is not a
 * PIN code, a state or "India"; "" when the address is empty or only has those.
 */
export function gymArea(address) {
    const parts = String(address || "")
        .split(/[,\n]/)
        .map((part) => part.replace(/\b\d{6}\b/g, "").replace(/[-–]\s*$/, "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
    for (let index = parts.length - 1; index >= 0; index -= 1) {
        const part = parts[index];
        if (!SKIP.has(part.toLowerCase()) && /\p{L}/u.test(part)) return part.length > 40 ? `${part.slice(0, 39)}…` : part;
    }
    return "";
}

let titleObserver = null;

/**
 * The top bar shows the page title only after the big title on the page has scrolled past, so the
 * title is never on screen twice. Pages without a big title keep the top bar title.
 */
export function watchPageTitle(page, topbar) {
    titleObserver?.disconnect();
    titleObserver = null;
    if (!topbar) return;
    const title = page?.querySelector(".page-heading h1");
    const show = (visible) => {
        topbar.classList.toggle("title-shown", visible);
        topbar.querySelector(".topbar-title")?.setAttribute("aria-hidden", visible ? "false" : "true");
    };
    if (!title || typeof IntersectionObserver === "undefined") return show(true);
    show(false);
    const height = Math.round(topbar.getBoundingClientRect?.().height || 64);
    titleObserver = new IntersectionObserver(([entry]) => show(!entry.isIntersecting), { rootMargin: `-${height}px 0px 0px 0px` });
    titleObserver.observe(title);
}
