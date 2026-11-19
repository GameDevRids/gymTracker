// Stage 6 of the live-app review: the page title once, no "Workspace" heading (the gym's city
// instead), one marigold action per screen, the legal pages in the app's light theme, contrast of
// the status pills and grey text (at least 4.5:1, read from the real CSS) and 44px text-link taps.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installPhotoDom } from "./helpers/fakeDom.js";
import { gymArea, watchPageTitle } from "../../assets/js/layout.js";

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const boot = installPhotoDom();
const { renderProfile, renderMembers } = await import("../../assets/js/modules/members.js");
const { state, memberFromApiRow } = await import("../../assets/js/state.js");
boot.restore();

const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const theme = source("assets/css/theme.css");

// ---------- Contrast ----------

const token = (name) => {
    const match = theme.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`));
    assert.ok(match, `token --${name}`);
    return match[1];
};
const luminance = (hex) => {
    const [r, g, b] = hex.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
// Colours a rule sets, resolving var(--token).
const ruleColours = (selector) => {
    const line = theme.split("\n").find((text) => text.startsWith(`${selector} `) || text.startsWith(`${selector},`));
    assert.ok(line, selector);
    const value = (prop) => {
        const raw = line.match(new RegExp(`(?:^|[;{\\s])${prop}:\\s*([^;]+);`))?.[1].trim();
        const variable = raw?.match(/var\(--([\w-]+)/)?.[1];
        return variable ? token(variable) : raw;
    };
    return { color: value("color"), background: value("background") };
};

test("status pills (Active, Upcoming, On hold, In grace, Lapsed, Old) have at least 4.5:1", () => {
    for (const selector of [".status", ".status-suspended", ".status-on_hold", ".status-in_grace", ".status-lapsed", ".status-old"]) {
        const { color, background } = ruleColours(selector);
        const ratio = contrast(color, background);
        assert.ok(ratio >= 4.5, `${selector} ${color} on ${background}: ${ratio.toFixed(2)}`);
    }
    assert.ok(contrast(token("leaf-strong"), token("leaf-tint")) > 6, "Active pill now uses the darker green");
});

test("grey helper text has at least 4.5:1 on every surface it sits on", () => {
    for (const surface of ["surface", "canvas", "slate-soft", "marigold-tint"]) {
        const ratio = contrast(token("ink-3"), token(surface));
        assert.ok(ratio >= 4.5, `ink-3 on ${surface}: ${ratio.toFixed(2)}`);
    }
    assert.match(theme, /^\.helper-text \{ color: var\(--ink-3\)/m);
});

test("text links used as buttons are at least 44px tall on every screen size", () => {
    assert.match(theme, /\.text-button \{ display: inline-flex; align-items: center; min-height: 44px; \}/);
    assert.match(theme, /\.settings-section \.helper-text a \{ display: inline-flex; align-items: center; min-height: 44px; \}/);
});

// ---------- Page title once ----------

test("the top bar title shows only after the big page title has scrolled past", () => {
    assert.match(theme, /\.topbar \.topbar-title \{ opacity: 0;/);
    assert.match(theme, /\.topbar\.title-shown \.topbar-title \{ opacity: 1; \}/);
    let observed = null;
    let callback = null;
    globalThis.IntersectionObserver = class { constructor(fn) { callback = fn; } observe(el) { observed = el; } disconnect() {} };
    const classes = new Set();
    const title = { aria: null, setAttribute(_name, value) { this.aria = value; } };
    const topbar = { classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) }, querySelector: () => title, getBoundingClientRect: () => ({ height: 64 }) };
    const h1 = {};
    watchPageTitle({ querySelector: () => h1 }, topbar);
    assert.equal(observed, h1);
    assert.equal(classes.has("title-shown"), false, "hidden while the big title is on screen");
    callback([{ isIntersecting: false }]);
    assert.equal(classes.has("title-shown"), true, "shown once it scrolls past");
    assert.equal(title.aria, "false");
    watchPageTitle({ querySelector: () => null }, topbar);
    assert.equal(classes.has("title-shown"), true, "pages without a big title keep the top bar title");
    delete globalThis.IntersectionObserver;
    assert.match(source("assets/js/main.js"), /watchPageTitle\(page, document\.querySelector\("\.topbar"\)\)/);
});

// ---------- Sidebar ----------

test("no 'Workspace' heading; under the gym name its city or area, or nothing", () => {
    const html = source("index.html");
    assert.doesNotMatch(html, /WORKSPACE|Gym workspace/);
    assert.match(html, /<small id="gym-area-label" hidden><\/small>/);
    assert.equal(gymArea("12 MG Road, Indiranagar, Bengaluru, Karnataka 560038"), "Bengaluru");
    assert.equal(gymArea("Shop 4, Baner Road, Pune 411045, Maharashtra, India"), "Pune");
    assert.equal(gymArea("Koramangala, Bengaluru"), "Bengaluru");
    assert.equal(gymArea("Near bus stand\nNashik"), "Nashik");
    assert.equal(gymArea(""), "");
    assert.equal(gymArea("560038, India"), "");
});

// ---------- One marigold action per screen ----------

test("the profile has one marigold button; empty lists offer their action as secondary", () => {
    state.members = [memberFromApiRow({ id: "00000000-0000-4000-8000-000000000061", full_name: "Riya Shah", member_code: "GP-61", phone: "9876543261", member_status: "expiring", status_detail: { days_left: 2 } })];
    const profile = renderProfile("00000000-0000-4000-8000-000000000061");
    assert.equal((profile.match(/class="button button-primary/g) || []).length, 1);
    assert.match(profile, /button-secondary" data-action="assign-member-plan"[^>]*>Assign plan</);
    state.members = [];
    assert.equal((renderMembers({}).match(/class="button button-primary/g) || []).length, 1, "Add member in the header only");
    assert.match(source("assets/js/modules/plans.js"), /emptyState\("No plans yet\.[^)]*button-secondary/);
    assert.match(source("assets/js/modules/holds.js"), /button-secondary" type="button" data-action="hold-resume"/);
});

// ---------- Legal pages ----------

test("/privacy and /terms use the app's light theme, with no dark mode", () => {
    const legal = source("assets/css/legal.css");
    assert.doesNotMatch(legal, /prefers-color-scheme/);
    assert.match(legal, /--legal-bg: #F2F4F5;/);
    assert.match(legal, /--legal-text: #1E2D3A;/);
    assert.match(legal, /color-scheme: light;/);
    for (const page of ["privacy.html", "terms.html"]) assert.match(source(page), /family=Anek\+Latin[^"]*family=Mukta/, page);
    assert.ok(contrast("#52606B", "#FFFFFF") >= 4.5, "legal muted text");
});
