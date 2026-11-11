import { escapeHTML, formatDate, formatPhone } from "../utils.js";
import { t } from "../i18n.js";
import { renderSkeletonList } from "../components/skeleton.js";

/** Identifies one reminder: renewing a membership changes its end date, so it starts unreminded. */
export function reminderKey(membership) {
    return `${membership.id}:${membership.end_date}`;
}

function remindablePhone(member) {
    const phoneDigits = String(member.phone || "").replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
    return /^[6-9]\d{9}$/.test(phoneDigits) ? phoneDigits : "";
}

/** Reminders go only to members who consented and have a valid mobile number. */
export function reminderBlocker(member) {
    if (member?.whatsapp_opt_in !== true) return "no-consent";
    return remindablePhone(member || {}) ? "" : "invalid-phone";
}

function renderSummary(memberships, remindedKeys) {
    const remindable = memberships.filter((membership) => !reminderBlocker(membership.member));
    if (!remindable.length) return "";
    const reminded = remindable.filter((membership) => remindedKeys.has(reminderKey(membership))).length;
    return `<div class="board-summary" data-reminder-summary data-total="${remindable.length}">
        <span><strong>${remindable.length}</strong> ${escapeHTML(t("toRemind"))}</span>
        <span><strong data-reminded-count>${reminded}</strong> ${escapeHTML(t("remindedSoFar"))}</span>
        <div class="board-progress" role="progressbar" aria-label="${escapeHTML(t("remindersProgress"))}" aria-valuemin="0" aria-valuemax="${remindable.length}" aria-valuenow="${reminded}"><span style="--progress:${reminded / remindable.length}"></span></div>
    </div>`;
}

export function renderExpiring(memberships = [], status = "loading", days = 7, reminderTemplate = "", remindedKeys = new Set()) {
    const content = status === "loading"
        ? renderSkeletonList({ count: 4, label: t("loading"), variant: "card" })
        : status && typeof status === "object"
            ? `<div class="empty-state" role="alert"><p>${escapeHTML(status.message || "Unable to load expiring memberships.")}</p><button class="button button-secondary" data-action="retry-expiring">Try again</button></div>`
            : memberships.length
                ? `${renderSummary(memberships, remindedKeys)}<div class="expiring-list">${memberships.map((membership) => {
                    const member = membership.member;
                    const key = reminderKey(membership);
                    const isReminded = remindedKeys.has(key);
                    const dayLabel = membership.days_left < 0
                        ? `${Math.abs(membership.days_left)} ${t("expiredDays")}`
                        : membership.days_left === 0 ? t("expiresToday") : `${membership.days_left} ${t("daysLeft").toLowerCase()}`;
                    const phoneDigits = remindablePhone(member);
                    const message = reminderTemplate
                        .replace(/\{(name|plan|expiry_date)\}/g, (_match, placeholder) => ({
                            name: member.full_name,
                            plan: membership.plan_name,
                            expiry_date: formatDate(membership.end_date)
                        })[placeholder]);
                    const blocker = reminderBlocker(member);
                    const whatsappAction = !blocker
                        ? `<a class="button button-secondary button-small" href="https://wa.me/91${phoneDigits}?text=${encodeURIComponent(message)}" target="_blank" rel="noopener noreferrer" data-remind-key="${escapeHTML(key)}">${escapeHTML(isReminded ? t("reminded") : t("remindWhatsApp"))}</a>`
                        : `<span class="helper-text reminder-blocked">${blocker === "no-consent" ? escapeHTML(t("noWhatsAppConsent")) : "Invalid phone"}</span>`;
                    return `<article class="card expiring-card${isReminded ? " is-reminded" : ""}">
                        <div class="expiring-member"><span class="member-avatar">${escapeHTML(member.full_name.slice(0, 1))}</span><div><strong>${escapeHTML(member.full_name)}</strong><small>${escapeHTML(formatPhone(member.phone))}</small></div></div>
                        <div class="expiring-detail"><small>${t("plan")}</small><strong>${escapeHTML(membership.plan_name)}</strong></div>
                        <div class="expiring-detail"><small>${t("expiry")}</small><strong>${formatDate(membership.end_date)}</strong></div>
                        <span class="badge-soft ${membership.days_left < 0 ? "expiry-overdue" : ""}">${escapeHTML(dayLabel)}</span>
                        <div class="expiring-actions">
                            <button class="button button-secondary button-small" data-action="record-payment" data-id="${escapeHTML(member.id)}" data-membership-id="${escapeHTML(membership.id)}" data-amount="${escapeHTML(membership.price)}">${t("recordPayment")}</button>
                            ${whatsappAction}
                        </div>
                    </article>`;
                }).join("")}</div>`
                : `<div class="empty-state">${t("noExpiring")}</div>`;
    return `<div class="page-heading"><div><h1>${t("expiring")}</h1><p>${t("expiryDescription")}</p></div></div>
        <div class="toolbar"><label for="expiry-days">${t("windowLabel")}</label><select class="field-control" id="expiry-days">${[3, 7, 15, 30].map((window) => `<option value="${window}" ${window === Number(days) ? "selected" : ""}>${window} ${t("days")}</option>`).join("")}</select></div>
        ${content}`;
}

/**
 * Marks a card as reminded in place, without re-rendering, so CSS can animate the change:
 * the card fades, its stripe turns green, and the progress bar grows.
 * Returns the reminder key the first time, or "" if it was already reminded.
 */
export function markReminderSent(link) {
    const card = link.closest(".expiring-card");
    if (!card || card.classList.contains("is-reminded")) return "";
    card.classList.add("is-reminded");
    link.textContent = t("reminded");

    const summary = document.querySelector("[data-reminder-summary]");
    const count = summary?.querySelector("[data-reminded-count]");
    const bar = summary?.querySelector(".board-progress");
    const total = Number(summary?.dataset.total || 0);
    if (count && bar && total) {
        const reminded = Math.min(total, Number(count.textContent) + 1);
        count.textContent = String(reminded);
        bar.setAttribute("aria-valuenow", String(reminded));
        bar.firstElementChild?.style.setProperty("--progress", String(reminded / total));
    }
    return link.dataset.remindKey || "";
}
