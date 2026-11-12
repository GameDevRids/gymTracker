// A small in-memory stand-in for the Supabase client, enough for the check-in services:
// eq/is/in/gte/lte/like/or filters, insert/update/upsert/delete, and the unique rules that
// matter (one check-in per member per IST day, one link per member per phone).
import { randomUUID } from "node:crypto";
import { indiaDate } from "../../../assets/js/checkin.js";

export const gymA = "00000000-0000-4000-8000-0000000000a1";
export const gymB = "00000000-0000-4000-8000-0000000000b1";
export const owner = "00000000-0000-4000-8000-00000000000a";
export const ids = {
    riya: "00000000-0000-4000-8000-000000000001",
    dev: "00000000-0000-4000-8000-000000000002",
    aisha: "00000000-0000-4000-8000-000000000003",
    neha: "00000000-0000-4000-8000-000000000004",
    kabir: "00000000-0000-4000-8000-000000000005",
    meera: "00000000-0000-4000-8000-000000000006"
};

function likeRegex(pattern, flags = "") {
    const source = pattern.split("%").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp(`^${source}$`, flags);
}

// "full_name.ilike."%x%",member_code.ilike."%x%"" -> [[field, op, value], ...]
function parseOr(text) {
    const parts = [];
    const pattern = /([a-z_0-9]+)\.(ilike|like|eq)\.("(?:[^"\\]|\\.)*"|[^,]*)/g;
    let match;
    while ((match = pattern.exec(text))) {
        let value = match[3];
        if (value.startsWith('"')) value = value.slice(1, -1).replace(/\\(.)/g, "$1");
        parts.push([match[1], match[2], value]);
    }
    return parts;
}

function test(row, [method, field, value]) {
    const cell = row[field];
    if (method === "eq") return cell === value;
    if (method === "is") return (cell ?? null) === value;
    if (method === "in") return value.includes(cell);
    if (method === "gte") return cell >= value;
    if (method === "lte") return cell <= value;
    if (method === "like") return typeof cell === "string" && likeRegex(value).test(cell);
    if (method === "ilike") return typeof cell === "string" && likeRegex(value, "i").test(cell);
    if (method === "or") return parseOr(value).some(([orField, op, orValue]) => test(row, [op, orField, orValue]));
    throw new Error(`fake db: unsupported filter ${method}`);
}

const phoneDigits = (phone) => String(phone || "").replace(/\D/g, "");

