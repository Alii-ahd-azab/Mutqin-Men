// Phase H: reconcile Firestore writes made after the Phase 1 import into Supabase.
//
// Transforms a fresh export with the approved Phase 1 mapping (unknown fields/collections fail closed),
// then, per table and primary key:
//   missing in Supabase            → inserted (only these)
//   present but different          → CONFLICT, reported, never overwritten
//   legacy document gone from Firebase → REMOVED, reported, never deleted
// Rows created natively by the Supabase application (no Firestore provenance) are left alone.
// Inserted rows are re-read and compared field by field before commit.
//
//   node migration/cutover/reconcile.mjs plan  BACKUP_DIR --project uaublandjewfzmhnbflc   # read-only
//   node migration/cutover/reconcile.mjs apply BACKUP_DIR --project uaublandjewfzmhnbflc   # needs MEN_CUTOVER_APPROVED_PROJECT
import fs from "node:fs";
import path from "node:path";
import { transform, keys, qualified } from "../transform.mjs";
import { order } from "../database.mjs";

async function compareTable(db, table, list) {
  if (!list.length) return { missing: [], conflicts: 0 };
  const t = qualified(table);
  const cols = Object.keys(list[0]);
  const k = keys[table];
  const match = k.map((c) => `a.${c} = b.${c}`).join(" and ");
  const differ = cols.map((c) => `a.${c} is distinct from b.${c}`).join(" or ");
  const missing = [];
  let conflicts = 0;
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const { rows } = await db.query(
      `with expected as (select row_number() over () - 1 as idx, * from jsonb_populate_recordset(null::${t}, $1::jsonb))
       select b.idx, a.${k[0]} is null as absent from expected b left join ${t} a on ${match}
        where a.${k[0]} is null or (${differ})`,
      [JSON.stringify(chunk)],
    );
    for (const r of rows) {
      if (r.absent) missing.push(chunk[Number(r.idx)]);
      else conflicts++;
    }
  }
  return { missing, conflicts };
}

async function removedLegacyDocuments(db, rows) {
  const expected = rows["migration_private.source_documents"].map((r) => r.source_path);
  const { rows: gone } = await db.query(
    "select count(*)::int as n from migration_private.source_documents where not (source_path = any($1::text[]))",
    [expected],
  );
  return gone[0].n;
}

export async function reconcile(db, backupDir, { apply = false } = {}) {
  const { rows } = transform(backupDir);
  const report = { backup: path.resolve(backupDir), mode: apply ? "apply" : "plan", tables: {}, conflicts: 0, removed: 0, inserted: 0 };
  const pending = [];
  for (const table of order) {
    const { missing, conflicts } = await compareTable(db, table, rows[table]);
    report.tables[table] = { expected: rows[table].length, missing: missing.length, conflicts };
    report.conflicts += conflicts;
    if (missing.length) pending.push([table, missing]);
  }
  report.removed = await removedLegacyDocuments(db, rows);
  if (!apply) return report;
  if (report.conflicts || report.removed)
    throw Object.assign(Error("Conflicts or removed documents require an explicit decision; nothing was written."), { report });

  for (const [table, list] of pending) {
    const cols = Object.keys(list[0]);
    const r = await db.query(
      `insert into ${qualified(table)} (${cols.join(",")})
       select ${cols.join(",")} from jsonb_populate_recordset(null::${qualified(table)}, $1::jsonb)
       on conflict (${keys[table].join(",")}) do nothing`,
      [JSON.stringify(list)],
    );
    const n = r.rowCount ?? r.affectedRows ?? 0;
    if (n !== list.length) throw Error(`Insert count mismatch in ${table}: ${n}/${list.length}`);
    report.inserted += n;
  }
  for (const [table, list] of pending) {
    const { missing, conflicts } = await compareTable(db, table, list);
    if (missing.length || conflicts) throw Error(`Post-insert validation failed in ${table}`);
  }
  return report;
}

async function main() {
  const [mode, dir, ...rest] = process.argv.slice(2);
  if (!["plan", "apply"].includes(mode) || !dir) throw Error("Usage: reconcile.mjs plan|apply BACKUP_DIR --project REF");
  const { connectOwner, requireApproval, requireProjectArg } = await import("./production.mjs");
  const project = requireProjectArg(rest);
  if (mode === "apply") requireApproval(project);
  const client = await connectOwner(project);
  try {
    await client.query(mode === "apply" ? "begin" : "begin isolation level repeatable read read only");
    const report = await reconcile(client, dir, { apply: mode === "apply" });
    await client.query(mode === "apply" ? "commit" : "rollback");
    fs.writeFileSync(path.join(dir, `reconcile-${mode}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (e) {
    await client.query("rollback").catch(() => {});
    if (e.report) console.error(JSON.stringify(e.report, null, 2));
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")))
  main();
