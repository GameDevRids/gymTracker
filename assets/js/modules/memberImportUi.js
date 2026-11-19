// "Import members" (owner only): template, column matching, plans, preview, then one save.
// The rules live in memberImport.js; the file is read by spreadsheet.js; the server saves
// everything in one transaction (POST /api/members/import, migration 016).
import { apiClient } from "../api/apiClient.js";
import { fetchPlans } from "../api/plansApi.js";
import { openModal } from "../components/modal.js";
import { toast } from "../components/toast.js";
import { state } from "../state.js";
import { getAllMemberships } from "./memberMemberships.js";
import { downloadCSV, downloadFile, escapeHTML, formatDate, formatINR, formatPhone, formatPlanDuration } from "../utils.js";
import { SpreadsheetError, columnName, readSpreadsheet, writeXlsx } from "../spreadsheet.js";
import {
    IMPORT_FIELDS,
    IMPORT_MAX_ROWS,
    TEMPLATE_HEADERS,
    findHeaderRow,
    guessColumns,
    guessPlanDays,
    planImport,
    planKey,
    readImportRows,
    skippedRows,
    unknownPlans
} from "./memberImport.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const PREVIEW_LIMIT = 100;
const DURATIONS = [[30, "1 month"], [90, "3 months"], [180, "6 months"], [365, "12 months"]];
let job = null;

/** Only the gym's owner imports. */
export function canImportMembers() {
    return state.gym.role === "owner";
}

const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
const sheet = () => job.sheets[job.sheetIndex];
const headers = () => (sheet().rows[job.headerIndex] || []).map((cell) => cell?.text || "");

// ---------- Step 1: start ----------

export function openMemberImport() {
    if (!canImportMembers()) return toast("Only the gym owner can import members.", "error");
    job = { step: "start" };
    renderStart();
}

function renderStart(message = "") {
    openModal({
        title: "Import members",
        subtitle: "Bring in the members you already have in Excel or a register.",
        wide: true,
        body: `<ol class="import-steps">
                <li><strong>Use your own sheet, or our template.</strong> Your columns can have any names; you match them in the next step.</li>
                <li><strong>Check the preview.</strong> Rows with problems are shown with the reason and left out.</li>
                <li><strong>Save.</strong> All members are saved together. If anything fails, nothing is saved.</li>
            </ol>
            <div class="import-actions">
                <button class="button button-secondary" type="button" data-action="import-template">↓ Download template (.xlsx)</button>
                <button class="button button-primary" type="button" data-action="import-choose-file">Choose file (.xlsx or .csv)</button>
            </div>
            ${message ? `<p class="note-box import-error" role="alert">${escapeHTML(message)}</p>` : ""}
            <p class="helper-text">Phones can be written with or without +91, spaces or dashes. Dates can be DD/MM/YYYY, DD-MM-YYYY or Excel dates. Imported members are not sent any WhatsApp message, and no WhatsApp or photo consent is recorded for them; record consent on each member's profile when they agree.</p>`,
        footer: `<button class="button button-secondary" type="button" data-action="close-modal">Cancel</button>`
    });
}

