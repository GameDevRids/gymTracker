import test from "node:test";
import assert from "node:assert/strict";
import { createDemoState, createEmptyState } from "../../data/demo-data.js";

test("new workspaces are empty while sample data remains available explicitly", () => {
    const empty = createEmptyState();
    assert.deepEqual(empty.members, []);
    assert.deepEqual(empty.plans, []);
    assert.deepEqual(empty.payments, []);
    assert.deepEqual(empty.attendance, []);

    const sample = createDemoState();
    assert.ok(sample.members.length > 0);
    assert.ok(sample.payments.length > 0);
    assert.ok(sample.attendance.length > 0);
});
