/* global qrcode */
// UPI payment QR codes, the gym's UPI settings and payment receipts. There is no payment
// gateway: the member pays in any UPI app and staff confirm the payment arrived before saving.
// qrcode comes from assets/vendor/qrcode-generator-1.4.4.js, loaded as a plain script.
import { state } from "../state.js";
import { apiClient } from "../api/apiClient.js";
import { openModal } from "../components/modal.js";
import { toast } from "../components/toast.js";
import { escapeHTML, formatDate, formatINR } from "../utils.js";
import { buildUpiLink, upiNote } from "../upi.js";
import { welcomePhone } from "../welcomeMessage.js";
import { CARD_COLORS, cardFontFamilies, cardFontsReady, drawQr, fitTextBlock, roundedRect, setFont, shareImageFile } from "./cardCanvas.js";

const METHOD_LABELS = { upi: "UPI", cash: "Cash", card: "Card", other: "Other" };

export function methodLabel(method) {
    return METHOD_LABELS[method] || String(method || "");
}

// ---------- Gym settings (database) ----------

// { status: "idle" | "loading" | "ready" | "error", data, message }
export const gymSettings = { status: "idle", data: null, message: "" };

function applyGymSettings(data) {
    gymSettings.data = data;
    gymSettings.status = "ready";
    gymSettings.message = "";
    state.gym.name = data.name || state.gym.name;
    // Phone and address used to live only in this browser. Until they are saved to the
    // database, keep showing the browser's values so the owner can save them.
    if (data.saved || data.phone) state.gym.phone = data.phone || "";
    if (data.saved || data.address) state.gym.address = data.address || "";
    state.gym.upiId = data.upi_id || "";
    state.gym.upiPayeeName = data.upi_payee_name || "";
}

export async function loadGymSettings() {
    gymSettings.status = "loading";
    try {
        const response = await apiClient.get("/api/gym-settings");
        applyGymSettings(response?.data || {});
    } catch (error) {
        gymSettings.status = "error";
        gymSettings.message = error.message || "Gym settings could not be loaded.";
    }
    return gymSettings;
}

export async function saveGymSettingsOnApi(values) {
    const response = await apiClient.put("/api/gym-settings", values);
    applyGymSettings(response?.data || {});
    return gymSettings.data;
}

/** The UPI details payments are made to, or null when no UPI ID is set. */
export function gymUpi() {
    const upiId = state.gym.upiId || "";
    if (!upiId) return null;
    return { upiId, payeeName: state.gym.upiPayeeName || state.gym.name || "" };
}

// ---------- QR codes ----------

function qrFor(text) {
    if (typeof qrcode !== "function") throw new Error("The QR code library did not load. Reload the page.");
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr;
}

/** An SVG QR code (crisp at any size) with the standard 4-module quiet zone. */
export function qrSvg(text, label = "UPI payment QR code") {
    const qr = qrFor(text);
    const count = qr.getModuleCount();
    const size = count + 8;
    let path = "";
    for (let row = 0; row < count; row += 1) {
        for (let col = 0; col < count; col += 1) {
            if (qr.isDark(row, col)) path += `M${col + 4} ${row + 4}h1v1h-1z`;
        }
    }
    return `<svg class="qr-svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${escapeHTML(label)}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#1E2D3A"/></svg>`;
}


function canvasFile(canvas, name) {
    return new Promise((resolve, reject) => canvas.toBlob((blob) => blob
        ? resolve(new File([blob], name, { type: "image/png" }))
        : reject(new Error("The image could not be created.")), "image/png"));
}

// ---------- Payment QR in the Record payment form ----------

/** The upi:// link for a payment, or null with the reason. */
export function paymentLink({ amount, memberCode = "", planName = "" }) {
    const upi = gymUpi();
    if (!upi) return { link: null, reason: "no-upi" };
    if (!(Number(amount) > 0)) return { link: null, reason: "no-amount" };
    try {
        return { link: buildUpiLink({ upiId: upi.upiId, payeeName: upi.payeeName, amount, note: upiNote({ gymName: state.gym.name, memberCode, planName }) }), reason: "" };
    } catch (error) {
        return { link: null, reason: "invalid", message: error.message };
    }
}

