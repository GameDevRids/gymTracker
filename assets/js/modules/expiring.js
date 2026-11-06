import { escapeHTML, formatDate } from "../utils.js";
import { t } from "../i18n.js";

export function renderExpiring(memberships = [], status = "loading", days = 7, reminderTemplate = "") {
    const content = status === "loading"
        ? `<div class="empty-state">${t("loading")}</div>`
        : status === "error"
            ? `<div class="empty-state" role="alert">${escapeHTML(status.message)}</div>`
            : memberships.length
                ? `<div class="expiring-list">${memberships.map((membership) => {
                    const member = membership.member;
                    const dayLabel = membership.days_left < 0
                        ? `${Math.abs(membership.days_left)} ${t("expiredDays")}`
                        : membership.days_left === 0 ? t("expiresToday") : `${membership.days_left} ${t("daysLeft").toLowerCase()}`;
                    const phoneDigits = String(member.phone || "").replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
                    const message = reminderTemplate
                        .replace(/\{(name|plan|expiry_date)\}/g, (_match, placeholder) => ({
                            name: member.full_name,
                            plan: membership.plan_name,
                            expiry_date: formatDate(membership.end_date)
                        })[placeholder]);
                    const canRemind = /^[6-9]\d{9}$/.test(phoneDigits);
                    const whatsappAction = canRemind
                        ? `<a class="button button-secondary button-small" href="https://wa.me/91${phoneDigits}?text=${encodeURIComponent(message)}" target="_blank" rel="noopener noreferrer">${t("remindWhatsApp")}</a>`
                        : `<span class="helper-text">Invalid phone</span>`;
                    return `<article class="card expiring-card">
                        <div class="expiring-member"><span class="member-avatar">${escapeHTML(member.full_name.slice(0, 1))}</span><div><strong>${escapeHTML(member.full_name)}</strong><small>${escapeHTML(member.phone)}</small></div></div>
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
