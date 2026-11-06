import { apiClient } from "../api/apiClient.js";
import { closeModal, openModal } from "../components/modal.js";
import { toast } from "../components/toast.js";
import { state, getMember } from "../state.js";
import { escapeHTML, formatDate, localISODate, statusPill } from "../utils.js";

const membershipsByMember = new Map();
let allMemberships = [];
let allMembershipsLoaded = false;
let assigning = false;
let assignmentModalRequest = 0;

function formatINR(amount) {
    return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 2
    }).format(Number(amount) || 0);
}

export function getAllMemberships() {
    return allMemberships;
}

export function areAllMembershipsLoaded() {
    return allMembershipsLoaded;
}

export function getCurrentMembership(memberId) {
    const memberships = membershipsByMember.get(memberId)
        || allMemberships.filter((membership) => membership.member_id === memberId);
    return memberships.find((membership) => membership.effective_status === "active")
        || memberships.find((membership) => membership.effective_status === "upcoming")
        || memberships[0]
        || null;
}

export async function loadAllMemberships(onLoaded = () => {}) {
    try {
        const firstPage = await apiClient.get("/api/memberships", { params: { page: 1, limit: 100 } });
        const pagination = firstPage?.data?.pagination;
        const entries = Array.isArray(firstPage?.data?.memberships) ? [...firstPage.data.memberships] : [];
        for (let page = 2; page <= (pagination?.totalPages || 1); page += 1) {
            const response = await apiClient.get("/api/memberships", { params: { page, limit: 100 } });
            if (Array.isArray(response?.data?.memberships)) entries.push(...response.data.memberships);
        }
        allMemberships = entries;
        allMembershipsLoaded = true;
        onLoaded();
    } catch (error) {
        allMembershipsLoaded = false;
        toast(error.message || "Unable to load membership assignments.", "error");
    }
}

export async function loadMemberMembershipHistory(memberId) {
    const target = document.querySelector("#member-membership-history");
    const currentTarget = document.querySelector("#member-current-membership");
    if ((!target || target.dataset.memberId !== memberId)
        && (!currentTarget || currentTarget.dataset.memberId !== memberId)) return;
    if (target) target.innerHTML = `<div class="empty-state">Loading membership history…</div>`;
    if (currentTarget) currentTarget.innerHTML = `<div class="empty-state">Loading membership details…</div>`;
    try {
        const response = await apiClient.get(`/api/members/${memberId}/memberships`);
        const memberships = Array.isArray(response?.data) ? response.data : [];
        membershipsByMember.set(memberId, memberships);
        if (target?.isConnected && target.dataset.memberId === memberId) {
            target.innerHTML = renderMembershipHistory(memberId, memberships);
        }
        if (currentTarget?.isConnected && currentTarget.dataset.memberId === memberId) {
            currentTarget.innerHTML = renderCurrentMembership(memberships);
        }
    } catch (error) {
        const message = escapeHTML(error.message || "Unable to load membership history.");
        if (target?.isConnected) {
            target.innerHTML = `<div class="empty-state"><p>${message}</p><button class="button button-secondary" data-action="refresh-member-memberships" data-id="${escapeHTML(memberId)}">Try again</button></div>`;
        }
        if (currentTarget?.isConnected) currentTarget.innerHTML = `<div class="empty-state">${message}</div>`;
    }
}

function renderCurrentMembership(memberships) {
    const current = memberships.find((membership) => membership.effective_status === "active")
        || memberships.find((membership) => membership.effective_status === "upcoming")
        || memberships[0];
    if (!current) return `<div class="empty-state">No plan has been assigned to this member yet.</div>`;
    return `<div class="profile-fields membership-fields">
        <div><label>Plan</label><strong>${escapeHTML(current.plan_name)}</strong></div>
        <div><label>Assigned price</label><strong>${formatINR(current.price)}</strong></div>
        <div><label>Membership period</label><strong>${formatDate(current.start_date)} – ${formatDate(current.end_date)}</strong></div>
        <div><label>Effective status</label><strong>${statusPill(current.effective_status)}</strong></div>
    </div>`;
}

function renderMembershipHistory(memberId, memberships) {
    if (!memberships.length) {
        return `<div class="empty-state">No plan assignments yet. <button class="text-button" data-action="assign-member-plan" data-id="${escapeHTML(memberId)}">Assign a plan</button></div>`;
    }
    return memberships.map((membership) => `<article class="membership-history-item">
        <div><strong>${escapeHTML(membership.plan_name)}</strong><span>${statusPill(membership.effective_status)}</span></div>
        <p>${formatINR(membership.price)} · ${membership.duration_days} days</p>
        <small>${formatDate(membership.start_date)} – ${formatDate(membership.end_date)}</small>
    </article>`).join("");
}

