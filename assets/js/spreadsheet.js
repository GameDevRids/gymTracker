// Reading and writing spreadsheets without a library: .xlsx (Excel, Google Sheets, LibreOffice)
// and .csv. An .xlsx file is a ZIP of XML files; this reads the cell values of each visible
// sheet and writes simple workbooks (the import template, exports). No DOM access, so it is
// tested in Node; the browser's DecompressionStream inflates the compressed parts.
//
// A cell is { text } plus, when the file says so, { number } or { date: "YYYY-MM-DD" }.

export class SpreadsheetError extends Error {}

const MAX_ROWS = 20000;
const textDecoder = new TextDecoder("utf-8");

// ---------- ZIP ----------

function u16(bytes, offset) { return bytes[offset] | (bytes[offset + 1] << 8); }
function u32(bytes, offset) { return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0; }

function zipEntries(bytes) {
    let end = -1;
    for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset -= 1) {
        if (u32(bytes, offset) === 0x06054b50) { end = offset; break; }
    }
    if (end < 0) throw new SpreadsheetError("This file is not a readable Excel file. Save it again as .xlsx or CSV and try again.");
    const count = u16(bytes, end + 10);
    let offset = u32(bytes, end + 16);
    if (count === 0xffff || offset === 0xffffffff) throw new SpreadsheetError("This Excel file is too large to read here. Save it as CSV and try again.");
    const entries = new Map();
    for (let index = 0; index < count; index += 1) {
        if (u32(bytes, offset) !== 0x02014b50) throw new SpreadsheetError("This Excel file looks damaged. Save it again as .xlsx or CSV and try again.");
        const method = u16(bytes, offset + 10);
        const compressedSize = u32(bytes, offset + 20);
        const nameLength = u16(bytes, offset + 28);
        const extraLength = u16(bytes, offset + 30);
        const commentLength = u16(bytes, offset + 32);
        const localOffset = u32(bytes, offset + 42);
        const name = textDecoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
        const localStart = localOffset + 30 + u16(bytes, localOffset + 26) + u16(bytes, localOffset + 28);
        entries.set(name.replace(/^\/+/, ""), { method, data: bytes.subarray(localStart, localStart + compressedSize) });
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

/** The browser's built-in "deflate-raw" decompression (Chrome, Safari 16.4+, Firefox 113+). */
export async function browserInflateRaw(data) {
    if (typeof DecompressionStream === "undefined") {
        throw new SpreadsheetError("This browser cannot open Excel files. Update it, or save the sheet as CSV and try again.");
    }
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function entryText(entries, name, inflateRaw) {
    const entry = entries.get(name);
    if (!entry) return null;
    if (entry.method === 0) return textDecoder.decode(entry.data);
    if (entry.method === 8) return textDecoder.decode(await inflateRaw(entry.data));
    throw new SpreadsheetError("This Excel file uses a format that cannot be read here. Save it as CSV and try again.");
}

// ---------- XML ----------

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

export function decodeXml(text) {
    return String(text).replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (match, entity) => {
        if (entity[0] !== "#") return ENTITIES[entity.toLowerCase()] ?? match;
        const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    });
}

function attributes(tag) {
    const result = {};
    for (const [, name, double, single] of String(tag).matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        // A prefixed id (r:id, or another prefix for the same namespace) links a sheet to its file.
        const local = name.includes(":") && !name.startsWith("xmlns") ? name.split(":").pop() : name;
        result[local === "id" && name.includes(":") ? "r:id" : local] = decodeXml(double ?? single);
    }
    return result;
}

// Elements may carry a namespace prefix (<x:c>), so every pattern allows one.
const element = (name) => new RegExp(`<(?:\\w+:)?${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:\\w+:)?${name}>)`, "g");
const textRuns = (xml) => [...String(xml).replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, "").matchAll(element("t"))].map((match) => decodeXml(match[2] ?? "")).join("");

