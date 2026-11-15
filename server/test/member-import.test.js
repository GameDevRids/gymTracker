// Stage 3: importing members from an owner's Excel or CSV file. Covers reading spreadsheets
// (no library), Indian phone and date formats, column matching, plans, duplicates, the payload
// sent to the server, the server's checks and the owner-only rule.
import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { SpreadsheetError, columnName, excelSerialToDate, parseDelimited, readSpreadsheet, writeXlsx } from "../../assets/js/spreadsheet.js";
import {
    TEMPLATE_HEADERS,
    findHeaderRow,
    guessColumns,
    guessPlanDays,
    importAmount,
    importDate,
    importPhone,
    planImport,
    readImportRows,
    skippedRows,
    unknownPlans
} from "../../assets/js/modules/memberImport.js";
import { validateImportPayload } from "../middleware/validateImport.js";
import { ownerOnly, requireOwner } from "../middleware/requireOwner.js";
import { importMembers } from "../services/memberImportService.js";

const inflateRaw = async (data) => new Uint8Array(inflateRawSync(data));
const cells = (...values) => values.map((text) => ({ text: String(text) }));

// A small .xlsx written the way Excel does: deflated parts, shared strings, styles.
function zipDeflated(files) {
    const encoder = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const [name, text] of Object.entries(files)) {
        const nameBytes = encoder.encode(name);
        const raw = encoder.encode(text);
        const data = deflateRawSync(raw);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
        local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBytes.length, 26);
        chunks.push(local, nameBytes, data);
        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(8, 10);
        entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(raw.length, 24); entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
        central.push(entry, nameBytes);
        offset += 30 + nameBytes.length + data.length;
    }
    const centralSize = central.reduce((total, part) => total + part.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
    return new Uint8Array(Buffer.concat([...chunks, ...central, end]));
}

const excelLikeWorkbook = (date1904 = false) => zipDeflated({
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml": `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr${date1904 ? " date1904=\"1\"" : ""}/><sheets><sheet name="Members" sheetId="1" r:id="rId1"/><sheet name="Old" sheetId="2" r:id="rId2" state="hidden"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="worksheet"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml" Type="worksheet"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst><si><t>Member Name</t></si><si><t>Mobile No.</t></si><si><t>Valid Till</t></si><si><r><t>Riya </t></r><r><t>Shah &amp; Co</t></r><rPh><t>ignored</t></rPh></si><si><t>नेहा पाटील</t></si></sst>`,
    "xl/styles.xml": `<styleSheet><numFmts><numFmt numFmtId="164" formatCode="dd\\-mmm\\-yy"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": `<x:worksheet xmlns:x="main"><x:sheetData>
        <x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1" t="s"><x:v>1</x:v></x:c><x:c r="D1" t="s"><x:v>2</x:v></x:c></x:row>
        <x:row r="3"><x:c r="A3" t="s"><x:v>3</x:v></x:c><x:c r="B3"><x:v>9876543210</x:v></x:c><x:c r="D3" s="1"><x:v>46356</x:v></x:c></x:row>
        <x:row><x:c t="s"><x:v>4</x:v></x:c><x:c t="inlineStr"><x:is><x:t>+91 98765-43211</x:t></x:is></x:c><x:c t="b"><x:v>1</x:v></x:c><x:c s="2"><x:v>46357</x:v></x:c></x:row>
    </x:sheetData></x:worksheet>`,
    "xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hidden</t></is></c></row></sheetData></worksheet>`
});

// ---------- Reading and writing spreadsheets ----------

test("an Excel workbook is read: shared and rich text, numbers, dates, inline strings, prefixed tags", async () => {
    const { sheets } = await readSpreadsheet("members.xlsx", excelLikeWorkbook(), { inflateRaw });
    assert.deepEqual(sheets.map((sheet) => sheet.name), ["Members"], "hidden sheets are left out");
    const rows = sheets[0].rows;
    assert.deepEqual(rows[0].map((cell) => cell.text), ["Member Name", "Mobile No.", "", "Valid Till"]);
    assert.deepEqual(rows[1], [], "an empty row keeps its place, so row numbers match the file");
    assert.equal(rows[2][0].text, "Riya Shah & Co", "rich text runs are joined; phonetic hints are ignored");
    assert.deepEqual(rows[2][1], { text: "9876543210", number: 9876543210 }, "a phone stored as a number keeps every digit");
    assert.equal(rows[2][3].date, "2026-11-30", "built-in date format 14");
    assert.equal(rows[3][0].text, "नेहा पाटील");
    assert.equal(rows[3][1].text, "+91 98765-43211");
    assert.equal(rows[3][2].text, "TRUE");
    assert.equal(rows[3][3].date, "2026-12-01", "a custom dd-mmm-yy format is a date");
    const in1904 = await readSpreadsheet("members.xlsx", excelLikeWorkbook(true), { inflateRaw });
    assert.equal(in1904.sheets[0].rows[2][3].date, "2030-12-01", "the 1904 date system is honoured");
});

