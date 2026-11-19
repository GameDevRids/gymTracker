// Stage 5: the same name for the same action everywhere, matching toasts, an explanation and a fix on
// every empty list, no leftover prototype/demo/coming-soon wording, and the phone touch-target rule.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { installPhotoDom } from "./helpers/fakeDom.js";

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const boot = installPhotoDom();
const { emptyRow, emptyState } = await import("../../assets/js/components/tables.js");
const { renderMembers, renderProfile } = await import("../../assets/js/modules/members.js");
const { renderOperationsPage } = await import("../../assets/js/modules/operations.js");
const { renderExpiring } = await import("../../assets/js/modules/expiring.js");
const { renderLapsedBody, loadLapsed } = await import("../../assets/js/modules/lapsed.js");
const { paymentsPage } = await import("../../assets/js/modules/upiPayments.js");
const { renderVisitsSection } = await import("../../assets/js/modules/attendance.js");
const { state, memberFromApiRow } = await import("../../assets/js/state.js");
const { t } = await import("../../assets/js/i18n.js");
boot.restore();

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const jsFiles = (dir = "assets/js") => readdirSync(new URL(`${dir}/`, root), { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? jsFiles(`${dir}/${entry.name}`) : entry.name.endsWith(".js") ? [`${dir}/${entry.name}`] : []));
const sources = jsFiles().map((path) => [path, read(path)]);
// A label written as ${t("key")} is read as the text it shows.
const shownLabel = (label) => label.trim().replace(/^\$\{t\("(\w+)"\)\}$/, (_all, key) => t(key));
const labelsOf = (action) => sources.flatMap(([path, source]) => [...source.matchAll(new RegExp(`data-action="${action}"[^>]*>([^<]+)<`, "g"))].map((match) => [path, shownLabel(match[1])]));
const withoutComments = (source) => source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");

// ---------- The same name for the same action ----------

test("Renew is called Renew on every button", () => {
    const labels = labelsOf("renew-member");
    assert.ok(labels.length >= 3, "the buttons were found");
    for (const [path, label] of labels) assert.equal(label, "Renew", path);
    // The Members row and the profile build their button with rowPrimaryAction (Resume when on hold).
    state.members = [memberFromApiRow({ id: "00000000-0000-4000-8000-000000000031", full_name: "Riya Shah", member_code: "GP-31", phone: "9876543231", member_status: "expiring", status_detail: {} })];
    assert.match(renderMembers({}), /data-action="renew-member"[^>]*>Renew</);
    assert.match(renderProfile("00000000-0000-4000-8000-000000000031"), /data-action="renew-member"[^>]*>Renew</);
    assert.equal(t("renew"), "Renew");
});

test("Record payment is called Record payment on every button", () => {
    const labels = labelsOf("record-payment");
    assert.ok(labels.length >= 4);
    for (const [path, label] of labels) assert.equal(label, "Record payment", path);
    assert.equal(t("recordPayment"), "Record payment");
});

test("Check in is called Check in on the profile and the empty visits lists (the page itself is Check-in)", () => {
    for (const [path, label] of labelsOf("check-in")) assert.equal(label, "Check in", path);
    assert.equal(sources.some(([, source]) => source.includes("Record check-in")), false);
});

test("sending a reminder is Send reminder, and a sent one says Reminder sent", () => {
    assert.equal(t("remindWhatsApp"), "Send reminder");
    assert.equal(t("reminded"), "Reminder sent ✓");
    assert.equal(sources.some(([, source]) => withoutComments(source).includes("Remind on WhatsApp")), false);
});

test("receipts are sent, never shared, in every button", () => {
    const upi = read("assets/js/modules/upiPayments.js");
    assert.equal(upi.includes("Share receipt on WhatsApp"), false);
    assert.match(upi, /Send receipt on WhatsApp/);
});

test("the old labels are gone everywhere", () => {
    for (const old of ["Renew membership", "＋ Record payment", "＋ Create plan", "Archive member", "Lapsed members</h1>"]) {
        assert.equal(sources.some(([, source]) => source.includes(old)), false, old);
    }
});

// ---------- Toasts say what happened, in the same shape ----------

test("toasts for the main actions start with what happened", () => {
    const has = (path, text) => assert.ok(read(path).includes(text), `${path}: ${text}`);
    has("assets/js/modules/renewSheet.js", "toast(`Renewed: ");
    has("assets/js/modules/holds.js", "toast(`Plan on hold: ");
    has("assets/js/modules/holds.js", "`Plan resumed: ");
    has("assets/js/modules/memberMemberships.js", "toast(`Plan assigned: ");
    has("assets/js/modules/attendance.js", "return [`Checked in: ${name} at ${time}.`");
    has("assets/js/modules/attendance.js", "`Already checked in: ");
    has("assets/js/main.js", "toast(`Reminder sent: ");
    has("assets/js/main.js", `safePersist("Member updated.")`);
    has("assets/js/main.js", `safePersist("Settings saved.")`);
    has("assets/js/modules/upiPayments.js", `"Payment recorded"`);
    for (const old of ["renewed through", "assigned through", "checked in at ${time}.`, \"success\"]"]) {
        assert.equal(sources.some(([, source]) => source.includes(old)), false, old);
    }
});

