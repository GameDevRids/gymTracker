import test from "node:test";
import assert from "node:assert/strict";
import { createGym, login, refresh, logout } from "../services/authService.js";

process.env.SUPABASE_URL = "https://gympulse-auth.example.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "server-only-test-key";

const user = { id: "00000000-0000-4000-8000-000000000001", email: "owner@example.test" };
const gymId = "00000000-0000-4000-8000-000000000002";
const gym = { gym_id: gymId, gyms: { id: gymId, name: "Gym A" } };

function mockDatabase() {
    return {
        from(table) {
            assert.equal(table, "gym_users");
            return {
                select(columns) {
                    assert.equal(columns, "gym_id,gyms(id,name)");
                    return this;
                },
                eq(field, value) {
                    assert.equal(field, "user_id");
                    assert.equal(value, user.id);
                    return this;
                },
                maybeSingle: async () => ({ data: gym, error: null })
            };
        }
    };
}

function jsonResponse(data, ok = true, status = 200) {
    return { ok, status, json: async () => data };
}

test("login and refresh use Supabase Auth REST and return the linked gym", async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options) => {
        requests.push({ url: String(url), options });
        return jsonResponse({
            access_token: "access",
            refresh_token: "refresh",
            expires_in: 3600,
            user
        });
    };
    try {
        const client = mockDatabase();
        const session = await login({ email: user.email, password: "passphrase" }, client);
        assert.equal(session.access_token, "access");
        assert.equal(session.gym.id, gymId);
        const refreshed = await refresh("refresh-token-value-at-least-twenty", client);
        assert.equal(refreshed.user.id, user.id);
        assert.match(requests[0].url, /\/auth\/v1\/token\?grant_type=password$/);
        assert.match(requests[1].url, /\/auth\/v1\/token\?grant_type=refresh_token$/);
        assert.equal(requests[0].options.headers.apikey, process.env.SUPABASE_SERVICE_ROLE_KEY);
        assert.deepEqual(JSON.parse(requests[0].options.body), { email: user.email, password: "passphrase" });
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("logout revokes the access token through Auth REST without returning credentials", async () => {
    const originalFetch = globalThis.fetch;
    let requestOptions;
    globalThis.fetch = async (_url, options) => {
        requestOptions = options;
        return jsonResponse({});
    };
    try {
        assert.equal(await logout("access-token", mockDatabase()), undefined);
        assert.equal(requestOptions.headers.Authorization, "Bearer access-token");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("gym onboarding claims the unowned default workspace through the atomic RPC", async () => {
    let rpcCall;
    const client = {
        rpc: async (name, args) => {
            rpcCall = { name, args };
            return { data: [{ id: gymId, name: "Gym A" }], error: null };
        }
    };
    assert.deepEqual(await createGym("Gym A", user.id, client), { id: gymId, name: "Gym A", is_demo: false });
    assert.deepEqual(rpcCall, {
        name: "gympulse_create_or_claim_gym",
        args: { p_name: "Gym A", p_owner_user_id: user.id }
    });
});

test("only gyms listed in DEMO_GYM_IDS are flagged as demo accounts", async () => {
    const { isDemoGym } = await import("../services/authService.js");
    assert.equal(isDemoGym(gymId, {}), false);
    assert.equal(isDemoGym(gymId, { DEMO_GYM_IDS: "other-gym" }), false);
    assert.equal(isDemoGym(gymId, { DEMO_GYM_IDS: ` other-gym , ${gymId} ` }), true);
    assert.equal(isDemoGym("", { DEMO_GYM_IDS: "," }), false);

    const originalFetch = globalThis.fetch;
    const original = process.env.DEMO_GYM_IDS;
    globalThis.fetch = async () => jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600, user });
    try {
        delete process.env.DEMO_GYM_IDS;
        assert.equal((await login({ email: user.email, password: "passphrase" }, mockDatabase())).gym.is_demo, false);
        process.env.DEMO_GYM_IDS = gymId;
        assert.equal((await refresh("refresh-token-value-at-least-twenty", mockDatabase())).gym.is_demo, true);
    } finally {
        globalThis.fetch = originalFetch;
        if (original === undefined) delete process.env.DEMO_GYM_IDS;
        else process.env.DEMO_GYM_IDS = original;
    }
});