// Built-in Excel number formats that show dates.
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function isDateFormat(code) {
    const cleaned = String(code || "").replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
    return /[dy]/i.test(cleaned) && !/^[#0.,%\s]*$/.test(cleaned);
}

function dateStyles(stylesXml) {
    if (!stylesXml) return [];
    const custom = new Map([...stylesXml.matchAll(element("numFmt"))].map((match) => {
        const attrs = attributes(match[1]);
        return [Number(attrs.numFmtId), attrs.formatCode];
    }));
    const cellXfs = stylesXml.match(/<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/)?.[1] || "";
    return [...cellXfs.matchAll(element("xf"))].map((match) => {
        const id = Number(attributes(match[1]).numFmtId || 0);
        return DATE_FORMAT_IDS.has(id) || (custom.has(id) && isDateFormat(custom.get(id)));
    });
}

/** "YYYY-MM-DD" for an Excel date serial number (1900 or 1904 date system). */
export function excelSerialToDate(serial, date1904 = false) {
    if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return "";
    const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    return new Date(base + Math.floor(serial) * 86400000).toISOString().slice(0, 10);
}

function numberText(number) {
    const rounded = Math.round(number * 1e10) / 1e10;
    return Number.isInteger(rounded) && Math.abs(rounded) < 1e21 ? BigInt(rounded).toString() : String(rounded);
}

function columnIndex(reference) {
    const letters = /^([A-Z]+)/i.exec(String(reference || ""))?.[1]?.toUpperCase();
    if (!letters) return -1;
    return [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

export function columnName(index) {
    let name = "";
    for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
    return name;
}

function readSheet(xml, sharedStrings, styles, date1904) {
    const rows = [];
    let nextRow = 0;
    for (const rowMatch of xml.matchAll(element("row"))) {
        const rowNumber = Number(attributes(rowMatch[1]).r) || nextRow + 1;
        nextRow = rowNumber;
        if (rowNumber > MAX_ROWS) throw new SpreadsheetError(`This sheet has more than ${MAX_ROWS} rows. Split it into smaller files and import them one by one.`);
        const cells = [];
        let nextColumn = 0;
        for (const cellMatch of String(rowMatch[2] || "").matchAll(element("c"))) {
            const attrs = attributes(cellMatch[1]);
            const column = attrs.r ? columnIndex(attrs.r) : nextColumn;
            nextColumn = column + 1;
            const inner = cellMatch[2] || "";
            const raw = inner.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1];
            const value = raw === undefined ? "" : decodeXml(raw);
            let cell;
            if (attrs.t === "s") cell = { text: sharedStrings[Number(value)] ?? "" };
            else if (attrs.t === "inlineStr") cell = { text: textRuns(inner.match(/<(?:\w+:)?is\b[^>]*>([\s\S]*?)<\/(?:\w+:)?is>/)?.[1] || "") };
            else if (attrs.t === "str" || attrs.t === "e") cell = { text: value };
            else if (attrs.t === "b") cell = { text: value === "1" ? "TRUE" : "FALSE" };
            else if (attrs.t === "d") cell = { text: value, ...(/^\d{4}-\d{2}-\d{2}/.test(value) ? { date: value.slice(0, 10) } : {}) };
            else if (value === "") cell = { text: "" };
            else {
                const number = Number(value);
                if (!Number.isFinite(number)) cell = { text: value };
                else if (styles[Number(attrs.s || 0)]) {
                    const date = excelSerialToDate(number, date1904);
                    cell = date ? { text: date, number, date } : { text: numberText(number), number };
                } else cell = { text: numberText(number), number };
            }
            cell.text = String(cell.text ?? "").trim();
            if (column >= 0 && column < 1000) cells[column] = cell;
        }
        rows[rowNumber - 1] = Array.from(cells, (cell) => cell || { text: "" });
    }
    return Array.from(rows, (row) => row || []);
}

async function readXlsx(bytes, inflateRaw) {
    const entries = zipEntries(bytes);
    const workbook = await entryText(entries, "xl/workbook.xml", inflateRaw);
    if (!workbook) throw new SpreadsheetError("This file is not an Excel workbook. Save it as .xlsx or CSV and try again.");
    const relations = await entryText(entries, "xl/_rels/workbook.xml.rels", inflateRaw) || "";
    const targets = new Map([...relations.matchAll(element("Relationship"))].map((match) => {
        const attrs = attributes(match[1]);
        const target = String(attrs.Target || "");
        return [attrs.Id, target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`];
    }));
    const sharedXml = await entryText(entries, "xl/sharedStrings.xml", inflateRaw) || "";
    const sharedStrings = [...sharedXml.matchAll(element("si"))].map((match) => textRuns(match[2] || ""));
    const styles = dateStyles(await entryText(entries, "xl/styles.xml", inflateRaw));
    const workbookPr = attributes(workbook.match(/<(?:\w+:)?workbookPr\b([^>]*)/)?.[1] || "");
    const date1904 = ["1", "true"].includes(String(workbookPr.date1904 || "").toLowerCase());
    const sheets = [];
    for (const match of workbook.matchAll(element("sheet"))) {
        const attrs = attributes(match[1]);
        if (["hidden", "veryHidden"].includes(attrs.state)) continue;
        const path = targets.get(attrs["r:id"]) || `xl/worksheets/sheet${sheets.length + 1}.xml`;
        const xml = await entryText(entries, path, inflateRaw);
        if (xml !== null) sheets.push({ name: attrs.name || `Sheet ${sheets.length + 1}`, rows: readSheet(xml, sharedStrings, styles, date1904) });
    }
    if (!sheets.length) throw new SpreadsheetError("No sheets with data were found in this file.");
    return { sheets };
}

// ---------- CSV ----------

/** Rows of text from a CSV (comma, semicolon or tab separated), with quoted fields. */
export function parseDelimited(text) {
    const input = String(text).replace(/^﻿/, "");
    const firstLine = input.slice(0, input.search(/\r?\n|$/));
    const delimiter = [",", ";", "\t"].map((char) => [char, firstLine.split(char).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < input.length; index += 1) {
        const char = input[index];
        if (quoted) {
            if (char === "\"" && input[index + 1] === "\"") { cell += "\""; index += 1; }
            else if (char === "\"") quoted = false;
            else cell += char;
        } else if (char === "\"" && cell.trim() === "") { quoted = true; cell = ""; }
        else if (char === delimiter) { row.push(cell); cell = ""; }
        else if (char === "\n" || char === "\r") {
            if (char === "\r" && input[index + 1] === "\n") index += 1;
            row.push(cell); rows.push(row); row = []; cell = "";
            if (rows.length > MAX_ROWS) throw new SpreadsheetError(`This file has more than ${MAX_ROWS} rows. Split it into smaller files and import them one by one.`);
        } else cell += char;
    }
    if (quoted) throw new SpreadsheetError("This CSV has a quote (\") that is never closed. Check the file and try again.");
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows.map((cells) => cells.map((value) => ({ text: value.trim() })));
}

// ---------- Any file ----------

/**
 * Reads an uploaded .xlsx or .csv file: { sheets: [{ name, rows }] }, rows being arrays of cells.
 * inflateRaw is replaceable so Node tests can use zlib.
 */
export async function readSpreadsheet(fileName, bytes, { inflateRaw = browserInflateRaw } = {}) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const isZip = data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
    const isOldExcel = data[0] === 0xd0 && data[1] === 0xcf && data[2] === 0x11 && data[3] === 0xe0;
    if (isOldExcel) throw new SpreadsheetError("This is an older Excel file (.xls). In Excel choose File › Save As › Excel Workbook (.xlsx), or save it as CSV, then try again.");
    if (isZip) return readXlsx(data, inflateRaw);
    if (/\.(xlsx|xlsm)$/i.test(fileName)) throw new SpreadsheetError("This file is not a readable Excel file. Save it again as .xlsx or CSV and try again.");
    const text = textDecoder.decode(data);
    if (text.includes("\u0000")) throw new SpreadsheetError("This file is not a spreadsheet. Choose an .xlsx or .csv file.");
    return { sheets: [{ name: String(fileName || "CSV").replace(/\.[^.]+$/, ""), rows: parseDelimited(text) }] };
}

// ---------- Writing .xlsx ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
});

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(files, deflateRaw) {
    const encoder = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    const header = (size) => { const buffer = new Uint8Array(size); return { buffer, view: new DataView(buffer.buffer) }; };
    for (const { name, content } of files) {
        const nameBytes = encoder.encode(name);
        const raw = typeof content === "string" ? encoder.encode(content) : content;
        const crc = crc32(raw);
        // Compressed when the caller can deflate (the server); stored as-is otherwise.
        const data = deflateRaw ? deflateRaw(raw) : raw;
        const method = deflateRaw ? 8 : 0;
        const local = header(30);
        local.view.setUint32(0, 0x04034b50, true);
        local.view.setUint16(4, 20, true);
        local.view.setUint16(6, 0x0800, true);
        local.view.setUint16(8, method, true);
        local.view.setUint32(14, crc, true);
        local.view.setUint32(18, data.length, true);
        local.view.setUint32(22, raw.length, true);
        local.view.setUint16(26, nameBytes.length, true);
        parts.push(local.buffer, nameBytes, data);
        const entry = header(46);
        entry.view.setUint32(0, 0x02014b50, true);
        entry.view.setUint16(4, 20, true);
        entry.view.setUint16(6, 20, true);
        entry.view.setUint16(8, 0x0800, true);
        entry.view.setUint16(10, method, true);
        entry.view.setUint32(16, crc, true);
        entry.view.setUint32(20, data.length, true);
        entry.view.setUint32(24, raw.length, true);
        entry.view.setUint16(28, nameBytes.length, true);
        entry.view.setUint32(42, offset, true);
        central.push(entry.buffer, nameBytes);
        offset += 30 + nameBytes.length + data.length;
    }
    const centralSize = central.reduce((total, part) => total + part.length, 0);
    const end = header(22);
    end.view.setUint32(0, 0x06054b50, true);
    end.view.setUint16(8, files.length, true);
    end.view.setUint16(10, files.length, true);
    end.view.setUint32(12, centralSize, true);
    end.view.setUint32(16, offset, true);
    const all = [...parts, ...central, end.buffer];
    const output = new Uint8Array(all.reduce((total, part) => total + part.length, 0));
    let position = 0;
    for (const part of all) { output.set(part, position); position += part.length; }
    return output;
}

const escapeXml = (value) => String(value ?? "")
    // Characters XML 1.0 does not allow are dropped, so Excel always opens the file.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char]);

function sheetXml({ rows = [], widths = [] }) {
    const columns = Math.max(0, ...rows.map((row) => row.length));
    const cols = Array.from({ length: columns }, (_, index) => {
        const width = widths[index] || Math.min(60, Math.max(10, ...rows.slice(0, 200).map((row) => String(row[index] ?? "").length + 2)));
        return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
    }).join("");
    const body = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, column) => {
        const reference = `${columnName(column)}${rowIndex + 1}`;
        const style = rowIndex === 0 ? " s=\"1\"" : "";
        if (typeof value === "number" && Number.isFinite(value)) return `<c r="${reference}"${style}><v>${value}</v></c>`;
        // { date: "YYYY-MM-DD" } is a real Excel date (sorts and filters as a date), shown DD/MM/YYYY.
        if (value && typeof value === "object" && /^d{4}-d{2}-d{2}$/.test(value.date || "")) {
            const [year, month, day] = value.date.split("-").map(Number);
            return `<c r="${reference}" s="2"><v>${(Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86400000}</v></c>`;
        }
        if (value && typeof value === "object") return "";
        if (value === null || value === undefined || value === "") return "";
        // Text is written as an inline string: a spreadsheet shows it as text and never runs it.
        return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
    }).join("")}</row>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols ? `<cols>${cols}</cols>` : ""}<sheetData>${body}</sheetData></worksheet>`;
}

/**
 * A workbook with one or more sheets: [{ name, rows: [[header, ...], [value, ...]], widths? }].
 * Values are text, numbers or { date: "YYYY-MM-DD" }. The first row of each sheet is bold and
 * stays in view while scrolling. Pass deflateRaw (zlib on the server) to compress the file.
 */
export function writeXlsx(sheets, { deflateRaw } = {}) {
    const safeName = (name, index) => (String(name || `Sheet${index + 1}`).replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || `Sheet${index + 1}`);
    const files = [
        { name: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>` },
        { name: "_rels/.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
        { name: "xl/workbook.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${escapeXml(safeName(sheet.name, index))}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>` },
        { name: "xl/_rels/workbook.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
        { name: "xl/styles.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>` },
        ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, content: sheetXml(sheet) }))
    ];
    return zipStore(files, deflateRaw);
}