// ---------- Every empty list says why and how to fix it ----------

test("an empty list is one line and, when there is a fix, the button for it", () => {
    const withAction = emptyState("Nothing here yet.", `<button data-action="x">Do it</button>`);
    assert.match(withAction, /<p>Nothing here yet\.<\/p><div class="empty-actions"><button data-action="x">Do it<\/button><\/div>/);
    assert.equal(emptyState("Just a note.").includes("empty-actions"), false);
    assert.match(emptyState("<b>"), /&lt;b&gt;/, "text is escaped");
    assert.match(emptyRow(4, "Empty."), /<td colspan="4">/);
});

test("no members: Add member and Import members; filters that match nothing just say so", () => {
    state.members = [];
    const none = renderMembers({});
    assert.match(none, /No members yet\. Add your first member, or import a spreadsheet\./);
    assert.match(none, /data-action="add-member">Add member<\/button>/);
    state.members = [memberFromApiRow({ id: "00000000-0000-4000-8000-000000000001", full_name: "Riya Shah", member_code: "GP-101", member_status: "active", status_detail: {} })];
    const filtered = renderMembers({ search: "zzz" });
    assert.match(filtered, /No members match this search or filter\./);
    assert.equal(/No members yet/.test(filtered), false);
});

test("no payments: the page offers Record payment", () => {
    Object.assign(paymentsPage, { status: "ready", payments: [], total: 0, monthTotal: 0, loaded: true });
    const html = renderOperationsPage("payments");
    assert.match(html, /No payments yet\. They appear here when you renew a member or record one\./);
    // Review stage 6: the header keeps the one marigold Record payment; the empty list offers it as secondary.
    assert.match(html, /class="button button-secondary" type="button" data-action="record-payment">Record payment<\/button>/);
});

test("no expiring plans: says what appears here and offers the members list", () => {
    const html = renderExpiring([], "ready", "", new Set());
    assert.match(html, /No plans are ending soon/);
    assert.match(html, /7 days or less left, or while it is in grace/, "no mention of the window that no longer exists");
    assert.match(html, /data-view="members">See all members/);
    for (const language of ["hi", "mr"]) assert.ok(t("noExpiring").length > 20, language);
});

test("no lapsed or old members: a friendly line", async () => {
    globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ status: "success", data: [] }) });
    await loadLapsed("lapsed");
    await loadLapsed("old");
    assert.match(renderLapsedBody("lapsed"), /No lapsed members – nice!/);
    assert.match(renderLapsedBody("old"), /No old members\. Members move here/);
});

test("a member's profile: empty payments and visits offer the action; no plan offers Assign plan", () => {
    const id = "00000000-0000-4000-8000-000000000009";
    state.members = [memberFromApiRow({ id, full_name: "New Nina", member_code: "GP-109", member_status: "none", status_detail: {} })];
    state.attendance = [];
    const html = renderProfile(id);
    assert.match(html, /No payments yet\. They appear here when you renew or record one\.[\s\S]*?data-action="record-payment" data-id="[^"]+">Record payment/);
    // The visits list loads after the page opens; its empty line (same wording) is in the code.
    assert.match(read("assets/js/modules/attendance.js"), /No check-ins yet\. They appear here as this member checks in\./);
});

test("the visits list says why it is empty and offers a manual check-in", () => {
    // The feed is still loading in a fresh session, so the list says so rather than "empty".
    assert.match(renderVisitsSection(), /Loading visits…|No check-ins yet today\./);
});

// ---------- Wording ----------

test("no prototype, demo or coming-soon wording in the live app", () => {
    const pages = [["index.html", read("index.html")], ["manifest.webmanifest", read("manifest.webmanifest")], ...sources];
    for (const [path, source] of pages) {
        // The old browser-storage key name is not shown to anyone.
        const visible = withoutComments(source).replace(/gympulse\.prototype\.v1|LEGACY_PROTOTYPE_KEY/g, "");
        assert.equal(/prototype|coming soon|preview only|not connected/i.test(visible), false, path);
    }
    assert.doesNotMatch(read("manifest.webmanifest"), /local gym management workspace/i);
});

// ---------- Phones ----------

test("on phones every button, link and chip is at least 44px (the audit checked each screen at 360px)", () => {
    const css = read("assets/css/theme.css");
    const phone = css.slice(css.indexOf("Phones: every tap target is at least 44px"));
    assert.match(phone, /@media \(max-width: 767px\)/);
    assert.match(phone, /\.button, \.text-button, \.icon-button, \.modal-close, \.welcome-chip, \.tab-button, \.row-menu-button \{ min-width: 44px; min-height: 44px; \}/);
    assert.match(phone, /\.heading-actions \.button[^{]*\.button-small \{ min-height: 44px; \}/);
    assert.match(phone, /\.helper-text a[^{]*\{[^}]*min-height: 44px/);
});