let preparedQr = { link: "", promise: null, file: null };

async function createPaymentQrImage(link, amount) {
    const width = 800;
    const height = 1040;
    const sample = `${state.gym.name} ${formatINR(amount)} Scan to pay with any UPI app ${gymUpi()?.upiId || ""}`;
    await cardFontsReady(sample);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot draw the payment QR image.");
    const fonts = cardFontFamilies(context);
    const pad = 64;
    context.fillStyle = CARD_COLORS.slate;
    context.fillRect(0, 0, width, height);
    context.fillStyle = CARD_COLORS.marigold;
    context.fillRect(0, 0, width, 14);
    const gym = fitTextBlock(context, state.gym.name || "GymPulse", { weight: 700, family: fonts.heading, max: 46, min: 28, width: width - pad * 2, maxLines: 2 });
    context.fillStyle = CARD_COLORS.marigold;
    setFont(context, 700, gym.size, fonts.heading);
    let y = 56;
    gym.lines.forEach((line) => { y += gym.lineHeight; context.fillText(line, pad, y); });
    context.fillStyle = CARD_COLORS.soft;
    setFont(context, 500, 32, fonts.body);
    y += 50;
    context.fillText("Scan to pay with any UPI app", pad, y);
    const qrSize = 560;
    const qrTop = y + 52;
    context.fillStyle = "#FFFFFF";
    roundedRect(context, (width - qrSize) / 2 - 16, qrTop - 16, qrSize + 32, qrSize + 32, 20);
    context.fill();
    drawQr(context, link, (width - qrSize) / 2, qrTop, qrSize);
    const amountText = fitTextBlock(context, formatINR(amount), { weight: 800, family: fonts.heading, max: 96, min: 48, width: width - pad * 2 });
    context.fillStyle = CARD_COLORS.white;
    setFont(context, 800, amountText.size, fonts.heading);
    context.textAlign = "center";
    context.fillText(amountText.lines[0], width / 2, qrTop + qrSize + 16 + 30 + amountText.size);
    context.fillStyle = CARD_COLORS.soft;
    setFont(context, 400, 28, fonts.body);
    context.fillText(`UPI ID: ${gymUpi()?.upiId || ""}`, width / 2, height - 48);
    context.textAlign = "left";
    return canvasFile(canvas, "payment-qr.png");
}

function prepareQrImage(link, amount) {
    if (preparedQr.link === link) return preparedQr;
    const entry = { link, file: null, promise: null };
    entry.promise = createPaymentQrImage(link, amount).then((file) => { entry.file = file; return file; });
    entry.promise.catch(() => { if (preparedQr === entry) preparedQr = { link: "", promise: null, file: null }; });
    preparedQr = entry;
    return entry;
}

/** Fills the QR panel and UTR field of the Record payment form from its current values. */
export function updatePaymentQrPanel(form, { memberCode = "", planName = "" } = {}) {
    const panel = form.querySelector("#payment-qr-panel");
    const utr = form.querySelector("#payment-utr-field");
    if (!panel) return;
    const isUpi = form.elements.method?.value === "upi";
    panel.hidden = !isUpi;
    if (utr) utr.hidden = !isUpi;
    if (!isUpi) return;
    const amount = Number(form.elements.amount?.value);
    const { link, reason, message } = paymentLink({ amount, memberCode, planName });
    if (reason === "no-upi") {
        panel.innerHTML = `<div class="note-box qr-note">Add your gym's UPI ID in Settings to show a payment QR here. <button class="text-button" type="button" data-action="open-upi-settings">Open Settings</button></div>`;
        return;
    }
    if (!link) {
        panel.innerHTML = `<div class="note-box qr-note">${escapeHTML(reason === "no-amount" ? "Enter an amount to show the payment QR." : message)}</div>`;
        return;
    }
    if (panel.dataset.link === link) return;
    panel.dataset.link = link;
    panel.innerHTML = `<div class="payment-qr">
            <div class="payment-qr-code">${qrSvg(link, `UPI QR code for ${formatINR(amount)}`)}</div>
            <div class="payment-qr-info">
                <span class="payment-qr-label">Amount</span>
                <strong class="payment-qr-amount">${escapeHTML(formatINR(amount))}</strong>
                <span class="payment-qr-payee">${escapeHTML(gymUpi().payeeName)}<br><small>${escapeHTML(gymUpi().upiId)}</small></span>
                <button class="button button-whatsapp button-small" type="button" data-action="payment-qr-share" data-amount="${escapeHTML(String(amount))}">Share payment QR on WhatsApp</button>
            </div>
        </div>`;
    prepareQrImage(link, amount);
}