test("the template and other workbooks we write open again with the same values", async () => {
    const bytes = writeXlsx([
        { name: "Members", rows: [TEMPLATE_HEADERS, ["Riya Shah", "+919876543210", "Monthly", "01/11/2026", "", 1500, "=SUM(A1) & <b>\"quoted\""]] },
        { name: "How/to:fill?", rows: [["Column", "What to write"], ["Name", "नाम"]] }
    ]);
    assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
    const { sheets } = await readSpreadsheet("template.xlsx", bytes, { inflateRaw });
    assert.deepEqual(sheets.map((sheet) => sheet.name), ["Members", "How to fill"]);
    assert.deepEqual(sheets[0].rows[0].map((cell) => cell.text), TEMPLATE_HEADERS);
    assert.deepEqual(sheets[0].rows[1].map((cell) => cell.text), ["Riya Shah", "+919876543210", "Monthly", "01/11/2026", "", "1500", "=SUM(A1) & <b>\"quoted\""]);
    assert.equal(sheets[1].rows[1][1].text, "नाम");
    assert.match(new TextDecoder().decode(bytes), /t="inlineStr"><is><t xml:space="preserve">=SUM/, "text that looks like a formula is stored as text");
    assert.equal(columnName(0), "A");
    assert.equal(columnName(27), "AB");
});

test("CSV files are read with commas, semicolons or tabs, quotes and a byte-order mark", async () => {
    const comma = await readSpreadsheet("members.csv", new TextEncoder().encode("﻿Name,Mobile\r\n\"Shah, Riya\",\"98765 43210\"\r\n\"Dev \"\"DJ\"\" Rao\",9876543211\n"));
    assert.deepEqual(comma.sheets[0].rows.map((row) => row.map((cell) => cell.text)), [["Name", "Mobile"], ["Shah, Riya", "98765 43210"], ["Dev \"DJ\" Rao", "9876543211"]]);
    assert.deepEqual(parseDelimited("Name;Phone\nRiya;9876543210").map((row) => row.map((cell) => cell.text)), [["Name", "Phone"], ["Riya", "9876543210"]]);
    assert.deepEqual(parseDelimited("Name\tPhone\nRiya\t9876543210")[1].map((cell) => cell.text), ["Riya", "9876543210"]);
    assert.throws(() => parseDelimited("Name\n\"Riya"), SpreadsheetError);
});

test("old .xls files, damaged files and non-spreadsheets get a clear message", async () => {
    await assert.rejects(readSpreadsheet("old.xls", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0])), /older Excel file \(\.xls\).*Save As/);
    await assert.rejects(readSpreadsheet("broken.xlsx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])), /not a readable Excel file/);
    await assert.rejects(readSpreadsheet("photo.csv", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0])), /not a spreadsheet/);
    assert.equal(excelSerialToDate(46356), "2026-11-30");
    assert.equal(excelSerialToDate(-1), "");
});

// ---------- Columns, phones, dates and amounts ----------

test("the header row is found under a title row, and columns are matched by their usual names", () => {
    const rows = [cells("Power Gym members 2026"), [], cells("S.No", "Member Name", "Mobile No.", "Package", "DOJ", "Valid Till", "Fees Paid", "Remarks"), cells("1", "Riya", "9876543210")];
    const header = findHeaderRow(rows);
    assert.equal(header, 2);
    assert.deepEqual(guessColumns(rows[header]), { name: 1, phone: 2, plan: 3, startDate: 4, endDate: 5, amountPaid: 6, notes: 7 });
    assert.deepEqual(guessColumns(cells("Name", "Phone", "Plan", "Start date", "End date", "Amount paid", "Notes")), { name: 0, phone: 1, plan: 2, startDate: 3, endDate: 4, amountPaid: 5, notes: 6 });
    assert.equal(guessColumns(cells("Customer", "Address")).phone, -1);
});