export function fakeCheckinDb({ gyms = {}, members, memberships, plans } = {}) {
    const gymRow = (id, name, values = {}) => ({
        id,
        name,
        checkin_method: "member_qr",
        expired_checkin_policy: "warn",
        expiry_grace_days: 0,
        entrance_token: randomUUID().replace(/-/g, "") + "posterAB",
        entrance_require_location: false,
        latitude: null,
        longitude: null,
        location_radius_m: 150,
        ...values
    });
    const member = (id, gymId, fullName, code, phone, extra = {}) => ({
        id, gym_id: gymId, full_name: fullName, member_code: code, phone, whatsapp_opt_in: false, qr_token: `qr${id.replace(/-/g, "")}token`, archived_at: null, ...extra
    });
    const tables = {
        gyms: [gymRow(gymA, "Power Gym", gyms.a), gymRow(gymB, "Iron Den", gyms.b)],
        gym_settings: [{ gym_id: gymA, upi_id: "powergym@okicici", upi_payee_name: "Power Gym" }],
        members: members || [
            member(ids.riya, gymA, "Riya Shah", "GP-1", "9876543210", { whatsapp_opt_in: true }),
            member(ids.dev, gymA, "Dev Rao", "GP-2", "9876543211"),
            member(ids.neha, gymA, "Neha Joshi", "GP-4", "9876543213"),
            member(ids.aisha, gymB, "Aisha Khan", "GP-3", "9876543212", { whatsapp_opt_in: true }),
            // A family: Kabir and Meera share their mother's number.
            member(ids.kabir, gymA, "Kabir Mehta", "GP-5", "9123403210"),
            member(ids.meera, gymA, "Meera Mehta", "GP-6", "9123403210")
        ],
        member_memberships: memberships || [
            { id: "ms-riya", gym_id: gymA, member_id: ids.riya, plan_id: "plan-monthly", plan_name: "Monthly", price: 1100, start_date: "2026-11-01", end_date: "2026-11-30", status: "assigned", created_at: "2026-11-01" },
            { id: "ms-dev", gym_id: gymA, member_id: ids.dev, plan_id: "plan-monthly", plan_name: "Monthly", price: 1100, start_date: "2026-10-01", end_date: "2026-11-09", status: "assigned", created_at: "2026-10-01" },
            { id: "ms-aisha", gym_id: gymB, member_id: ids.aisha, plan_id: null, plan_name: "Annual", price: 9000, start_date: "2026-01-01", end_date: "2026-12-31", status: "assigned", created_at: "2026-01-01" },
            { id: "ms-kabir", gym_id: gymA, member_id: ids.kabir, plan_id: "plan-monthly", plan_name: "Monthly", price: 1100, start_date: "2026-11-01", end_date: "2026-11-30", status: "assigned", created_at: "2026-11-01" },
            { id: "ms-meera", gym_id: gymA, member_id: ids.meera, plan_id: "plan-monthly", plan_name: "Monthly", price: 1100, start_date: "2026-11-01", end_date: "2026-11-30", status: "assigned", created_at: "2026-11-01" }
        ],
        membership_plans: plans || [{ id: "plan-monthly", gym_id: gymA, price: 1200, is_active: true }],
        attendance: [],
        member_devices: []
    };
    // Generated columns, as in migration 013.
    for (const row of tables.members) {
        row.phone_last10 = phoneDigits(row.phone).slice(-10);
        row.phone_last4 = phoneDigits(row.phone).slice(-4);
    }
    const calls = [];
    const prepare = {
        attendance: (row) => ({ id: `att-${tables.attendance.length + 1}`, created_at: new Date().toISOString(), member_device_id: null, ...row, check_in_date: indiaDate(new Date(row.checked_in_at)) }),
        member_devices: (row) => ({ id: randomUUID(), created_at: new Date().toISOString(), approved_at: null, approved_by: null, revoked_at: null, revoked_by: null, last_used_at: null, device_label: null, ...row })
    };
    const conflicts = {
        attendance: (row) => tables.attendance.some((saved) => saved.gym_id === row.gym_id && saved.member_id === row.member_id && saved.check_in_date === row.check_in_date),
        member_devices: (row) => tables.member_devices.some((saved) => saved.gym_id === row.gym_id && saved.member_id === row.member_id && saved.device_secret_hash === row.device_secret_hash)
    };
    return {
        tables,
        calls,
        from(table) {
            const op = { table, filters: [], action: "select", payload: null };
            calls.push(op);
            const query = {};
            query.select = () => query;
            for (const method of ["eq", "is", "in", "gte", "lte", "like", "ilike"]) query[method] = (field, value) => { op.filters.push([method, field, value]); return query; };
            query.or = (text) => { op.filters.push(["or", null, text]); return query; };
            query.order = () => query;
            query.range = () => query;
            query.limit = () => query;
            query.insert = (row) => { op.action = "insert"; op.payload = row; return query; };
            query.update = (row) => { op.action = "update"; op.payload = row; return query; };
            query.upsert = (rows) => { op.action = "upsert"; op.payload = rows; return query; };
            query.delete = () => { op.action = "delete"; return query; };
            const matches = (row) => op.filters.every((filter) => test(row, filter));
            const run = () => {
                const list = tables[table];
                if (!list) return { data: null, error: { code: "42P01" } };
                if (op.action === "insert" || op.action === "upsert") {
                    const rows = Array.isArray(op.payload) ? op.payload : [op.payload];
                    const inserted = [];
                    for (const raw of rows) {
                        const row = (prepare[table] || ((value) => value))(raw);
                        if (conflicts[table]?.(row)) {
                            if (op.action === "upsert") continue;
                            return { data: null, error: { code: "23505" } };
                        }
                        list.push(row);
                        inserted.push(row);
                    }
                    return { data: inserted, error: null };
                }
                if (op.action === "update") {
                    const hits = list.filter(matches);
                    hits.forEach((row) => Object.assign(row, op.payload));
                    return { data: hits, error: null };
                }
                if (op.action === "delete") {
                    const hits = list.filter(matches);
                    tables[table] = list.filter((row) => !hits.includes(row));
                    return { data: hits, error: null };
                }
                return { data: list.filter(matches).map((row) => ({ ...row })), error: null };
            };
            query.single = () => { const result = run(); return Promise.resolve(result.error ? result : { data: result.data[0], error: null }); };
            query.maybeSingle = () => { const result = run(); return Promise.resolve({ data: result.data?.[0] || null, error: result.error }); };
            query.then = (resolve, reject) => Promise.resolve(run()).then(resolve, reject);
            return query;
        }
    };
}