function sharePaymentQr(button) {
    const form = button.closest("form") || document.querySelector("#payment-form");
    const link = form?.querySelector("#payment-qr-panel")?.dataset.link;
    const amount = Number(button.dataset.amount);
    if (!link) return;
    const entry = prepareQrImage(link, amount);
    const text = `Please pay ${formatINR(amount)} to ${state.gym.name} by scanning this QR in any UPI app (GPay, PhonePe, Paytm). UPI ID: ${gymUpi()?.upiId || ""}`;
    button.disabled = true;
    const sharing = entry.file ? shareImageFile(entry.file, { text }) : entry.promise.then((file) => shareImageFile(file, { text }));
    sharing
        .then((result) => { if (result === "downloaded") toast("QR image saved. Attach it in WhatsApp."); })
        .catch((error) => toast(error.message || "The QR image could not be created.", "error"))
        .finally(() => { if (button.isConnected) button.disabled = false; });
}

/** The ₹1 test QR shown in Settings, from the values typed in the form. */
export function renderUpiTestQr(upiId, payeeName) {
    try {
        const link = buildUpiLink({ upiId, payeeName: payeeName || state.gym.name, amount: 1, note: `${state.gym.name || "GymPulse"} test` });
        return `<div class="payment-qr upi-test"><div class="payment-qr-code">${qrSvg(link, "Test UPI QR code for ₹1")}</div><div class="payment-qr-info"><span class="payment-qr-label">Test QR</span><strong class="payment-qr-amount">₹1.00</strong><span class="helper-text">Scan with your phone's UPI app. It should show ${escapeHTML(payeeName || state.gym.name || "your name")} and ₹1.00. You don't need to pay.</span></div></div>`;
    } catch (error) {
        return `<p class="helper-text">${escapeHTML(upiId ? error.message : "Enter your UPI ID to see a ₹1 test QR.")}</p>`;
    }
}

// ---------- Payments list (database) ----------

export const paymentsPage = { status: "idle", payments: [], total: 0, monthTotal: 0, message: "" };

export async function loadPaymentsPage(onChange = () => {}) {
    paymentsPage.status = "loading";
    onChange();
    try {
        const response = await apiClient.get("/api/payments", { params: { page: 1, limit: 100 } });
        paymentsPage.payments = response?.data?.payments || [];
        paymentsPage.total = response?.data?.pagination?.total ?? paymentsPage.payments.length;
        paymentsPage.monthTotal = Number(response?.data?.month_total || 0);
        paymentsPage.status = "ready";
    } catch (error) {
        paymentsPage.status = "error";
        paymentsPage.message = error.message || "Payments could not be loaded.";
    }
    onChange();
}

// ---------- Receipts ----------

export async function fetchReceipt(paymentId) {
    const response = await apiClient.get(`/api/payments/${paymentId}/receipt`);
    if (!response?.data?.payment) throw new Error("The receipt could not be loaded.");
    return response.data;
}

function periodText(membership) {
    return membership?.start_date && membership?.end_date ? `${formatDate(membership.start_date)} – ${formatDate(membership.end_date)}` : "";
}

