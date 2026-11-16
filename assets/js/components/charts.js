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

// The plan donut's colours, and its legend as plain HTML under the chart: Chart.js cuts a long plan
// name short ("Monthly Membe…"), a list shows every name in full and wraps on a phone.
export const PLAN_COLORS = ["#326a48", "#8db876", "#c4dc86", "#d9a966", "#b8c5ba", "#5b7fa6", "#c97b63", "#8a7bb0"];

/** The list under the donut: a colour swatch, the full plan name and its member count. */
export function planLegendHtml(rows) {
    const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
    return rows.map((row, index) => `<li><span class="legend-swatch" style="background:${PLAN_COLORS[index % PLAN_COLORS.length]}" aria-hidden="true"></span><span class="legend-name">${escape(row.plan_name)}</span><strong>${Number(row.members) || 0}</strong></li>`).join("");
}