test("Indian phone numbers are accepted with +91, 91, 0, spaces or dashes", () => {
    for (const value of ["9876543210", "+91 98765 43210", "+91-98765-43210", "919876543210", "098765 43210", "(+91) 98765.43210"]) {
        assert.equal(importPhone({ text: value }).phone, "9876543210", value);
    }
    assert.match(importPhone({ text: "9.88E+09" }).problem, /shortened by the spreadsheet/);
    assert.match(importPhone({ text: "12345" }).problem, /not a 10-digit Indian mobile/);
    assert.match(importPhone({ text: "98765 4321O" }).problem, /not a mobile number/);
    assert.match(importPhone({ text: "5876543210" }).problem, /not a 10-digit/);
    assert.equal(importPhone({ text: "" }).problem, "phone is missing");
});

test("dates are read day first: DD/MM/YYYY, DD-MM-YY, month names and Excel dates", () => {
    const read = (text) => importDate({ text }).date;
    assert.equal(read("05/11/2026"), "2026-11-05");
    assert.equal(read("5-11-26"), "2026-11-05");
    assert.equal(read("05.11.2026"), "2026-11-05");
    assert.equal(read("2026-11-05"), "2026-11-05");
    assert.equal(read("5 Nov 2026"), "2026-11-05");
    assert.equal(read("05-Nov-26"), "2026-11-05");
    assert.equal(read("November 5, 2026"), "2026-11-05");
    assert.equal(read("46331"), "2026-11-05", "an Excel date that lost its format");
    assert.equal(importDate({ text: "x", date: "2026-11-05" }).date, "2026-11-05");
    for (const bad of ["31/02/2026", "13/13/2026", "next month", "5/11"]) assert.match(importDate({ text: bad }).problem, /not a date we can read/, bad);
    assert.deepEqual(importDate({ text: "" }), { date: "", problem: "" });
});

test("amounts paid accept ₹, Rs., commas and /-; blank means nothing was paid", () => {
    assert.equal(importAmount({ text: "₹1,500" }).amount, 1500);
    assert.equal(importAmount({ text: "Rs. 1500/-" }).amount, 1500);
    assert.equal(importAmount({ text: "1500.50" }).amount, 1500.5);
    assert.deepEqual(importAmount({ text: "" }), { amount: 0, problem: "" });
    assert.match(importAmount({ text: "paid" }).problem, /not a number/);
    assert.equal(guessPlanDays("Quarterly"), 90);
    assert.equal(guessPlanDays("3 Months"), 90);
    assert.equal(guessPlanDays("Annual"), 365);
    assert.equal(guessPlanDays("Gold"), 0);
});

// ---------- What will be saved ----------

const monthly = { id: "00000000-0000-4000-8000-000000000101", name: "Monthly", duration_days: 30, is_active: true };
const header = cells("Name", "Phone", "Plan", "Start date", "End date", "Amount paid", "Notes");
const columns = guessColumns(header);
const sheet = (...rows) => [header, ...rows.map((values) => cells(...values))];