/** The receipt as a WhatsApp text message. */
export function receiptText(receipt) {
    const { payment, member, membership, gym } = receipt;
    const method = `${methodLabel(payment.method)}${payment.upi_reference ? ` (UTR ${payment.upi_reference})` : ""}`;
    const lines = [
        gym.name,
        `Payment receipt ${payment.receipt_number}`,
        `Date: ${formatDate(payment.paid_on)}`,
        member ? `Member: ${member.full_name}${member.member_code ? ` (${member.member_code})` : ""}` : "",
        `Amount: ${formatINR(payment.amount)}`,
        `Method: ${method}`,
        membership ? `Plan: ${membership.plan_name}${periodText(membership) ? `, ${periodText(membership)}` : ""}` : "",
        membership?.end_date ? `Valid until: ${formatDate(membership.end_date)}` : "",
        receipt.balance === null ? "" : receipt.balance > 0 ? `Balance due: ${formatINR(receipt.balance)}` : "Paid in full",
        gym.phone ? `Questions? Call ${gym.phone}` : "",
        "This is a payment receipt, not a tax invoice."
    ];
    return lines.filter(Boolean).join("\n");
}

export const RECEIPT_WIDTH = 1080;
export const RECEIPT_HEIGHT = 1350;

/** Draws the 1080x1350 receipt card and resolves to a PNG file. */
export async function createReceiptCard(receipt) {
    const { payment, member, membership, gym } = receipt;
    const rows = [
        ["Method", methodLabel(payment.method)],
        ["UPI reference", payment.upi_reference || ""],
        ["Plan", membership?.plan_name || ""],
        ["Period", periodText(membership)],
        ["Valid until", membership?.end_date ? formatDate(membership.end_date) : ""]
    ].filter(([, value]) => value);
    const status = receipt.balance === null ? null : receipt.balance > 0
        ? { text: `Balance due ${formatINR(receipt.balance)}`, color: CARD_COLORS.brick }
        : { text: "Paid in full", color: CARD_COLORS.leaf };
    await cardFontsReady([gym.name, gym.phone, member?.full_name, member?.member_code, payment.receipt_number, formatINR(payment.amount), status?.text, ...rows.flat(), "Payment receipt Received from Amount paid This is a payment receipt, not a tax invoice. ₹0123456789"].filter(Boolean).join(" "));

    const canvas = document.createElement("canvas");
    canvas.width = RECEIPT_WIDTH;
    canvas.height = RECEIPT_HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot draw the receipt.");
    const fonts = cardFontFamilies(context);
    const pad = 80;
    const width = RECEIPT_WIDTH - pad * 2;

    context.fillStyle = CARD_COLORS.slate;
    context.fillRect(0, 0, RECEIPT_WIDTH, RECEIPT_HEIGHT);
    context.fillStyle = CARD_COLORS.marigold;
    context.fillRect(0, 0, RECEIPT_WIDTH, 16);

    let y = 52;
    const gymName = fitTextBlock(context, gym.name || "GymPulse", { weight: 700, family: fonts.heading, max: 48, min: 30, width, maxLines: 2 });
    context.fillStyle = CARD_COLORS.marigold;
    setFont(context, 700, gymName.size, fonts.heading);
    gymName.lines.forEach((line) => { y += gymName.lineHeight; context.fillText(line, pad, y); });
    if (gym.phone) {
        context.fillStyle = CARD_COLORS.soft;
        setFont(context, 400, 30, fonts.body);
        y += 44;
        context.fillText(gym.phone, pad, y);
    }

    y += 82;
    context.fillStyle = CARD_COLORS.white;
    setFont(context, 800, 60, fonts.heading);
    context.fillText("Payment receipt", pad, y);
    y += 50;
    context.fillStyle = CARD_COLORS.soft;
    setFont(context, 500, 32, fonts.body);
    context.fillText(`${payment.receipt_number}  ·  ${formatDate(payment.paid_on)}`, pad, y);

    y += 36;
    context.fillStyle = CARD_COLORS.slate2;
    context.fillRect(pad, y, width, 2);

    y += 58;
    context.fillStyle = CARD_COLORS.soft;
    setFont(context, 400, 30, fonts.body);
    context.fillText("Received from", pad, y);
    const name = fitTextBlock(context, member?.full_name || "Member", { weight: 700, family: fonts.heading, max: 56, min: 34, width, maxLines: 2 });
    context.fillStyle = CARD_COLORS.white;
    setFont(context, 700, name.size, fonts.heading);
    y += 8;
    name.lines.forEach((line) => { y += name.lineHeight; context.fillText(line, pad, y); });
    if (member?.member_code) {
        context.fillStyle = CARD_COLORS.soft;
        setFont(context, 500, 30, fonts.body);
        y += 44;
        context.fillText(member.member_code, pad, y);
    }

    y += 36;
    const amountTop = y;
    context.fillStyle = CARD_COLORS.marigold;
    roundedRect(context, pad, amountTop, width, 176, 24);
    context.fill();
    context.fillStyle = CARD_COLORS.slate;
    setFont(context, 500, 30, fonts.body);
    context.fillText("Amount paid", pad + 36, amountTop + 52);
    const amount = fitTextBlock(context, formatINR(payment.amount), { weight: 800, family: fonts.heading, max: 100, min: 48, width: width - 72 });
    setFont(context, 800, amount.size, fonts.heading);
    context.fillText(amount.lines[0], pad + 36, amountTop + 150);
    y = amountTop + 176;

    if (status) {
        y += 28;
        setFont(context, 700, 36, fonts.heading);
        const pillWidth = context.measureText(status.text).width + 56;
        context.fillStyle = status.color;
        roundedRect(context, pad, y, pillWidth, 64, 32);
        context.fill();
        context.fillStyle = CARD_COLORS.white;
        context.fillText(status.text, pad + 28, y + 45);
        y += 64;
    }

    if (rows.length) {
        y += 28;
        const rowHeight = 58;
        const panelHeight = 24 * 2 + rows.length * rowHeight;
        context.fillStyle = CARD_COLORS.slate2;
        roundedRect(context, pad, y, width, panelHeight, 22);
        context.fill();
        rows.forEach(([label, value], index) => {
            const baseline = y + 24 + index * rowHeight + 40;
            context.fillStyle = CARD_COLORS.soft;
            setFont(context, 400, 30, fonts.body);
            context.fillText(label, pad + 32, baseline);
            const labelWidth = context.measureText(label).width;
            const fitted = fitTextBlock(context, value, { weight: 700, family: fonts.heading, max: 36, min: 24, width: width - 64 - labelWidth - 32 });
            context.fillStyle = CARD_COLORS.white;
            setFont(context, 700, fitted.size, fonts.heading);
            context.textAlign = "right";
            context.fillText(fitted.lines[0], pad + width - 32, baseline);
            context.textAlign = "left";
        });
    }

    context.fillStyle = CARD_COLORS.soft;
    setFont(context, 400, 28, fonts.body);
    context.textAlign = "center";
    context.fillText("This is a payment receipt, not a tax invoice.", RECEIPT_WIDTH / 2, RECEIPT_HEIGHT - 44);
    context.textAlign = "left";

    return canvasFile(canvas, `receipt-${payment.receipt_number}.png`);
}

