// Apply one cutover migration (supabase/migrations/20261026*) to Men production in a single transaction.
// Usage: node migration/cutover/apply-migration.mjs <file.sql> --project uaublandjewfzmhnbflc
// Requires MEN_MIGRATION_DATABASE_URL and MEN_CUTOVER_APPROVED_PROJECT. Records applied files so a
// second run is refused instead of re-executing DDL.
import fs from "node:fs";
import path from "node:path";
import { connectOwner, requireApproval, requireProjectArg } from "./production.mjs";

const args = process.argv.slice(2);
const file = args[0];
// Cutover and later migrations only (never the Phase 1 20261025* files).
if (!file || !/^2026(10(2[6-9]|3[01])|1[12][0-3]\d)\d{6}_[a-z0-9_]+\.sql$/.test(path.basename(file)))
  throw Error("Usage: node migration/cutover/apply-migration.mjs supabase/migrations/2026102XXXXXXX_name.sql --project REF");
const project = requireProjectArg(args);
requireApproval(project);
const sql = fs.readFileSync(path.resolve("supabase/migrations", path.basename(file)), "utf8");
const name = path.basename(file);

const client = await connectOwner(project);
try {
  await client.query("begin");
  await client.query(
    "create table if not exists migration_private.cutover_migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  await client.query("alter table migration_private.cutover_migrations enable row level security");
  await client.query("revoke all on table migration_private.cutover_migrations from public");
  const done = await client.query("select 1 from migration_private.cutover_migrations where name = $1", [name]);
  if (done.rowCount) throw Error(`${name} is already applied.`);
  await client.query(sql);
  await client.query("insert into migration_private.cutover_migrations(name) values ($1)", [name]);
  await client.query("commit");
  console.log(JSON.stringify({ applied: name, project }));
} catch (e) {
  await client.query("rollback").catch(() => {});
  console.error(JSON.stringify({ failed: name, code: e.code, message: e.message }));
  process.exitCode = 1;
} finally {
  await client.end();
}
