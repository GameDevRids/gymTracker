import { supabaseClient } from "../config/database.js";
import { getGymSettings } from "./gymSettingsService.js";
import { approvers } from "./holdsService.js";

const paymentColumns = "id,gym_id,member_id,membership_id,amount,method,paid_on,note,receipt_number,upi_reference,kind,refunded_at,status,voided_at,voided_by,void_reason,created_at";
const PAGE_SIZE = 1000;
const MISSING = ["PGRST202", "PGRST204", "PGRST205", "42883", "42703", "42P01"];

export class PaymentsServiceError extends Error {
    /** reason: a short code the app words its message by ("fully_paid", "over_balance", …); extra goes in the reply. */
    constructor(status, message, reason = "", extra = {}) {
        super(message);
        this.status = status;
        this.reason = reason;
        this.extra = extra;
    }
}

function requireClient(client) {
    if (!client) throw new PaymentsServiceError(503, "Supabase is not configured.");
}

function requireGym(gymId) {
    if (!gymId) throw new PaymentsServiceError(403, "Gym is required.");
}

const money = (value) => Math.round(Number(value || 0) * 100) / 100;
/** ₹1,000 / ₹1,250.50, Indian grouping. */
export function rupees(value) {
    const amount = money(value);
    return `₹${amount.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

function databaseError(error) {
    const text = `${error?.message || ""} ${error?.details || ""}`;
    if (error?.code === "P0001") {
        const reason = String(error.details || "").trim() || (/fully paid/i.test(text) ? "fully_paid" : /is due/i.test(text) ? "over_balance" : "");
        if (reason === "fully_paid") throw new PaymentsServiceError(409, "Already fully paid.", reason, { balance_due: 0 });
        if (reason === "over_balance") {
            const due = money(error.hint);
            throw new PaymentsServiceError(409, `Only ${rupees(due)} is due.`, reason, { balance_due: due });
        }
        if (reason === "membership_required") throw new PaymentsServiceError(400, "Choose the plan this payment is for.", reason);
        if (reason === "membership_cancelled") throw new PaymentsServiceError(409, "This plan was cancelled, so nothing is due on it.", reason);
        if (reason === "already_voided") throw new PaymentsServiceError(409, "This payment is already voided.", reason);
        if (reason === "refunded") throw new PaymentsServiceError(409, error.message, reason);
        throw new PaymentsServiceError(409, error.message || "This payment cannot be saved.", reason);
    }
    if (error?.code === "P0002" || error?.code === "23503") {
        throw new PaymentsServiceError(404, /Payment/.test(text) ? "Payment not found." : /Membership/i.test(text) ? "Membership not found for this member." : "Member or membership not found.", "not_found");
    }
    if (error?.code === "22023") {
        if (/reason/i.test(text)) throw new PaymentsServiceError(400, "Give a reason for voiding (3 to 300 characters).", "reason_required");
        throw new PaymentsServiceError(409, "This request was already used for another member. Close the form and try again.", "key_reused");
    }
    if (error?.code === "23505") {
        if (/upi_reference/.test(text)) {
            throw new PaymentsServiceError(409, "This UPI reference (UTR) is already recorded for another payment.", "utr_taken");
        }
        throw new PaymentsServiceError(409, "Another save for this member was in progress. Please try again.", "busy");
    }
    if (error?.code === "23514") throw new PaymentsServiceError(400, "Check the amount, and that a UPI reference is 12 digits on a UPI payment.", "invalid");
    if (MISSING.includes(error?.code)) {
        throw new PaymentsServiceError(503, "Payments need the latest database update. Run migration 025_payment_rules_and_void.sql in Supabase SQL Editor.", "unavailable");
    }
    throw new PaymentsServiceError(500, "The database could not complete the payment request.");
}

async function findMember(memberId, gymId, client, columns = "id") {
    const { data, error } = await client
        .from("members")
        .select(columns)
        .eq("id", memberId)
        .eq("gym_id", gymId)
        .is("archived_at", null)
        .maybeSingle();
    if (error) databaseError(error);
    if (!data) throw new PaymentsServiceError(404, "Member not found.", "not_found");
    return data;
}

const context = (value) => (typeof value === "string" || !value ? { gymId: value, userId: null } : value);
/** A payment that counts: not voided, and not a hold fee given back. */
export const counts = (payment) => (payment.status || "paid") === "paid" && !payment.refunded_at;

/**
 * Saves a payment through gympulse_record_payment (migration 025), in one transaction: the plan is
 * locked, the balance due checked (nothing due: "Already fully paid"; too much: "Only ₹X is due"),
 * and a repeated idempotency_key returns the first payment instead of saving another.
 * The database assigns the receipt number; any number sent is ignored.
 * Returns { payment, balance_due, replayed }.
 */
export async function createPayment(payment, ctx, client = supabaseClient) {
    const { gymId, userId } = context(ctx);
    requireClient(client);
    requireGym(gymId);
    if (!payment.idempotency_key) throw new PaymentsServiceError(400, "Refresh the app and try again (the request had no key).", "key_missing");
    if (!payment.membership_id) throw new PaymentsServiceError(400, "Choose the plan this payment is for.", "membership_required");
    const { data, error } = await client.rpc("gympulse_record_payment", {
        p_gym_id: gymId,
        p_member_id: payment.member_id,
        p_membership_id: payment.membership_id,
        p_amount: payment.amount,
        p_method: payment.method,
        p_paid_on: payment.paid_on,
        p_note: payment.note ?? null,
        p_upi_reference: payment.upi_reference ?? null,
        p_idempotency_key: payment.idempotency_key,
        p_recorded_by: userId || null
    });
    if (error) databaseError(error);
    if (!data?.payment) throw new PaymentsServiceError(500, "The database did not return the payment.");
    return { payment: data.payment, balance_due: data.balance_due === null || data.balance_due === undefined ? null : money(data.balance_due), replayed: data.replayed === true };
}

/** Voids a payment (owners only; the route checks). It stays, with its receipt number, marked voided. */
export async function voidPayment(paymentId, reason, ctx, client = supabaseClient) {
    const { gymId, userId } = context(ctx);
    requireClient(client);
    requireGym(gymId);
    const { data, error } = await client.rpc("gympulse_void_payment", {
        p_gym_id: gymId,
        p_payment_id: paymentId,
        p_reason: reason,
        p_by: userId || null
    });
    if (error) databaseError(error);
    if (!data?.payment) throw new PaymentsServiceError(500, "The database did not return the payment.");
    return { payment: (await withVoiders([data.payment], gymId, client))[0], balance_due: data.balance_due === null || data.balance_due === undefined ? null : money(data.balance_due) };
}

// Who voided each payment: their role in this gym and email, like the holds history.
async function withVoiders(rows, gymId, client) {
    const ids = [...new Set(rows.map((row) => row.voided_by).filter(Boolean))];
    if (!ids.length) return rows;
    const people = await approvers(ids, gymId, client).catch(() => new Map());
    return rows.map((row) => (row.voided_by ? { ...row, voided_by_name: people.get(row.voided_by) || null } : row));
}

export async function listMemberPayments(memberId, gymId, client = supabaseClient) {
    requireClient(client);
    requireGym(gymId);
    await findMember(memberId, gymId, client);

    const { data, error } = await client
        .from("payments")
        .select(paymentColumns)
        .eq("member_id", memberId)
        .eq("gym_id", gymId)
        .order("paid_on", { ascending: false })
        .order("created_at", { ascending: false });
    if (error) databaseError(error);
    return withVoiders(data || [], gymId, client);
}

function indiaMonthStart(now = new Date()) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    return `${today.slice(0, 7)}-01`;
}

/** This gym's payments, newest first, with member names, plus the total collected this month (voided and refunded left out). */
export async function listPayments({ page = 1, limit = 50 } = {}, gymId, client = supabaseClient, now = new Date()) {
    requireClient(client);
    requireGym(gymId);
    const from = (page - 1) * limit;
    const { data, count, error } = await client
        .from("payments")
        .select(paymentColumns, { count: "exact" })
        .eq("gym_id", gymId)
        .order("paid_on", { ascending: false })
        .order("created_at", { ascending: false })
        .range(from, from + limit - 1);
    if (error) databaseError(error);
    const rows = data || [];

    const memberIds = [...new Set(rows.map((row) => row.member_id))];
    let members = [];
    if (memberIds.length) {
        const result = await client.from("members").select("id,full_name,member_code").in("id", memberIds).eq("gym_id", gymId);
        if (result.error) databaseError(result.error);
        members = result.data || [];
    }
    const byId = new Map(members.map((member) => [member.id, member]));

    // PostgREST returns at most 1000 rows per request, so add up the month in pages.
    let monthTotal = 0;
    const monthStart = indiaMonthStart(now);
    for (let offset = 0; ; offset += PAGE_SIZE) {
        const result = await client
            .from("payments")
            .select("id,amount,status,refunded_at")
            .eq("gym_id", gymId)
            .is("refunded_at", null)
            .gte("paid_on", monthStart)
            .order("id", { ascending: true })
            .range(offset, offset + PAGE_SIZE - 1);
        if (result.error) databaseError(result.error);
        monthTotal += (result.data || []).filter(counts).reduce((sum, row) => sum + Number(row.amount || 0), 0);
        if (!result.data || result.data.length < PAGE_SIZE) break;
    }

    return {
        payments: (await withVoiders(rows, gymId, client)).map((row) => ({ ...row, member: byId.get(row.member_id) || null })),
        total: count ?? rows.length,
        monthTotal: money(monthTotal)
    };
}

function receiptSequence(receiptNumber) {
    const value = Number(String(receiptNumber || "").replace(/^R-/, ""));
    return Number.isFinite(value) ? value : 0;
}

/**
 * Everything a receipt shows, read from the database. The balance is as it stood just after
 * this payment, so a receipt shared again later still shows the same figures. Voided payments
 * never count towards it; a voided payment's own receipt is marked VOID and has no balance.
 */
export async function getReceipt(paymentId, gymId, client = supabaseClient) {
    requireClient(client);
    requireGym(gymId);
    const { data: found, error } = await client
        .from("payments")
        .select(paymentColumns)
        .eq("id", paymentId)
        .eq("gym_id", gymId)
        .maybeSingle();
    if (error) databaseError(error);
    if (!found) throw new PaymentsServiceError(404, "Payment not found.", "not_found");
    const [payment] = await withVoiders([found], gymId, client);
    const voided = (payment.status || "paid") === "voided";

    const { data: member, error: memberError } = await client
        .from("members")
        .select("id,full_name,member_code,phone,whatsapp_opt_in")
        .eq("id", payment.member_id)
        .eq("gym_id", gymId)
        .maybeSingle();
    if (memberError) databaseError(memberError);

    let membership = null;
    let paidToDate = null;
    if (payment.membership_id) {
        const [membershipResult, paymentsResult] = await Promise.all([
            client.from("member_memberships")
                .select("id,plan_name,start_date,end_date,price,total_fees,grace_days")
                .eq("id", payment.membership_id)
                .eq("gym_id", gymId)
                .maybeSingle(),
            client.from("payments")
                .select("id,amount,receipt_number,status")
                .eq("membership_id", payment.membership_id)
                .eq("gym_id", gymId)
                .eq("kind", "plan")
        ]);
        if (membershipResult.error) databaseError(membershipResult.error);
        if (paymentsResult.error) databaseError(paymentsResult.error);
        membership = membershipResult.data || null;
        const upTo = receiptSequence(payment.receipt_number);
        paidToDate = (paymentsResult.data || [])
            .filter((row) => (row.status || "paid") === "paid" && receiptSequence(row.receipt_number) <= upTo)
            .reduce((sum, row) => sum + Number(row.amount || 0), 0);
    }
    // A hold fee is not part of the plan's fee: its receipt shows no fee, balance or paid-to-date.
    // A voided payment's receipt shows none either: it no longer counts.
    if (payment.kind === "hold_fee" || voided) paidToDate = null;
    const rawFee = membership && payment.kind !== "hold_fee" && !voided ? membership.total_fees ?? membership.price : null;
    const fee = rawFee === null || rawFee === undefined ? null : Number(rawFee);
    const gym = await getGymSettings(gymId, client).catch(() => null);

    return {
        payment,
        voided,
        member: member || null,
        membership,
        fee,
        paid_to_date: paidToDate === null ? null : money(paidToDate),
        balance: fee === null || paidToDate === null ? null : Math.max(0, money(fee - paidToDate)),
        gym: { name: gym?.name || "", phone: gym?.phone || null, address: gym?.address || null }
    };
}
