import {
    state,
    persist,
    resetDemo,
    getPlan,
    getMember,
    memberBalance,
    initializationWarning,
    loadMembersFromApi,
    createMemberOnApi,
    updateMemberOnApi,
    deleteMemberOnApi,
    memberFromApiRow
} from "./state.js";
import { renderDashboard, drawDashboardCharts } from "./modules/dashboard.js";
import { renderMembers, renderProfile } from "./modules/members.js";
import { renderPlansPage, loadPlans, setPlanSearch, setPlanStatus, handlePlanAction, handlePlanSubmit } from "./modules/plans.js";
import {
    handleMembershipAction,
    loadAllMemberships,
    loadMemberMembershipHistory,
    submitMembershipAssignment,
    updateAssignmentForm
} from "./modules/memberMemberships.js";
import { renderOperationsPage, drawAnalyticsCharts } from "./modules/operations.js";
import { openModal, closeModal } from "./components/modal.js";
import { toast } from "./components/toast.js";
import { renderWhatsAppPage, handleWhatsAppAction, handleWhatsAppSubmit, handleWhatsAppChange } from "./modules/whatsapp.js";
import { escapeHTML, uid, localISODate, addDays, formatCurrency, formatDate, memberStatus, parseCSV, downloadCSV, daysBetween, setDateFormat, setCurrency } from "./utils.js";

const page = document.querySelector("#page-content");
const viewTitles = {
    overview: "Overview", members: "Members", plans: "Membership plans", attendance: "Attendance", payments: "Payments",
    renewals: "Renewals", retention: "Retention", analytics: "Analytics", reports: "Reports",
    notifications: "Notifications", whatsapp: "WhatsApp inbox", integrations: "Integrations", settings: "Settings", profile: "Member profile"
};
let currentView = "overview";
let profileId = "";
let memberFilters = { search: "", filter: "all", sort: "name" };
let importedRows = [];
let currentFileName = "members.csv";

function render() {
    setDateFormat(state.gym.dateFormat || "DD MMM YYYY");
    setCurrency(state.gym.currency || "INR");
    document.querySelectorAll(".nav-link[data-view]").forEach((link) => link.classList.toggle("active", link.dataset.view === currentView));
    document.querySelector("#current-page").textContent = viewTitles[currentView] || "Overview";
    document.querySelector("#member-count").textContent = state.members.length;
    document.querySelector("#gym-name-label").textContent = state.gym.name;
    const now = new Date();
    document.querySelector("#today-label").textContent = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(now);
    if (currentView === "overview") {
        page.innerHTML = renderDashboard();
        drawDashboardCharts();
    } else if (currentView === "members") {
        page.innerHTML = renderMembers(memberFilters);
    } else if (currentView === "plans") {
        page.innerHTML = renderPlansPage();
    } else if (currentView === "whatsapp") {
        page.innerHTML = renderWhatsAppPage();
    } else if (currentView === "profile") {
        page.innerHTML = renderProfile(profileId);
    } else {
        page.innerHTML = renderOperationsPage(currentView);
        if (currentView === "analytics") drawAnalyticsCharts();
    }
}

async function refreshMembersFromApi({ silent = false } = {}) {
    try {
        const nextFilter = memberFilters.filter === "expired" ? "all" : memberFilters.filter;
        const members = await loadMembersFromApi({
            page: 1,
            limit: 100,
            status: nextFilter === "all" ? undefined : nextFilter,
            search: memberFilters.search
        });
        state.members = members;
        if (!silent) render();
    } catch (error) {
        if (!silent) toast(error.message || "Unable to load members from the backend.", "error");
    }
}

