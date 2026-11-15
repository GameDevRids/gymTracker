import test from "node:test";
import assert from "node:assert/strict";
import { memberNameProblem, validateMemberPayload } from "../middleware/validateMember.js";
import { cleanMemberName, formatPhone, formatPlanDuration, memberNameIssue } from "../../assets/js/utils.js";
import { readImportRows } from "../../assets/js/modules/memberImport.js";

const goodNames = ["Riya Shah", "Rhea D'Souza", "Anne-Marie Joseph", "S. Kumar", "Jr.", "प्रिया देशमुख", "सई", "José Álvarez", "O’Brien", "  Kabir   Mehta  "];
const badNames = ["", "   ", "riya@example.com", "owner@gym", "Riya123", "9876543210", "Riya_Shah", "-Riya", "<script>", "a".repeat(201)];

test("the API accepts real names in any script and rejects empty, email-like and non-letter names", () => {
    for (const name of goodNames) assert.equal(memberNameProblem(name), "", `${name} should be accepted`);
    for (const name of badNames) assert.notEqual(memberNameProblem(name), "", `${name} should be rejected`);
    assert.match(memberNameProblem("riya@example.com"), /not an email/);
    assert.equal(memberNameProblem(42), "Full name is required.");
});

test("the browser and the API agree on every sample name", () => {
    for (const name of [...goodNames, ...badNames]) {
        assert.equal(memberNameIssue(name) === "", memberNameProblem(name) === "", `disagreement on ${JSON.stringify(name)}`);
    }
    assert.equal(memberNameIssue("riya@example.com"), "email");
    assert.equal(memberNameIssue(""), "missing");
    assert.equal(cleanMemberName("  Kabir   Mehta "), "Kabir Mehta");
});

test("member create and update reject an email as the name and collapse extra spaces", () => {
    const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
    for (const mode of ["create", "update"]) {
        const res = response();
        let called = false;
        validateMemberPayload(mode)({ body: { full_name: "owner@example.com", phone: "9876543210" } }, res, () => { called = true; });
        assert.equal(called, false);
        assert.equal(res.statusCode, 400);
        assert.match(res.body.message, /not an email/);
    }
    const request = { body: { full_name: "  Kabir   Mehta ", phone: "9876543210" } };
    validateMemberPayload("create")(request, response(), () => {});
    assert.equal(request.validatedMember.full_name, "Kabir Mehta");
});

test("member import flags empty and email-like names per row", () => {
    const text = (...values) => values.map((value) => ({ text: value }));
    const rows = readImportRows([
        text("Name", "Phone"),
        text("Riya Shah", "9876543210"),
        text("riya@example.com", "9876543211"),
        text("", "9876543212"),
        text("R2D2", "9876543213")
    ], 0, { name: 0, phone: 1, plan: -1, startDate: -1, endDate: -1, amountPaid: -1, notes: -1 });
    assert.deepEqual(rows.map((row) => row.problems), [
        [],
        ["name looks like an email address"],
        ["name is missing"],
        ["name must use letters (spaces, dots, apostrophes and hyphens are fine)"]
    ]);
});

test("phone numbers display as +91 followed by two groups of five digits", () => {
    for (const input of ["9823012345", "+919823012345", "919823012345", "09823012345", "+91 98230 12345", "98230-12345"]) {
        assert.equal(formatPhone(input), "+91 98230 12345", input);
    }
    assert.equal(formatPhone("12345"), "12345");
    assert.equal(formatPhone(""), "");
    assert.equal(formatPhone(null), "");
    assert.equal(formatPhone("+44 20 7946 0958"), "+44 20 7946 0958");
});

test("plan durations read as months with the day count, or as plain days", () => {
    assert.equal(formatPlanDuration(30), "1 month (30 days)");
    assert.equal(formatPlanDuration(90), "3 months (90 days)");
    assert.equal(formatPlanDuration(180), "6 months (180 days)");
    assert.equal(formatPlanDuration(365), "12 months (365 days)");
    assert.equal(formatPlanDuration("60"), "2 months (60 days)");
    assert.equal(formatPlanDuration(45), "45 days");
    assert.equal(formatPlanDuration(1), "1 day");
    assert.equal(formatPlanDuration(0), "");
});
