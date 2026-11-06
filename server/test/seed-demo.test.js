import test from "node:test";
import assert from "node:assert/strict";
import { assertSeedAllowed } from "../scripts/seed-demo.js";

test("demo seeder refuses production and unconfirmed destructive runs", () => {
    assert.throws(
        () => assertSeedAllowed({ NODE_ENV: "production", ALLOW_SEED: "false" }),
        /Refusing to seed in production/
    );
    assert.throws(
        () => assertSeedAllowed({ NODE_ENV: "test", ALLOW_SEED: "false" }),
        /Refusing destructive demo seeding/
    );
    assert.throws(
        () => assertSeedAllowed({ NODE_ENV: "test", ALLOW_SEED: "true" }),
        /DEMO_SUPABASE_URL/
    );
    assert.doesNotThrow(() => assertSeedAllowed({
        NODE_ENV: "production",
        ALLOW_SEED: "true",
        DEMO_SUPABASE_URL: "https://demo-project.supabase.co",
        DEMO_SUPABASE_SERVICE_ROLE_KEY: "test-key",
        DEMO_GYM_ID: "00000000-0000-4000-8000-000000000001"
    }));
});
