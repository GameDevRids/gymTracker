import { escapeHTML } from "../utils.js";

/**
 * Draws a Chart.js chart, or shows a short message in its place when there is nothing
 * to plot, so empty data never appears as bare axes.
 */
export function drawChartOrEmpty(canvas, { hasData, emptyMessage, config }) {
    if (!canvas) return null;
    const area = canvas.parentElement;
    area.querySelector(".chart-empty")?.remove();
    canvas.hidden = !hasData;
    if (!hasData) {
        area.insertAdjacentHTML("beforeend", `<div class="empty-state chart-empty" role="status">${escapeHTML(emptyMessage)}</div>`);
        return null;
    }
    return new window.Chart(canvas, config);
}

export const hasNonZero = (values) => values.some((value) => Number(value) > 0);
