// Local, disposable Supabase-like database for cutover tests (PGlite; never a remote connection).
// Phase 1 schema + the real Firestore snapshot (approved transform) + cutover migrations + Auth stubs.
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { transform } from "../transform.mjs";
import { applySchema, load } from "../database.mjs";
import { phoneToAuthEmail } from "../../src/lib/authIdentity.ts";

const migrations = new URL("../../supabase/migrations/", import.meta.url);

// Minimal stand-ins for Supabase platform objects the migrations reference.
export const AUTH_STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create table auth.users (id uuid primary key, email text unique, encrypted_password text);
create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to public;
grant usage on schema public to anon, authenticated, service_role;
`;

export function cutoverMigrationFiles() {
  return fs
    .readdirSync(migrations)
    .filter((n) => n.endsWith(".sql") && !n.startsWith("20261025"))
    .sort();
}

export async function applyCutover(db, { startAt, stopBefore } = {}) {
  for (const name of cutoverMigrationFiles()) {
    if (startAt && name < startAt) continue;
    if (stopBefore && name >= stopBefore) break;
    await db.exec(fs.readFileSync(new URL(name, migrations), "utf8"));
  }
}

// Same identity mapping as link-auth.mjs, against the local auth stub.
export async function linkAuthLocally(db) {
  const { rows } = await db.query(
    "select p.id, p.phone, c.password_hash from public.profiles p join migration_private.user_credentials c on c.profile_id = p.id",
  );
  for (const r of rows)
    await db.query(
      "insert into auth.users (id, email, encrypted_password) values ($1, $2, $3)",
      [r.id, phoneToAuthEmail(r.phone), r.password_hash],
    );
  return rows.length;
}

export async function createCutoverDb(backupDir) {
  const { rows } = transform(backupDir);
  const db = new PGlite();
  await db.exec(AUTH_STUBS);
  await applySchema(db);
  await load(db, rows);
  await applyCutover(db, { stopBefore: "20261026000200" });
  await linkAuthLocally(db);
  await applyCutover(db, { startAt: "20261026000200" });
  return { db, rows };
}

// Run fn as a Supabase API role (anon / authenticated with claims) inside a rolled-back transaction.
export async function asRole(db, role, sub, fn) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
      sub ? JSON.stringify({ sub, role }) : "",
    ]);
    await tx.exec(`set local role ${role}`);
    try {
      return await fn(tx);
    } finally {
      await tx.rollback();
    }
  });
}

export function defaultBackup() {
  return (
    process.env.MEN_TEST_BACKUP ||
    new URL("../backups/2026-10-25-final-production", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
  );
}
