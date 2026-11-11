import test from "node:test";
import assert from "node:assert/strict";
import { createDemoState, createEmptyState, removeLegacyDemoData } from "../../data/demo-data.js";

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

test("legacy auto-seeded demo data is removed while owner-created records are kept", () => {
    const legacy = createDemoState();
    const ownMember = { id: "GP-LX8K2J-AB12", name: "Real Member", phone: "9876543210", planId: "" };
    const ownPayment = { id: "TX-LX8K2J-CD34", memberId: ownMember.id, amount: 500, date: "2026-11-01", method: "upi", status: "paid" };
    const demoMemberId = legacy.members[0].id;
    legacy.members.push(ownMember);
    legacy.payments.push(ownPayment, { id: "TX-LX8K2J-EF56", memberId: demoMemberId, amount: 100, date: "2026-11-01", method: "cash", status: "paid" });
    legacy.gym.currency = "INR";
    legacy.gym.preferences.expiryReminderDays = 15;
    legacy.whatsapp = { activeMemberId: demoMemberId, conversations: [{ memberId: demoMemberId, messages: [{ text: "hi" }] }, { memberId: ownMember.id, messages: [{ text: "hello" }] }] };

    const { state, changed } = removeLegacyDemoData(legacy);
    assert.equal(changed, true);
    assert.equal(state.gym.name, "My Gym");
    assert.equal(state.gym.address, "");
    assert.equal(state.gym.phone, "");
    assert.equal(state.gym.preferences.expiryReminderDays, 15);
    assert.deepEqual(state.members, [ownMember]);
    assert.deepEqual(state.payments, [ownPayment]);
    assert.deepEqual(state.plans, []);
    assert.deepEqual(state.attendance, []);
    assert.deepEqual(state.whatsapp.conversations.map((item) => item.memberId), [ownMember.id]);
    assert.equal(state.whatsapp.activeMemberId, ownMember.id);
});

test("legacy cleanup keeps the owner's own gym details and skips explicit sample data", () => {
    const own = { ...createEmptyState(), gym: { ...createEmptyState().gym, name: "Iron Temple", address: "MG Road, Pune" } };
    assert.deepEqual(removeLegacyDemoData(own), { state: own, changed: false });

    const renamedLegacy = createDemoState();
    renamedLegacy.gym = { ...renamedLegacy.gym, name: "Iron Temple", address: "MG Road, Pune", phone: "+91 20 1234 5678" };
    const cleaned = removeLegacyDemoData(renamedLegacy).state;
    assert.equal(cleaned.gym.name, "Iron Temple");
    assert.equal(cleaned.gym.address, "MG Road, Pune");
    assert.deepEqual(cleaned.members, []);

    const sample = { ...createDemoState(), sampleDataLoaded: true };
    assert.deepEqual(removeLegacyDemoData(sample), { state: sample, changed: false });
});