function downloadTemplate() {
    const bytes = writeXlsx([
        { name: "Members", rows: [TEMPLATE_HEADERS], widths: [24, 16, 18, 14, 14, 14, 30] },
        {
            name: "How to fill",
            widths: [16, 90],
            rows: [
                ["Column", "What to write"],
                ["Name", "The member's full name. Required."],
                ["Phone", "10-digit mobile number, with or without +91, spaces or dashes. Required. Each member needs their own number."],
                ["Plan", "The plan name exactly as in GymPulse (Plans page), for example Monthly. New names can be created during the import."],
                ["Start date", "When the current plan started, as DD/MM/YYYY. Leave empty if you only know the end date."],
                ["End date", "When the current plan ends, as DD/MM/YYYY. Leave empty to use the plan's length from the start date."],
                ["Amount paid", "What the member has paid for this plan, in rupees, for example 1500. Leave empty if nothing was paid."],
                ["Notes", "Anything else, for example batch timing."],
                ["", ""],
                ["Example", "Riya Shah | 98765 43210 | Monthly | 01/11/2026 | 30/11/2026 | 1500 | Morning batch"],
                ["Consent", "Importing does not record WhatsApp or photo consent. Ask each member and tick it on their profile."]
            ]
        }
    ]);
    downloadFile("gympulse-members-template.xlsx", bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

// ---------- Step 2: read the file and match columns ----------

export async function handleImportFile(file) {
    if (!file) return;
    if (!job) job = { step: "start" };
    if (file.size > MAX_FILE_BYTES) return renderStart("This file is larger than 10 MB. Save only the members sheet, or split it, and try again.");
    openModal({ title: "Import members", subtitle: escapeHTML(file.name), body: `<div class="empty-state" role="status">Reading ${escapeHTML(file.name)}…</div>` });
    try {
        const [workbook, plans] = await Promise.all([
            file.arrayBuffer().then((buffer) => readSpreadsheet(file.name, new Uint8Array(buffer))),
            fetchAllPlans()
        ]);
        const sheets = workbook.sheets.filter((item) => item.rows.some((row) => row.some((cell) => cell?.text)));
        if (!sheets.length) return renderStart("This file has no rows with data.");
        job = { step: "columns", fileName: file.name, sheets, sheetIndex: 0, plans, activePlans: plans.filter((plan) => plan.is_active), planChoices: {}, duplicateMode: "skip" };
        chooseSheet(0);
        renderColumns();
    } catch (error) {
        renderStart(error instanceof SpreadsheetError ? error.message : `The file could not be read: ${error.message || "please try again"}.`);
    }
}

async function fetchAllPlans() {
    const plans = [];
    for (let page = 1; ; page += 1) {
        const response = await fetchPlans({ page, limit: 100 });
        const rows = response?.data?.plans || [];
        plans.push(...rows);
        const total = Number(response?.data?.pagination?.total ?? plans.length);
        if (!rows.length || plans.length >= total) return plans;
    }
}

function chooseSheet(index) {
    job.sheetIndex = index;
    job.headerIndex = findHeaderRow(sheet().rows);
    job.columns = guessColumns(sheet().rows[job.headerIndex] || []);
}

function samples(column) {
    if (column < 0) return "";
    const values = sheet().rows.slice(job.headerIndex + 1).map((row) => row?.[column]?.text || "").filter(Boolean).slice(0, 3);
    return values.length ? `e.g. ${values.map((value) => escapeHTML(value.slice(0, 30))).join(", ")}` : "No values under this heading";
}

function renderColumns(message = "") {
    const heads = headers();
    const rowOptions = sheet().rows.slice(0, 10).map((row, index) => {
        const preview = (row || []).map((cell) => cell?.text).filter(Boolean).slice(0, 3).join(", ");
        return `<option value="${index}" ${index === job.headerIndex ? "selected" : ""}>Row ${index + 1}${preview ? `: ${escapeHTML(preview.slice(0, 50))}` : " (empty)"}</option>`;
    }).join("");
    const columnOptions = (selected) => `<option value="-1">Not in my file</option>${heads.map((header, index) => `<option value="${index}" ${index === selected ? "selected" : ""}>${escapeHTML(header || `Column ${columnName(index)}`)}</option>`).join("")}`;
    openModal({
        title: "Match your columns",
        subtitle: `${escapeHTML(job.fileName)} · ${escapeHTML(sheet().name)}`,
        wide: true,
        body: `<div class="form-grid">
                ${job.sheets.length > 1 ? `<div class="field"><label for="import-sheet">Sheet</label><select id="import-sheet" data-import="sheet">${job.sheets.map((item, index) => `<option value="${index}" ${index === job.sheetIndex ? "selected" : ""}>${escapeHTML(item.name)}</option>`).join("")}</select></div>` : ""}
                <div class="field"><label for="import-header-row">Column headings are in</label><select id="import-header-row" data-import="header-row">${rowOptions}</select></div>
            </div>
            <p class="helper-text">For each GymPulse field, choose the column in your file. We have guessed where we could.</p>
            <div class="import-columns">${IMPORT_FIELDS.map((field) => `<div class="field"><label for="import-column-${field.key}">${escapeHTML(field.label)}${field.required ? " *" : ""}</label><select id="import-column-${field.key}" data-import-column="${field.key}">${columnOptions(job.columns[field.key])}</select><span class="helper-text">${samples(job.columns[field.key])}</span></div>`).join("")}</div>
            ${message ? `<p class="note-box import-error" role="alert">${escapeHTML(message)}</p>` : ""}`,
        footer: `<button class="button button-secondary" type="button" data-action="import-restart">Back</button><button class="button button-primary" type="button" data-action="import-columns-done">Continue</button>`
    });
}

function finishColumns() {
    if (job.columns.name < 0 || job.columns.phone < 0) return renderColumns("Choose the columns with the member's name and phone number.");
    const used = IMPORT_FIELDS.map((field) => job.columns[field.key]).filter((index) => index >= 0);
    if (new Set(used).size !== used.length) return renderColumns("Each column of your file can be used for one field only.");
    job.rows = readImportRows(sheet().rows, job.headerIndex, job.columns);
    if (!job.rows.length) return renderColumns("There are no rows under the headings. Check the heading row.");
    if (job.rows.length > IMPORT_MAX_ROWS) return renderColumns(`This sheet has ${job.rows.length} members. Import at most ${IMPORT_MAX_ROWS} at a time: split the file and import each part.`);
    job.unknown = unknownPlans(job.rows, job.activePlans);
    if (job.unknown.length) renderPlans();
    else renderPreview();
}

// ---------- Step 3: plans the gym does not have ----------

function choiceValue(choice) {
    if (!choice) return "";
    return choice.action === "map" ? `map:${choice.planId}` : choice.action;
}

function renderPlans(message = "") {
    const options = job.activePlans.map((plan) => `<option value="map:${escapeHTML(plan.id)}">${escapeHTML(plan.name)} · ${escapeHTML(formatPlanDuration(plan.duration_days))} · ${formatINR(plan.price)}</option>`).join("");
    const items = job.unknown.map((entry) => {
        const choice = job.planChoices[entry.key];
        const title = entry.key ? `“${escapeHTML(entry.name)}”` : "Rows with dates or an amount paid, but no plan";
        const create = choice?.action === "create" ? `<div class="form-grid import-new-plan">
                <div class="field"><label>New plan name</label><input data-import-new="${escapeHTML(entry.key)}" data-part="name" value="${escapeHTML(choice.name)}" maxlength="120"></div>
                <div class="field"><label>Length</label><select data-import-new="${escapeHTML(entry.key)}" data-part="durationDays">${DURATIONS.map(([days, label]) => `<option value="${days}" ${Number(choice.durationDays) === days ? "selected" : ""}>${label}</option>`).join("")}${DURATIONS.some(([days]) => days === Number(choice.durationDays)) ? "" : `<option value="${Number(choice.durationDays) || ""}" selected>${Number(choice.durationDays) ? `${Number(choice.durationDays)} days` : "Choose a length"}</option>`}</select></div>
                <div class="field"><label>Price (₹)</label><input data-import-new="${escapeHTML(entry.key)}" data-part="price" type="number" min="0" step="1" inputmode="numeric" value="${escapeHTML(String(choice.price ?? ""))}"></div>
            </div>` : "";
        return `<div class="import-plan-choice"><div class="import-plan-name"><strong>${title}</strong><span class="helper-text">${plural(entry.count, "row")}</span></div>
            <select data-import-plan="${escapeHTML(entry.key)}" aria-label="What to do with ${title}"><option value="">Choose what to do…</option><optgroup label="Use one of your plans">${options}</optgroup><option value="create">Create a new plan</option><option value="skip">Skip these rows</option></select>${create}</div>`;
    }).join("");
    openModal({
        title: "Plans in your file",
        subtitle: "These plan names are not in GymPulse yet. Choose what to do with each.",
        wide: true,
        body: `<div class="import-plans">${items}</div>${message ? `<p class="note-box import-error" role="alert">${escapeHTML(message)}</p>` : ""}`,
        footer: `<button class="button button-secondary" type="button" data-action="import-back-columns">Back</button><button class="button button-primary" type="button" data-action="import-plans-done">Continue</button>`
    });
    // Selected values are set after drawing so a <select> shows the saved choice.
    for (const entry of job.unknown) {
        const select = document.querySelector(`[data-import-plan="${CSS.escape(entry.key)}"]`);
        if (select) select.value = choiceValue(job.planChoices[entry.key]);
    }
}

function finishPlans() {
    const taken = new Set(job.plans.map((plan) => planKey(plan.name)));
    for (const entry of job.unknown) {
        const choice = job.planChoices[entry.key];
        const label = entry.key ? `“${entry.name}”` : "rows without a plan";
        if (!choice) return renderPlans(`Choose what to do with ${label}.`);
        if (choice.action !== "create") continue;
        const name = String(choice.name || "").trim();
        if (!name) return renderPlans(`Give the new plan for ${label} a name.`);
        if (taken.has(planKey(name))) return renderPlans(`A plan called “${name}” already exists. Choose it from your plans, or use another name.`);
        taken.add(planKey(name));
        if (!(Number(choice.durationDays) >= 1 && Number(choice.durationDays) <= 3650)) return renderPlans(`Choose a length for the new plan “${name}”.`);
        if (!(Number(choice.price) >= 0) || String(choice.price).trim() === "") return renderPlans(`Enter a price for the new plan “${name}” (0 or more).`);
    }
    renderPreview();
}

// The most common amount paid among the rows with this plan name: a starting price to edit.
function suggestedPrice(key) {
    const counts = new Map();
    for (const row of job.rows.filter((item) => planKey(item.planName) === key && item.amountPaid > 0)) counts.set(row.amountPaid, (counts.get(row.amountPaid) || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

// ---------- Step 4: preview ----------

function computePlan() {
    job.plan = planImport(job.rows, {
        activePlans: job.activePlans,
        planChoices: job.planChoices,
        existingMembers: state.members.map((member) => ({ id: member.id, name: member.name, phone: member.phone })),
        memberships: getAllMemberships(),
        duplicateMode: job.duplicateMode
    });
}

function planLabel(row) {
    if (!row.plan) return "—";
    return `${escapeHTML(row.plan.name)}${row.plan.ref ? " <span class=\"badge-soft\">new</span>" : ""}`;
}

function renderPreview() {
    computePlan();
    const { ready, problems, duplicates, newMembers, updates, existingMatches: matches } = job.plan;
    const duplicateNote = job.duplicateMode === "update"
        ? "The name and notes from your file replace theirs. The plan and amount paid from your file are added when they don't overlap a plan the member already has."
        : "They are left as they are in GymPulse.";
    const table = (rows, head, cells, empty) => rows.length
        ? `<div class="table-wrap"><table class="import-table"><thead><tr>${head.map((label) => `<th>${label}</th>`).join("")}</tr></thead><tbody>${rows.slice(0, PREVIEW_LIMIT).map((row) => `<tr>${cells(row).map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>${rows.length > PREVIEW_LIMIT ? `<p class="helper-text">Showing the first ${PREVIEW_LIMIT} of ${rows.length}.</p>` : ""}`
        : `<p class="helper-text">${empty}</p>`;
    const dates = (row) => (row.plan ? `${formatDate(row.startDate)} – ${formatDate(row.endDate)}${(row.warnings || []).map((text) => `<small class="cell-sub import-warning">⚠ ${escapeHTML(text)}</small>`).join("")}` : "—");
    const warned = ready.filter((row) => row.warnings?.length).length;
    openModal({
        title: "Check before saving",
        subtitle: `${escapeHTML(job.fileName)} · ${plural(job.rows.length, "row")}`,
        wide: true,
        body: `<div class="summary-row">
                <span class="summary-chip"><strong>${ready.length}</strong> ready to save</span>
                <span class="summary-chip"><strong>${problems.length}</strong> need attention</span>
                ${matches ? `<span class="summary-chip"><strong>${matches}</strong> already in GymPulse</span>` : ""}
            </div>
            ${matches ? `<fieldset class="import-duplicates"><legend>${plural(matches, "row has a phone number", "rows have phone numbers")} that already belong to a member</legend>
                <label class="checkbox-label"><input type="radio" name="import-duplicates" value="skip" data-import="duplicates" ${job.duplicateMode === "skip" ? "checked" : ""}> Skip them</label>
                <label class="checkbox-label"><input type="radio" name="import-duplicates" value="update" data-import="duplicates" ${job.duplicateMode === "update" ? "checked" : ""}> Update those members</label>
                <p class="helper-text">${duplicateNote}</p></fieldset>` : ""}
            <h3 class="import-heading">Ready to save · ${newMembers} new${updates ? ` · ${updates} updated` : ""}</h3>
            ${warned ? `<p class="note-box import-warnings" role="note">${plural(warned, "row has a date", "rows have dates")} worth checking (marked ⚠). They will be saved as they are; go Back to fix your file if they are wrong.</p>` : ""}
            ${table(ready, ["Row", "Name", "Phone", "Plan", "Dates", "Paid"], (row) => [row.rowNumber, `${escapeHTML(row.name)}${row.existing ? " <span class=\"badge-soft\">update</span>" : ""}`, escapeHTML(formatPhone(row.phone)), planLabel(row), dates(row), row.plan && row.amountPaid ? formatINR(row.amountPaid) : "—"], "No rows are ready to save.")}
            ${problems.length ? `<h3 class="import-heading">Need attention · left out</h3>${table(problems, ["Row", "Name", "Phone", "What to fix"], (row) => [row.rowNumber, escapeHTML(row.name || "—"), escapeHTML(row.phoneText || "—"), escapeHTML(row.reasons.join("; "))], "")}` : ""}
            ${duplicates.length ? `<h3 class="import-heading">Already in GymPulse · skipped</h3>${table(duplicates, ["Row", "Name in your file", "Phone", "Member in GymPulse"], (row) => [row.rowNumber, escapeHTML(row.name), escapeHTML(formatPhone(row.phone)), escapeHTML(row.existing.name)], "")}` : ""}
            <p class="note-box" style="margin-top:12px">Imported members are not sent any WhatsApp message, and no WhatsApp or photo consent is recorded. Amounts paid are saved as payments with receipts (method “Other”). Fees are the plan prices.</p>`,
        footer: `<button class="button button-secondary" type="button" data-action="${job.unknown?.length ? "import-back-plans" : "import-back-columns"}">Back</button><button class="button button-primary" type="button" data-action="import-save" ${ready.length ? "" : "disabled"}>Save ${plural(ready.length, "member")}</button>`
    });
}

// ---------- Step 5: save everything at once ----------

async function save(onImported) {
    if (!job?.plan?.ready.length || job.saving) return;
    job.saving = true;
    const count = job.plan.ready.length;
    openModal({
        title: "Saving members…",
        subtitle: escapeHTML(job.fileName),
        body: `<div class="empty-state" role="status">Saving ${plural(count, "member")}. Nothing is saved until every one of them is.</div>`
    });
    try {
        const response = await apiClient.post("/api/members/import", job.plan.payload, { timeoutMs: 120000 });
        job.result = response?.data || {};
        job.saving = false;
        renderDone();
        onImported();
    } catch (error) {
        job.saving = false;
        renderFailed(error.message || "The import could not be saved.");
    }
}

function skippedCount() {
    return job.plan.problems.length + job.plan.duplicates.length;
}

function renderDone() {
    const result = job.result;
    const imported = Number(result.created || 0) + Number(result.updated || 0);
    const skipped = skippedCount();
    const details = [
        result.created ? `${plural(result.created, "new member")}` : "",
        result.updated ? `${plural(result.updated, "member")} updated` : "",
        result.memberships ? `${plural(result.memberships, "plan")} added` : "",
        result.payments ? `${plural(result.payments, "payment")} recorded` : "",
        result.plans_created ? `${plural(result.plans_created, "new plan")} created` : ""
    ].filter(Boolean).join(" · ");
    const message = `Imported ${plural(imported, "member")}${skipped ? `, skipped ${skipped}` : ""}.`;
    if (!document.querySelector("#modal-root .modal")) toast(message);
    openModal({
        title: message,
        subtitle: escapeHTML(job.fileName),
        body: `<p role="status">${escapeHTML(details)}.</p>
            ${skipped ? `<p class="helper-text">The ${plural(skipped, "skipped row")} ${skipped === 1 ? "is" : "are"} in a file you can download, with the reason for each. Fix them there and import that file.</p>` : ""}
            <p class="helper-text">Ask members who want WhatsApp updates, and tick consent on their profile.</p>`,
        footer: `${skipped ? `<button class="button button-secondary" type="button" data-action="import-download-skipped">↓ Download skipped rows (CSV)</button>` : ""}<button class="button button-primary" type="button" data-action="close-modal">Done</button>`
    });
}

function renderFailed(message) {
    if (!document.querySelector("#modal-root .modal")) toast(message, "error");
    openModal({
        title: "Nothing was saved",
        subtitle: escapeHTML(job.fileName),
        body: `<p class="note-box import-error" role="alert">${escapeHTML(message.replace(/^Nothing was saved\.\s*/, ""))}</p><p class="helper-text">No members, plans or payments from this file were saved. Fix the row in your file, or go back to the preview, and try again.</p>`,
        footer: `<button class="button button-secondary" type="button" data-action="close-modal">Close</button><button class="button button-primary" type="button" data-action="import-back-preview">Back to the preview</button>`
    });
}

function downloadSkipped() {
    try {
        downloadCSV(`${String(job.fileName || "members").replace(/\.[^.]+$/, "")}-skipped.csv`, skippedRows(job.plan, headers()));
    } catch (error) {
        toast(error.message || "The skipped rows could not be downloaded.", "error");
    }
}

// ---------- Events ----------

/** Buttons in the import dialogs. Returns true when handled. */
export function handleImportAction(action, _element, onImported) {
    if (!action.startsWith("import-") || action === "import-csv") return false;
    switch (action) {
        case "import-template": downloadTemplate(); break;
        case "import-choose-file": document.querySelector("#import-file")?.click(); break;
        case "import-restart": job = { step: "start" }; renderStart(); break;
        case "import-columns-done": finishColumns(); break;
        case "import-back-columns": renderColumns(); break;
        case "import-plans-done": finishPlans(); break;
        case "import-back-plans": renderPlans(); break;
        case "import-back-preview": renderPreview(); break;
        case "import-save": save(onImported); break;
        case "import-download-skipped": downloadSkipped(); break;
        default: return false;
    }
    return true;
}

/** Selects, radios and inputs in the import dialogs. Returns true when handled. */
export function handleImportChange(target) {
    if (!job) return false;
    if (target.dataset.import === "sheet") {
        chooseSheet(Number(target.value));
        renderColumns();
        return true;
    }
    if (target.dataset.import === "header-row") {
        job.headerIndex = Number(target.value);
        job.columns = guessColumns(sheet().rows[job.headerIndex] || []);
        renderColumns();
        return true;
    }
    if (target.dataset.importColumn) {
        job.columns[target.dataset.importColumn] = Number(target.value);
        renderColumns();
        return true;
    }
    if (target.dataset.importPlan !== undefined) {
        const key = target.dataset.importPlan;
        const entry = job.unknown.find((item) => item.key === key);
        if (!target.value) delete job.planChoices[key];
        else if (target.value === "skip") job.planChoices[key] = { action: "skip" };
        else if (target.value === "create") job.planChoices[key] = { action: "create", name: entry?.name || "", durationDays: guessPlanDays(entry?.name) || 30, price: suggestedPrice(key) };
        else job.planChoices[key] = { action: "map", planId: target.value.slice(4) };
        renderPlans();
        return true;
    }
    if (target.dataset.importNew !== undefined) {
        const choice = job.planChoices[target.dataset.importNew];
        if (choice && ["name", "durationDays", "price"].includes(target.dataset.part)) choice[target.dataset.part] = target.value;
        return true;
    }
    if (target.dataset.import === "duplicates") {
        job.duplicateMode = target.value === "update" ? "update" : "skip";
        renderPreview();
        return true;
    }
    return false;
}
