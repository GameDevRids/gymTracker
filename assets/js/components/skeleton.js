import { escapeHTML } from "../utils.js";

/**
 * Grey placeholder rows shown while a list loads. The shimmer is a CSS transform on a
 * pseudo-element, so it stays cheap and respects prefers-reduced-motion.
 * Screen readers hear the label once instead of the decorative rows.
 */
export function renderSkeletonList({ count = 4, label = "Loading…", variant = "row" } = {}) {
    const items = Array.from({ length: count }, (_, index) => `<div class="skeleton-item skeleton-${variant}" aria-hidden="true">
        <span class="skeleton-block skeleton-avatar"></span>
        <span class="skeleton-lines">
            <span class="skeleton-block" style="width:${[62, 48, 70, 55][index % 4]}%"></span>
            <span class="skeleton-block skeleton-block-short" style="width:${[38, 30, 44, 34][index % 4]}%"></span>
        </span>
        ${variant === "card" ? `<span class="skeleton-block skeleton-pill"></span>` : ""}
    </div>`).join("");
    return `<div class="skeleton-list" role="status" aria-live="polite"><span class="sr-only">${escapeHTML(label)}</span>${items}</div>`;
}
