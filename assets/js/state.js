import { clearSavedWorkspace, readSavedWorkspace } from "./storage.js";
import { cleanMemberName } from "./utils.js";
import { createEmptyState, removeLegacyDemoData } from "./workspace.js";
import { apiClient } from "./api/apiClient.js";
import { fetchMembers } from "./api/membersApi.js";

// Everything about the gym comes from the database and is kept in memory only. The demo gym is a
// real gym in the database too (server/scripts/seed-demo.js); nothing is saved in the browser.
export const state = Object.assign(createEmptyState(), { apiMemberPayments: {} });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let workspaceUser = "";
// What an older version kept in this browser for this owner (never sample data), waiting for
// the one-time "Move my saved data to the cloud" step. The app does not read it otherwise.
let savedWorkspace = null;

function resetState(values = {}) {
    Object.keys(state).forEach((key) => delete state[key]);
    Object.assign(state, createEmptyState(), { apiMemberPayments: {} }, values);
}

/** Call after sign-in: starts an empty workspace. */
export function startWorkspace(userId) {
    workspaceUser = userId || "";
    resetState();
    const saved = readSavedWorkspace(workspaceUser);
    // Sample data an older version loaded in this browser is fictional: it is simply removed.
    if (saved?.sampleDataLoaded === true) {
        clearSavedWorkspace(workspaceUser);
        savedWorkspace = null;
        return;
    }
    savedWorkspace = saved ? removeLegacyDemoData(saved).state : null;
}

export function savedBrowserWorkspace() {
    return savedWorkspace;
}

/** Deletes what older versions kept in this browser; the app stops using it. */
export function forgetSavedBrowserWorkspace() {
    clearSavedWorkspace(workspaceUser);
    savedWorkspace = null;
}

/** Check-ins an older version saved only in this browser, for the one-time move. */
export function legacyAttendance() {
    return (Array.isArray(savedWorkspace?.attendance) ? savedWorkspace.attendance : [])
        .filter((record) => record && record.memberId && record.checkedInAt);
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
        // The shared status (assets/js/memberStatus.js) worked out by the server, and its dates.
        memberStatus: member.member_status || "",
        statusDetail: member.status_detail || null,
        // Lifetime totals calculated by the server from memberships and recorded payments.
        totalFees: Number(member.billing?.billed ?? 0),
        paidTotal: Number(member.billing?.paid ?? 0),
        emergencyContact: member.emergency_contact || "",
        // Consent comes only from the database; the browser never assumes it.
        whatsappOptIn: member.whatsapp_opt_in === true,
        whatsappOptInAt: member.whatsapp_opt_in_at || "",
        whatsappOptOutAt: member.whatsapp_opt_out_at || "",
        notes: member.notes || "",
        // Photo state only; the image itself is loaded from a short-lived signed URL kept in
        // memory (modules/memberPhotos.js), never stored with the member.
        photoStatus: ["pending", "approved"].includes(member.photo_status) ? member.photo_status : "none",
        photoConsent: member.photo_consent === true,
        photoConsentAt: member.photo_consent_at || "",
        photoUpdatedAt: member.photo_updated_at || "",
        // Only single-member responses carry the check-in QR token.
        ...(member.qr_token ? { qrToken: member.qr_token } : {}),
        followUpStatus: member.follow_up_status || "pending",
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
        emergency_contact: member.emergencyContact || null,
        follow_up_status: member.followUpStatus || "pending"
    };
    if (member.memberCode) payload.member_code = member.memberCode;
    return payload;
}

const MEMBER_PAGE_SIZE = 100;

/**
 * Loads every current member of the gym into memory, a page of 100 at a time. Totals, filters,
 * exports and pickers then cover the whole gym, not just one page.
 */