function navigate(view) {
    if (!viewTitles[view]) return;
    currentView = view;
    if (view !== "profile") profileId = "";
    render();
    if (view === "plans") loadPlans(renderPlansIfCurrent);
    if (view === "profile" && profileId) loadMemberMembershipHistory(profileId);
    if (initializationWarning) toast(initializationWarning, "error");
    page.focus({ preventScroll: true });
    closeMobileMenu();
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderPlansIfCurrent() {
    if (currentView === "plans") render();
}

function closeMobileMenu() {
    document.querySelector("#sidebar").classList.remove("open");
    document.querySelector("#mobile-scrim").classList.remove("visible");
    document.querySelector("#mobile-menu").setAttribute("aria-expanded", "false");
}

function safePersist(message = "Changes saved.") {
    try {
        persist();
        render();
        toast(message);
    } catch (error) {
        toast(error.message || "Unable to save changes.", "error");
    }
}

function setField(name, label, value = "", type = "text", required = false, extra = "") {
    return `<div class="field"><label for="form-${name}">${label}${required ? " *" : ""}</label><input id="form-${name}" name="${name}" type="${type}" value="${escapeHTML(value)}" ${required ? "required" : ""} ${extra}></div>`;
}

function planOptions(selected = "") {
    const activePlans = state.plans.filter((plan) => plan.active);
    return activePlans.map((plan) => `<option value="${escapeHTML(plan.id)}" data-price="${plan.price}" data-days="${plan.durationDays}" ${plan.id === selected ? "selected" : ""}>${escapeHTML(plan.name)} · ${formatCurrency(plan.price)}</option>`).join("");
}

function openMemberForm(memberId = "") {
    const member = memberId ? getMember(memberId) : null;
    if (memberId && !member) return toast("Member was not found.", "error");
    const isEdit = Boolean(member);
    const defaultPlan = state.plans.find((plan) => plan.active);
    const planId = member?.planId || defaultPlan?.id || "";
    const plan = getPlan(planId);
    openModal({
        title: isEdit ? "Edit member" : "Add a member",
        subtitle: isEdit ? `Update ${member.name}'s profile and membership.` : "Add someone new to your gym community.",
        wide: true,
        body: `<form id="member-form" data-id="${escapeHTML(member?.id || "")}" class="form-grid" novalidate>
            ${setField("name", "Full name", member?.name || "", "text", true)}
            <div class="field"><label for="form-phone">Phone number *</label><input id="form-phone" name="phone" type="text" value="${escapeHTML(member?.phone || "")}" inputmode="numeric" maxlength="10" pattern="[0-9]{10}" placeholder="9876543210" required aria-describedby="form-phone-error"><span id="form-phone-error" class="helper-text phone-error" role="alert" hidden>Phone number must contain exactly 10 digits.</span></div>
            ${setField("email", "Email address", member?.email || "", "email")}
            ${setField("dob", "Date of birth", member?.dob || "", "date")}
            <div class="field"><label for="form-gender">Gender</label><select id="form-gender" name="gender"><option value="">Not specified</option>${["Female", "Male", "Prefer not to say"].map((item) => `<option ${member?.gender === item ? "selected" : ""}>${item}</option>`).join("")}</select></div>
            <div class="field"><label for="form-planId">Membership plan *</label><select id="form-planId" name="planId" required>${planOptions(planId)}</select></div>
            <div class="field"><label for="form-status">Membership status</label><select id="form-status" name="status"><option value="active" ${member?.status !== "suspended" ? "selected" : ""}>Active</option><option value="suspended" ${member?.status === "suspended" ? "selected" : ""}>Suspended</option></select><span class="helper-text">Expired status is calculated from the expiry date.</span></div>
            ${setField("startDate", "Membership start date", member?.startDate || "", "date", false, 'readonly aria-readonly="true"')}
            ${setField("expiryDate", "Membership expiry date", member?.expiryDate || "", "date", false, 'readonly aria-readonly="true"')}
            <p class="helper-text field full">Membership dates are read-only here. Create or change them using Assign plan.</p>
            ${setField("totalFees", "Total billed fees (₹)", member?.totalFees ?? plan?.price ?? 0, "number", true, 'min="0" step="1"')}
            ${!isEdit ? setField("initialPayment", "Amount collected now (₹)", 0, "number", false, 'min="0" step="1"') : ""}
            ${setField("emergencyContact", "Emergency contact", member?.emergencyContact || "", "tel")}
            <div class="field full"><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="whatsappOptIn" ${member?.whatsappOptIn === true ? "checked" : ""}> Member has opted in to WhatsApp messages</label><span class="helper-text">Record consent before sending live WhatsApp messages. Keep proof of consent in your gym records.</span></div>
            <div class="field full"><label for="form-notes">Notes</label><textarea id="form-notes" name="notes">${escapeHTML(member?.notes || "")}</textarea></div>
            <p class="helper-text field full">Phone numbers must be unique. For imports, use columns: name, phone, email, plan, joinedAt, startDate, expiryDate.</p>
        </form>`,
        footer: `<button class="button button-secondary" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit" form="member-form">${isEdit ? "Save changes" : "Add member"}</button>`
    });
}

function openPaymentForm(memberId = "") {
    const member = memberId ? getMember(memberId) : null;
    if (memberId && !member) return toast("Member was not found.", "error");
    const choices = state.members.map((item) => `<option value="${escapeHTML(item.id)}" ${member?.id === item.id ? "selected" : ""}>${escapeHTML(item.name)} · ${escapeHTML(item.id)}</option>`).join("");
    const max = member ? memberBalance(member) : "";
    openModal({
        title: "Record a payment",
        subtitle: "Manual entry only. No payment gateway is connected.",
        body: `<form id="payment-form" class="form-grid">
            <div class="field full"><label for="form-memberId">Member *</label><select id="form-memberId" name="memberId" required><option value="">Select a member</option>${choices}</select></div>
            ${setField("amount", "Amount collected (₹)", "", "number", true, 'min="1" step="1"')}
            <div class="field"><label for="form-method">Payment method</label><select id="form-method" name="method">${["UPI", "Cash", "Card", "Bank transfer", "Other"].map((method) => `<option>${method}</option>`).join("")}</select></div>
            ${setField("date", "Payment date", localISODate(), "date", true)}
            <div class="field full"><label for="form-notes">Notes</label><textarea id="form-notes" name="notes" placeholder="Optional reference or payment note"></textarea></div>
            <div class="field full helper-text" id="payment-balance-note">${member ? `Outstanding balance: ${formatCurrency(max)}. A payment cannot exceed this balance.` : "Choose a member to check their balance."}</div>
        </form>`,
        footer: `<button class="button button-secondary" data-action="close-modal" type="button">Cancel</button><button class="button button-primary" type="submit" form="payment-form">Save payment</button>`
    });
}

function openCheckInForm(memberId = "", source = "manual") {
    const member = memberId ? getMember(memberId) : null;
    const choices = state.members.map((item) => `<option value="${escapeHTML(item.id)}" ${member?.id === item.id ? "selected" : ""}>${escapeHTML(item.name)} · ${escapeHTML(item.id)}</option>`).join("");
    openModal({
        title: source === "fingerprint" ? "Fingerprint scan simulation" : source === "qr" ? "QR check-in demo" : "Check in a member",
        subtitle: source === "fingerprint" ? "Simulation only — no biometric data or device connection is used." : "Select a member to record an attendance event.",
        body: `<form id="checkin-form" data-source="${escapeHTML(source)}"><div class="field"><label for="form-memberId">Member *</label><select id="form-memberId" name="memberId" required><option value="">Select a member</option>${choices}</select></div>
            <div class="note-box" style="margin-top:13px">${source === "fingerprint" ? "A successful simulated match records a normal attendance event. No fingerprint image or template is captured or stored." : "A second check-in for the same member on the same day will be prevented."}</div>
            <div id="checkin-warning" class="helper-text" style="margin-top:9px"></div></form>`,
        footer: `<button class="button button-secondary" data-action="close-modal" type="button">Cancel</button><button class="button button-primary" type="submit" form="checkin-form">${source === "fingerprint" ? "Simulate successful scan" : "Record check-in"}</button>`
    });
}

function openRenewForm(memberId) {
    const member = getMember(memberId);
    if (!member) return toast("Member was not found.", "error");
    const selectedPlan = getPlan(member.planId) || state.plans.find((plan) => plan.active);
    const start = member.expiryDate >= localISODate() ? addDays(member.expiryDate, 1) : localISODate();
    openModal({
        title: `Renew ${escapeHTML(member.name)}'s membership`,
        subtitle: "Previous membership activity will remain in the renewal history.",
        body: `<form id="renew-form" data-id="${escapeHTML(member.id)}" class="form-grid">
            <div class="field full"><label for="form-planId">New plan *</label><select id="form-planId" name="planId" required>${planOptions(selectedPlan?.id)}</select></div>
            ${setField("startDate", "New start date", start, "date", true)}
            ${setField("expiryDate", "New expiry date", addDays(start, selectedPlan?.durationDays || 30), "date", true)}
            ${setField("amount", "Payment collected now (₹)", selectedPlan?.price || 0, "number", true, 'min="0" step="1"')}
            <div class="field"><label for="form-method">Payment method</label><select id="form-method" name="method">${["UPI", "Cash", "Card", "Bank transfer", "Other"].map((method) => `<option>${method}</option>`).join("")}</select></div>
            <div class="field full helper-text">New membership fee will be added to the member's billed fees. Any partial payment remains outstanding.</div>
        </form>`,
        footer: `<button class="button button-secondary" data-action="close-modal" type="button">Cancel</button><button class="button button-primary" type="submit" form="renew-form">Save renewal</button>`
    });
}

function askDeleteMember(memberId) {
    const member = getMember(memberId);
    if (!member) return toast("Member was not found.", "error");
    openModal({
        title: "Delete member?",
        body: `<p class="confirm-copy">Delete <strong>${escapeHTML(member.name)}</strong> and remove their linked payment and attendance records? This cannot be undone.</p>`,
        footer: `<button class="button button-secondary" data-action="close-modal">Cancel</button><button class="button button-danger" data-action="confirm-delete-member" data-id="${escapeHTML(member.id)}">Delete member</button>`
    });
}

function openReceipt(paymentId) {
    const payment = state.payments.find((item) => item.id === paymentId);
    if (!payment) return toast("Payment was not found.", "error");
    const member = getMember(payment.memberId);
    openModal({
        title: "Payment receipt preview",
        subtitle: "A local preview only; this is not a tax invoice.",
        body: `<div class="card" style="padding:18px"><div style="font:800 17px Manrope,sans-serif;color:#173f32">${escapeHTML(state.gym.name)}</div><p class="helper-text">${escapeHTML(state.gym.address || "")}</p><hr style="border:0;border-top:1px solid #e8ede7"><div class="profile-fields">${receiptRow("Transaction ID", payment.id)}${receiptRow("Member", member?.name || "Removed member")}${receiptRow("Date", formatDate(payment.date))}${receiptRow("Method", payment.method)}${receiptRow("Status", payment.status)}${receiptRow("Amount", formatCurrency(payment.amount))}</div><p class="helper-text" style="margin-top:15px">Manually recorded payment · no gateway transaction</p></div>`,
        footer: `<button class="button button-primary" data-action="close-modal">Done</button>`
    });
}

function receiptRow(label, value) {
    return `<div><label>${escapeHTML(label)}</label><strong>${escapeHTML(value)}</strong></div>`;
}

function handleAction(action, target) {
    const id = target.dataset.id || "";
    switch (action) {
        case "close-modal": closeModal(); break;
        case "add-member": openMemberForm(); break;
        case "edit-member": openMemberForm(id); break;
        case "profile": profileId = id; navigate("profile"); break;
        case "delete-member": askDeleteMember(id); break;
        case "confirm-delete-member": {
            (async () => {
                try {
                    await deleteMemberOnApi(id);
                    state.payments = state.payments.filter((payment) => payment.memberId !== id);
                    state.attendance = state.attendance.filter((record) => record.memberId !== id);
                    closeModal();
                    safePersist("Member and linked records deleted.");
                } catch (error) {
                    toast(error.message || "Member could not be deleted.", "error");
                }
            })();
            break;
        }
        case "record-payment": openPaymentForm(id); break;
        case "check-in": openCheckInForm(id); break;
        case "qr-check-in": openCheckInForm("", "qr"); break;
        case "fingerprint": openCheckInForm("", "fingerprint"); break;
        case "check-out": checkOut(id); break;
        case "renew-member": openRenewForm(id); break;
        case "export-members": exportMembers(); break;
        case "export-payments": exportPayments(); break;
        case "export-renewals": exportRenewals(); break;
        case "export-retention": exportRetention(); break;
        case "export-analytics": exportAnalytics(); break;
        case "download-report": downloadReport(); break;
        case "import-csv": document.querySelector("#csv-file").click(); break;
        case "confirm-import": confirmImport(); break;
        case "copy-message": copyMessage(target.dataset.message || ""); break;
        case "receipt": openReceipt(id); break;
        case "reset-demo": resetDemoData(); break;
        default: break;
    }
}

function checkOut(attendanceId) {
    const record = state.attendance.find((item) => item.id === attendanceId);
    if (!record || record.checkedOutAt) return toast("This attendance record is not available for check-out.", "error");
    record.checkedOutAt = new Date().toISOString();
    safePersist("Check-out recorded.");
}

function updateMemberFormDefaults(target) {
    const form = target.closest("form");
    if (!form) return;
    if (form.id === "member-form" && target.name === "planId") {
        const option = target.selectedOptions[0];
        form.elements.totalFees.value = option?.dataset.price || "0";
    }
    if ((form.id === "renew-form" || form.id === "member-form") && target.name === "planId" && form.id === "renew-form") {
        const option = target.selectedOptions[0];
        const startDate = form.elements.startDate.value;
        form.elements.expiryDate.value = addDays(startDate, Number(option?.dataset.days || 30));
        form.elements.amount.value = option?.dataset.price || "0";
    }
    if (form.id === "renew-form" && target.name === "startDate") {
        const option = form.elements.planId.selectedOptions[0];
        form.elements.expiryDate.value = addDays(target.value, Number(option?.dataset.days || 30));
    }
    if (form.id === "payment-form" && target.name === "memberId") {
        const member = getMember(target.value);
        const balance = member ? memberBalance(member) : null;
        form.elements.amount.max = balance ?? "";
        document.querySelector("#payment-balance-note").textContent = member ? `Outstanding balance: ${formatCurrency(balance)}. A payment cannot exceed this balance.` : "Choose a member to check their balance.";
    }
    if (form.id === "checkin-form" && target.name === "memberId") {
        const member = getMember(target.value);
        document.querySelector("#checkin-warning").textContent = member && memberStatus(member) === "expired" ? "This membership has expired. Submitting will require confirmation." : "";
    }
}

function phoneDigits(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
    if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
    return digits;
}

function uniqueMemberId() {
    let id = uid("GP");
    while (state.members.some((member) => member.id === id)) id = uid("GP");
    return id;
}

function adjustCharges(charges, totalFees, date) {
    const updated = charges?.length
        ? charges.map((charge) => ({ ...charge, amount: Number(charge.amount) || 0 }))
        : [{ amount: Number(totalFees), date }];
    let difference = Number(totalFees) - updated.reduce((sum, charge) => sum + charge.amount, 0);
    if (difference > 0) updated[updated.length - 1].amount += difference;
    else {
        for (let index = updated.length - 1; index >= 0 && difference < 0; index -= 1) {
            const reduction = Math.min(updated[index].amount, Math.abs(difference));
            updated[index].amount -= reduction;
            difference += reduction;
        }
    }
    return updated.filter((charge) => charge.amount > 0);
}

async function saveMember(form) {
    const values = new FormData(form);
    const name = String(values.get("name") || "").trim();
    const phone = String(values.get("phone") || "").trim();
    if (!/^[0-9]{10}$/.test(phone)) throw new Error("Phone number must contain exactly 10 digits.");
    const current = form.dataset.id ? getMember(form.dataset.id) : null;
    const duplicate = state.members.find((member) => member.phone === phone && member.id !== (current?.id || ""));
    if (duplicate) throw new Error(`This phone number already belongs to ${duplicate.name}.`);
    const plan = getPlan(String(values.get("planId") || ""));
    if (!plan) throw new Error("Select an available membership plan.");
    const totalFees = Number(values.get("totalFees"));
    if (!Number.isFinite(totalFees) || totalFees < 0) throw new Error("Membership fees must be zero or more.");
    const initialPayment = Number(values.get("initialPayment") || 0);
    if (!Number.isFinite(initialPayment) || initialPayment < 0 || initialPayment > totalFees) throw new Error("Initial payment must be between zero and the membership fee.");
    const startDate = current?.startDate || "";
    const expiryDate = current?.expiryDate || "";

    const record = {
        id: current?.id || uniqueMemberId(),
        memberCode: current?.memberCode || "",
        name,
        phone,
        email: String(values.get("email") || "").trim(),
        dob: String(values.get("dob") || ""),
        gender: String(values.get("gender") || ""),
        planId: plan.id,
        startDate,
        expiryDate,
        totalFees,
        status: String(values.get("status") || current?.status || "active"),
        emergencyContact: String(values.get("emergencyContact") || "").trim(),
        whatsappOptIn: values.has("whatsappOptIn"),
        notes: String(values.get("notes") || "").trim(),
        renewals: current?.renewals || [],
        followUpStatus: current?.followUpStatus || "pending",
        charges: current?.charges || [{ amount: totalFees, date: startDate }]
    };

    const saved = current
        ? await updateMemberOnApi(current.id, record)
        : await createMemberOnApi(record);

    if (saved) {
        const normalized = memberFromApiRow(saved) || record;
        const targetIndex = state.members.findIndex((member) => member.id === normalized.id);
        if (targetIndex >= 0) state.members[targetIndex] = normalized;
        else state.members.unshift(normalized);
    }

    if (initialPayment > 0) {
        state.payments.unshift({
            id: uid("TX"),
            memberId: saved?.id || record.id,
            amount: initialPayment,
            date: localISODate(),
            method: "UPI",
            status: "paid",
            notes: "Initial payment"
        });
    }

    closeModal();
    safePersist(current ? "Member details updated." : "New member added.");
}

function savePayment(form) {
    const values = new FormData(form);
    const member = getMember(String(values.get("memberId") || ""));
    if (!member) throw new Error("Select a valid member.");
    const amount = Number(values.get("amount"));
    const balance = memberBalance(member);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Payment amount must be greater than zero.");
    if (amount > balance) throw new Error(`Payment cannot exceed the outstanding balance of ${formatCurrency(balance)}.`);
    state.payments.unshift({ id: uid("TX"), memberId: member.id, amount, date: String(values.get("date")), method: String(values.get("method")), status: "paid", notes: String(values.get("notes") || "").trim() });
    closeModal(); safePersist("Payment recorded successfully.");
}

function saveRenewal(form) {
    const member = getMember(form.dataset.id);
    if (!member) throw new Error("Member was not found.");
    const values = new FormData(form);
    const plan = getPlan(String(values.get("planId") || ""));
    if (!plan || !plan.active) throw new Error("Choose an active membership plan.");
    const amount = Number(values.get("amount"));
    if (!Number.isFinite(amount) || amount < 0 || amount > plan.price) throw new Error("Payment must be between zero and the plan price.");
    const startDate = String(values.get("startDate"));
    const expiryDate = String(values.get("expiryDate"));
    if (!startDate || !expiryDate || expiryDate < startDate) throw new Error("Enter a valid membership date range.");
    const renewal = { date: localISODate(), previousExpiryDate: member.expiryDate, planId: plan.id, startDate, expiryDate, amount };
    member.renewals = [...(member.renewals || []), renewal];
    member.charges = [...(member.charges || [{ amount: Number(member.totalFees || 0), date: member.startDate }]), { amount: plan.price, date: localISODate() }];
    member.planId = plan.id;
    member.startDate = startDate;
    member.expiryDate = expiryDate;
    member.totalFees = Number(member.totalFees || 0) + plan.price;
    member.status = "active";
    if (amount > 0) state.payments.unshift({ id: uid("TX"), memberId: member.id, amount, date: localISODate(), method: String(values.get("method")), status: "paid", notes: "Membership renewal" });
    closeModal(); safePersist("Membership renewed.");
}

function recordCheckIn(form) {
    const values = new FormData(form);
    const member = getMember(String(values.get("memberId") || ""));
    if (!member) throw new Error("Select a valid member.");
    if (memberStatus(member) === "expired" && !window.confirm(`${member.name}'s membership is expired. Record this check-in anyway?`)) return;
    const today = localISODate();
    if (state.attendance.some((record) => record.memberId === member.id && record.checkedInAt.slice(0, 10) === today)) throw new Error("This member already has a check-in recorded today.");
    const source = form.dataset.source || "manual";
    state.attendance.unshift({ id: uid("AT"), memberId: member.id, checkedInAt: new Date().toISOString(), checkedOutAt: "", source });
    closeModal(); safePersist(source === "fingerprint" ? "Simulated scan matched. Attendance recorded." : "Check-in recorded.");
}

function openImportPreview() {
    const valid = [];
    const invalid = [];
    const seen = new Set(state.members.map((member) => phoneDigits(member.phone)));
    importedRows.forEach(({ rowNumber, data }) => {
        const name = data.name || data.fullname || "";
        const phone = data.phone || data.phonenumber || data.mobile || "";
        const digits = phoneDigits(phone);
        const issues = [];
        if (!name.trim()) issues.push("name is required");
        if (digits.length < 10 || digits.length > 15) issues.push("valid phone is required");
        if (digits && seen.has(digits)) issues.push("duplicate phone number");
        if (digits) seen.add(digits);
        const planName = String(data.plan || "").trim();
        if (planName && !state.plans.some((plan) => plan.active && plan.name.toLowerCase() === planName.toLowerCase())) issues.push("unknown membership plan");
        const startDate = data.startdate || data.joinedat || data.joiningdate || "";
        const expiryDate = data.expirydate || "";
        const isISODate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T12:00:00`).getTime()) && new Date(`${value}T12:00:00`).toISOString().slice(0, 10) === value;
        if (startDate && !isISODate(startDate)) issues.push("start date must use YYYY-MM-DD");
        if (expiryDate && !isISODate(expiryDate)) issues.push("expiry date must use YYYY-MM-DD");
        if (startDate && expiryDate && isISODate(startDate) && isISODate(expiryDate) && expiryDate < startDate) issues.push("expiry date precedes start date");
        const row = { rowNumber, data, name: name.trim(), phone: phone.trim(), issues };
        (issues.length ? invalid : valid).push(row);
    });
    importedRows = [...valid, ...invalid];
    const rows = importedRows.slice(0, 30);
    openModal({
        title: "Preview member import",
        subtitle: `${escapeHTML(currentFileName)} · ${valid.length} valid · ${invalid.length} invalid or duplicate`,
        wide: true,
        body: `<div class="note-box" style="margin-bottom:12px">Required columns: <strong>name</strong> and <strong>phone</strong>. Supported aliases include full name, mobile, phone number, joining date and membership plan. Rows with an existing or repeated phone are skipped.</div>
            <div class="table-wrap"><table><thead><tr><th>Row</th><th>Name</th><th>Phone</th><th>Plan</th><th>Validation</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${row.rowNumber}</td><td>${escapeHTML(row.name)}</td><td>${escapeHTML(row.phone)}</td><td>${escapeHTML(row.data.plan || "Default plan")}</td><td>${row.issues.length ? `<span class="status status-expired">${escapeHTML(row.issues.join(", "))}</span>` : `<span class="status">Ready</span>`}</td></tr>`).join("")}</tbody></table></div>${importedRows.length > 30 ? `<p class="helper-text">Showing first 30 of ${importedRows.length} rows.</p>` : ""}`,
        footer: `<button class="button button-secondary" data-action="close-modal">Cancel</button><button class="button button-primary" data-action="confirm-import" ${valid.length ? "" : "disabled"}>Import ${valid.length} members</button>`
    });
}

function confirmImport() {
    let imported = 0;
    const failed = importedRows.filter((row) => row.issues.length).length;
    importedRows.filter((row) => !row.issues.length).forEach(({ data, name, phone }) => {
        const planName = String(data.plan || "").trim();
        const matchedPlan = planName
            ? state.plans.find((plan) => plan.name.toLowerCase() === planName.toLowerCase() && plan.active)
            : state.plans.find((plan) => plan.active);
        if (!matchedPlan) return;
        const joinedAt = data.joinedat || data.joiningdate || localISODate();
        const startDate = data.startdate || joinedAt;
        const member = {
            id: uniqueMemberId(), name, phone, email: data.email || "", dob: data.dob || data.dateofbirth || "",
            gender: data.gender || "", joinedAt, planId: matchedPlan.id, startDate,
            expiryDate: data.expirydate || addDays(startDate, matchedPlan.durationDays),
            status: "active", totalFees: matchedPlan.price, charges: [{ amount: matchedPlan.price, date: startDate }], amountPaid: 0,
            emergencyContact: "", notes: "Imported from CSV", followUpStatus: "pending", renewals: []
        };
        state.members.push(member);
        imported += 1;
    });
    importedRows = [];
    closeModal();
    safePersist(`${imported} imported, ${failed} skipped. Existing data was not overwritten.`);
}

function exportMembers() {
    runExport("members.csv", state.members.map((member) => ({
        memberId: member.id, name: member.name, phone: member.phone, email: member.email || "", joinedAt: member.joinedAt,
        plan: getPlan(member.planId)?.name || "", startDate: member.startDate, expiryDate: member.expiryDate,
        status: memberStatus(member), totalFees: member.totalFees, amountPaid: member.totalFees - memberBalance(member), outstanding: memberBalance(member)
    })));
}

function exportPayments() {
    runExport("payments.csv", state.payments.map((payment) => ({ ...payment, memberName: getMember(payment.memberId)?.name || "Removed member" })));
}

function exportRenewals() {
    runExport("renewals.csv", state.members.flatMap((member) => (member.renewals || []).map((renewal) => ({ memberId: member.id, memberName: member.name, ...renewal }))));
}

function exportRetention() {
    const rows = state.members.map((member) => {
        const last = state.attendance.filter((record) => record.memberId === member.id).sort((a, b) => b.checkedInAt.localeCompare(a.checkedInAt))[0];
        const daysInactive = last ? daysBetween(last.checkedInAt.slice(0, 10)) : "";
        return { memberId: member.id, name: member.name, phone: member.phone, lastVisit: last?.checkedInAt.slice(0, 10) || "", daysInactive, expiryDate: member.expiryDate, followUpStatus: member.followUpStatus || "pending" };
    }).filter((row) => row.daysInactive === "" || row.daysInactive >= 7);
    runExport("retention-followups.csv", rows);
}

function exportAnalytics() {
    runExport("analytics-summary.csv", [
        { metric: "totalMembers", value: state.members.length },
        { metric: "activeMembers", value: state.members.filter((member) => memberStatus(member) === "active").length },
        { metric: "allTimeCollected", value: state.payments.filter((payment) => payment.status === "paid").reduce((sum, payment) => sum + Number(payment.amount), 0) },
        { metric: "outstanding", value: state.members.reduce((sum, member) => sum + memberBalance(member), 0) },
        { metric: "attendanceRecords", value: state.attendance.length }
    ]);
}

function downloadReport() {
    const type = document.querySelector("#report-type")?.value;
    const date = document.querySelector("#report-date")?.value || localISODate();
    let rows = [];
    let filename = `${type || "report"}.csv`;
    if (type === "attendance-daily" || type === "attendance-monthly") {
        rows = state.attendance.filter((record) => type === "attendance-daily" ? record.checkedInAt.slice(0, 10) === date : record.checkedInAt.slice(0, 7) === localISODate().slice(0, 7)).map((record) => ({ memberId: record.memberId, memberName: getMember(record.memberId)?.name || "Removed member", phone: getMember(record.memberId)?.phone || "", checkedInAt: record.checkedInAt, checkedOutAt: record.checkedOutAt || "", source: record.source }));
    } else if (type === "revenue") rows = state.payments.filter((payment) => payment.status === "paid").map((payment) => ({ ...payment, memberName: getMember(payment.memberId)?.name || "Removed member" }));
    else if (type === "outstanding") rows = state.members.filter((member) => memberBalance(member) > 0).map((member) => ({ memberId: member.id, name: member.name, phone: member.phone, outstanding: memberBalance(member) }));
    else if (type === "memberships") rows = state.members.map((member) => ({ memberId: member.id, name: member.name, plan: getPlan(member.planId)?.name || "", startDate: member.startDate, expiryDate: member.expiryDate, status: memberStatus(member) }));
    else if (type === "renewals") rows = state.members.flatMap((member) => (member.renewals || []).map((renewal) => ({ memberId: member.id, memberName: member.name, ...renewal })));
    else if (type === "inactive") rows = state.members.filter((member) => {
        const last = state.attendance.filter((record) => record.memberId === member.id).sort((a, b) => b.checkedInAt.localeCompare(a.checkedInAt))[0];
        return !last || daysBetween(last.checkedInAt.slice(0, 10)) >= 14;
    }).map((member) => ({ memberId: member.id, name: member.name, phone: member.phone, expiryDate: member.expiryDate }));
    runExport(filename, rows);
}

function runExport(filename, rows) {
    try {
        downloadCSV(filename, rows);
        toast(`${filename} downloaded.`);
    } catch (error) {
        toast(error.message || "Unable to export CSV.", "error");
    }
}

async function copyMessage(message) {
    try {
        await navigator.clipboard.writeText(message);
        toast("Preview copied. It has not been sent.");
    } catch {
        toast("Clipboard access is unavailable in this browser.", "error");
    }
}

function resetDemoData() {
    openModal({
        title: "Reset demo data?",
        body: `<p class="confirm-copy">This restores the original fictional GymPulse data and replaces changes saved in this browser. This cannot be undone.</p>`,
        footer: `<button class="button button-secondary" data-action="close-modal">Cancel</button><button class="button button-danger" data-action="confirm-reset">Reset workspace</button>`
    });
}

function confirmReset() {
    try {
        resetDemo();
        memberFilters = { search: "", filter: "all", sort: "name" };
        currentView = "overview";
        closeModal(); render(); toast("Demo data restored.");
    } catch (error) {
        toast(error.message || "Could not reset demo data.", "error");
    }
}

function saveSettings(form) {
    const values = new FormData(form);
    const phone = String(values.get("phone") || "").trim();
    if (phone && (phoneDigits(phone).length < 10 || phoneDigits(phone).length > 15)) throw new Error("Enter a valid gym phone number.");
    state.gym = {
        ...state.gym,
        name: String(values.get("name") || "").trim(),
        phone,
        address: String(values.get("address") || "").trim(),
        currency: String(values.get("currency") || "INR"),
        dateFormat: String(values.get("dateFormat") || "DD MMM YYYY"),
        preferences: {
            expiryReminderDays: Math.max(0, Math.min(90, Number(values.get("expiryReminderDays") || 0))),
            paymentReminders: values.has("paymentReminders"),
            inactivityReminders: values.has("inactivityReminders")
        }
    };
    if (!state.gym.name) throw new Error("Gym name is required.");
    safePersist("Settings saved.");
}

async function handleSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.id === "membership-assignment-form") {
        event.preventDefault();
        await submitMembershipAssignment(form, render);
        return;
    }
    if (form.id === "plan-form") {
        event.preventDefault();
        await handlePlanSubmit(form, renderPlansIfCurrent);
        return;
    }
    if (form.id === "whatsapp-compose" || form.id === "whatsapp-template-form") {
        event.preventDefault();
        if (!form.reportValidity()) return;
        handleWhatsAppSubmit(form, render);
        return;
    }
    const handlers = {
        "member-form": saveMember,
        "payment-form": savePayment,
        "renew-form": saveRenewal,
        "checkin-form": recordCheckIn,
        "settings-form": saveSettings
    };
    const handler = handlers[form.id];
    if (!handler) return;
    event.preventDefault();
    if (form.id === "member-form" && !validateMemberPhone(form, true)) return;
    if (!form.reportValidity()) return;
    try {
        await handler(form);
    } catch (error) {
        toast(error.message || "Please check the form and try again.", "error");
    }
}

