import { deflateRawSync } from "node:zlib";
import { supabaseClient } from "../config/database.js";
import { writeXlsx } from "../../assets/js/spreadsheet.js";
import { memberBilling } from "./membersService.js";
import { selectCurrentMembership } from "./membershipsService.js";

// "Download all data": one Excel workbook with the gym's members (archived ones too, marked),
// every plan they have had, every payment and every check-in. Read straight from the database,
// so it is complete whatever the browser has loaded.

export class ExportError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const PAGE = 1000;

async function readAll(client, table, columns, gymId, order) {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
        let query = client.from(table).select(columns).eq("gym_id", gymId);
        for (const column of order) query = query.order(column, { ascending: true });
        const { data, error } = await query.range(from, from + PAGE - 1);
        if (error) {
            if (["PGRST205", "42P01", "PGRST204", "42703"].includes(error.code)) {
                throw new ExportError(503, "Some of the gym's data could not be read. Run the latest migrations in Supabase SQL Editor.");
            }
            throw new ExportError(500, "The database could not read the gym's data.");
        }
        rows.push(...(data || []));
        if (!data || data.length < PAGE) return rows;
    }
}

const ENQUIRY_SOURCE_NAMES = { walk_in: "Walk-in", instagram: "Instagram", friend: "Friend", other: "Other" };
const ENQUIRY_STAGE_NAMES = { new: "New", contacted: "Contacted", joined: "Joined", not_interested: "Not interested" };
const date = (value) => (/^\d{4}-\d{2}-\d{2}/.test(String(value || "")) ? { date: String(value).slice(0, 10) } : "");
const money = (value) => Math.round(Number(value || 0) * 100) / 100;
const yesNo = (value) => (value ? "Yes" : "No");
const indiaDate = (value) => (value ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(value)) : "");
const indiaTime = (value) => (value ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value)) : "");
const METHODS = { upi: "UPI", cash: "Cash", card: "Card", other: "Other" };
const CHECKIN_METHODS = { member_qr: "QR card", qr: "QR card", entrance_poster: "Poster", manual: "Manual" };

