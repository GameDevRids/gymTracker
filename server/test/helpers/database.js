// Runs the real migrations in PGlite (Postgres compiled to WebAssembly) so SQL behaviour,
// triggers and row level security can be tested without a Supabase project.
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const migrationsDir = new URL("../../migrations/", import.meta.url);

// The parts of Supabase that the migrations rely on: the auth schema, auth.uid() and the API roles.
const supabaseStubs = `
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text, created_at timestamptz NOT NULL DEFAULT now());
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, service_role;
`;

export function migrationFiles() {
    return readdirSync(migrationsDir).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort();
}

export async function createMigratedDatabase({ upTo } = {}) {
    const db = new PGlite();
    await db.exec(supabaseStubs);
    for (const name of migrationFiles()) {
        if (upTo && name > upTo) break;
        try {
            await db.exec(readFileSync(new URL(name, migrationsDir), "utf8"));
        } catch (error) {
            throw new Error(`${name} failed: ${error.message}`);
        }
    }
    return db;
}

export async function applyMigration(db, name) {
    await db.exec(readFileSync(new URL(name, migrationsDir), "utf8"));
}