// Receipt shown in the open dialog, with its card drawn ahead so sharing stays inside the tap.
let openReceipt = null;

function receiptBlocker(receipt) {
    if (!receipt.member) return "The member was not found.";
    if (receipt.member.whatsapp_opt_in !== true) return "This member has not agreed to receive WhatsApp updates.";
    if (!welcomePhone(receipt.member.phone)) return "This member does not have a valid Indian mobile number.";
    return "";
}

/**
 * Shows the receipt for a saved payment: "Payment recorded" right after saving, or
 * "Payment receipt" when opened again from a payment list. All data comes from the database.
 */
export async function openReceiptDialog(paymentId, { recorded = false } = {}) {
    openModal({
        title: recorded ? "Payment recorded" : "Payment receipt",
        body: `<div class="empty-state" role="status">Loading receipt…</div>`,
        footer: `<button class="button button-secondary" type="button" data-action="close-modal">Close</button>`
    });
    let receipt;
    try {
        receipt = await fetchReceipt(paymentId);
    } catch (error) {
        openModal({
            title: recorded ? "Payment recorded" : "Payment receipt",
            body: `<div class="empty-state" role="alert"><p>${escapeHTML(recorded ? `The payment was saved, but its receipt could not be loaded: ${error.message}` : error.message)}</p></div>`,
            footer: `<button class="button button-secondary" type="button" data-action="close-modal">Close</button>`
        });
        return;
    }
    const entry = { receipt, file: null, promise: null };
    entry.promise = createReceiptCard(receipt).then((file) => { entry.file = file; return file; });
    entry.promise.catch(() => {});
    openReceipt = entry;
    const { payment, member, membership } = receipt;
    const blocker = receiptBlocker(receipt);
    const status = receipt.balance === null ? "" : receipt.balance > 0
        ? `<span class="status status-overdue">Balance due ${escapeHTML(formatINR(receipt.balance))}</span>`
        : `<span class="status status-active">Paid in full</span>`;
    openModal({
        title: recorded ? "Payment recorded" : "Payment receipt",
        subtitle: `${escapeHTML(payment.receipt_number)} · ${escapeHTML(formatDate(payment.paid_on))}`,
        body: `<div class="receipt-summary">
            <div class="receipt-amount"><span>Amount paid</span><strong>${escapeHTML(formatINR(payment.amount))}</strong>${status}</div>
            <div class="profile-fields">
                <div><label>Member</label><strong>${escapeHTML(member?.full_name || "—")}</strong></div>
                <div><label>Member ID</label><strong>${escapeHTML(member?.member_code || "—")}</strong></div>
                <div><label>Method</label><strong>${escapeHTML(methodLabel(payment.method))}</strong></div>
                ${payment.upi_reference ? `<div><label>UPI reference</label><strong>${escapeHTML(payment.upi_reference)}</strong></div>` : ""}
                ${membership ? `<div><label>Plan</label><strong>${escapeHTML(membership.plan_name)}</strong></div><div><label>Valid until</label><strong>${escapeHTML(formatDate(membership.end_date))}</strong></div>` : ""}
            </div>
            ${blocker ? `<p class="helper-text">${escapeHTML(blocker)} You can still share the receipt card.</p>` : ""}
        </div>`,
        footer: `<div class="welcome-footer">
            <button class="button button-secondary" type="button" data-action="close-modal">Done</button>
            <button class="button button-secondary" type="button" data-action="receipt-text" ${blocker ? "disabled" : ""}>Send receipt as text</button>
            <button class="button button-whatsapp" type="button" data-action="receipt-share">Share receipt on WhatsApp</button>
        </div>`
    });
}

