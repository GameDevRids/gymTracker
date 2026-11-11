import { loadState, saveState, resetState } from "./storage.js";
import { cleanMemberName } from "./utils.js";
import { createEmptyState } from "../../data/demo-data.js";
import { apiClient } from "./api/apiClient.js";
import { fetchMembers } from "./api/membersApi.js";

export let initializationWarning = "";
export let memberListPagination = { page: 1, limit: 25, total: 0 };
export const state = (() => {
    try {
        return loadState();
    } catch (error) {
        initializationWarning = error.message || "Browser storage is unavailable; changes may not persist.";
        return createEmptyState();
    }
})();
if (!state.whatsapp) state.whatsapp = {};
if (!state.apiMemberPayments) state.apiMemberPayments = {};

export function persist() { saveState(state); }

export function resetDemo() {
    const fresh = resetState();
    Object.keys(state).forEach((key) => delete state[key]);
    Object.assign(state, fresh);
}

export function memberFromApiRow(member) {
    if (!member) return null;
    const currentMembership = member.current_membership || null;
    return {
        id: member.id,
        memberCode: member.member_code || "",
        name: member.full_name || "",
        phone: member.phone || "",
        email: member.email || "",
        dob: member.date_of_birth || "",
        gender: member.gender || "",
        joinedAt: member.created_at ? member.created_at.slice(0, 10) : "",
        planId: currentMembership?.plan_id || "",
        currentMembership,
        membershipStatus: member.membership_status || currentMembership?.effective_status || "unassigned",
        startDate: currentMembership?.start_date || "",
        expiryDate: currentMembership?.end_date || "",
        status: member.status === "suspended" ? "suspended" : "active",
        // Lifetime totals calculated by the server from memberships and recorded payments.
        totalFees: Number(member.billing?.billed ?? currentMembership?.total_fees ?? currentMembership?.price ?? 0),
        paidTotal: Number(member.billing?.paid ?? 0),
        charges: [],
        amountPaid: 0,
        emergencyContact: "",
        whatsappOptIn: false,
        notes: member.notes || "",
        followUpStatus: "pending",
        renewals: [],
        createdAt: member.created_at || "",
        updatedAt: member.updated_at || ""
    };
}

export function memberToApiPayload(member) {
    const payload = {
        full_name: cleanMemberName(member.name),
        phone: member.phone || "",
        email: member.email || null,
        gender: member.gender || null,
        date_of_birth: member.dob || null,
        status: member.status === "suspended" ? "suspended" : "active",
        notes: member.notes || null,
    };
    if (member.memberCode) payload.member_code = member.memberCode;
    return payload;
}

export async function loadMembersFromApi(options = {}) {
    const status = options.status && ["active", "suspended"].includes(options.status) ? options.status : undefined;
    const params = {
        page: options.page ?? 1,
        limit: options.limit ?? 25,
        ...(status ? { status } : {}),
        ...(options.search ? { search: options.search } : {})
    };
    const response = await fetchMembers(params);
    const members = Array.isArray(response?.data?.members) ? response.data.members : [];
    memberListPagination = {
        page: response?.page ?? response?.data?.pagination?.page ?? params.page,
        limit: response?.limit ?? response?.data?.pagination?.limit ?? params.limit,
        total: response?.total ?? response?.data?.pagination?.total ?? members.length
    };
    state.members = members.map((member) => memberFromApiRow(member));
    return state.members;
}

export async function createMemberOnApi(member) {
    const response = await apiClient.post("/api/members", memberToApiPayload(member));
    const record = response?.data ?? null;
    const mapped = memberFromApiRow(record);
    if (mapped) {
        const existingIndex = state.members.findIndex((entry) => entry.id === mapped.id);
        if (existingIndex >= 0) state.members[existingIndex] = mapped;
        else state.members.unshift(mapped);
    }
    return mapped;
}

export async function updateMemberOnApi(id, member) {
    const response = await apiClient.put(`/api/members/${id}`, memberToApiPayload(member));
    const record = response?.data ?? null;
    const mapped = memberFromApiRow(record);
    if (mapped) {
        const existingIndex = state.members.findIndex((entry) => entry.id === mapped.id);
        if (existingIndex >= 0) state.members[existingIndex] = mapped;
        else state.members.unshift(mapped);
    }
    return mapped;
}

export async function deleteMemberOnApi(id) {
    await apiClient.delete(`/api/members/${id}`);
    state.members = state.members.filter((member) => member.id !== id);
    memberListPagination = {
        ...memberListPagination,
        total: Math.max(0, memberListPagination.total - 1)
    };
}

export function getPlan(planId) { return state.plans.find((plan) => plan.id === planId); }
export function getMember(memberId) { return state.members.find((member) => member.id === memberId); }
export function getMemberPayments(memberId) {
    const member = getMember(memberId);
    if (member?.memberCode) return state.apiMemberPayments[memberId] || [];
    return state.payments.filter((payment) => payment.memberId === memberId);
}
export function memberBalance(member) {
    if (member.memberCode) return Math.max(0, Number(member.totalFees || 0) - Number(member.paidTotal || 0));
    const payments = state.payments.filter((payment) => payment.memberId === member.id);
    return Math.max(0, Number(member.totalFees || 0) - payments.filter((payment) => payment.status === "paid").reduce((sum, payment) => sum + Number(payment.amount || 0), 0));
}

// Keeps the database totals current after this browser records a payment, until the next reload.
export function addPaidAmount(memberId, amount) {
    const member = getMember(memberId);
    if (member) member.paidTotal = Number(member.paidTotal || 0) + Number(amount || 0);
}
export function activeMembers() {
    const date = new Date();
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    const today = date.toISOString().slice(0, 10);
    return state.members.filter((member) => member.status !== "suspended" && member.expiryDate >= today);
}