test("rows are sorted into ready, needing attention and already a member, with a reason each", () => {
    const rows = readImportRows(sheet(
        ["Riya Shah", "98765 43210", "monthly ", "01/11/2026", "", "1000", "Morning"],
        ["Dev Rao", "9876543211", "Gold", "", "31/12/2026", "", ""],
        ["", "9876543212", "", "", "", "", ""],
        ["riya@example.com", "9876543213", "", "", "", "", ""],
        ["Same Phone", "+919876543210", "", "", "", "", ""],
        ["Has Dates", "9876543214", "", "01/11/2026", "", "", ""],
        ["No Dates", "9876543215", "Monthly", "", "", "", ""],
        ["Paid Only", "9876543216", "", "", "", "500", ""],
        ["Bad Date", "9876543217", "Monthly", "31/02/2026", "", "", ""],
        ["Existing Member", "9876543218", "Monthly", "01/11/2026", "", "", ""],
        ["", "", "", "", "", "", ""]
    ), 0, columns);
    assert.equal(rows.length, 10, "empty rows are left out");
    assert.equal(rows[0].rowNumber, 2, "row numbers are the file's");
    assert.deepEqual(unknownPlans(rows, [monthly]).map((plan) => [plan.key, plan.count]), [["", 2], ["gold", 1]]);

    const existingMembers = [{ id: "m-existing", name: "Kabir Mehta", phone: "+91 98765 43218" }];
    const result = planImport(rows, { activePlans: [monthly], planChoices: { gold: { action: "create", name: "Gold", durationDays: 90, price: 2500 } }, existingMembers });
    assert.deepEqual(result.ready.map((row) => row.rowNumber), [2, 3]);
    assert.equal(result.ready[0].endDate, "2026-11-30", "a start date alone uses the plan's length");
    assert.equal(result.ready[1].startDate, "2026-10-03", "an end date alone counts back the new plan's length");
    assert.deepEqual(result.duplicates.map((row) => [row.rowNumber, row.existing.name]), [[11, "Kabir Mehta"]]);
    const reasons = Object.fromEntries(result.problems.map((row) => [row.rowNumber, row.reasons.join("; ")]));
    assert.deepEqual(reasons, {
        4: "name is missing",
        5: "name looks like an email address",
        6: "same phone as row 2",
        7: "dates or an amount paid but no plan",
        8: "plan needs a start date or an end date",
        9: "dates or an amount paid but no plan",
        10: "start date \"31/02/2026\" is not a date we can read; use DD/MM/YYYY; plan needs a start date or an end date"
    });
    assert.deepEqual(result.payload, {
        update_existing: false,
        new_plans: [{ ref: "new-1", name: "Gold", duration_days: 90, price: 2500 }],
        rows: [
            { row: 2, full_name: "Riya Shah", phone: "9876543210", notes: "Morning", plan: { id: monthly.id }, start_date: "2026-11-01", end_date: "2026-11-30", amount_paid: 1000 },
            { row: 3, full_name: "Dev Rao", phone: "9876543211", notes: null, plan: { ref: "new-1" }, start_date: "2026-10-03", end_date: "2026-12-31", amount_paid: null }
        ]
    });
    for (const row of result.payload.rows) {
        assert.deepEqual(Object.keys(row).filter((key) => /consent|opt_in|whatsapp|photo/.test(key)), [], "an import never carries consent");
    }
});

test("plans can be mapped or skipped, and existing members updated unless their plan overlaps", () => {
    const rows = readImportRows(sheet(
        ["Kabir S Mehta", "9876543218", "1 month", "01/12/2026", "", "", "Evening"],
        ["Kabir Again", "9876543219", "1 month", "01/11/2026", "", "", ""],
        ["Skipped Plan", "9876543220", "Trial", "01/11/2026", "", "", ""]
    ), 0, columns);
    const existingMembers = [{ id: "m1", name: "Kabir Mehta", phone: "9876543218" }, { id: "m2", name: "Asha Nair", phone: "9876543219" }];
    const memberships = [{ member_id: "m2", start_date: "2026-11-10", end_date: "2026-12-09", status: "assigned" }];
    const result = planImport(rows, {
        activePlans: [monthly],
        planChoices: { "1 month": { action: "map", planId: monthly.id }, trial: { action: "skip" } },
        existingMembers, memberships, duplicateMode: "update"
    });
    assert.deepEqual(result.ready.map((row) => [row.rowNumber, row.existing?.id]), [[2, "m1"]]);
    assert.equal(result.updates, 1);
    assert.equal(result.existingMatches, 2, "a match that overlaps still counts, so the skip/update choice stays on screen");
    assert.equal(result.payload.update_existing, true);
    assert.deepEqual(result.problems.map((row) => row.reasons[0]), ["Asha Nair already has a plan from 2026-11-10 to 2026-12-09", "plan \"Trial\" was set to be skipped"]);

    const skipped = skippedRows(result, ["Name", "Phone", "Plan", "Start date", "End date", "Amount paid", "Name"]);
    assert.deepEqual(Object.keys(skipped[0]), ["Row in file", "Name", "Phone", "Plan", "Start date", "End date", "Amount paid", "Name (2)", "Why it was skipped"]);
    assert.equal(skipped[0]["Row in file"], 3);
    assert.equal(skipped[1]["Why it was skipped"], "plan \"Trial\" was set to be skipped");
});

