import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/004_create_member_memberships.sql", import.meta.url), "utf8");
const archiveMigration = readFileSync(new URL("../migrations/005_add_members_archived_at.sql", import.meta.url), "utf8");
const feesMigration = readFileSync(new URL("../migrations/008_add_membership_total_fees.sql", import.meta.url), "utf8");
const assignmentFunction = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION public.gympulse_assign_member_plan"));

test("archive migration adds a nullable timestamp without deleting member records", () => {
    assert.match(archiveMigration, /ADD COLUMN IF NOT EXISTS archived_at timestamptz/i);
    assert.doesNotMatch(archiveMigration, /\bDELETE\b|\bDROP\b/i);
});

test("assignment SQL retains the member lock and overlap guard and locks the plan for share", () => {
    assert.match(assignmentFunction, /WHERE id = p_member_id\s+FOR UPDATE/);
    assert.match(assignmentFunction, /FOR SHARE;/);
    assert.doesNotMatch(assignmentFunction, /FOR KEY SHARE/);
    assert.match(assignmentFunction, /start_date <= v_end_date\s+AND end_date >= p_start_date/);
});

test("assignment SQL rejects null start dates and synchronizes current before nearest upcoming history", () => {
    assert.match(migration, /ALTER COLUMN membership_start_date DROP NOT NULL,\s+ALTER COLUMN membership_end_date DROP NOT NULL/);
    assert.match(assignmentFunction, /IF p_start_date IS NULL THEN\s+RAISE EXCEPTION 'Membership start date is required\.'/);
    assert.match(assignmentFunction, /status <> 'cancelled'/);
    assert.match(assignmentFunction, /end_date >= v_today/);
    assert.match(assignmentFunction, /CASE WHEN start_date <= v_today THEN 0 ELSE 1 END,\s+start_date ASC/);
    assert.match(assignmentFunction, /SET membership_start_date = v_legacy_start_date,\s+membership_end_date = v_legacy_end_date/);
});

test("fee migration backfills membership totals and returns the stored assignment fee", () => {
    assert.match(feesMigration, /ADD COLUMN IF NOT EXISTS total_fees numeric\(12, 2\)/i);
    assert.match(feesMigration, /SET total_fees = price\s+WHERE total_fees IS NULL/i);
    assert.match(feesMigration, /p_total_fees numeric/i);
    assert.match(feesMigration, /total_fees, start_date, end_date/i);
    assert.match(feesMigration, /COALESCE\(p_total_fees, v_plan\.price\)/i);
    assert.match(feesMigration, /RETURNS SETOF public\.member_memberships/i);
});