function calculateEndDate(startDate, durationDays) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || "") || !Number.isInteger(durationDays) || durationDays < 1) return "";
    const start = new Date(`${startDate}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== startDate) return "";
    start.setUTCDate(start.getUTCDate() + durationDays - 1);
    return start.toISOString().slice(0, 10);
}

function overlappingMembership(memberships, startDate, endDate) {
    return memberships.find((membership) => membership.status !== "cancelled"
        && membership.start_date <= endDate
        && membership.end_date >= startDate);
}

function updateAssignmentPreview(form) {
    const selected = form.elements.plan_id.selectedOptions[0];
    const startDate = form.elements.start_date.value;
    const endDate = calculateEndDate(startDate, Number(selected?.dataset.duration || 0));
    const summary = form.querySelector("#assignment-summary");
    const warning = form.querySelector("#assignment-warning");
    const endDateField = form.querySelector("#assignment-end-date");
    const memberships = membershipsByMember.get(form.dataset.memberId) || [];
    if (endDateField) endDateField.textContent = endDate ? formatDate(endDate) : "Choose a valid start date.";
    const overlap = endDate && overlappingMembership(memberships, startDate, endDate);
    warning.hidden = !overlap;
    warning.textContent = overlap ? `Overlaps an existing ${overlap.plan_name} membership (${formatDate(overlap.start_date)} – ${formatDate(overlap.end_date)}).` : "";
    if (!selected?.value) {
        summary.innerHTML = `<div class="empty-state">Select a plan to review its details.</div>`;
        return;
    }
    summary.innerHTML = `<strong>${escapeHTML(selected.dataset.name)}</strong><p>${selected.dataset.duration} days · ${formatINR(Number(selected.dataset.price))}</p>`;
}

function renderAssignmentForm(memberId, plans) {
    const activePlans = plans.filter((plan) => plan.is_active);
    if (!activePlans.length) {
        return {
            body: `<div class="empty-state"><p>No active plans are available.</p><button class="button button-secondary" data-action="go-to-plans">Manage plans</button></div>`,
            footer: `<button class="button button-secondary" data-action="close-modal" type="button">Close</button>`
        };
    }
    const options = activePlans.map((plan) => `<option value="${escapeHTML(plan.id)}" data-name="${escapeHTML(plan.name)}" data-duration="${plan.duration_days}" data-price="${plan.price}">${escapeHTML(plan.name)} · ${plan.duration_days} days · ${formatINR(plan.price)}</option>`).join("");
    const body = `<form id="membership-assignment-form" data-member-id="${escapeHTML(memberId)}" class="form-grid">
        <div class="field full"><label for="assignment-plan">Active plan *</label><select id="assignment-plan" name="plan_id" required><option value="">Select a plan</option>${options}</select></div>
        <div class="field full" id="assignment-summary"><div class="empty-state">Select a plan to review its details.</div></div>
        <div class="field"><label for="assignment-start-date">Membership start date *</label><input id="assignment-start-date" name="start_date" type="date" value="${localISODate()}" required></div>
        <div class="field"><label>Calculated expiry date</label><div class="field-control assignment-end-date" id="assignment-end-date">Select a plan and start date.</div></div>
        <div class="note-box field full">The end date includes the plan's full duration. Existing membership history is preserved.</div>
        <div class="note-box field full assignment-warning" id="assignment-warning" role="alert" hidden></div>
    </form>`;
    return {
        body,
        footer: `<button class="button button-secondary" data-action="close-modal" type="button">Cancel</button><button class="button button-primary" type="submit" form="membership-assignment-form">Assign plan</button>`
    };
}

export async function openAssignmentModal(memberId) {
    const member = getMember(memberId);
    if (!member || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(memberId)) {
        toast("Select a member loaded from the backend before assigning a plan.", "error");
        return;
    }
    const requestId = ++assignmentModalRequest;
    openModal({
        title: `Assign a plan to ${escapeHTML(member.name)}`,
        subtitle: "Choose an active plan and membership start date.",
        body: `<div class="empty-state" role="status">Loading active plans and membership history…</div>`,
        footer: `<button class="button button-secondary" data-action="close-modal" type="button">Cancel</button>`
    });
    document.querySelector("#modal-root .modal").dataset.assignmentRequest = String(requestId);
    try {
        const [planResponse, membershipResponse] = await Promise.all([
            apiClient.get("/api/plans", { params: { page: 1, limit: 100, status: "active" } }),
            apiClient.get(`/api/members/${memberId}/memberships`)
        ]);
        if (!isCurrentAssignmentModal(requestId)) return;
        const plans = Array.isArray(planResponse?.data?.plans) ? [...planResponse.data.plans] : [];
        for (let page = 2; page <= (planResponse?.data?.pagination?.totalPages || 1); page += 1) {
            const response = await apiClient.get("/api/plans", { params: { page, limit: 100, status: "active" } });
            if (!isCurrentAssignmentModal(requestId)) return;
            if (Array.isArray(response?.data?.plans)) plans.push(...response.data.plans);
        }
        const memberships = Array.isArray(membershipResponse?.data) ? membershipResponse.data : [];
        membershipsByMember.set(memberId, memberships);
        const form = renderAssignmentForm(memberId, plans);
        const modal = document.querySelector("#modal-root .modal");
        if (!isCurrentAssignmentModal(requestId)) return;
        modal.querySelector(".modal-body").innerHTML = form.body;
        modal.querySelector(".modal-footer").innerHTML = form.footer;
        const assignmentForm = modal.querySelector("#membership-assignment-form");
        if (assignmentForm) updateAssignmentPreview(assignmentForm);
    } catch (error) {
        const modal = document.querySelector("#modal-root .modal");
        if (!isCurrentAssignmentModal(requestId)) return;
        modal.querySelector(".modal-body").innerHTML = `<div class="empty-state"><p>${escapeHTML(error.message || "Unable to load plans and membership history.")}</p><button class="button button-secondary" data-action="retry-assignment" data-id="${escapeHTML(memberId)}">Try again</button></div>`;
    }
}

function isCurrentAssignmentModal(requestId) {
    const modal = document.querySelector("#modal-root .modal");
    return requestId === assignmentModalRequest
        && modal?.dataset.assignmentRequest === String(requestId);
}

export function handleMembershipAction(action, target) {
    const memberId = target.dataset.id || "";
    if (action === "assign-member-plan") {
        openAssignmentModal(memberId);
    } else if (action === "refresh-member-memberships") {
        loadMemberMembershipHistory(memberId);
    } else if (action === "retry-assignment") {
        openAssignmentModal(memberId);
    } else if (action === "go-to-plans") {
        closeModal();
        document.querySelector('[data-view="plans"]')?.click();
    } else {
        return false;
    }

    return true;
}

export function updateAssignmentForm(target) {
    const form = target.closest("#membership-assignment-form");
    if (form) updateAssignmentPreview(form);
}

export async function submitMembershipAssignment(form, onUpdated) {
    if (assigning) return;
    const memberId = form.dataset.memberId;
    const planId = form.elements.plan_id.value;
    const startDate = form.elements.start_date.value;
    const selected = form.elements.plan_id.selectedOptions[0];
    const duration = Number(selected?.dataset.duration || 0);
    const endDate = calculateEndDate(startDate, duration);
    if (!planId) {
        toast("Select an active membership plan.", "error");
        return;
    }
    if (!endDate) {
        toast("Choose a valid membership start date.", "error");
        return;
    }
    const conflict = overlappingMembership(membershipsByMember.get(memberId) || [], startDate, endDate);
    if (conflict) {
        updateAssignmentPreview(form);
        toast("This member already has a membership during those dates.", "error");
        return;
    }

    assigning = true;
    const submitButton = document.querySelector('[type="submit"][form="membership-assignment-form"]');
    if (submitButton) submitButton.disabled = true;
    try {
        await apiClient.post(`/api/members/${memberId}/memberships`, { plan_id: planId, start_date: startDate });
        const member = getMember(memberId);
        if (member) {
            member.startDate = startDate;
            member.expiryDate = endDate;
        }
        closeModal();
        toast(`${selected.dataset.name} assigned through ${formatDate(endDate)}.`);
        await Promise.all([loadMemberMembershipHistory(memberId), loadAllMemberships()]);
        onUpdated();
        await loadMemberMembershipHistory(memberId);
    } catch (error) {
        toast(error.message || "Unable to assign this plan.", "error");
    } finally {
        assigning = false;
        if (submitButton?.isConnected) submitButton.disabled = false;
    }
}