test("names follow the member rules: empty, email-like and non-letter names are flagged per row", () => {
    const rows = readImportRows(sheet(["Riya Shah", "9876543210"], ["riya@example.com", "9876543211"], ["", "9876543212"], ["R2D2", "9876543213"], ["  Kabir   Mehta ", "9876543214"]), 0, columns);
    assert.deepEqual(rows.map((row) => row.problems), [[], ["name looks like an email address"], ["name is missing"], ["name must use letters (spaces, dots, apostrophes and hyphens are fine)"], []]);
    assert.equal(rows[4].name, "Kabir Mehta");
});

// ---------- The server's checks ----------

function invoke(middleware, request) {
    const response = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    let nextCalled = false;
    middleware(request, response, () => { nextCalled = true; });
    return { request, response, nextCalled };
}

const validRow = { row: 2, full_name: "Riya Shah", phone: "9876543210", notes: null, plan: { id: monthly.id }, start_date: "2026-11-01", end_date: null, amount_paid: 500 };

test("the server checks every row again before saving", () => {
    const ok = invoke(validateImportPayload, { body: { update_existing: false, new_plans: [], rows: [validRow] } });
    assert.equal(ok.nextCalled, true);
    assert.equal(ok.request.importPayload.rows[0].full_name, "Riya Shah");
    for (const [rows, message] of [
        [[{ ...validRow, full_name: "riya@example.com" }], /Row 2: the name looks like an email address/],
        [[{ ...validRow, phone: "12345" }], /Row 2: the phone number is not a 10-digit/],
        [[validRow, { ...validRow, row: 7 }], /Row 7: this phone number is also on row 2/],
        [[{ ...validRow, plan: null }], /Row 2: an amount paid needs a plan/],
        [[{ ...validRow, start_date: null }], /Row 2: the plan needs a start date or an end date/],
        [[{ ...validRow, start_date: "2026-02-30" }], /Row 2: check the start date/],
        [[{ ...validRow, end_date: "2026-10-01" }], /Row 2: the end date is before the start date/],
        [[{ ...validRow, plan: { ref: "new-9" } }], /Row 2: the new plan is missing/],
        [[{ ...validRow, whatsapp_opt_in: true }], /Row 2: check/],
        [[], /no members to import/],
        [Array.from({ length: 2001 }, (_, index) => ({ ...validRow, row: index + 2, phone: `98765${String(index).padStart(5, "0")}` })), /at most 2000/]
    ]) {
        const result = invoke(validateImportPayload, { body: { update_existing: false, new_plans: [], rows } });
        assert.equal(result.nextCalled, false, String(message));
        assert.equal(result.response.statusCode, 400);
        assert.match(result.response.body.message, message);
    }
});

test("only the gym owner can import members", () => {
    const guard = ownerOnly("Only the gym owner can import members.");
    for (const role of ["staff", "admin", null]) {
        const result = invoke(guard, { gymRole: role });
        assert.equal(result.nextCalled, false);
        assert.equal(result.response.statusCode, 403);
        assert.match(result.response.body.message, /import members/);
    }
    assert.equal(invoke(guard, { gymRole: "owner" }).nextCalled, true);
    assert.match(invoke(requireOwner, { gymRole: "staff" }).response.body.message, /check-in settings/);
});

test("the database's reason is shown when an import is refused, and nothing is saved", async () => {
    const reply = (error, data = null) => ({ rpc: async (name, args) => { assert.equal(name, "gympulse_import_members"); assert.ok(args.p_gym_id && args.p_payload); return { data, error }; } });
    assert.deepEqual(await importMembers({ rows: [] }, "gym", reply(null, { created: 2, updated: 1, memberships: 2, payments: 1, plans_created: 0 })), { created: 2, updated: 1, memberships: 2, payments: 1, plans_created: 0 });
    await assert.rejects(importMembers({}, "gym", reply({ code: "23505", message: "Row 3: Riya Shah already has this phone number." })), (error) => error.status === 409 && error.message === "Nothing was saved. Row 3: Riya Shah already has this phone number.");
    await assert.rejects(importMembers({}, "gym", reply({ code: "22023", message: "Row 4: an amount paid needs a plan." })), (error) => error.status === 400);
    await assert.rejects(importMembers({}, "gym", reply({ code: "PGRST202", message: "not found" })), (error) => error.status === 503 && /016/.test(error.message));
    await assert.rejects(importMembers({}, "gym", reply({ code: "XX000", message: "internal detail" })), (error) => error.status === 500 && !/internal detail/.test(error.message));
});