document.addEventListener("click", (event) => {
    const viewLink = event.target.closest("[data-view]");
    if (viewLink) { navigate(viewLink.dataset.view); return; }
    const action = event.target.closest("[data-action]");
    if (action) {
        if (action.dataset.action.startsWith("whatsapp-")) {
            handleWhatsAppAction(action.dataset.action, action, render);
            return;
        }
        if (action.dataset.action === "confirm-reset") { confirmReset(); return; }
        if (action.dataset.action === "confirm-import") { confirmImport(); return; }
        if (handleMembershipAction(action.dataset.action, action)) return;
        if (handlePlanAction(action.dataset.action, action, renderPlansIfCurrent)) return;
        handleAction(action.dataset.action, action);
    }
});

document.addEventListener("submit", handleSubmit);
document.addEventListener("change", (event) => {
    const target = event.target;
    if (target.matches("[data-whatsapp-change]")) {
        handleWhatsAppChange(target, render);
        return;
    }
    if (target.closest("#modal-root")) updateMemberFormDefaults(target);
    if (target.matches("#membership-assignment-form [name='plan_id'], #membership-assignment-form [name='start_date']")) updateAssignmentForm(target);
    if (target.id === "plan-status-filter") { setPlanStatus(target.value, renderPlansIfCurrent); return; }
    if (target.id === "member-filter") { memberFilters.filter = target.value; render(); }
    if (target.id === "member-sort") { memberFilters.sort = target.value; render(); }
    if (target.id === "renewal-filter") {
        document.querySelectorAll("[data-renewal-row]").forEach((row) => {
            const days = Number(row.dataset.days);
            const value = target.value;
            row.hidden = value === "all" ? false : value === "expired" ? days >= 0 : value === "today" ? days !== 0 : value === "3" ? days < 1 || days > 3 : value === "7" ? days < 1 || days > 7 : days < 1 || days > 30;
        });
    }
    if (target.id === "payment-method-filter" || target.id === "payment-date-filter") filterPaymentRows();
    if (target.classList.contains("followup-select")) {
        const member = getMember(target.dataset.id);
        if (member) { member.followUpStatus = target.value; safePersist("Follow-up status updated."); }
    }
});

