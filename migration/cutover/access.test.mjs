// Phase D: RLS/grant behavior per role on the real migrated snapshot (local PGlite only).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createCutoverDb, defaultBackup, asRole } from "./harness.mjs";

let db;
const who = {};
const count = async (tx, sql, params) => (await tx.query(`select count(*)::int as n from (${sql}) q`, params)).rows[0].n;
// A failed statement aborts the transaction; isolate each expected failure in a savepoint.
const rejects = async (tx, sql, params, check) => {
  await tx.query("savepoint expect_failure");
  await assert.rejects(tx.query(sql, params), check);
  await tx.query("rollback to savepoint expect_failure");
};
const denied = (tx, sql, params = []) => rejects(tx, sql, params, (e) => e.code === "42501");

before(async () => {
  ({ db } = await createCutoverDb(defaultBackup()));
  const one = async (sql) => (await db.query(sql)).rows[0].id;
  who.member = await one(`select p.id from profiles p where p.role='member' and p.active
      and exists(select 1 from tasmia_submissions t where t.user_id=p.id)
      and exists(select 1 from tasmia_submissions t where t.listener_id=p.id)
      and exists(select 1 from peer_test_attempts a where a.examiner_id=p.id) order by p.id limit 1`);
  who.other = await one(`select p.id from profiles p where p.role='member' and p.active and p.id<>'${who.member}'
      and exists(select 1 from tasmia_submissions t where t.user_id=p.id and t.listener_id is distinct from '${who.member}') order by p.id limit 1`);
  who.inactive = await one(`select id from profiles where role='member' and not active order by id limit 1`);
  who.admin = await one(`select id from profiles where role='admin' and active order by id limit 1`);
  // Owner-level totals, computed up front: PGlite serializes access, so the outer handle
  // must not be used inside a role transaction.
  who.totals = {};
  for (const t of ["profiles", "tasmia_submissions", "review_confirmations", "peer_tests", "peer_test_attempts", "peer_test_selected_members"])
    who.totals[t] = (await db.query(`select count(*)::int n from public.${t}`)).rows[0].n;
  who.totals.active_profiles = (await db.query("select count(*)::int n from profiles where active")).rows[0].n;
});
after(() => db?.close());

test("anon has no table or helper access", async () => {
  await asRole(db, "anon", null, async (tx) => {
    for (const t of ["profiles", "tasmia_submissions", "review_confirmations", "peer_test_attempts", "personal_tests"])
      await denied(tx, `select 1 from public.${t} limit 1`);
  });
  await asRole(db, "anon", null, (tx) => denied(tx, "select app_private.is_master_admin()"));
});

test("authenticated without a matching profile sees nothing", async () => {
  await asRole(db, "authenticated", "00000000-0000-4000-8000-000000000000", async (tx) => {
    for (const t of ["profiles", "batches", "cycles", "tasmia_submissions", "review_confirmations", "peer_tests", "peer_test_attempts"])
      assert.equal(await count(tx, `select 1 from public.${t}`), 0, t);
  });
});

test("active member: own + batch-visible rows only", async () => {
  await asRole(db, "authenticated", who.member, async (tx) => {
    assert.equal(await count(tx, "select 1 from profiles"), who.totals.active_profiles);
    assert.equal(await count(tx, "select 1 from cycles"), 1);
    // tasmia: only rows where the member recited or listened
    assert.equal(await count(tx, "select 1 from tasmia_submissions where user_id<>$1 and listener_id is distinct from $1", [who.member]), 0);
    assert.ok((await count(tx, "select 1 from tasmia_submissions where listener_id=$1", [who.member])) > 0, "listener rows visible");
    assert.equal(await count(tx, "select 1 from tasmia_submissions where user_id=$1 and listener_id is distinct from $2", [who.other, who.member]), 0);
    // reviews: own only
    assert.equal(await count(tx, "select 1 from review_confirmations where user_id<>$1", [who.member]), 0);
    // attempts/questions: only as candidate or examiner
    assert.equal(await count(tx, "select 1 from peer_test_attempts where candidate_id<>$1 and examiner_id is distinct from $1", [who.member]), 0);
    assert.ok((await count(tx, "select 1 from peer_test_attempts where examiner_id=$1", [who.member])) > 0, "examiner rows visible");
    assert.equal(await count(tx, "select 1 from peer_test_attempt_questions q join peer_test_attempts a on a.id=q.attempt_id"), await count(tx, "select 1 from peer_test_attempt_questions"));
    // peer tests: only live tests in the member's audience
    assert.equal(await count(tx, "select 1 from peer_tests where status<>'published'"), 0);
    // no private schema / auth access
    await denied(tx, "select 1 from migration_private.user_credentials");
    await denied(tx, "select 1 from auth.users");
  });
});

