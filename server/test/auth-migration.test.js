import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/007_create_gyms_and_auth.sql", import.meta.url), "utf8");

test("auth migration backfills a default gym and requires a gym for every persisted record", () => {
    assert.match(migration, /owner_user_id uuid REFERENCES auth\.users/i);
    assert.match(migration, /SELECT id INTO v_owner_id FROM auth\.users ORDER BY created_at, id LIMIT 1/i);
    assert.match(migration, /IF v_owner_id IS NOT NULL THEN[\s\S]*?INSERT INTO public\.gym_users/i);
    assert.doesNotMatch(migration, /Migration 007 needs at least one Supabase Auth user/);
    for (const table of ["members", "membership_plans", "member_memberships", "payments"]) {
        assert.match(migration, new RegExp(`ALTER TABLE public\\.${table}[\\s\\S]*?ALTER COLUMN gym_id SET NOT NULL`, "i"));
        assert.match(migration, new RegExp(`ALTER TABLE public\\.${table}[\\s\\S]*?FOREIGN KEY \\(gym_id\\) REFERENCES public\\.gyms`, "i"));
    }
});

test("owner onboarding atomically claims the unowned default gym or creates a new one", () => {
    assert.match(migration, /CREATE OR REPLACE FUNCTION public\.gympulse_create_or_claim_gym/i);
    assert.match(migration, /owner_user_id IS NULL AND name = 'GymPulse Default Gym'[\s\S]*?FOR UPDATE SKIP LOCKED/i);
    assert.match(migration, /INSERT INTO public\.gym_users \(gym_id, user_id, role\)[\s\S]*?RETURN NEXT v_gym/i);
    assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.gympulse_create_or_claim_gym\(text, uuid\) TO service_role/i);
});

test("authenticated database policies and relationship constraints are gym-scoped", () => {
    for (const table of ["gyms", "gym_users", "members", "membership_plans", "member_memberships", "payments"]) {
        assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`, "i"));
    }
    assert.match(migration, /CREATE POLICY members_select_own_gym[\s\S]*?gympulse_user_has_gym\(gym_id\)/i);
    assert.match(migration, /FOREIGN KEY \(gym_id, member_id\) REFERENCES public\.members \(gym_id, id\)/i);
    assert.match(migration, /FOREIGN KEY \(gym_id, plan_id\) REFERENCES public\.membership_plans \(gym_id, id\)/i);
    assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS members_gym_member_code_key\s+ON public\.members \(gym_id, member_code\)/i);
    assert.match(migration, /p_gym_id uuid[\s\S]*?WHERE id = p_member_id AND gym_id = p_gym_id/i);
});