document.addEventListener("input", (event) => {
    const target = event.target;
    if (target.matches('#member-form [name="phone"]')) {
        target.value = target.value.replace(/[^0-9]/g, "").slice(0, 10);
        validateMemberPhone(target.form, false);
    }
    if (target.matches("#membership-assignment-form [name='start_date']")) updateAssignmentForm(target);
    if (target.id === "member-search") {
        memberFilters.search = target.value;
        const query = target.value.toLowerCase();
        document.querySelectorAll(".table-card tbody tr").forEach((row) => { row.hidden = !row.textContent.toLowerCase().includes(query); });
    }
    if (target.id === "plan-search") setPlanSearch(target.value, renderPlansIfCurrent);
    if (target.id === "attendance-search") {
        const query = target.value.toLowerCase();
        document.querySelectorAll("[data-attendance-row]").forEach((row) => { row.hidden = !row.textContent.toLowerCase().includes(query); });
    }
    if (target.id === "payment-search") {
        filterPaymentRows();
    }
});

function validateMemberPhone(form, showError) {
    const input = form?.elements?.phone;
    const error = document.querySelector("#form-phone-error");
    if (!input || !error) return true;
    const valid = /^[0-9]{10}$/.test(input.value);
    error.hidden = valid || !showError;
    input.setAttribute("aria-invalid", String(!valid && showError));
    return valid;
}

