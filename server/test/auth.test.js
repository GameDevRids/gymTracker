import test from "node:test";
import assert from "node:assert/strict";
import { requireAuth } from "../middleware/requireAuth.js";

const userId = "00000000-0000-4000-8000-000000000001";
const gymId = "00000000-0000-4000-8000-000000000002";

function responseMock() {
    return {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

function mockClient({ user, gym, authError, gymError } = {}) {
    return {
        auth: {
            getUser: async (token) => {
                assert.equal(token, "valid-token");
                return { data: { user }, error: authError || null };
            }
        },
        from(table) {
            assert.equal(table, "gym_users");
            return {
                select(columns) {
                    assert.equal(columns, "gym_id,role,gyms(id,name)");
                    return this;
                },
                eq(field, value) {
                    assert.equal(field, "user_id");
                    assert.equal(value, userId);
                    return this;
                },
                maybeSingle: async () => ({ data: gym, error: gymError || null })
            };
        }
    };
}

async function invoke(client, authorization, options) {
    const request = { get: () => authorization };
    const response = responseMock();
    let nextCalled = false;
    await requireAuth({ client, ...options })(request, response, () => { nextCalled = true; });
    return { request, response, nextCalled };
}

test("auth middleware rejects missing and invalid bearer tokens", async () => {
    const missing = await invoke(mockClient(), "");
    assert.equal(missing.response.statusCode, 401);
    assert.equal(missing.nextCalled, false);

    const invalid = await invoke(mockClient({ user: null, authError: new Error("invalid") }), "Bearer valid-token");
    assert.equal(invalid.response.statusCode, 401);
});

test("auth middleware requires a gym unless onboarding explicitly allows none", async () => {
    const user = { id: userId, email: "owner@example.test" };
    const blocked = await invoke(mockClient({ user, gym: null }), "Bearer valid-token");
    assert.equal(blocked.response.statusCode, 403);

    const onboarding = await invoke(mockClient({ user, gym: null }), "Bearer valid-token", { allowNoGym: true });
    assert.equal(onboarding.nextCalled, true);
    assert.equal(onboarding.request.authUser.id, userId);
    assert.equal(onboarding.request.gymId, null);
});

test("auth middleware attaches only the authenticated user's gym", async () => {
    const user = { id: userId, email: "owner@example.test" };
    const gym = { gym_id: gymId, gyms: { id: gymId, name: "Gym A" } };
    const result = await invoke(mockClient({ user, gym }), "Bearer valid-token");
    assert.equal(result.nextCalled, true);
    assert.equal(result.request.authUser.id, userId);
    assert.equal(result.request.gymId, gymId);
    assert.deepEqual(result.request.gym, gym.gyms);
});
