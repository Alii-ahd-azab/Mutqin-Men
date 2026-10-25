import { validateSourceRoundtrip } from "./roundtrip.mjs";
import fs from "node:fs";
import { qualified, keys } from "./transform.mjs";
import { validateSchema } from "./validate-schema.mjs";
export const order = [
  "profiles",
  "batches",
  "batch_memberships",
  "cycles",
  "daily_thoughts",
  "group_rest_days",
  "program_pauses",
  "tasmia_submissions",
  "review_confirmations",
  "peer_tests",
  "peer_test_selected_members",
  "peer_test_attempts",
  "peer_test_attempt_questions",
  "personal_tests",
  "personal_test_questions",
  "batch_membership_transfers",
  "migration_private.source_settings",
  "migration_private.user_credentials",
  "migration_private.source_documents",
  "migration_private.empty_legacy_arrays",
];
export async function applySchema(db) {
  for (const name of fs
    .readdirSync(new URL("../supabase/migrations/", import.meta.url))
    // Phase 1 files only; later cutover migrations are applied separately.
    .filter((n) => n.startsWith("20261025") && n.endsWith(".sql"))
    .sort())
    await db.exec(
      fs.readFileSync(
        new URL("../supabase/migrations/" + name, import.meta.url),
        "utf8",
      ),
    );
}
export async function validate(db, rows) {
  const result = {};
  result.schema = await validateSchema(db);
  for (const t of order) {
    const list = rows[t],
      table = qualified(t);
    const { rows: counts } = await db.query(
      `select count(*)::int as n from ${table}`,
    );
    if (counts[0].n !== list.length)
      throw Error("Record count mismatch in " + t);
    let checked = 0;
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100),
        cols = Object.keys(chunk[0]);
      const match = keys[t].map((k) => `a.${k}=b.${k}`).join(" and ");
      const differ = cols
        .map((k) => `a.${k} is distinct from b.${k}`)
        .join(" or ");
      const r = await db.query(
        `with expected as(select * from jsonb_populate_recordset(null::${table},$1::jsonb)) select count(*)::int as n from expected b left join ${table} a on ${match} where a.${keys[t][0]} is null or (${differ})`,
        [JSON.stringify(chunk)],
      );
      if (r.rows[0].n)
        throw Error(
          "Missing ID or field/relationship/timestamp mismatch in " + t,
        );
      checked += chunk.length;
    }
    result[t] = {
      expected: list.length,
      actual: counts[0].n,
      fullRowsChecked: checked,
    };
  }
  const fk = await db.query(
    "select count(*)::int as n from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname in ('public','migration_private') and c.contype in ('f','c') and not c.convalidated",
  );
  if (fk.rows[0].n) throw Error("Unvalidated FK/check constraints");
  return result;
}
export async function load(db, rows, backupDir) {
  await db.exec("begin");
  try {
    for (const t of order) {
      const list = rows[t],
        table = qualified(t);
      for (let i = 0; i < list.length; i += 100) {
        const chunk = list.slice(i, i + 100),
          cols = Object.keys(chunk[0]);
        await db.query(
          `insert into ${table} (${cols.join(",")}) select ${cols.join(",")} from jsonb_populate_recordset(null::${table},$1::jsonb) on conflict (${keys[t].join(",")}) do nothing`,
          [JSON.stringify(chunk)],
        );
      }
    }
    const report = await validate(db, rows);
    if (backupDir)
      report.sourceRoundtrip = await validateSourceRoundtrip(db, backupDir);
    await db.exec("commit");
    return report;
  } catch (e) {
    await db.exec("rollback");
    throw e;
  }
}
