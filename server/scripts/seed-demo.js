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
    // Payments cannot be deleted directly (receipt numbers must stay complete); this database
    // function empties the demo gym's payments and restarts its receipt numbers.
    const { error: paymentsError } = await client.rpc("gympulse_reset_demo_payments", { p_gym_id: gymId });
    if (paymentsError) throw new Error(`Could not clear demo payments: ${paymentsError.message}`);
    for (const table of ["member_memberships", "members", "membership_plans"]) {
        const { error } = await client.from(table).delete().eq("gym_id", gymId);
        if (error) throw new Error(`Could not clear demo ${table}: ${error.message}`);
    }
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
                start_date: startDate,
                end_date: endDate,
                status: "assigned"
            })
            .select("id")
            .single();
        if (membershipError) throw new Error(`Could not create membership for ${memberCode}: ${membershipError.message}`);

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
}

async function main() {
    assertSeedAllowed();
    const client = createClient(process.env.DEMO_SUPABASE_URL, process.env.DEMO_SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false }
    });
    await seedDemo(client);
    console.log("Demo project seeded with 40 fictional members, 4 plans, memberships, and payments.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message || "Demo seeding failed.");
        process.exitCode = 1;
    });
}
