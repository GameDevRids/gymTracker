import { supabaseClient } from "../config/database.js";
import { getGymSettings } from "./gymSettingsService.js";

const paymentColumns = "id,gym_id,member_id,membership_id,amount,method,paid_on,note,receipt_number,upi_reference,created_at";
const PAGE_SIZE = 1000;

export class PaymentsServiceError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function requireClient(client) {
    if (!client) throw new PaymentsServiceError(503, "Supabase is not configured.");
}

function requireGym(gymId) {
    if (!gymId) throw new PaymentsServiceError(403, "Gym is required.");
}

function databaseError(error) {
    if (error?.code === "23503") throw new PaymentsServiceError(404, "Member or membership not found.");
    if (error?.code === "23505") {
        if (/upi_reference/.test(`${error.message} ${error.details || ""}`)) {
            throw new PaymentsServiceError(409, "This UPI reference (UTR) is already recorded for another payment.");
        }
        throw new PaymentsServiceError(409, "The receipt number was taken by another save. Please try again.");
    }
    if (error?.code === "23514") throw new PaymentsServiceError(400, "Check the amount, and that a UPI reference is 12 digits on a UPI payment.");
    if (["PGRST204", "PGRST205", "42703", "42P01"].includes(error?.code)) {
        throw new PaymentsServiceError(503, "Payments are unavailable. Run migrations 006_create_payments.sql and 011_add_upi_and_receipts.sql in Supabase SQL Editor.");
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
    if (!data) throw new PaymentsServiceError(404, "Member not found.");
    return data;
}

/** Saves a payment. The database assigns the receipt number; any number sent is ignored. */
export async function createPayment(payment, gymId, client = supabaseClient) {
    requireClient(client);
    requireGym(gymId);
    await findMember(payment.member_id, gymId, client);

    if (payment.membership_id) {
        const { data: membership, error } = await client
            .from("member_memberships")
            .select("id")
            .eq("id", payment.membership_id)
            .eq("member_id", payment.member_id)
            .eq("gym_id", gymId)
            .maybeSingle();
        if (error) databaseError(error);
        if (!membership) throw new PaymentsServiceError(404, "Membership not found for this member.");
    }

    const { receipt_number: _ignored, ...fields } = payment;
    const { data, error } = await client
        .from("payments")
        .insert({ ...fields, gym_id: gymId })
        .select(paymentColumns)
        .single();
    if (error) databaseError(error);
    return data;
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
    return data || [];
}

function indiaMonthStart(now = new Date()) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    return `${today.slice(0, 7)}-01`;
}

/** This gym's payments, newest first, with member names, plus the total collected this month. */
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
            .select("id,amount")
            .eq("gym_id", gymId)
            .gte("paid_on", monthStart)
            .order("id", { ascending: true })
            .range(offset, offset + PAGE_SIZE - 1);
        if (result.error) databaseError(result.error);
        monthTotal += (result.data || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
        if (!result.data || result.data.length < PAGE_SIZE) break;
    }

    return {
        payments: rows.map((row) => ({ ...row, member: byId.get(row.member_id) || null })),
        total: count ?? rows.length,
        monthTotal: Math.round(monthTotal * 100) / 100
    };
}

function receiptSequence(receiptNumber) {
    const value = Number(String(receiptNumber || "").replace(/^R-/, ""));
    return Number.isFinite(value) ? value : 0;
}

/**
 * Everything a receipt shows, read from the database. The balance is as it stood just after
 * this payment, so a receipt shared again later still shows the same figures.
 */
export async function getReceipt(paymentId, gymId, client = supabaseClient) {
    requireClient(client);
    requireGym(gymId);
    const { data: payment, error } = await client
        .from("payments")
        .select(paymentColumns)
        .eq("id", paymentId)
        .eq("gym_id", gymId)
        .maybeSingle();
    if (error) databaseError(error);
    if (!payment) throw new PaymentsServiceError(404, "Payment not found.");

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
                .select("id,plan_name,start_date,end_date,price,total_fees")
                .eq("id", payment.membership_id)
                .eq("gym_id", gymId)
                .maybeSingle(),
            client.from("payments")
                .select("id,amount,receipt_number")
                .eq("membership_id", payment.membership_id)
                .eq("gym_id", gymId)
        ]);
        if (membershipResult.error) databaseError(membershipResult.error);
        if (paymentsResult.error) databaseError(paymentsResult.error);
        membership = membershipResult.data || null;
        const upTo = receiptSequence(payment.receipt_number);
        paidToDate = (paymentsResult.data || [])
            .filter((row) => receiptSequence(row.receipt_number) <= upTo)
            .reduce((sum, row) => sum + Number(row.amount || 0), 0);
    }
    const rawFee = membership ? membership.total_fees ?? membership.price : null;
    const fee = rawFee === null || rawFee === undefined ? null : Number(rawFee);
    const gym = await getGymSettings(gymId, client).catch(() => null);

    return {
        payment,
        member: member || null,
        membership,
        fee,
        paid_to_date: paidToDate === null ? null : Math.round(paidToDate * 100) / 100,
        balance: fee === null || paidToDate === null ? null : Math.max(0, Math.round((fee - paidToDate) * 100) / 100),
        gym: { name: gym?.name || "", phone: gym?.phone || null, address: gym?.address || null }
    };
}