document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (target.matches?.('#member-form [name="phone"]')
        && !event.ctrlKey && !event.metaKey && !event.altKey
        && event.key.length === 1
        && !/[0-9]/.test(event.key)) {
        event.preventDefault();
    }
});

function filterPaymentRows() {
    const query = (document.querySelector("#payment-search")?.value || "").toLowerCase();
    const method = document.querySelector("#payment-method-filter")?.value || "all";
    const date = document.querySelector("#payment-date-filter")?.value || "";
    document.querySelectorAll("[data-payment-row]").forEach((row) => {
        row.hidden = !row.textContent.toLowerCase().includes(query)
            || (method !== "all" && row.dataset.method !== method)
            || (date && row.dataset.date !== date);
    });
}

document.querySelector("#mobile-menu").addEventListener("click", () => {
    document.querySelector("#sidebar").classList.add("open");
    document.querySelector("#mobile-scrim").classList.add("visible");
    document.querySelector("#mobile-menu").setAttribute("aria-expanded", "true");
});
document.querySelector("#mobile-scrim").addEventListener("click", closeMobileMenu);
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.querySelector("#sidebar").classList.contains("open")) {
        closeMobileMenu();
        document.querySelector("#mobile-menu").focus();
    }
    if (event.key === "Escape") document.querySelector(".wa-inbox.show-thread .wa-back")?.click();
});
document.querySelector("#csv-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
        currentFileName = file.name;
        importedRows = parseCSV(await file.text());
        openImportPreview();
    } catch (error) {
        toast(error.message || "Unable to read this CSV file.", "error");
    }
});

render();
refreshMembersFromApi();
loadAllMemberships(() => {
    if (currentView === "overview") render();
});
