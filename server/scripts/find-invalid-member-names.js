// Read-only: lists members whose stored name is empty, looks like an email, or is not made of letters.
// Usage: npm run check:member-names
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { memberNameProblem } from "../middleware/validateMember.js";

const PAGE_SIZE = 1000;

async function main() {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in server/.env.");
    }
    const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
    });
    const members = [];
    for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await client
            .from("members")
            .select("id,gym_id,member_code,full_name,archived_at,created_at,gyms(name)")
            .order("created_at", { ascending: true })
            .order("id", { ascending: true })
            .range(from, from + PAGE_SIZE - 1);
        if (error) throw new Error(`Could not read members: ${error.message}`);
        members.push(...data);
        if (data.length < PAGE_SIZE) break;
    }
    const invalid = members
        .map((member) => ({ ...member, problem: memberNameProblem(member.full_name ?? "") }))
        .filter((member) => member.problem);
    console.log(`Checked ${members.length} members; ${invalid.length} need a new name.`);
    for (const member of invalid) {
        console.log([
            member.gyms?.name || member.gym_id || "No gym",
            member.member_code || member.id,
            JSON.stringify(member.full_name ?? ""),
            member.archived_at ? "archived" : "active",
            member.problem
        ].join(" | "));
    }
}

main().catch((error) => {
    console.error(error.message || "The member name check failed.");
    process.exitCode = 1;
});
