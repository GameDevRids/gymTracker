import test from "node:test";
import assert from "node:assert/strict";
import { parseCSV } from "../../assets/js/utils.js";
import {
    fetchAllMemberPhones,
    importMembers,
    importPhoneKey,
    validateImportRows
} from "../../assets/js/modules/memberImport.js";

const plans = [
    { id: "11111111-1111-4111-8111-111111111111", name: "Monthly", price: 1800 },
    { id: "22222222-2222-4222-8222-222222222222", name: "Annual", price: 15000 }
];

test("phone keys treat +91, 91 and leading-zero forms as the same number", () => {
    assert.equal(importPhoneKey("+91 98765 43210"), "9876543210");
    assert.equal(importPhoneKey("919876543210"), "9876543210");
    assert.equal(importPhoneKey("09876543210"), "9876543210");
    assert.equal(importPhoneKey("12345"), "");
});

test("preview validates plans against the gym's API plans and supports the membership plan alias", () => {
    const rows = parseCSV([
        "Full Name,Mobile,Membership Plan,Joining Date",
        "Riya Shah,9876543210,monthly,2026-11-01",
        "Dev Rao,9876543211,Yoga,2026-11-01"
    ].join("\n"));
    const { valid, invalid } = validateImportRows(rows, { activePlans: plans });
    assert.deepEqual(valid.map((row) => [row.name, row.planName, row.startDate]), [["Riya Shah", "monthly", "2026-11-01"]]);
    assert.deepEqual(invalid.map((row) => row.issues), [["unknown membership plan"]]);
});

test("preview flags phones that already exist in the gym or repeat within the file", () => {
    const rows = parseCSV([
        "name,phone",
        "Existing Member,+919876543210",
        "First Copy,9876543211",
        "Second Copy,09876543211",
        ",123"
    ].join("\n"));
    const { valid, invalid, rows: ordered } = validateImportRows(rows, { existingPhones: ["9876543210"] });
    assert.deepEqual(valid.map((row) => row.rowNumber), [3]);
    assert.deepEqual(invalid.map((row) => [row.rowNumber, row.issues]), [
        [2, ["duplicate phone number"]],
        [4, ["valid Indian mobile number is required"]],
        [5, ["name is required", "valid Indian mobile number is required"]]
    ]);
    assert.deepEqual(ordered.map((row) => row.rowNumber), [3, 2, 4, 5]);
});

test("preview rejects malformed and reversed dates", () => {
    const rows = parseCSV("name,phone,start date,expiry date\nA,9876543210,2026-02-30,\nB,9876543211,2026-11-10,2026-11-01");
    const { invalid } = validateImportRows(rows);
    assert.deepEqual(invalid.map((row) => row.issues), [["start date must use YYYY-MM-DD"], ["expiry date precedes start date"]]);
});

test("import creates members through the API, assigns named plans, and reports progress", async () => {
    const { valid } = validateImportRows(parseCSV("name,phone,plan,start date\nRiya,+919876543210,Annual,2026-11-05\nDev,9876543211,,"), { activePlans: plans });
    const created = [];
    const assigned = [];
    const progress = [];
    const result = await importMembers(valid, {
        plans,
        today: "2026-11-11",
        createMember: async (member) => { created.push(member); return { id: `member-${created.length}` }; },
        assignPlan: async (...args) => { assigned.push(args); return { id: "assignment" }; },
        onProgress: ({ current, total }) => progress.push(`${current}/${total}`)
    });
    assert.deepEqual(result, { imported: 2, withoutPlan: 1, errors: [] });
    assert.deepEqual(created.map((member) => [member.name, member.phone, member.notes]), [
        ["Riya", "9876543210", "Imported from CSV"],
        ["Dev", "9876543211", "Imported from CSV"]
    ]);
    assert.deepEqual(assigned, [["member-1", plans[1].id, "2026-11-05", 15000]]);
    assert.deepEqual(progress, ["1/2", "2/2"]);
});

test("import keeps going after failures and reports each row's error", async () => {
    const { valid } = validateImportRows(parseCSV("name,phone,plan\nOne,9876543210,Monthly\nTwo,9876543211,Monthly\nThree,9876543212,Monthly"), { activePlans: plans });
    const result = await importMembers(valid, {
        plans,
        today: "2026-11-11",
        createMember: async (member) => {
            if (member.name === "One") throw new Error("Phone number is invalid.");
            if (member.name === "Two") return null;
            return { id: "member-3" };
        },
        assignPlan: async () => { throw new Error("This member already has a membership during those dates."); }
    });
    assert.equal(result.imported, 1);
    assert.deepEqual(result.errors, [
        { rowNumber: 2, message: "Phone number is invalid." },
        { rowNumber: 3, message: "The member was not returned by the API." },
        { rowNumber: 4, message: "Member was created, but the plan was not assigned: This member already has a membership during those dates. Assign it from the member's profile." }
    ]);
});

test("import does not create a member when its plan is no longer active", async () => {
    const { valid } = validateImportRows(parseCSV("name,phone,plan\nOne,9876543210,Monthly"), { activePlans: plans });
    let calls = 0;
    const result = await importMembers(valid, {
        plans: [plans[1]],
        today: "2026-11-11",
        createMember: async () => { calls += 1; return { id: "x" }; },
        assignPlan: async () => {}
    });
    assert.equal(calls, 0);
    assert.deepEqual(result.errors, [{ rowNumber: 2, message: "Active membership plan \"Monthly\" was not found." }]);
});

test("existing phones are collected from every page of the members API", async () => {
    const requests = [];
    const phones = await fetchAllMemberPhones(async (params) => {
        requests.push(params);
        const members = params.page === 1 ? [{ phone: "9876543210" }, { phone: "9876543211" }] : [{ phone: "9876543212" }];
        return { data: { members, pagination: { totalPages: 2 } } };
    }, 2);
    assert.deepEqual(requests, [{ page: 1, limit: 2 }, { page: 2, limit: 2 }]);
    assert.deepEqual(phones, ["9876543210", "9876543211", "9876543212"]);
    await assert.rejects(fetchAllMemberPhones(async () => ({ data: {} })), /unexpected response/);
});
