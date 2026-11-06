import test from "node:test";
import assert from "node:assert/strict";
import { fetchActivePlans } from "../../assets/js/api/plansApi.js";
import { createMemberPlanAssignment } from "../../assets/js/api/membershipsApi.js";

test("active plan fetch uses the plans API, filters inactive rows, and paginates", async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    const activePlan = {
        id: "00000000-0000-4000-8000-000000000001",
        name: "Monthly Membership",
        duration_days: 30,
        price: 1100,
        is_active: true
    };
    const inactivePlan = { ...activePlan, id: "00000000-0000-4000-8000-000000000002", is_active: false };

    globalThis.fetch = async (url) => {
        const requestUrl = new URL(url);
        requests.push(requestUrl);
        const page = Number(requestUrl.searchParams.get("page"));
        const payload = page === 1
            ? { data: { plans: [activePlan], pagination: { totalPages: 2 } } }
            : { data: { plans: [inactivePlan], pagination: { totalPages: 2 } } };
        return {
            ok: true,
            headers: { get: () => "application/json" },
            json: async () => payload
        };
    };

    try {
        const plans = await fetchActivePlans();
        assert.deepEqual(plans, [activePlan]);
        assert.equal(requests.length, 2);
        for (const url of requests) {
            assert.equal(url.pathname, "/api/plans");
            assert.equal(url.searchParams.get("status"), "active");
            assert.equal(url.searchParams.get("limit"), "100");
        }
        assert.deepEqual(requests.map((url) => url.searchParams.get("page")), ["1", "2"]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("active plan fetch surfaces API errors instead of using demo plans", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: false,
        status: 503,
        headers: { get: () => "application/json" },
        json: async () => ({ status: "error", message: "Plans unavailable." })
    });

    try {
        await assert.rejects(fetchActivePlans(), /Plans unavailable\./);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("active plan fetch returns an empty list when no active plans exist", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({
            status: "success",
            data: { plans: [], pagination: { totalPages: 1 } }
        })
    });

    try {
        assert.deepEqual(await fetchActivePlans(), []);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("member plan assignment posts the selected database UUID to the Phase 5 endpoint", async () => {
    const originalFetch = globalThis.fetch;
    const memberId = "5bfff1a2-3b1c-4a66-a88b-d9ea7e97238a";
    const planId = "00000000-0000-4000-8000-000000000001";
    const membership = {
        id: "00000000-0000-4000-8000-000000000003",
        member_id: memberId,
        plan_id: planId,
        start_date: "2026-11-06",
        end_date: "2026-12-05"
    };
    let requestUrl;
    let requestOptions;
    globalThis.fetch = async (url, options) => {
        requestUrl = new URL(url);
        requestOptions = options;
        return {
            ok: true,
            headers: { get: () => "application/json" },
            json: async () => ({ status: "success", data: membership })
        };
    };

    try {
        const result = await createMemberPlanAssignment(memberId, planId, "2026-11-06");
        assert.deepEqual(result, membership);
        assert.equal(requestUrl.pathname, `/api/members/${memberId}/memberships`);
        assert.equal(requestOptions.method, "POST");
        assert.deepEqual(JSON.parse(requestOptions.body), {
            plan_id: planId,
            start_date: "2026-11-06"
        });
    } finally {
        globalThis.fetch = originalFetch;
    }
});
