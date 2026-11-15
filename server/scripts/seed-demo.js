import "dotenv/config";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";

const demoNames = [
    "Aarav Sharma", "Ananya Iyer", "Vivaan Patel", "Diya Nair", "Aditya Rao",
    "Isha Kulkarni", "Arjun Mehta", "Saanvi Joshi", "Reyansh Shah", "Aadhya Deshmukh",
    "Krishna Reddy", "Myra Kapoor", "Ishaan Verma", "Sara Fernandes", "Atharv Singh",
    "Kiara Menon", "Kabir Chawla", "Anvi Gupta", "Rohan Shetty", "Pari Bansal",
    "Dev Malhotra", "Aanya Mishra", "Neil Thomas", "Tara Jadhav", "Yash Agarwal",
    "Mira Sinha", "Ritvik Das", "Nisha Pillai", "Omkar Pawar", "Zara Khan",
    "Samar Banerjee", "Avni Rao", "Kunal Arora", "Rhea D'Souza", "Dhruv Jain",
    "Meera Subramanian", "Ayaan Ghosh", "Pooja Naik", "Siddharth Bose", "Ira Chavan"
];
const planSpecs = [
    { name: "Monthly Strength", duration_days: 30, price: 1800 },
    { name: "Quarterly Fitness", duration_days: 90, price: 4800 },
    { name: "Half-Year Training", duration_days: 180, price: 8500 },
    { name: "Annual Wellness", duration_days: 365, price: 15000 }
];
const expiryOffsets = [-32, -14, -5, -2, 0, 2, 4, 6, 9, 20];

export function assertSeedAllowed(environment = process.env) {
    if (environment.NODE_ENV === "production" && environment.ALLOW_SEED !== "true") {
        throw new Error("Refusing to seed in production. Set ALLOW_SEED=true only for the intended demo project.");
    }
    if (environment.ALLOW_SEED !== "true") {
        throw new Error("Refusing destructive demo seeding. Set ALLOW_SEED=true to confirm the target is disposable.");
    }
    if (!environment.DEMO_SUPABASE_URL || !environment.DEMO_SUPABASE_SERVICE_ROLE_KEY || !environment.DEMO_GYM_ID) {
        throw new Error("Set DEMO_SUPABASE_URL, DEMO_SUPABASE_SERVICE_ROLE_KEY, and DEMO_GYM_ID for the disposable demo project.");
    }
}

function isoDate(date) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(date);
}

function shiftDate(date, offset) {
    const shifted = new Date(`${date}T00:00:00.000Z`);
    shifted.setUTCDate(shifted.getUTCDate() + offset);
    return shifted.toISOString().slice(0, 10);
}

async function clearDemo(client, gymId) {
    // Visitors leave check-ins, linked phones, WhatsApp logs and consent history, which ordinary
    // deletes refuse; this database function (migration 018) empties the demo gym in one go and
    // restarts its receipt numbers. The gym, its settings and sign-in accounts stay.
    const { error } = await client.rpc("gympulse_reset_demo_gym", { p_gym_id: gymId, p_confirm: `RESET DEMO ${gymId}` });
    if (error) throw new Error(`Could not clear the demo gym (run migration 018 in the demo project): ${error.message}`);
}

// Check-ins over the last 30 days for members whose plan is current, so the Overview, Visits and
// Retention pages have something to show. Times are in the morning and evening, India time.
export function demoVisits(members, today) {
    const visits = [];
    members.forEach(({ id, startDate, endDate }, index) => {
        if (index % 7 === 3) return; // a few members have not been in lately
        for (let daysAgo = 0; daysAgo < 30; daysAgo += 1) {
            if ((index + daysAgo) % (2 + (index % 3)) !== 0) continue;
            const day = shiftDate(today, -daysAgo);
            if (day < startDate || day > endDate) continue;
            const hour = (index + daysAgo) % 2 ? 6 + (index % 3) : 18 + (index % 3);
            visits.push({ member_id: id, checked_in_at: `${day}T${String(hour).padStart(2, "0")}:${String((index * 7) % 60).padStart(2, "0")}:00+05:30` });
        }
    });
    return visits;
}

async function seedDemo(client) {
    const gymId = process.env.DEMO_GYM_ID;
    await clearDemo(client, gymId);
    const today = isoDate(new Date());
    const { data: plans, error: planError } = await client
        .from("membership_plans")
        .insert(planSpecs.map((plan) => ({ ...plan, gym_id: gymId, is_active: true })))
        .select("id,name,duration_days,price");
    if (planError) throw new Error(`Could not create demo plans: ${planError.message}`);

    const payments = [];
    const seeded = [];
    for (let index = 0; index < demoNames.length; index += 1) {
        const plan = plans[index % plans.length];
        const endDate = shiftDate(today, expiryOffsets[index % expiryOffsets.length]);
        const startDate = shiftDate(endDate, -(plan.duration_days - 1));
        const memberCode = `DEMO-${String(index + 1).padStart(3, "0")}`;
        const phone = String(9000000000 + index + 1);
        const { data: member, error: memberError } = await client
            .from("members")
            .insert({
                gym_id: gymId,
                member_code: memberCode,
                full_name: demoNames[index],
                phone,
                email: `member${index + 1}@example.test`,
                gender: index % 2 ? "female" : "male",
                membership_start_date: startDate,
                membership_end_date: endDate,
                status: "active",
                notes: "Fictional demo member"
            })
            .select("id")
            .single();
        if (memberError) throw new Error(`Could not create demo member ${memberCode}: ${memberError.message}`);

        const { data: membership, error: membershipError } = await client
            .from("member_memberships")
            .insert({
                gym_id: gymId,
                member_id: member.id,
                plan_id: plan.id,
                plan_name: plan.name,
                duration_days: plan.duration_days,
                price: plan.price,
                total_fees: plan.price,
                start_date: startDate,
                end_date: endDate,
                status: "assigned"
            })
            .select("id")
            .single();
        if (membershipError) throw new Error(`Could not create membership for ${memberCode}: ${membershipError.message}`);
        seeded.push({ id: member.id, startDate, endDate });

        if (index % 4 !== 0) {
            payments.push({
                gym_id: gymId,
                member_id: member.id,
                membership_id: membership.id,
                amount: index % 3 === 0 ? Math.round(plan.price / 2) : plan.price,
                method: ["cash", "upi", "card", "other"][index % 4],
                paid_on: shiftDate(today, -(index % 26)),
                note: "Fictional demo payment"
            });
        }
    }
    const { error: paymentError } = await client.from("payments").insert(payments);
    if (paymentError) throw new Error(`Could not create demo payments: ${paymentError.message}`);

    const visits = demoVisits(seeded, today).map((visit) => ({ ...visit, gym_id: gymId, method: "manual", membership_status_at_check_in: "active" }));
    const { error: visitError } = await client.from("attendance").insert(visits);
    if (visitError) throw new Error(`Could not create demo check-ins: ${visitError.message}`);
    return { members: seeded.length, payments: payments.length, visits: visits.length };
}

async function main() {
    assertSeedAllowed();
    const client = createClient(process.env.DEMO_SUPABASE_URL, process.env.DEMO_SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false }
    });
    const counts = await seedDemo(client);
    console.log(`Demo gym filled with ${counts.members} fictional members, 4 plans, ${counts.payments} payments and ${counts.visits} check-ins.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message || "Demo seeding failed.");
        process.exitCode = 1;
    });
}
