// Voiding a payment (owner only, migration 025): it stays in every list with its receipt number,
// marked Voided with who did it, when and why, and stops counting towards balances and totals.
import { voidPayment } from "../api/paymentsApi.js";
import { closeModal, openModal } from "../components/modal.js";
import { toast } from "../components/toast.js";
import { rupees } from "../paymentRules.js";
import { state } from "../state.js";
import { escapeHTML, formatDate } from "../utils.js";

const indiaDay = (value) => (value ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(value)) : "");

/** Works with an API payment row (status, voided_at, …) or a mapped one (status, voidedAt, …). */
export const isVoidedPayment = (payment) => payment?.status === "voided";

/** Only the owner voids, and only a payment that still counts. */
export function canVoid(payment) {
    return state.gym.role === "owner" && !isVoidedPayment(payment) && !(payment?.refunded_at || payment?.status === "refunded");
}

/** "Owner (owner@gym.in)" or "Staff". */
export function personLabel(person) {
    if (!person) return "";
    return person.email ? `${person.role || "Owner"} (${person.email})` : person.role || "";
}

/** "Voided 17 Nov 2026 by Owner (o@gym.in): Duplicate entry". */
export function voidSummary(payment) {
    const at = payment.voided_at ?? payment.voidedAt;
    const by = personLabel(payment.voided_by_name ?? payment.voidedByName);
    const reason = payment.void_reason ?? payment.voidReason;
    return `Voided${at ? ` ${formatDate(indiaDay(at))}` : ""}${by ? ` by ${by}` : ""}${reason ? `: ${reason}` : ""}`;
}

/** The small note under a voided payment's amount. */
export function voidNote(payment) {
    return isVoidedPayment(payment) ? `<small class="cell-sub void-note">${escapeHTML(voidSummary(payment))}</small>` : "";
}

/** The Void button for a payment row, for owners only. */
export function voidButton(payment, receiptNumber = "") {
    if (!canVoid(payment)) return "";
    return `<button class="button button-secondary button-small void-button" type="button" data-action="payment-void" data-id="${escapeHTML(payment.id)}" aria-label="Void payment ${escapeHTML(receiptNumber || "")}">Void</button>`;
}

/**
 * Asks for the reason and voids the payment. payment: { id, receipt_number|receiptNumber, amount,
 * memberName }. onDone(result) runs after it is voided, to reload balances and lists.
 */
export function openVoidDialog(payment, onDone = () => {}) {
    const receipt = payment.receipt_number || payment.receiptNumber || "";
    openModal({
        title: "Void this payment?",
        subtitle: `${escapeHTML(receipt)} · ${escapeHTML(rupees(payment.amount))}${payment.memberName ? ` · ${escapeHTML(payment.memberName)}` : ""}`,
        body: `<form id="void-form" class="form-grid" novalidate>
            <p class="confirm-copy field full">The payment stays in the list with its receipt number, marked <strong>Voided</strong>. It stops counting as money collected, and the member's balance due goes back up by ${escapeHTML(rupees(payment.amount))}. This can't be undone.</p>
            <div class="field full"><label for="void-reason">Reason *</label><textarea id="void-reason" name="reason" required minlength="3" maxlength="300" placeholder="For example: recorded twice by mistake" aria-describedby="void-error"></textarea><span class="helper-text phone-error" id="void-error" role="alert" hidden></span></div>
        </form>`,
        footer: `<button class="button button-secondary" type="button" data-action="close-modal">Cancel</button><button class="button button-danger" type="submit" form="void-form" id="void-submit">Void payment</button>`
    });
    const form = document.querySelector("#void-form");
    const submit = document.querySelector("#void-submit");
    const error = form.querySelector("#void-error");
    const fail = (message) => { error.textContent = message; error.hidden = false; };
    form.addEventListener("input", () => { error.hidden = true; });
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const reason = form.elements.reason.value.trim();
        if (reason.length < 3) return fail("Give a reason for voiding (at least 3 characters).");
        if (submit.disabled) return;
        submit.disabled = true;
        submit.textContent = "Voiding…";
        try {
            const result = await voidPayment(payment.id, reason);
            closeModal();
            toast(`${receipt || "Payment"} voided.${result.balanceDue > 0 ? ` Balance due is now ${rupees(result.balanceDue)}.` : ""}`);
            onDone(result);
        } catch (failure) {
            fail(failure.message || "The payment could not be voided.");
            if (submit.isConnected) { submit.disabled = false; submit.textContent = "Void payment"; }
        }
    });
}
