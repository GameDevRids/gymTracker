import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyState, removeLegacyDemoData } from "../../assets/js/workspace.js";
import { createDemoState } from "./helpers/legacyDemoData.js";

test("new workspaces are empty", () => {
    const empty = createEmptyState();
    assert.deepEqual(empty.members, []);
    assert.deepEqual(empty.plans, []);
    assert.deepEqual(empty.payments, []);
    assert.deepEqual(empty.attendance, []);
});

test("the cleanup knows every id of the old fictional workspace, without shipping it", () => {
    const legacy = createDemoState();
    // Even if a record's member link were lost, its own id still marks it as fictional.
    for (const list of [legacy.attendance, legacy.payments]) list.forEach((item) => { item.memberId = "GP-OWN-1"; });
    const { state } = removeLegacyDemoData(legacy);
    assert.deepEqual(state.members, []);
    assert.deepEqual(state.plans, []);
    assert.deepEqual(state.attendance, []);
    assert.deepEqual(state.payments, []);
});

test("the app no longer ships or imports the sample data", async () => {
    const { existsSync, readFileSync, readdirSync } = await import("node:fs");
    const root = new URL("../../", import.meta.url);
    assert.equal(existsSync(new URL("data/demo-data.js", root)), false);
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory()
        ? walk(new URL(`${entry.name}/`, dir))
        : entry.name.endsWith(".js") ? [new URL(entry.name, dir)] : []));
    for (const file of [...walk(new URL("assets/js/", root)), new URL("sw.js", root)]) {
        assert.doesNotMatch(readFileSync(file, "utf8"), /demo-data|createDemoState|load-sample-data|loadSampleState/, file.pathname);
    }
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
