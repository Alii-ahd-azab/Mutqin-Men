import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { transform, uuid } from "./transform.mjs";
import { applySchema, load, validate } from "./database.mjs";
import { validateSourceRoundtrip } from "./roundtrip.mjs";
import { readBackup } from "./analyze.mjs";
import { validateSchema, inspectEmptyDestination } from "./validate-schema.mjs";
function cleanTemp(dir) {
  const resolved = path.resolve(dir);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith("mutqin-")
  )
    throw Error("Unsafe temporary cleanup path");
  fs.rmSync(resolved, { recursive: true });
}
const backup =
  process.env.MEN_TEST_BACKUP ||
  fileURLToPath(new URL("backups/2026-10-25-verification", import.meta.url));
test("approved existing Men RLS helper is reused and handles quoted identifiers", async () => {
  const db = new PGlite();
  try {
    const baseline = JSON.parse(fs.readFileSync(new URL("reference/men-approved-rls-helper.json", import.meta.url), "utf8"));
    await db.exec(baseline.function.definition);
    await db.exec("create event trigger ensure_rls on ddl_command_end when tag in ('CREATE TABLE','CREATE TABLE AS','SELECT INTO') execute function public.rls_auto_enable()");
    assert.equal((await inspectEmptyDestination(db)).compatible, true);
    const before = (await db.query("select oid,prosrc from pg_proc where oid='public.rls_auto_enable()'::regprocedure")).rows[0];
    await applySchema(db);
    assert.deepEqual((await db.query("select oid,prosrc from pg_proc where oid='public.rls_auto_enable()'::regprocedure")).rows[0], before);
    await validateSchema(db);
    await db.exec('create table public."RLS quoted table"(id integer)');
    assert.equal((await db.query("select relrowsecurity from pg_class where relname='RLS quoted table'")).rows[0].relrowsecurity,true);
  } finally { await db.close(); }
});
test("deterministic namespace-separated IDs", () => {
  assert.equal(uuid("users/a"), uuid("users/a"));
  assert.notEqual(uuid("users/a"), uuid("tests/a"));
});
test("backup checksum rejects tampering", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutqin-integrity-"));
  try {
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({ complete: true, sha256: "wrong" }),
    );
    fs.writeFileSync(path.join(dir, "firestore.ndjson"), "{}");
    assert.throws(() => readBackup(dir), /corrupt/);
  } finally {
    cleanTemp(dir);
  }
});
test("all source records import, rerun, detect corruption, rollback FK errors and deny client reads", async () => {
  const { rows } = transform(backup),
    db = new PGlite();
  try {
    await db.exec(
      "create role anon; create role authenticated; create role service_role;",
    );
    await applySchema(db);
    assert.equal((await inspectEmptyDestination(db)).compatible, false);
    await validateSchema(db);
    await db.exec("begin; alter table public.profiles drop constraint profiles_pkey cascade");
    await assert.rejects(validateSchema(db), e => e.code === "SCHEMA_VALIDATION_FAILED");
    await db.exec("rollback");
    await db.exec("begin; grant select on public.profiles to anon");
    await assert.rejects(validateSchema(db), e => e.code === "SCHEMA_VALIDATION_FAILED");
    await db.exec("rollback");
    await load(db, rows, backup);
    await load(db, rows, backup);
    const rt = await validateSourceRoundtrip(db, backup);
    assert.equal(rt.sourceDocumentsChecked, 926);
    assert.equal(rt.sourceScalarFieldsChecked, 9364);
    const view = await db.query(
      "select count(*)::int as n from public.profile_batch_overview",
    );
    assert.equal(view.rows[0].n, 30);
    const opt = await db.query(
      "select reloptions from pg_class where oid='public.profile_batch_overview'::regclass",
    );
    assert.ok(opt.rows[0].reloptions.includes("security_invoker=true"));
    await db.exec("create table public.migration_rls_probe(id integer)");
    assert.equal(
      (
        await db.query(
          "select relrowsecurity from pg_class where oid='public.migration_rls_probe'::regclass",
        )
      ).rows[0].relrowsecurity,
      true,
    );
    await db.exec("drop table public.migration_rls_probe");
    assert.equal(rows["migration_private.source_documents"].length, 926);
    assert.equal(
      rows.tasmia_submissions.filter((x) => x.legacy_occurrence > 0).length,
      4,
    );
    assert.equal(
      rows.review_confirmations.filter((x) => x.legacy_occurrence > 0).length,
      14,
    );
    await db.exec("set role anon");
    await assert.rejects(
      db.query("select * from public.profiles"),
      (e) => e.code === "42501",
    );
    await assert.rejects(
      db.query("select * from public.profile_batch_overview"),
      (e) => e.code === "42501",
    );
    await db.exec("reset role");
    await db.exec("begin");
    await db.query(
      "update public.tasmia_submissions set listener_name_snapshot='synthetic corruption' where id=$1",
      [rows.tasmia_submissions[0].id],
    );
    await assert.rejects(
      validateSourceRoundtrip(db, backup),
      /Roundtrip field mismatch/,
    );
    await db.exec("rollback");
    const changed = structuredClone(rows);
    changed.tasmia_submissions[0].submitted_at = "2000-01-01T00:00:00Z";
    await assert.rejects(validate(db, changed), /timestamp mismatch/);
    const orphan = structuredClone(rows);
    orphan.tasmia_submissions.push({
      ...orphan.tasmia_submissions[0],
      id: uuid("orphan"),
      firestore_id: "orphan",
      legacy_occurrence: 999,
      listener_id: uuid("missing"),
    });
    await assert.rejects(load(db, orphan), (e) => e.code === "23503");
    await validate(db, rows);
    await db.query(
      "delete from public.peer_test_attempt_questions where attempt_id=$1 and question_number=$2",
      [
        rows.peer_test_attempt_questions[0].attempt_id,
        rows.peer_test_attempt_questions[0].question_number,
      ],
    );
    await assert.rejects(validate(db, rows), /count mismatch/);
    await load(db, rows, backup);
    const drift = structuredClone(rows);
    drift.profiles[0].full_name += "changed";
    await assert.rejects(load(db, drift), /mismatch/);
    await validate(db, rows);
  } finally {
    await db.close();
  }
});
test("unknown fields fail closed instead of disappearing", () => {
  const original = readBackup(backup),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutqin-schema-"));
  try {
    const d = structuredClone(original.docs);
    d[0].data.v.unexpected = { t: "string", v: "synthetic" };
    const raw = d.map(JSON.stringify).join("\n") + "\n";
    fs.writeFileSync(path.join(dir, "firestore.ndjson"), raw);
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        ...original.manifest,
        sha256: crypto.createHash("sha256").update(raw).digest("hex"),
      }),
    );
    assert.throws(() => transform(dir), /Unmapped fields/);
  } finally {
    cleanTemp(dir);
  }
});

test("live and reconstructed range checks accept the same boundaries and nulls", async () => {
  const db = new PGlite();
  try {
    const q =
      await db.query(`with valueset(v) as (values (null::smallint),((-32768)::smallint),(-1::smallint),(0::smallint),(1::smallint),(2::smallint),(239::smallint),(240::smallint),(241::smallint),(32767::smallint))
 select count(*)::int as differences from valueset a cross join valueset b where
 ((((a.v>=1 and a.v<=240) and (b.v>=1 and b.v<=240)) and a.v<=b.v))
 is distinct from (((a.v>=1 and a.v<=240 and (b.v>=1 and b.v<=240)) and a.v<=b.v))`);
    assert.equal(q.rows[0].differences, 0);
  } finally {
    await db.close();
  }
});
