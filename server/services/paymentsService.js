import { supabaseClient } from "../config/database.js";

const paymentColumns = "id,gym_id,member_id,membership_id,amount,method,paid_on,note,created_at";

export class PaymentsServiceError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function requireClient(client) {
    if (!client) throw new PaymentsServiceError(503, "Supabase is not configured.");
}

function databaseError(error) {
    if (error?.code === "23503") throw new PaymentsServiceError(404, "Member or membership not found.");
    if (["PGRST204", "PGRST205", "42703", "42P01"].includes(error?.code)) {
        throw new PaymentsServiceError(503, "Payments are unavailable. Run migration 006_create_payments.sql in Supabase SQL Editor.");
    }
    throw new PaymentsServiceError(500, "The database could not complete the payment request.");
}

export async function createPayment(payment, gymId, client = supabaseClient) {
    requireClient(client);
    if (!gymId) throw new PaymentsServiceError(403, "Gym is required.");
    const { data: member, error: memberError } = await client
        .from("members")
        .select("id")
        .eq("id", payment.member_id)
        .eq("gym_id", gymId)
        .is("archived_at", null)
        .maybeSingle();
    if (memberError) databaseError(memberError);
    if (!member) throw new PaymentsServiceError(404, "Member not found.");

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

    const { data, error } = await client
        .from("payments")
        .insert({ ...payment, gym_id: gymId })
        .select(paymentColumns)
        .single();
    if (error) databaseError(error);
    return data;
}

export async function listMemberPayments(memberId, gymId, client = supabaseClient) {
    requireClient(client);
    if (!gymId) throw new PaymentsServiceError(403, "Gym is required.");
    const { data: member, error: memberError } = await client
        .from("members")
        .select("id")
        .eq("id", memberId)
        .eq("gym_id", gymId)
        .is("archived_at", null)
        .maybeSingle();
    if (memberError) databaseError(memberError);
    if (!member) throw new PaymentsServiceError(404, "Member not found.");

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
