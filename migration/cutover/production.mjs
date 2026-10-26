// Guarded production connections for cutover tooling. Every entry point verifies that the
// destination is the approved Men project and refuses the Sisters project outright.
// Credentials come only from the environment and are never printed.
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

export const MEN_PROJECT = "uaublandjewfzmhnbflc";
const SISTERS_PROJECT = "cuexuketulmyskmdvosp";

export function requireProjectArg(args) {
  const i = args.indexOf("--project");
  const project = i >= 0 ? args[i + 1] : null;
  if (project !== MEN_PROJECT) throw Error(`Explicit --project ${MEN_PROJECT} is required.`);
  return project;
}

export function requireApproval(project) {
  if (process.env.MEN_CUTOVER_APPROVED_PROJECT !== project)
    throw Error("Set MEN_CUTOVER_APPROVED_PROJECT to the exact destination reference to allow writes.");
}

function parseUrl(value, name) {
  if (!value) throw Error(`${name} is required in the environment.`);
  if (value.includes(SISTERS_PROJECT)) throw Error("Sisters destination is forbidden.");
  try {
    return new URL(value);
  } catch {
    throw Error(`${name} is not a valid URL; value suppressed.`);
  }
}

// Owner connection (same credential as the Phase 1 importer).
export async function connectOwner(project) {
  const parsed = parseUrl(process.env.MEN_MIGRATION_DATABASE_URL, "MEN_MIGRATION_DATABASE_URL");
  const direct = parsed.hostname === `db.${project}.supabase.co`;
  const pooled =
    parsed.hostname.endsWith(".pooler.supabase.com") && decodeURIComponent(parsed.username) === `postgres.${project}`;
  if (!direct && !pooled) throw Error("Database identity does not match the approved Men project.");
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) parsed.searchParams.delete(key);
  const client = new pg.Client({
    connectionString: parsed.toString(),
    ssl: { rejectUnauthorized: true },
    application_name: "mutqin_men_cutover",
    connectionTimeoutMillis: 15000,
  });
  await client.connect();
  return client;
}

// Supabase Auth admin client (secret / service-role key; tooling and server only).
export function authAdmin(project) {
  const url = parseUrl(process.env.SUPABASE_URL, "SUPABASE_URL");
  if (url.hostname !== `${project}.supabase.co`) throw Error("SUPABASE_URL does not match the approved Men project.");
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw Error("SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) is required.");
  return createClient(url.origin, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