test("member writes are rejected (writes go through the server)", async () => {
  await asRole(db, "authenticated", who.member, async (tx) => {
    const cycle = (await tx.query("select id from cycles")).rows[0].id;
    await denied(tx, "insert into tasmia_submissions(cycle_id,user_id,quarter_number,listener_name_snapshot) values($1,$2,240,'x')", [cycle, who.member]);
    await denied(tx, "update profiles set role='admin' where id=$1", [who.member]);
    await denied(tx, "delete from review_confirmations where user_id=$1", [who.member]);
    await denied(tx, "select app_private.delete_member_completely($1)", [who.other]);
    await denied(tx, "select app_private.revoke_user_sessions($1)", [who.other]);
  });
});

test("inactive member sees only their own profile", async () => {
  await asRole(db, "authenticated", who.inactive, async (tx) => {
    assert.equal(await count(tx, "select 1 from profiles"), 1);
    for (const t of ["cycles", "tasmia_submissions", "review_confirmations", "peer_tests", "group_rest_days"])
      assert.equal(await count(tx, `select 1 from public.${t}`), 0, t);
  });
});

test("master admin reads every batch row", async () => {
  await asRole(db, "authenticated", who.admin, async (tx) => {
    for (const t of ["profiles", "tasmia_submissions", "review_confirmations", "peer_tests", "peer_test_attempts", "peer_test_selected_members"])
      assert.equal(await count(tx, `select 1 from public.${t}`), who.totals[t], t);
    await denied(tx, "update cycles set starts_on=starts_on");
  });
});

test("non-master admin manages only batches with an admin membership", async () => {
  await db.query("update profiles set is_master_admin=false where id=$1", [who.admin]);
  try {
    await asRole(db, "authenticated", who.admin, async (tx) => {
      assert.equal(await count(tx, "select 1 from batches"), 1);
      assert.ok((await count(tx, "select 1 from tasmia_submissions")) > 0);
    });
    await db.query("delete from batch_memberships where user_id=$1", [who.admin]);
    await asRole(db, "authenticated", who.admin, async (tx) => {
      assert.equal(await count(tx, "select 1 from tasmia_submissions"), 0);
      assert.equal(await count(tx, "select 1 from batches"), 0);
    });
  } finally {
    await db.query("update profiles set is_master_admin=true where id=$1", [who.admin]);
    await db.query(
      "insert into batch_memberships(id,batch_id,user_id,membership_role) select gen_random_uuid(), b.id, $1, 'admin' from batches b on conflict do nothing",
      [who.admin],
    );
  }
});

test("selected-audience tests are hidden from non-selected members", async () => {
  await db.query("begin");
  try {
    const t = (await db.query("select id from peer_tests where audience='selected' limit 1")).rows[0].id;
    await db.query("update peer_tests set status='published' where id=$1", [t]);
    const selected = (await db.query("select user_id from peer_test_selected_members where test_id=$1 order by position limit 1", [t])).rows[0].user_id;
    const outsider = (await db.query(
      "select p.id from profiles p where p.role='member' and p.active and not exists(select 1 from peer_test_selected_members s where s.test_id=$1 and s.user_id=p.id) limit 1", [t])).rows[0].id;
    // Setup must stay visible to the role checks, so they run inside this outer transaction.
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: selected })]);
    assert.equal(await count(db, "select 1 from peer_tests where id=$1", [t]), 1);
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: outsider })]);
    assert.equal(await count(db, "select 1 from peer_tests where id=$1", [t]), 0);
  } finally {
    await db.query("rollback");
  }
});

test("personal tests are private to their owner", async () => {
  await db.query("begin");
  try {
    const id = "11111111-1111-4111-8111-111111111111";
    await db.query(`insert into personal_tests(id,member_id,start_surah,start_surah_name,end_surah,end_surah_name,questions_count,lines_per_question,difficulty,total_errors,grade,grade_label,date,created_at)
      values($1,$2,1,'الفاتحة',1,'الفاتحة',1,1,'any',0,100,'ممتاز','2026-10-26',now())`, [id, who.member]);
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: who.member })]);
    assert.equal(await count(db, "select 1 from personal_tests where id=$1", [id]), 1);
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: who.admin })]);
    assert.equal(await count(db, "select 1 from personal_tests where id=$1", [id]), 0);
  } finally {
    await db.query("rollback");
  }
});

test("server role: explicit table access, no auth/provenance access, guarded deletion", async () => {
  await asRole(db, "mutqin_app_server", null, async (tx) => {
    assert.equal(await count(tx, "select 1 from profiles"), who.totals.profiles);
    await denied(tx, "select 1 from auth.users");
    await denied(tx, "select 1 from migration_private.source_documents");
    await denied(tx, "select 1 from migration_private.user_credentials");
    await denied(tx, "delete from profiles where id=$1", [who.other]);
    await rejects(tx, "select app_private.delete_member_completely($1)", [who.admin], /admin profiles cannot be deleted/);
  });
  await asRole(db, "mutqin_app_server", null, async (tx) => {
    const r = (await tx.query("select app_private.delete_member_completely($1) as r", [who.other])).rows[0].r;
    assert.ok(r.recitations > 0);
    assert.equal(await count(tx, "select 1 from profiles where id=$1", [who.other]), 0);
    assert.equal(await count(tx, "select 1 from tasmia_submissions where user_id=$1", [who.other]), 0);
  });
});