export async function loadAllMembersFromApi() {
    const first = await fetchMembers({ page: 1, limit: MEMBER_PAGE_SIZE });
    const total = Number(first?.total ?? first?.data?.pagination?.total ?? 0);
    const pages = Math.max(1, Math.ceil(total / MEMBER_PAGE_SIZE));
    const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, index) => fetchMembers({ page: index + 2, limit: MEMBER_PAGE_SIZE })));
    const rows = [first, ...rest].flatMap((response) => (Array.isArray(response?.data?.members) ? response.data.members : []));
    // A member added while the pages load can shift a row onto two pages; keep it once.
    const byId = new Map();
    for (const row of rows) if (row?.id && !byId.has(row.id)) byId.set(row.id, memberFromApiRow(row));
    state.members = [...byId.values()];
    return state.members;
}

function storeMember(mapped) {
    if (!mapped) return mapped;
    const index = state.members.findIndex((entry) => entry.id === mapped.id);
    if (index >= 0) state.members[index] = { ...state.members[index], ...mapped };
    else state.members.unshift(mapped);
    return state.members[index >= 0 ? index : 0];
}

export async function createMemberOnApi(member) {
    const response = await apiClient.post("/api/members", memberToApiPayload(member));
    return storeMember(memberFromApiRow(response?.data ?? null));
}

/** The server answers with the whole member, including fees, payments and current plan. */
export async function updateMemberOnApi(id, member) {
    const response = await apiClient.put(`/api/members/${id}`, memberToApiPayload(member));
    return storeMember(memberFromApiRow(response?.data ?? null));
}

/** Saves only the given database fields, e.g. { follow_up_status: "contacted" }. */
export async function updateMemberFieldsOnApi(id, fields) {
    const response = await apiClient.put(`/api/members/${id}`, fields);
    return storeMember(memberFromApiRow(response?.data ?? null));
}

/** Reloads one member (fees, payments, plan) from the database, e.g. after a payment or a new plan. */
export async function reloadMemberFromApi(id) {
    if (!UUID.test(String(id || ""))) return getMember(id) || null;
    const response = await apiClient.get(`/api/members/${id}`);
    return storeMember(memberFromApiRow(response?.data ?? null));
}

/** The member from memory, or from the database when they are not loaded yet. */
export async function ensureMember(id) {
    return getMember(id) || (UUID.test(String(id || "")) ? reloadMemberFromApi(id) : null);
}

/** Grants or withdraws WhatsApp consent; the server records it in the member's consent history. */
export async function setWhatsAppConsentOnApi(id, optIn, source = "staff_form") {
    const response = await apiClient.put(`/api/members/${id}/consent/whatsapp`, { opt_in: optIn, source });
    delete consentHistory[id];
    return storeMember(memberFromApiRow(response?.data ?? null));
}

// Consent history per member id: { status: "loading" | "ready" | "error", events, message }.
export const consentHistory = {};

export async function loadConsentHistory(id, onChange = () => {}) {
    consentHistory[id] = { status: "loading", events: consentHistory[id]?.events || [] };
    onChange();
    try {
        const response = await apiClient.get(`/api/members/${id}/consent-events`);
        consentHistory[id] = { status: "ready", events: Array.isArray(response?.data) ? response.data : [] };
    } catch (error) {
        consentHistory[id] = { status: "error", events: [], message: error.message || "Consent history could not be loaded." };
    }
    onChange();
}

export async function deleteMemberOnApi(id) {
    await apiClient.delete(`/api/members/${id}`);
    state.members = state.members.filter((member) => member.id !== id);
}

export function getPlan(planId) { return state.plans.find((plan) => plan.id === planId); }
export function getMember(memberId) { return state.members.find((member) => member.id === memberId); }
export function getMemberPayments(memberId) {
    return state.apiMemberPayments[memberId] || [];
}
export function memberBalance(member) {
    return Math.max(0, Number(member.totalFees || 0) - Number(member.paidTotal || 0));
}

// Keeps the database totals current after this browser records a payment, until the next reload.
export function addPaidAmount(memberId, amount) {
    const member = getMember(memberId);
    if (member) member.paidTotal = Number(member.paidTotal || 0) + Number(amount || 0);
}