function shareReceipt(button) {
    const entry = openReceipt;
    if (!entry) return;
    const text = `Payment receipt ${entry.receipt.payment.receipt_number} from ${entry.receipt.gym.name}`;
    button.disabled = true;
    const sharing = entry.file ? shareImageFile(entry.file, { text }) : entry.promise.then((file) => shareImageFile(file, { text }));
    sharing
        .then((result) => { if (result === "downloaded") toast("Receipt saved. Attach it in WhatsApp."); else if (result === "shared") toast("Receipt shared."); })
        .catch((error) => toast(error.message || "The receipt image could not be created.", "error"))
        .finally(() => { if (button.isConnected) button.disabled = false; });
}

function sendReceiptText() {
    const receipt = openReceipt?.receipt;
    if (!receipt) return;
    const blocker = receiptBlocker(receipt);
    if (blocker) return toast(blocker, "error");
    // Opened straight from the tap so phones do not block it.
    window.open(`https://wa.me/91${welcomePhone(receipt.member.phone)}?text=${encodeURIComponent(receiptText(receipt))}`, "_blank", "noopener");
}

/** Handles payment QR and receipt buttons. Returns true when the action was handled. */
export function handleUpiPaymentAction(action, element) {
    if (action === "payment-qr-share") { sharePaymentQr(element); return true; }
    if (action === "receipt-share") { shareReceipt(element); return true; }
    if (action === "receipt-text") { sendReceiptText(); return true; }
    return false;
}