export async function buildGymWorkbook(gymId, client = supabaseClient, today = indiaDate(new Date())) {
    if (!client) throw new ExportError(503, "Supabase is not configured.");
    if (!gymId) throw new ExportError(403, "Gym is required.");
    // Enquiries (migration 024): before that migration there are none to include.
    const enquiries = await readAll(client, "enquiries", "full_name,phone,interest_plan_id,interest_text,source,note,stage,follow_up_on,last_contacted_at,whatsapp_consent,whatsapp_consent_at,joined_member_id,created_at", gymId, ["created_at"]).catch(() => []);
    const plansById = new Map(((await client.from("membership_plans").select("id,name").eq("gym_id", gymId)).data || []).map((plan) => [plan.id, plan.name]));
    const [members, memberships, payments, attendance] = await Promise.all([
        readAll(client, "members", "id,member_code,full_name,phone,email,gender,date_of_birth,status,notes,emergency_contact,follow_up_status,whatsapp_opt_in,created_at,archived_at", gymId, ["created_at", "id"]),
        readAll(client, "member_memberships", "id,member_id,plan_name,duration_days,price,total_fees,start_date,end_date,status,created_at", gymId, ["start_date", "id"]),
        readAll(client, "payments", "id,member_id,receipt_number,amount,method,paid_on,upi_reference,note,kind,refunded_at,status,voided_at,void_reason,created_at", gymId, ["paid_on", "id"]),
        readAll(client, "attendance", "id,member_id,checked_in_at,check_in_date,method,membership_status_at_check_in", gymId, ["checked_in_at", "id"])
    ]);
    const byId = new Map(members.map((member) => [member.id, member]));
    const plansByMember = new Map();
    for (const membership of memberships) {
        const list = plansByMember.get(membership.member_id) || [];
        list.push(membership);
        plansByMember.set(membership.member_id, list);
    }
    const paymentsByMember = new Map();
    for (const payment of payments) {
        const list = paymentsByMember.get(payment.member_id) || [];
        list.push(payment);
        paymentsByMember.set(payment.member_id, list);
    }
    const code = (memberId) => byId.get(memberId)?.member_code || "";
    const name = (memberId) => byId.get(memberId)?.full_name || "";
    const effective = (membership) => (membership.status === "cancelled" ? "Cancelled"
        : membership.start_date > today ? "Upcoming" : membership.end_date < today ? "Expired" : "Active");

    const memberRows = members.map((member) => {
        const history = plansByMember.get(member.id) || [];
        const current = selectCurrentMembership(history, today);
        const billing = memberBilling(history, paymentsByMember.get(member.id) || []);
        return [
            member.member_code, member.full_name, member.phone, member.email || "",
            member.status === "suspended" ? "Suspended" : "Active",
            current?.plan_name || "", date(current?.start_date), date(current?.end_date), current ? effective(current) : "No plan",
            money(billing.billed), money(billing.paid), money(billing.outstanding),
            yesNo(member.whatsapp_opt_in), date(indiaDate(member.created_at)), member.archived_at ? date(indiaDate(member.archived_at)) : "",
            member.gender || "", date(member.date_of_birth), member.emergency_contact || "", member.follow_up_status || "", member.notes || ""
        ];
    });
    const membershipRows = memberships.map((membership) => [
        code(membership.member_id), name(membership.member_id), membership.plan_name, date(membership.start_date), date(membership.end_date),
        Number(membership.duration_days), money(membership.price), money(membership.total_fees ?? membership.price), effective(membership),
        date(indiaDate(membership.created_at))
    ]);
    // Voided payments are listed (receipt numbers stay complete) but marked, and are not in any balance.
    const paymentRows = payments.map((payment) => [
        payment.receipt_number || "", date(payment.paid_on), code(payment.member_id), name(payment.member_id),
        money(payment.amount), METHODS[payment.method] || payment.method,
        payment.status === "voided" ? "Voided" : payment.refunded_at ? "Refunded" : "Paid",
        payment.kind === "hold_fee" ? "Plan hold fee" : "Plan",
        payment.status === "voided" ? `${date(indiaDate(payment.voided_at))}: ${payment.void_reason || ""}` : "",
        payment.upi_reference || "", payment.note || ""
    ]);
    const attendanceRows = attendance.map((visit) => [
        date(visit.check_in_date || indiaDate(visit.checked_in_at)), indiaTime(visit.checked_in_at), code(visit.member_id), name(visit.member_id),
        CHECKIN_METHODS[visit.method] || visit.method, visit.membership_status_at_check_in || ""
    ]);

    return writeXlsx([
        { name: "Members", rows: [["Member code", "Name", "Phone", "Email", "Account", "Current plan", "Plan start", "Plan end", "Plan status", "Total fees (₹)", "Paid (₹)", "Balance (₹)", "WhatsApp consent", "Joined", "Archived on", "Gender", "Date of birth", "Emergency contact", "Follow-up", "Notes"], ...memberRows], widths: [17, 24, 13, 24, 10, 18, 12, 12, 11, 13, 11, 12, 10, 12, 12, 10, 13, 16, 12, 30] },
        { name: "Memberships", rows: [["Member code", "Name", "Plan", "Start", "End", "Days", "Plan price (₹)", "Fee (₹)", "Status", "Added on"], ...membershipRows], widths: [17, 24, 18, 12, 12, 7, 13, 11, 11, 12] },
        { name: "Payments", rows: [["Receipt", "Paid on", "Member code", "Name", "Amount (₹)", "Method", "Status", "For", "Voided", "UPI reference (UTR)", "Note"], ...paymentRows], widths: [11, 12, 17, 24, 12, 9, 10, 13, 28, 16, 30] },
        { name: "Attendance", rows: [["Date", "Time (India)", "Member code", "Name", "Method", "Membership at check-in"], ...attendanceRows], widths: [12, 11, 17, 24, 10, 18] },
        { name: "Enquiries", rows: [["Enquired on", "Name", "Phone", "Interested in", "Source", "Stage", "Follow-up", "Last contacted", "WhatsApp consent", "Joined as member", "Note"], ...enquiries.map((enquiry) => [
            date(indiaDate(enquiry.created_at)), enquiry.full_name, enquiry.phone,
            enquiry.interest_plan_id ? plansById.get(enquiry.interest_plan_id) || "" : enquiry.interest_text || "Not sure",
            ENQUIRY_SOURCE_NAMES[enquiry.source] || enquiry.source, ENQUIRY_STAGE_NAMES[enquiry.stage] || enquiry.stage,
            date(enquiry.follow_up_on), enquiry.last_contacted_at ? date(indiaDate(enquiry.last_contacted_at)) : "",
            enquiry.whatsapp_consent ? `Yes, ${indiaDate(enquiry.whatsapp_consent_at)}` : "No",
            enquiry.joined_member_id ? code(enquiry.joined_member_id) || "Yes" : "", enquiry.note || ""
        ])], widths: [12, 24, 15, 18, 11, 14, 12, 14, 18, 16, 30] }
    ], { deflateRaw: (bytes) => new Uint8Array(deflateRawSync(bytes)) });
}
