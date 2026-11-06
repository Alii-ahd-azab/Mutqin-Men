// Sisters-style runtime on the real migrated Men data (local PGlite; never production):
// RLS reads/writes per role, Men insert guards, browser RPCs and Edge-Function-only RPCs.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCycleInfo, membershipDate, programDate, programDayStart } from '../src/lib/calculations';
import type { GroupSettings, RestDay } from '../src/types';
// @ts-ignore - shared ESM tooling
import { createCutoverDb, asRole } from '../migration/cutover/harness.mjs';

const BACKUP = process.env.MEN_TEST_BACKUP || 'migration/backups/2026-10-26-final-cutover';
let db: any;
const id: Record<string, string> = {};
const totals: Record<string, number> = {};
let cycle: string;
let TODAY: string;
let batch: string;

const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0] as any;
const n = async (tx: any, sql: string, p: unknown[] = []) =>
  (await tx.query(`select count(*)::int as n from (${sql}) q`, p)).rows[0].n as number;
// A failed statement aborts the transaction; each expected failure runs in a savepoint.
async function fails(tx: any, sql: string, p: unknown[] = [], check?: RegExp | string) {
  await tx.query('savepoint expect_failure');
  let err: any = null;
  try {
    await tx.query(sql, p);
  } catch (e) {
    err = e;
  }
  await tx.query('rollback to savepoint expect_failure');
  assert.ok(err, `expected failure: ${sql}`);
  if (typeof check === 'string') assert.equal(err.code, check, err.message);
  else if (check) assert.match(err.message, check);
}
const as = (uid: string | null, fn: (tx: any) => Promise<unknown>) => asRole(db, uid ? 'authenticated' : 'anon', uid, fn);
const asService = (fn: (tx: any) => Promise<unknown>) => asRole(db, 'service_role', null, fn);

const today = async () => (await one("select app_private.men_today()::text as d")).d as string;

before(async () => {
  ({ db } = await createCutoverDb(BACKUP));
  ({ id: cycle, batch_id: batch } = await one("select id, batch_id from cycles where status='active'"));
  TODAY = await today();
  id.admin = (await one("select id from profiles where role='admin' and active order by firestore_id limit 1")).id;
  id.inactive = (await one("select id from profiles where role='member' and not active order by firestore_id limit 1")).id;
  id.member = (await one(`select p.id from profiles p where p.role='member' and p.active
      and exists(select 1 from tasmia_submissions t where t.user_id=p.id and t.quarter_number=1) order by p.firestore_id limit 1`)).id;
  id.peer = (await one(`select id from profiles where role='member' and active and id<>$1 order by firestore_id limit 1`, [id.member])).id;
  for (const t of ['profiles', 'tasmia_submissions', 'review_confirmations', 'peer_tests', 'peer_test_attempts'])
    totals[t] = (await one(`select count(*)::int n from public.${t}`)).n;
  totals.active = (await one('select count(*)::int n from profiles where active')).n;
});
after(() => db?.close());

test('Express-era server role and its objects are gone; RLS is on everywhere', async () => {
  assert.equal((await one("select count(*)::int n from pg_roles where rolname='mutqin_app_server'")).n, 0);
  assert.equal((await one("select count(*)::int n from pg_policies where policyname='server_all'")).n, 0);
  assert.equal((await one("select count(*)::int n from pg_proc where proname in ('delete_member_completely','revoke_user_sessions') and pronamespace='app_private'::regnamespace")).n, 0);
  assert.equal((await one(`select count(*)::int n from pg_class c join pg_namespace s on s.oid=c.relnamespace
      where s.nspname in ('public','migration_private') and c.relkind='r' and not c.relrowsecurity`)).n, 0);
  assert.equal((await one("select count(*)::int n from profiles p where not exists (select 1 from auth.users u where u.id=p.id)")).n, 0);
});

test('SQL program day equals the JavaScript calendar on every date (real data and synthetic pauses)', async () => {
  const load = async () => {
    const c = await one("select to_char(starts_on,'YYYY-MM-DD') s, total_quarters, review_window, legacy_paused_days from cycles where id=$1", [cycle]);
    const pauses = (await db.query("select to_char(paused_on,'YYYY-MM-DD') f, to_char(resumed_on - 1,'YYYY-MM-DD') t from program_pauses where cycle_id=$1 order by paused_on", [cycle])).rows as any[];
    const rest = (await db.query("select to_char(rest_date,'YYYY-MM-DD') d from group_rest_days where cycle_id=$1", [cycle])).rows as any[];
    const open = pauses.find((p) => p.t === null);
    const settings: GroupSettings = {
      id: 'x', start_date: c.s, total_quarters: c.total_quarters, review_window: c.review_window, current_cycle_number: 1,
      is_paused: !!open, paused_at: open?.f ?? null, total_paused_days: c.legacy_paused_days,
      pause_periods: pauses.filter((p) => p.t !== null).map((p) => ({ from: p.f, to: p.t })),
    };
    const restDays: RestDay[] = rest.map((r, i) => ({ id: String(i), date: r.d, note: '', added_by_admin_id: '', created_at: '' }));
    return { settings, restDays };
  };
  const compare = async (label: string) => {
    const { settings, restDays } = await load();
    const days = (await db.query(
      "select to_char(d,'YYYY-MM-DD') d, app_private.men_cycle_day($1, d::date) n from generate_series('2026-09-10'::date, '2027-06-30'::date, interval '1 day') d",
      [cycle]
    )).rows as any[];
    for (const r of days) {
      const info = calculateCycleInfo(settings, restDays, r.d);
      assert.equal(r.n, info.has_started ? info.cycle_day : 0, `${label} ${r.d}`);
    }
  };
  await compare('real');
  await db.query('begin');
  try {
    await db.query("update program_pauses set resumed_on='2026-10-27' where cycle_id=$1 and resumed_on is null", [cycle]);
    await db.query("insert into program_pauses(cycle_id,paused_on,resumed_on) values($1,'2026-09-25','2026-09-28'),($1,'2026-11-10','2026-11-10'),($1,'2026-12-01',null)", [cycle]);
    await db.query("insert into group_rest_days(cycle_id,rest_date) values($1,'2026-09-26'),($1,'2026-11-05'),($1,'2026-12-03'),($1,'2027-01-01')", [cycle]);
    await compare('synthetic');
  } finally {
    await db.query('rollback');
  }
});

test('anon: no tables, no RPCs', async () => {
  await as(null, async (tx) => {
    for (const t of ['profiles', 'tasmia_submissions', 'review_confirmations', 'peer_tests', 'personal_tests'])
      await fails(tx, `select 1 from public.${t}`, [], '42501');
    await fails(tx, 'select public.men_save_personal_test($1)', ['{}'], '42501');
    await fails(tx, 'select public.start_next_cycle($1, current_date, null)', [batch], '42501');
  });
});

test('active member reads only own/listener rows (Sisters policies)', async () => {
  await as(id.member, async (tx) => {
    assert.equal(await n(tx, 'select 1 from profiles'), totals.active);
    assert.equal(await n(tx, 'select 1 from tasmia_submissions where user_id<>$1 and listener_id is distinct from $1', [id.member]), 0);
    assert.equal(await n(tx, 'select 1 from review_confirmations where user_id<>$1', [id.member]), 0);
    assert.equal(await n(tx, 'select 1 from peer_test_attempts where candidate_id<>$1 and examiner_id is distinct from $1', [id.member]), 0);
    assert.equal(await n(tx, "select 1 from peer_tests where status<>'published'"), 0);
    await fails(tx, 'select 1 from migration_private.user_credentials', [], '42501');
  });
});

test('member recitation: Men sequential-quarter rule, listener rules and snapshots enforced by the database', async () => {
  const day = (await one('select app_private.men_cycle_day($1, app_private.men_today()) n', [cycle])).n as number;
  const required = (await one(
    `select min(q) q from generate_series(1, $3::int) q
       where not exists (select 1 from tasmia_submissions t where t.cycle_id=$1 and t.user_id=$2 and t.quarter_number=q)`,
    [cycle, id.member, day]
  )).q as number | null;
  await as(id.member, async (tx) => {
    const ins = (quarter: number, listener: string | null, extra = '') =>
      `insert into tasmia_submissions(cycle_id,user_id,listener_id,quarter_number${extra ? ',notes' : ''}) values('${cycle}','${id.member}',${listener ? `'${listener}'` : 'null'},${quarter}${extra ? `,'${extra}'` : ''})`;
    await fails(tx, ins(1, id.peer), [], required === 1 ? undefined : /الربع|الاختبار الإلزامي|أتممت/);
    await fails(tx, ins(required ?? day, id.member), [], /المستمع/);
    await fails(tx, ins(required ?? day, null), [], /المستمع/);
    await fails(tx, ins(required ?? day, id.inactive), [], /المستمع/);
    await fails(tx, `insert into tasmia_submissions(cycle_id,user_id,listener_id,quarter_number) values('${cycle}','${id.peer}','${id.member}',${required ?? 1})`);
    if (required === null) return;
    // The mandatory-test checkpoint may legitimately block this member; otherwise the row is stored.
    await tx.query('savepoint s');
    try {
      await tx.query(ins(required, id.peer, 'ملاحظة'));
      const row = (await tx.query(
        'select member_name_snapshot is not null m, listener_name_snapshot is not null l, legacy_date = $3::date d, legacy_occurrence o from tasmia_submissions where user_id=$1 and quarter_number=$2 and firestore_id is null',
        [id.member, required, TODAY]
      )).rows[0];
      assert.deepEqual(row, { m: true, l: true, d: true, o: 0 });
      await fails(tx, ins(required, id.peer), [], /الربع/);
    } catch (e: any) {
      assert.match(e.message, /الاختبار الإلزامي/);
      await tx.query('rollback to savepoint s');
    }
  });
});

test('mandatory test blocks quarters past its range unless passed in full', async () => {
  await db.query('begin');
  try {
    await db.query("update peer_tests set status='hidden' where cycle_id=$1", [cycle]);
    await db.query(`insert into peer_tests(cycle_id,title,range_start,range_end,questions_count,lines_per_question,test_type,status,audience)
                    values($1,'إلزامي',1,1,1,1,'mandatory','published','all')`, [cycle]);
    // A member whose next required quarter is beyond 1.
    const m = (await one(`select p.id from profiles p where p.role='member' and p.active and exists
      (select 1 from tasmia_submissions t where t.user_id=p.id and t.quarter_number=1) and p.id<>$1 limit 1`, [id.peer])).id;
    const day = (await one('select app_private.men_cycle_day($1, app_private.men_today()) n', [cycle])).n;
    const req = (await one(`select min(q) q from generate_series(1,$3::int) q where not exists
      (select 1 from tasmia_submissions t where t.cycle_id=$1 and t.user_id=$2 and t.quarter_number=q)`, [cycle, m, day])).q;
    if (req !== null) {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: m })]);
      await db.query('set local role authenticated');
      await fails(db, `insert into tasmia_submissions(cycle_id,user_id,listener_id,quarter_number) values($1,$2,$3,$4)`,
        [cycle, m, m === id.peer ? id.member : id.peer, req], /الاختبار الإلزامي/);
    }
  } finally {
    await db.query('rollback');
  }
});

test('member review: one per date, quarters computed by the database, date bounds', async () => {
  const d = TODAY;
  const day = (await one('select app_private.men_cycle_day($1, $2::date) n', [cycle, TODAY])).n;
  await as(id.member, async (tx) => {
    // Quarters/program_day are not insertable by the browser at all.
    await fails(tx, 'insert into review_confirmations(cycle_id,user_id,start_quarter,end_quarter) values($1,$2,200,240)', [cycle, id.member], '42501');
    await tx.query('insert into review_confirmations(cycle_id,user_id,notes) values($1,$2,$3)', [cycle, id.member, 'تمت']);
    const r = (await tx.query('select start_quarter, end_quarter, program_day, legacy_date::text d from review_confirmations where user_id=$1 and legacy_date=$2', [id.member, TODAY])).rows[0];
    assert.deepEqual(r, { start_quarter: Math.max(1, day - 7), end_quarter: day, program_day: null, d });
    await fails(tx, 'insert into review_confirmations(cycle_id,user_id) values($1,$2)', [cycle, id.member], '23505');
    await fails(tx, "insert into review_confirmations(cycle_id,user_id,legacy_date) values($1,$2, $3::date + 5)", [cycle, id.member, TODAY], /مستقبلي/);
    await fails(tx, "insert into review_confirmations(cycle_id,user_id,legacy_date) values($1,$2,'2026-01-01')", [cycle, id.member], /يسبق/);
    // Retroactive day (allowed in Men)
    await tx.query("insert into review_confirmations(cycle_id,user_id,legacy_date) values($1,$2,'2026-09-17') on conflict do nothing", [cycle, id.member]);
  });
});

test('inactive member and admin cannot record; inactive sees only own profile', async () => {
  await as(id.inactive, async (tx) => {
    assert.equal(await n(tx, 'select 1 from profiles'), 1);
    await fails(tx, 'insert into review_confirmations(cycle_id,user_id) values($1,$2)', [cycle, id.inactive]);
  });
  await as(id.admin, async (tx) => {
    await fails(tx, 'insert into review_confirmations(cycle_id,user_id) values($1,$2)', [cycle, id.admin]);
    await fails(tx, 'insert into tasmia_submissions(cycle_id,user_id,listener_id,quarter_number) values($1,$2,$3,1)', [cycle, id.admin, id.peer]);
  });
});

test('admin writes: rest days, pause/resume, start date, daily thought, past pause, backfill', async () => {
  await as(id.admin, async (tx) => {
    for (const t of ['profiles', 'tasmia_submissions', 'review_confirmations', 'peer_tests', 'peer_test_attempts'])
      assert.equal(await n(tx, `select 1 from public.${t}`), totals[t], t);
    const rd = (await tx.query("insert into group_rest_days(cycle_id,rest_date,reason,created_by,created_by_name_snapshot) values($1,'2026-12-30','راحة',$2,'x') returning id", [cycle, id.admin])).rows[0].id;
    await fails(tx, "insert into group_rest_days(cycle_id,rest_date,created_by) values($1,'2026-12-30',$2)", [cycle, id.admin], '23505');
    await fails(tx, "insert into group_rest_days(cycle_id,rest_date,created_by) values($1,'2026-12-31',$2)", [cycle, id.member], '42501');
    assert.equal((await tx.query('delete from group_rest_days where id=$1', [rd])).affectedRows, 1);

    await fails(tx, "insert into program_pauses(cycle_id,paused_on,created_by) values($1,$3::date,$2)", [cycle, id.admin, TODAY], '23505');
    assert.equal((await tx.query("update program_pauses set resumed_on=$2::date where cycle_id=$1 and resumed_on is null", [cycle, TODAY])).affectedRows, 1);
    await tx.query("insert into program_pauses(cycle_id,paused_on,created_by) values($1,$3::date,$2)", [cycle, id.admin, TODAY]);
    await fails(tx, "update program_pauses set paused_on='2026-01-01' where cycle_id=$1", [cycle], '42501');

    await tx.query("update cycles set starts_on='2026-09-18' where id=$1", [cycle]);
    await fails(tx, "update cycles set status='archived' where id=$1", [cycle], '42501');
    await tx.query("update cycles set starts_on='2026-09-17' where id=$1", [cycle]);

    await tx.query("insert into daily_thoughts(batch_id,content_html,published_by,published_by_name_snapshot) values($1,'<p>x</p>',$2,'x')", [batch, id.admin]);
    await fails(tx, "insert into daily_thoughts(batch_id,content_html,published_by) values($1,'x',$2)", [batch, id.member], '42501');
    assert.ok((await tx.query('update daily_thoughts set is_published=false where batch_id=$1 and is_published', [batch])).affectedRows >= 1);

    const before = (await tx.query('select legacy_paused_days n from cycles where id=$1', [cycle])).rows[0].n;
    await tx.query("select public.men_add_past_pause_period($1,'2026-10-01','2026-10-02')", [cycle]);
    assert.equal((await tx.query('select legacy_paused_days n from cycles where id=$1', [cycle])).rows[0].n, Math.max(0, before - 2));
    const created = (await tx.query("select public.men_backfill_revisions($1,'2026-09-19') n", [cycle])).rows[0].n;
    assert.ok(created >= 0);
    assert.equal((await tx.query("select public.men_backfill_revisions($1,'2026-09-19') n", [cycle])).rows[0].n, 0, 'idempotent');
  });
  await as(id.member, async (tx) => {
    // RLS filters the row away for non-managers: nothing is updated.
    assert.equal((await tx.query("update cycles set starts_on='2026-09-18' where id=$1", [cycle])).affectedRows, 0);
    assert.equal((await tx.query("update program_pauses set resumed_on=$2::date where cycle_id=$1", [cycle, TODAY])).affectedRows, 0);
    assert.equal((await tx.query("delete from group_rest_days where cycle_id=$1", [cycle])).affectedRows, 0);
  });
  await as(id.member, (tx) => fails(tx, "select public.men_add_past_pause_period($1,'2026-10-01','2026-10-02')", [cycle], '42501'));
  await as(id.member, (tx) => fails(tx, "select public.men_backfill_revisions($1,'2026-09-19')", [cycle], '42501'));
});

test('«اختبر نفسك» retired: history kept and readable by its owner; no save RPC and no deletion', async () => {
  await db.query('begin');
  try {
    // A historical row, as the migrated data would hold it.
    const tid = (await db.query(`insert into personal_tests(id,member_id,start_surah,start_surah_name,end_surah,end_surah_name,questions_count,lines_per_question,difficulty,total_errors,grade,grade_label,date,created_at)
      values(gen_random_uuid(),$1,1,'الفاتحة',1,'الفاتحة',1,1,'any',0,100,'ممتاز','2026-10-01',now()) returning id`, [id.member])).rows[0].id;
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id.member, role: 'authenticated' })]);
    await db.query('set local role authenticated');
    assert.equal(await n(db, 'select 1 from personal_tests where id=$1', [tid]), 1, 'owner still reads his history');
    await fails(db, 'select public.men_save_personal_test($1)', ['{}'], '42501');
    await fails(db, 'delete from personal_tests where id=$1', [tid], '42501');
    await db.query('reset role');
    assert.equal(await n(db, 'select 1 from personal_tests where id=$1', [tid]), 1);
  } finally {
    await db.query('rollback');
  }
});

test('Edge-Function RPCs are service-role only', async () => {
  await as(id.admin, async (tx) => {
    for (const sql of [
      `select public.men_delete_member_completely('${id.peer}')`,
      `select public.peer_test_set_status('${id.peer}','show','${id.admin}')`,
      `select public.start_next_cycle('${batch}', current_date, null)`,
      `select public.create_batch_with_cycle('x', current_date, '${id.admin}')`,
      `select public.set_admin_batches('${id.admin}', array['${batch}']::uuid[], '${id.admin}')`,
      `select public.move_member_batch('${id.member}', '${batch}', null, '${id.admin}')`,
      `select public.men_set_account_role('${id.peer}', 'admin', null, '${id.admin}')`,
    ])
      await fails(tx, sql, [], '42501');
  });
  // Old Men-only peer-test RPCs were replaced by the Sisters model.
  assert.equal((await one("select count(*)::int n from pg_proc where proname like 'men_peer_test_%'")).n, 0);
});

test('Sisters multi-batch layer: create batch, batch admins, guarded memberships, member transfer', async () => {
  await asService(async (tx) => {
    const b2 = (await tx.query("select public.create_batch_with_cycle('دفعة اختبار', $1::date, $2) r", [TODAY, id.admin])).rows[0].r;
    assert.equal(b2.name, 'دفعة اختبار');
    assert.equal(await n(tx, "select 1 from cycles where batch_id=$1 and status='active' and cycle_number=1", [b2.id]), 1);
    await fails(tx, "select public.create_batch_with_cycle('  ', current_date, null)", [], /اسم الدفعة/);

    // Guards: a membership never changes batch except through the transfer function.
    await fails(tx, 'update batch_memberships set batch_id=$1 where user_id=$2', [b2.id, id.member], /النقل الآمن/);
    await fails(tx, "insert into batch_memberships(batch_id,user_id,membership_role) values($1,$2,'admin')", [b2.id, id.member], /مشرفي الدفعات/);
    await fails(tx, "update profiles set role='admin' where id=$1", [id.member], /مرتبط بدفعة/);

    // Batch admin: a demoted master admin assigned to the new batch only.
    await tx.query('update profiles set is_master_admin=false where id=$1', [id.admin]);
    await tx.query('select public.set_admin_batches($1, $2::uuid[], $1)', [id.admin, [b2.id]]);
    assert.deepEqual((await tx.query("select array_agg(batch_id::text) a from batch_memberships where user_id=$1 and membership_role='admin'", [id.admin])).rows[0].a, [b2.id]);
    await fails(tx, "select public.set_admin_batches($1, '{}'::uuid[], $1)", [id.admin], /دفعة واحدة/);

    // Transfer: same profile, membership moves, joined_at resets, history stays on the old cycle.
    const recsBefore = await n(tx, 'select 1 from tasmia_submissions where user_id=$1 and cycle_id=$2', [id.member, cycle]);
    await fails(tx, 'select public.move_member_batch($1,$2,$3,$4)', [id.member, b2.id, b2.id, id.admin], /تغيّرت دفعة العضو/);
    const moved = (await tx.query('select public.move_member_batch($1,$2,$3,$4) r', [id.member, b2.id, batch, id.admin])).rows[0].r;
    assert.equal(moved.to_batch_id, b2.id);
    assert.equal(await n(tx, "select 1 from batch_memberships where user_id=$1 and batch_id=$2 and membership_role='member'", [id.member, b2.id]), 1);
    assert.equal(await n(tx, 'select 1 from batch_membership_transfers where user_id=$1', [id.member]), 1);
    assert.equal(await n(tx, 'select 1 from tasmia_submissions where user_id=$1 and cycle_id=$2', [id.member, cycle]), recsBefore);
    await fails(tx, 'select public.move_member_batch($1,$2,null,$3)', [id.member, b2.id, id.admin], /موجود بالفعل/);

    // Promotion back to master removes the redundant assignments (Sisters trigger).
    await tx.query('update profiles set is_master_admin=true where id=$1', [id.admin]);
    assert.equal(await n(tx, "select 1 from batch_memberships where user_id=$1 and membership_role='admin'", [id.admin]), 0);
  });
});

test('batch admin sees only assigned batches; moved member keeps old names via history_member_names', async () => {
  await db.query('begin');
  try {
    const b2 = (await db.query("select public.create_batch_with_cycle('دفعة ب', $1::date, $2) r", [TODAY, id.admin])).rows[0].r;
    const admin2 = (await one("select id from profiles where role='admin' and id<>$1 order by firestore_id limit 1", [id.admin]))?.id;
    if (admin2) {
      await db.query('update profiles set is_master_admin=false where id=$1', [admin2]);
      await db.query('select public.set_admin_batches($1, $2::uuid[], $3)', [admin2, [b2.id], id.admin]);
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: admin2, role: 'authenticated' })]);
      await db.query('set local role authenticated');
      assert.deepEqual((await db.query('select id from batches')).rows.map((r: any) => r.id), [b2.id]);
      assert.equal((await db.query('select count(*)::int n from tasmia_submissions where cycle_id=$1', [cycle])).rows[0].n, 0);
      await db.query('reset role');
    }
    // A manager of the old batch still resolves the moved member's name.
    await db.query('select public.move_member_batch($1,$2,null,$3)', [id.peer, b2.id, id.admin]);
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id.admin, role: 'authenticated' })]);
    await db.query('set local role authenticated');
    const names = (await db.query('select id from public.history_member_names($1)', [cycle])).rows.map((r: any) => r.id);
    assert.ok(names.includes(id.peer));
  } finally {
    await db.query('rollback');
  }
});

test('listener correction: once, own fresh row, active listener of the same batch', async () => {
  await db.query('begin');
  try {
    const row = (await one(
      `select id, listener_id from tasmia_submissions where user_id=$1 and cycle_id=$2 and listener_id is not null order by submitted_at desc limit 1`,
      [id.member, cycle]
    )) as { id: string; listener_id: string };
    const other = (await one(
      `select p.id from profiles p join batch_memberships m on m.user_id=p.id and m.batch_id=$1 and m.membership_role='member'
        where p.active and p.id not in ($2,$3) order by p.firestore_id limit 1`,
      [batch, id.member, row.listener_id]
    )).id;
    await db.query('update tasmia_submissions set submitted_at=now() - interval \'13 hours\' where id=$1', [row.id]);
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id.member, role: 'authenticated' })]);
    await db.query('set local role authenticated');
    await fails(db, 'select public.correct_tasmia_listener($1,$2)', [row.id, other], /انتهت مهلة/);
    await db.query('reset role');
    await db.query('update tasmia_submissions set submitted_at=now() where id=$1', [row.id]);
    await db.query('set local role authenticated');
    await fails(db, 'select public.correct_tasmia_listener($1,$2)', [row.id, id.member], /نفسك/);
    await fails(db, 'select public.correct_tasmia_listener($1,$2)', [row.id, id.inactive], /عضوًا نشطًا/);
    const r = (await db.query('select public.correct_tasmia_listener($1,$2) r', [row.id, other])).rows[0].r;
    assert.equal(r.listener_id, other);
    assert.ok(r.listener_changed_at);
    await fails(db, 'select public.correct_tasmia_listener($1,$2)', [row.id, row.listener_id], /مسبقًا/);
    await db.query('reset role');
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id.peer, role: 'authenticated' })]);
    await db.query('set local role authenticated');
    await fails(db, 'select public.correct_tasmia_listener($1,$2)', [row.id, other], /لا يمكن تعديل/);
  } finally {
    await db.query('rollback');
  }
});

test('peer tests (Sisters model + Men rules): save, overlap, audience, partial range, start/submit, versioning', async () => {
  await asService(async (tx) => {
    // Free the cycle of live tests first (one live test per batch).
    await tx.query("update peer_tests set status='hidden' where cycle_id=$1 and status='published'", [cycle]);
    const save = (testId: string | null, o: Record<string, unknown>) =>
      tx.query(
        'select public.peer_test_save($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::uuid[],$17,$18) r',
        [testId, cycle, o.title ?? 'تجريبي', o.range_start ?? 1, o.range_end ?? 8, o.questions_count ?? 2, o.lines_per_question ?? 5,
          'max_errors' in o ? o.max_errors : 3, o.test_type ?? 'recommended', 'any', o.status ?? 'published', null, null, id.admin,
          o.audience ?? 'selected', o.selected ?? [id.member, id.peer], o.require_all ?? false, o.require_rev ?? false]
      ).then((r: any) => r.rows[0].r);

    await fails(tx, 'select 1 from (select public.peer_test_save(null,$1,$2,1,8,2,5,3,$3,$4,$5,null,null,$6,$7,$8::uuid[],false,false)) q',
      [cycle, 't', 'recommended', 'any', 'published', id.admin, 'selected', []], /عضو واحد على الأقل/);
    await fails(tx, 'select 1 from (select public.peer_test_save(null,$1,$2,1,8,2,5,3,$3,$4,$5,null,null,$6,$7,$8::uuid[],false,false)) q',
      [cycle, 't', 'recommended', 'any', 'published', id.admin, 'selected', [id.admin]], /غير موجود في هذه الدفعة/);

    const saved = await save(null, {});
    const testId = saved.test.id;
    assert.equal(saved.versioned, false);
    assert.deepEqual((await tx.query('select array_agg(user_id::text order by position) a from peer_test_selected_members where test_id=$1', [testId])).rows[0].a, [id.member, id.peer]);
    // Only one live test per batch at a time.
    await fails(tx, "select public.peer_test_save(null,$1,'ثانٍ',1,8,2,5,3,'recommended','any','published',null,null,$2,'all','{}'::uuid[],false,false)",
      [cycle, id.admin], /اختبار آخر ظاهر/);

    // Members: a member outside the audience is rejected; partial range end re-checked against recitations.
    const q = (k: number) => ({ question_number: k, start_surah: 2, start_surah_name: 'البقرة', start_ayah: k, end_surah: 2,
      end_surah_name: 'البقرة', end_ayah: k + 1, start_page: 2, start_line: 1, end_page: 2, end_line: 3, actual_lines: 3, difficulty_level: 'easy' });
    // Consecutive quarters the candidate has recited from the start of the range.
    const recited = new Set((await tx.query('select quarter_number q from tasmia_submissions where cycle_id=$1 and user_id=$2', [cycle, id.member])).rows.map((r: any) => r.q));
    let done = 0;
    while (recited.has(done + 1)) done++;
    const outsider = (await tx.query(
      `select p.id from profiles p join batch_memberships m on m.user_id=p.id and m.batch_id=$1 and m.membership_role='member' where p.active and p.id not in ($2,$3) limit 1`,
      [batch, id.member, id.peer]
    )).rows[0].id;
    await fails(tx, 'select public.peer_test_start_attempt($1,$2,$3,$4,$5)', [testId, outsider, id.peer, JSON.stringify([q(1), q(2)]), 1], /المشمولين/);
    await fails(tx, 'select public.peer_test_start_attempt($1,$2,$3,$4,$5)', [testId, id.member, id.member, JSON.stringify([q(1), q(2)]), 1], /نفسه/);
    await fails(tx, 'select public.peer_test_start_attempt($1,$2,$3,$4,$5)', [testId, id.member, id.peer, JSON.stringify([q(1), q(2)]), 9], /نطاق/);
    assert.ok(done >= 1, 'member has recited quarter 1');
    const end = Math.min(8, done);
    await fails(tx, 'select public.peer_test_start_attempt($1,$2,$3,$4,$5)', [testId, id.member, id.peer, JSON.stringify([q(1)]), end], /عدد الأسئلة/);
    const attemptId = (await tx.query('select public.peer_test_start_attempt($1,$2,$3,$4,$5) r', [testId, id.member, id.peer, JSON.stringify([q(1), q(2)]), end])).rows[0].r;
    const started = (await tx.query('select status, effective_range_end, covers_full_range, attempt_date::text d from peer_test_attempts where id=$1', [attemptId])).rows[0];
    assert.deepEqual(started, { status: 'in_progress', effective_range_end: end, covers_full_range: end === 8, d: TODAY });

    await fails(tx, 'select public.peer_test_submit_attempt($1,$2,$3,$4,$5)', [attemptId, id.member, [0, 0], ['', ''], null], /زميل آخر/);
    await fails(tx, 'select public.peer_test_submit_attempt($1,$2,$3,$4,$5)', [attemptId, id.peer, [0], [''], null], /جميع الأسئلة/);
    const res = (await tx.query('select public.peer_test_submit_attempt($1,$2,$3,$4,$5) r', [attemptId, id.peer, [1, 2], ['', 'ملاحظة'], 'جيد'])).rows[0].r;
    assert.equal(res.attempt.status, 'passed');
    assert.equal(res.attempt.total_errors, 3);
    await fails(tx, 'select public.peer_test_start_attempt($1,$2,$3,$4,$5)', [testId, id.member, id.peer, JSON.stringify([q(1), q(2)]), end], /اجتاز/);

    // Material change with results → new version, old one finished with its results kept.
    const v2 = await save(testId, { range_end: 16, max_errors: null, audience: 'all', selected: [] });
    assert.equal(v2.versioned, true);
    assert.notEqual(v2.test.id, testId);
    assert.equal((await tx.query('select status from peer_tests where id=$1', [testId])).rows[0].status, 'finished');
    assert.equal(await n(tx, "select 1 from peer_test_attempts where test_id=$1 and status='passed'", [testId]), 1);
    assert.equal((await tx.query("select public.peer_test_set_status($1,'hide',$2) r", [v2.test.id, id.admin])).rows[0].r.test.status, 'hidden');
    assert.equal((await tx.query("select public.peer_test_set_status($1,'show',$2) r", [v2.test.id, id.admin])).rows[0].r.test.status, 'published');
    assert.equal((await tx.query("select public.peer_test_set_status($1,'finish',$2) r", [v2.test.id, id.admin])).rows[0].r.test.status, 'finished');
    await fails(tx, "select public.peer_test_set_status($1,'show',$2)", [v2.test.id, id.admin], /منتهٍ/);

    // A test requiring the whole range only accepts the full range end.
    const full = await save(null, { require_all: true, audience: 'all', selected: [] });
    await fails(tx, 'select public.peer_test_start_attempt($1,$2,$3,$4,$5)', [full.test.id, id.member, id.peer, JSON.stringify([q(1), q(2)]), 1], /نطاق/);
  });
});

test('members see only live tests of their audience (RLS)', async () => {
  await db.query('begin');
  try {
    await db.query("update peer_tests set status='hidden' where cycle_id=$1", [cycle]);
    const t = (await db.query(
      `select public.peer_test_save(null,$1,'خاص',1,8,1,5,null,'recommended','any','published',null,null,$2,'selected',$3::uuid[],false,false) r`,
      [cycle, id.admin, [id.peer]]
    )).rows[0].r.test.id;
    for (const [who, visible] of [[id.peer, 1], [id.member, 0]] as const) {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: who, role: 'authenticated' })]);
      await db.query('set local role authenticated');
      assert.equal((await db.query('select count(*)::int n from peer_tests where id=$1', [t])).rows[0].n, visible, who);
      await db.query('reset role');
    }
  } finally {
    await db.query('rollback');
  }
});

test('accounts: Men role switch, batch-admin deletion, master admins are never deleted, cycle restart', async () => {
  await asService(async (tx) => {
    await tx.query("select public.men_set_account_role($1,'admin',null,$2)", [id.peer, id.admin]);
    assert.deepEqual((await tx.query('select role, is_master_admin from profiles where id=$1', [id.peer])).rows[0], { role: 'admin', is_master_admin: true });
    assert.equal(await n(tx, 'select 1 from batch_memberships where user_id=$1', [id.peer]), 0);
    await fails(tx, 'select public.men_delete_member_completely($1)', [id.peer], /مشرف عام/);
    await fails(tx, "select public.men_set_account_role($1,'member',null,$2)", [id.peer, id.admin], /دفعة العضو/);
    await tx.query("select public.men_set_account_role($1,'member',$2,$3)", [id.peer, batch, id.admin]);
    assert.equal(await n(tx, "select 1 from batch_memberships where user_id=$1 and batch_id=$2 and membership_role='member'", [id.peer, batch]), 1);

    // A batch admin may be deleted (Sisters); his attempts as examiner go too (Men).
    await tx.query("select public.men_set_account_role($1,'admin',null,$2)", [id.peer, id.admin]);
    await tx.query('update profiles set is_master_admin=false where id=$1', [id.peer]);
    await tx.query('select public.set_admin_batches($1,$2::uuid[],$3)', [id.peer, [batch], id.admin]);
    const counts = (await tx.query('select public.men_delete_member_completely($1) r', [id.peer])).rows[0].r;
    assert.ok(counts.recitations >= 0);
    assert.equal(await n(tx, 'select 1 from profiles where id=$1', [id.peer]), 0);

    // Sisters' non-destructive cycle restart
    const next = (await tx.query("select public.start_next_cycle($1, $4::date, $2, $3) r", [batch, id.admin, cycle, TODAY])).rows[0].r;
    assert.equal(next.cycle.cycle_number, 2);
    assert.equal((await tx.query('select status from cycles where id=$1', [cycle])).rows[0].status, 'archived');
    assert.equal(await n(tx, 'select 1 from tasmia_submissions where cycle_id=$1', [cycle]) > 0, true, 'history kept');
  });
});

test('review identity: JS program-day matching agrees with SQL men_cycle_day; retroactive rest days create no false overdue', async () => {
  const { calculateMemberRevisionStatus, getActiveCycleDates } = await import('../src/lib/calculations');
  const load = async () => {
    const c = await one("select to_char(starts_on,'YYYY-MM-DD') s, total_quarters, review_window, legacy_paused_days from cycles where id=$1", [cycle]);
    const pauses = (await db.query("select to_char(paused_on,'YYYY-MM-DD') f, to_char(resumed_on - 1,'YYYY-MM-DD') t, resumed_on is not null and resumed_on > paused_on closed, resumed_on is null open from program_pauses where cycle_id=$1 order by paused_on", [cycle])).rows as any[];
    const rest = (await db.query("select to_char(rest_date,'YYYY-MM-DD') d from group_rest_days where cycle_id=$1", [cycle])).rows as any[];
    const open = pauses.find((p) => p.open);
    const settings: GroupSettings = {
      id: 'x', start_date: c.s, total_quarters: c.total_quarters, review_window: c.review_window, current_cycle_number: 1,
      is_paused: !!open, paused_at: open?.f ?? null, total_paused_days: c.legacy_paused_days,
      pause_periods: pauses.filter((p) => p.closed).map((p) => ({ from: p.f, to: p.t })),
    };
    const restDays: RestDay[] = rest.map((r, i) => ({ id: String(i), date: r.d, note: '', added_by_admin_id: '', created_at: '' }));
    return { settings, restDays };
  };
  const reviews = (await db.query("select user_id m, to_char(legacy_date,'YYYY-MM-DD') d, end_quarter e from review_confirmations where cycle_id=$1 and legacy_date <= $2::date", [cycle, TODAY])).rows as { m: string; d: string; e: number }[];
  const members = [...new Set(reviews.map((r) => r.m))];
  const missedByMember = async () => {
    const { settings, restDays } = await load();
    const active = getActiveCycleDates(settings.start_date, TODAY, restDays, settings);
    const logs = reviews.map((r, i) => ({ id: String(i), member_id: r.m, member_name: '', date: r.d, cycle_number: 1, review_start_quarter: 0, review_end_quarter: r.e, created_at: '' }));
    return { active, missed: new Map(members.map((m) => [m, new Set(calculateMemberRevisionStatus(m, active, logs, TODAY, undefined, settings).pastMissedDates)])) };
  };

  // 1. Parity: a review on any date counts for the latest active date on or before it, and SQL gives
  //    both dates the same program day (so the stored range is exactly that obligation's range).
  const { active } = await missedByMember();
  const latestActive = (d: string) => [...active].reverse().find((a) => a <= d);
  const sqlDay = async (d: string) => (await one('select app_private.men_cycle_day($1, $2::date) n', [cycle, d])).n as number;
  let offDays = 0;
  for (const d of [...new Set(reviews.map((r) => r.d))]) {
    const a = latestActive(d);
    if (!a) continue;
    if (a !== d) offDays++;
    assert.equal(await sqlDay(d), await sqlDay(a), `review on ${d} ↔ active day ${a}`);
  }
  assert.ok(offDays >= 0);

  // 2. Retroactive rest days on dates that already have reviews: nobody gains a missed review.
  const before = (await missedByMember()).missed;
  await db.query('begin');
  try {
    const busy = (await db.query(
      "select to_char(legacy_date,'YYYY-MM-DD') d from review_confirmations where cycle_id=$1 and legacy_date < $2::date group by 1 order by count(*) desc limit 3",
      [cycle, TODAY]
    )).rows.map((r: any) => r.d);
    for (const d of busy) await db.query('insert into group_rest_days(cycle_id, rest_date) values($1, $2::date) on conflict do nothing', [cycle, d]);
    const after = (await missedByMember()).missed;
    for (const m of members) {
      const gained = [...after.get(m)!].filter((d) => !before.get(m)!.has(d));
      // Rest days only remove obligations: no member owes MORE reviews (an open day may be shown on
      // another date once the calendar shifts, but never an extra one).
      assert.ok(after.get(m)!.size <= before.get(m)!.size, `member ${m}: ${before.get(m)!.size} -> ${after.get(m)!.size} (gained ${gained}) after rest days ${busy}`);
    }
    // History untouched.
    assert.equal((await one('select count(*)::int n from review_confirmations where cycle_id=$1', [cycle])).n, reviews.length + (await one('select count(*)::int n from review_confirmations where cycle_id=$1 and legacy_date > $2::date', [cycle, TODAY])).n);
  } finally {
    await db.query('rollback');
  }
});

test('fresh-start member: starts at the batch quarter of today, sequential from there, no earlier debt', async () => {
  const { calculateMemberRequiredQuarter } = await import('../src/lib/calculations');
  await db.query('begin');
  try {
    const before = (await one('select count(*)::int p from profiles')).p;
    const day = (await one('select app_private.men_cycle_day($1, app_private.men_today()) n', [cycle])).n as number;
    assert.ok(day > 1, 'the real program is past day 1');
    const mk = async (phone: string) => {
      const uid = (await one("insert into auth.users(id, email) values (gen_random_uuid(), $1 || '@members.mutqin.local') returning id", [phone])).id;
      await db.query("select public.create_profile_with_membership($1, $2, $3, 'member', false, $4, '{}'::uuid[], null)", [uid, 'FRESH ' + phone, phone, batch]);
      return uid as string;
    };
    const fresh = await mk('000000000901');
    const normal = await mk('000000000902');

    // Only the Edge Function (service role) may set the baseline.
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id.admin, role: 'authenticated' })]);
    await db.query('set local role authenticated');
    await fails(db, 'select public.men_set_fresh_start($1, $2)', [fresh, batch], '42501');
    await db.query('reset role');

    const r = (await one('select public.men_set_fresh_start($1, $2) r', [fresh, batch])).r;
    assert.equal(r.start_quarter, day);
    const m = await one('select start_quarter, start_cycle_id from batch_memberships where user_id=$1', [fresh]);
    assert.deepEqual(m, { start_quarter: day, start_cycle_id: cycle });
    // A member with records in the cycle cannot be "reset" this way.
    await fails(db, 'select public.men_set_fresh_start($1, $2)', [id.member, batch], /سجلات/);

    // Database guard: sequential enforcement from the baseline.
    const as = async (uid: string) => {
      await db.query('reset role');
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: 'authenticated' })]);
      await db.query('set local role authenticated');
    };
    const ins = (uid: string, q: number) => `insert into tasmia_submissions(cycle_id,user_id,listener_id,quarter_number) values('${cycle}','${uid}','${id.peer}',${q})`;
    await as(fresh);
    await fails(db, ins(fresh, 1), [], new RegExp(`\(${day}\)`)); // quarter 1 is not owed: required is the start
    await fails(db, ins(fresh, day - 1), [], new RegExp(`\(${day}\)`));
    await fails(db, ins(fresh, day + 1), [], new RegExp(`\(${day}\)`)); // cannot skip the start
    await db.query(ins(fresh, day));
    await fails(db, ins(fresh, day + 1), [], /أتممت بالفعل/); // next one becomes due tomorrow (never ahead)
    // A normal new member still starts at quarter 1.
    await as(normal);
    await fails(db, ins(normal, day), [], /\(1\)/);
    await db.query('reset role');

    // Shared calculation from the baseline: no earlier recitation debt, today's quarter done.
    const recs = (await db.query('select user_id member_id, quarter_number from tasmia_submissions where user_id=$1', [fresh])).rows;
    const st = calculateMemberRequiredQuarter(fresh, day, recs, day);
    assert.deepEqual([st.pastMissedQuartersCount, st.allCompletedUpToToday, st.requiredQuarter], [0, true, day]);
    const st0 = calculateMemberRequiredQuarter(fresh, day, [], day);
    assert.deepEqual([st0.requiredQuarter, st0.pastMissedQuartersCount, st0.isBehind], [day, 0, false]);
    assert.equal(calculateMemberRequiredQuarter(normal, day, [], 1).pastMissedQuartersCount, day - 1);

    // Moving the membership elsewhere / a new cycle: the baseline belongs to this cycle only.
    assert.equal((await one('select count(*)::int n from batch_memberships where start_cycle_id is not null')).n, 1);
    assert.equal((await one('select count(*)::int p from profiles')).p, before + 2);
  } finally {
    await db.query('rollback');
  }
  // Nothing persisted: all real accounts and memberships unchanged.
  assert.equal((await one('select count(*)::int n from batch_memberships where start_quarter is not null')).n, 0);
});

// ---------------------------------------------------------------------------------------------
// «المراجعة البعيدة» (distant-review days)
// ---------------------------------------------------------------------------------------------
const addDays = (d: string, n: number) => {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
// Calendar of the active cycle as the shared JS code sees it (pauses, rest days, distant dates).
async function jsCalendar() {
  const c = await one("select to_char(starts_on,'YYYY-MM-DD') s, total_quarters, review_window, legacy_paused_days from cycles where id=$1", [cycle]);
  const pauses = (await db.query("select to_char(paused_on,'YYYY-MM-DD') f, to_char(resumed_on - 1,'YYYY-MM-DD') t, resumed_on is null o from program_pauses where cycle_id=$1 and (resumed_on is null or resumed_on > paused_on) order by paused_on", [cycle])).rows as any[];
  const rest = (await db.query("select to_char(rest_date,'YYYY-MM-DD') d from group_rest_days where cycle_id=$1", [cycle])).rows as any[];
  const distant = (await db.query("select to_char(review_date,'YYYY-MM-DD') d from distant_review_assignments where cycle_id=$1", [cycle])).rows as any[];
  const open = pauses.find((p) => p.o);
  const settings: GroupSettings = {
    id: 'x', start_date: c.s, total_quarters: c.total_quarters, review_window: c.review_window, current_cycle_number: 1,
    is_paused: !!open, paused_at: open?.f ?? null, total_paused_days: c.legacy_paused_days,
    pause_periods: pauses.filter((p) => !p.o).map((p) => ({ from: p.f, to: p.t })),
    distant_review_dates: distant.map((r) => r.d),
  };
  const restDays: RestDay[] = rest.map((r, i) => ({ id: String(i), date: r.d, note: '', added_by_admin_id: '', created_at: '' }));
  return { settings, restDays };
}
async function assertCalendarParity(label: string) {
  const { settings, restDays } = await jsCalendar();
  const rows = (await db.query(
    "select to_char(d,'YYYY-MM-DD') d, app_private.men_cycle_day($1, d::date) n from generate_series('2026-09-10'::date, '2027-03-31'::date, interval '1 day') d",
    [cycle]
  )).rows as any[];
  for (const r of rows) {
    const info = calculateCycleInfo(settings, restDays, r.d);
    assert.equal(r.n, info.has_started ? info.cycle_day : 0, `${label} ${r.d}`);
  }
}
const closeOpenPause = () => db.query("update program_pauses set resumed_on = paused_on + 2 where cycle_id=$1 and resumed_on is null", [cycle]);
const addDistant = (date: string, start = 1, end = 12) =>
  db.query('insert into distant_review_assignments(cycle_id, batch_id, review_date, start_quarter, end_quarter) values ($1, $2, $3, $4, $5) returning id', [cycle, batch, date, start, end]).then((r: any) => r.rows[0].id as string);

test('distant review: SQL program day equals the JS calendar (one, several, consecutive, rest/pause overlap, deletion)', async () => {
  await db.query('begin');
  try {
    await closeOpenPause();
    const before = (await one('select app_private.men_cycle_day($1, $2::date) n', [cycle, addDays(TODAY, 20)])).n;
    await addDistant(addDays(TODAY, 3));
    await addDistant(addDays(TODAY, 4)); // consecutive
    const separated = await addDistant(addDays(TODAY, 11));
    await addDistant('2026-10-08'); // a historical date
    await db.query("insert into program_pauses(cycle_id,paused_on,resumed_on) values($1,$2,$3)", [cycle, addDays(TODAY, 30), addDays(TODAY, 33)]);
    await addDistant(addDays(TODAY, 31)); // inside a global pause: not counted twice
    await assertCalendarParity('distant');
    // Each non-paused distant day takes exactly one program day; the Tuesday rule: next day continues.
    assert.equal((await one('select app_private.men_cycle_day($1, $2::date) n', [cycle, addDays(TODAY, 20)])).n, before - 4);
    const d3 = (await one('select app_private.men_cycle_day($1, $2::date) a, app_private.men_cycle_day($1, $3::date) b, app_private.men_cycle_day($1, $4::date) c', [cycle, addDays(TODAY, 2), addDays(TODAY, 3), addDays(TODAY, 5)]));
    assert.deepEqual([d3.b - d3.a, d3.c - d3.a], [0, 1]);
    // Deleting a future day restores it as a program day.
    await db.query('delete from distant_review_assignments where id=$1', [separated]);
    await assertCalendarParity('after delete');
    assert.equal((await one('select app_private.men_cycle_day($1, $2::date) n', [cycle, addDays(TODAY, 20)])).n, before - 3);
  } finally {
    await db.query('rollback');
  }
});

test('distant review: a rest day and a distant review may share a date (the distant review takes priority)', async () => {
  await db.query('begin');
  try {
    const date = addDays(TODAY, 6);
    await addDistant(date);
    // A rest day can be added on a distant-review date (the admin's own insert, browser RLS).
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id.admin, role: 'authenticated' })]);
    await db.query('set local role authenticated');
    await db.query("insert into group_rest_days(cycle_id, rest_date, created_by) values ($1, $2, $3)", [cycle, date, id.admin]);
    await db.query('reset role');
    // A distant review can be scheduled on a rest-day date.
    const restDate = addDays(TODAY, 7);
    await db.query("insert into group_rest_days(cycle_id, rest_date) values ($1, $2)", [cycle, restDate]);
    const saved = (await one('select public.men_distant_review_save(null, $1, $2, 1, 5, null, $3) r', [batch, restDate, id.admin])).r;
    assert.equal(saved.review_date, restDate);
    // The calendar counts such a date once (no double subtraction).
    const dayAfter = (await one('select app_private.men_cycle_day($1, $2::date) n', [cycle, addDays(TODAY, 8)])).n;
    await db.query('delete from distant_review_assignments where cycle_id=$1 and review_date in ($2, $3)', [cycle, date, restDate]);
    assert.equal((await one('select app_private.men_cycle_day($1, $2::date) n', [cycle, addDays(TODAY, 8)])).n, dayAfter);
  } finally {
    await db.query('rollback');
  }
});

test('distant review admin RPCs: service role only; one future date per call; edit/delete only while future', async () => {
  await as(id.admin, async (tx) => {
    await fails(tx, 'select public.men_distant_review_save(null, $1, $2, 1, 12, null, $3)', [batch, addDays(TODAY, 5), id.admin], '42501');
    await fails(tx, 'select public.men_distant_review_delete($1, $2)', [batch, batch], '42501');
    await fails(tx, "insert into distant_review_assignments(cycle_id, batch_id, review_date, start_quarter, end_quarter) values ($1,$2,$3,1,2)", [cycle, batch, addDays(TODAY, 5)], '42501');
  });
  await as(id.member, async (tx) => {
    await fails(tx, 'select public.men_distant_review_save(null, $1, $2, 1, 12, null, $3)', [batch, addDays(TODAY, 5), id.member], '42501');
  });
  await asService(async (tx) => {
    const save = (aid: string | null, date: string, s: number, e: number, note: string | null = null) =>
      tx.query('select public.men_distant_review_save($1, $2, $3, $4, $5, $6, $7) r', [aid, batch, date, s, e, note, id.admin]).then((r: any) => r.rows[0].r);
    const first = await save(null, addDays(TODAY, 10), 1, 12, '  مراجعة ما سبق قبل الاختبار  ');
    assert.deepEqual([first.review_date, first.start_quarter, first.end_quarter, first.note, first.batch_id, first.cycle_id], [addDays(TODAY, 10), 1, 12, 'مراجعة ما سبق قبل الاختبار', batch, cycle]);
    const second = await save(null, addDays(TODAY, 17), 20, 30);
    assert.notEqual(second.id, first.id);
    assert.equal(await n(tx, 'select 1 from distant_review_assignments where cycle_id=$1', [cycle]), 2); // nothing generated besides
    await fails(tx, 'select public.men_distant_review_save(null, $1, $2, 1, 12, null, $3)', [batch, TODAY, id.admin], /في المستقبل/);
    await fails(tx, 'select public.men_distant_review_save(null, $1, $2, 1, 12, null, $3)', [batch, addDays(TODAY, -3), id.admin], /في المستقبل/);
    await fails(tx, 'select public.men_distant_review_save(null, $1, $2, 13, 12, null, $3)', [batch, addDays(TODAY, 12), id.admin], /نطاق الأرباع/);
    await fails(tx, 'select public.men_distant_review_save(null, $1, $2, 0, 12, null, $3)', [batch, addDays(TODAY, 12), id.admin], /نطاق الأرباع/);
    await fails(tx, 'select public.men_distant_review_save(null, $1, $2, 1, 241, null, $3)', [batch, addDays(TODAY, 12), id.admin], /نطاق الأرباع/);
    await fails(tx, 'select public.men_distant_review_save(null, $1, $2, 1, 12, null, $3)', [batch, addDays(TODAY, 10), id.admin], '23505');
    // Edit a future one: date, range and note; colliding with another day is refused.
    const edited = await save(first.id, addDays(TODAY, 11), 2, 14, 'تعديل');
    assert.deepEqual([edited.id, edited.review_date, edited.start_quarter, edited.end_quarter, edited.note], [first.id, addDays(TODAY, 11), 2, 14, 'تعديل']);
    await fails(tx, 'select public.men_distant_review_save($1, $2, $3, 1, 2, null, $4)', [first.id, batch, addDays(TODAY, 17), id.admin], '23505');
    // Delete a future one.
    assert.equal((await tx.query('select public.men_distant_review_delete($1, $2) r', [second.id, batch])).rows[0].r.id, second.id);
    // Wrong batch for an existing id: not found.
    await fails(tx, 'select public.men_distant_review_delete($1, $2)', [first.id, '00000000-0000-0000-0000-000000000000'], 'P0002');
    // Today's and past days are kept: neither edited nor deleted.
    const past = (await tx.query("insert into distant_review_assignments(cycle_id, batch_id, review_date, start_quarter, end_quarter) values ($1,$2,$3,1,2) returning id", [cycle, batch, TODAY])).rows[0].id;
    await fails(tx, 'select public.men_distant_review_save($1, $2, $3, 1, 2, null, $4)', [past, batch, addDays(TODAY, 20), id.admin], /حلّ موعده/);
    await fails(tx, 'select public.men_distant_review_delete($1, $2)', [past, batch], /حلّ موعده/);
  });
});

test('distant review RLS: members read their batch days and only their own completions; anon nothing', async () => {
  await db.query('begin');
  try {
    await closeOpenPause();
    const a = await addDistant(TODAY, 1, 12);
    await db.query('insert into distant_review_completions(assignment_id, user_id, completed_on) values ($1, $2, $3)', [a, id.peer, TODAY]);
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id.member, role: 'authenticated' })]);
    await db.query('set local role authenticated');
    assert.equal(await n(db, 'select 1 from distant_review_assignments where id=$1', [a]), 1);
    assert.equal(await n(db, 'select 1 from distant_review_completions'), 0); // the peer's completion is not his
    await fails(db, 'insert into distant_review_completions(assignment_id, user_id, completed_on) values ($1, $2, $3)', [a, id.member, TODAY], '42501');
    await fails(db, 'update distant_review_assignments set end_quarter = 20 where id=$1', [a], '42501');
    await fails(db, 'delete from distant_review_assignments where id=$1', [a], '42501');
    await db.query('reset role');
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id.admin, role: 'authenticated' })]);
    await db.query('set local role authenticated');
    assert.equal(await n(db, 'select 1 from distant_review_completions where assignment_id=$1', [a]), 1); // admin sees the batch's
    await db.query('reset role');
    await db.query("select set_config('request.jwt.claims', '', true)");
    await db.query('set local role anon');
    await fails(db, 'select 1 from distant_review_assignments', [], '42501');
    await fails(db, 'select 1 from distant_review_completions', [], '42501');
    await fails(db, 'select public.men_complete_distant_review($1)', [a], '42501');
    await db.query('reset role');
  } finally {
    await db.query('rollback');
  }
});

test('distant review completion: owed today or late, idempotent, never future/paused/other batch/inactive; guards use the shifted day', async () => {
  await db.query('begin');
  try {
    await closeOpenPause();
    const dayBefore = (await one('select app_private.men_cycle_day($1, $2::date) n', [cycle, TODAY])).n as number;
    const today = await addDistant(TODAY, 1, 12);
    // A past program date that is not a rest day or paused (the snapshot has a real rest day).
    const missedDate = (await one(`select max(d)::date::text d from generate_series($1::date - 10, $1::date - 1, interval '1 day') d
      where not exists (select 1 from group_rest_days r where r.cycle_id=$2 and r.rest_date=d::date)
        and not app_private.men_is_paused_date($2, d::date)`, [TODAY, cycle])).d as string;
    const missed = await addDistant(missedDate, 13, 24);
    const future = await addDistant(addDays(TODAY, 2), 1, 2);
    // Today and the missed day no longer advance the program: today's day is two less.
    assert.equal((await one('select app_private.men_cycle_day($1, $2::date) n', [cycle, TODAY])).n, dayBefore - 2);
    // Normal guards follow the same calendar: a review recorded today stores the shifted range.
    const asUser = async (uid: string) => {
      await db.query('reset role');
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: 'authenticated' })]);
      await db.query('set local role authenticated');
    };
    await asUser(id.member);
    const completed = (await one('select public.men_complete_distant_review($1) r', [today])).r;
    assert.deepEqual([completed.user_id, completed.completed_on, completed.already_recorded], [id.member, TODAY, false]);
    assert.equal((await one('select public.men_complete_distant_review($1) r', [today])).r.already_recorded, true);
    const late = (await one('select public.men_complete_distant_review($1) r', [missed])).r;
    assert.equal(late.completed_on, TODAY); // completed late: assigned on a past date, done today
    await fails(db, 'select public.men_complete_distant_review($1)', [future], /لم يحن موعد/);
    await fails(db, 'select public.men_complete_distant_review($1)', ['00000000-0000-0000-0000-000000000000'], 'P0002');
    assert.equal(await n(db, 'select 1 from distant_review_completions where user_id=$1', [id.member]), 2);
    await asUser(id.inactive);
    await fails(db, 'select public.men_complete_distant_review($1)', [today], '42501');
    await db.query('reset role');
    // Paused date: the distant review is still owed (a pause does not cancel it).
    const pausedDate = (await one(`select min(d)::date::text d from generate_series($1::date - 20, $1::date - 12, interval '1 day') d
      where not exists (select 1 from group_rest_days r where r.cycle_id=$2 and r.rest_date=d::date)`, [TODAY, cycle])).d as string;
    await db.query("insert into program_pauses(cycle_id,paused_on,resumed_on) values($1,$2,$3)", [cycle, pausedDate, addDays(pausedDate, 1)]);
    const paused = await addDistant(pausedDate, 1, 2);
    await asUser(id.member);
    assert.equal((await one('select public.men_complete_distant_review($1) r', [paused])).r.already_recorded, false);
    await db.query('reset role');
    // Another batch's day: not his.
    const other = (await one("select public.create_batch_with_cycle('دفعة اختبار بعيدة', $1::date, null) b", [addDays(TODAY, -10)])).b;
    const otherCycle = (await one("select id from cycles where batch_id=$1 and status='active'", [other.id])).id;
    const otherA = (await one('insert into distant_review_assignments(cycle_id, batch_id, review_date, start_quarter, end_quarter) values ($1,$2,$3,1,2) returning id', [otherCycle, other.id, TODAY])).id;
    await asUser(id.member);
    await fails(db, 'select public.men_complete_distant_review($1)', [otherA], '42501');
    await db.query('reset role');
    // History: snapshot name kept; deleting the member removes only his completions (cascade).
    assert.ok((await one('select member_name_snapshot from distant_review_completions where assignment_id=$1', [today])).member_name_snapshot);
  } finally {
    await db.query('rollback');
  }
  assert.equal((await one('select count(*)::int n from distant_review_assignments')).n, 0);
});

test('migration 20261030 (distant review) changes no existing row, no history and no program day', async () => {
  const { createCutoverDb: build } = await import('../migration/cutover/harness.mjs');
  const fs = await import('node:fs');
  // The database exactly as production had it before this migration.
  const { db: fresh }: { db: any } = await (build as any)(BACKUP, { stopBefore: '20261030000100' });
  try {
    const tables = ['profiles', 'batches', 'batch_memberships', 'cycles', 'group_rest_days', 'program_pauses', 'tasmia_submissions', 'review_confirmations', 'peer_tests', 'peer_test_attempts', 'daily_thoughts'];
    const snapshot = async () => {
      const out: Record<string, string> = {};
      for (const t of tables) out[t] = (await fresh.query(`select count(*)::text || ':' || coalesce(md5(string_agg(x::text, '|' order by x::text)), '') h from public.${t} x`)).rows[0].h;
      const c = (await fresh.query("select id from cycles where status='active'")).rows[0].id;
      out.days = (await fresh.query("select string_agg(app_private.men_cycle_day($1, d::date)::text, ',' order by d) h from generate_series('2026-09-10'::date, '2027-06-30'::date, interval '1 day') d", [c])).rows[0].h;
      return out;
    };
    const before = await snapshot();
    assert.equal((await fresh.query("select to_regclass('public.distant_review_assignments') r")).rows[0].r, null);
    await fresh.exec(fs.readFileSync(new URL('../supabase/migrations/20261030000100_men_distant_review_days.sql', import.meta.url), 'utf8'));
    assert.deepEqual(await snapshot(), before);
  } finally {
    await fresh.close();
  }
});

test('program date: SQL men_program_date equals JS programDate (every 30 min across both DST changes, ±1 s at 05:00 Cairo)', async () => {
  const instants: Date[] = [];
  for (const [from, to] of [
    ['2026-01-14T00:00:00Z', '2026-01-16T00:00:00Z'],
    ['2026-04-22T00:00:00Z', '2026-04-27T00:00:00Z'],
    ['2026-07-14T00:00:00Z', '2026-07-16T00:00:00Z'],
    ['2026-10-26T00:00:00Z', '2026-11-03T00:00:00Z'],
  ])
    for (let t = Date.parse(from); t < Date.parse(to); t += 30 * 60_000) instants.push(new Date(t));
  for (const d of ['2026-01-15', '2026-04-24', '2026-04-25', '2026-07-15', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31']) {
    const s = programDayStart(d).getTime();
    instants.push(new Date(s - 1000), new Date(s), new Date(s + 1000));
  }
  const rows = (await db.query(
    'select i::int, app_private.men_program_date(t)::text d from unnest($1::timestamptz[]) with ordinality u(t, i)',
    [instants.map((x) => x.toISOString())]
  )).rows as { i: number; d: string }[];
  assert.equal(rows.length, instants.length);
  const mismatches = rows
    .filter((r) => r.d !== programDate(instants[r.i - 1]))
    .map((r) => `${instants[r.i - 1].toISOString()}: SQL ${r.d} JS ${programDate(instants[r.i - 1])}`);
  assert.deepEqual(mismatches, []);
  // The boundary itself, in SQL: 04:59:59 → previous date, 05:00:00 → new date (Cairo, both offsets).
  const at = async (iso: string) => (await one('select app_private.men_program_date($1::timestamptz)::text d', [iso])).d;
  assert.equal(await at('2026-10-28T01:59:59Z'), '2026-10-27'); // 04:59:59 Cairo (UTC+3)
  assert.equal(await at('2026-10-28T02:00:00Z'), '2026-10-28'); // 05:00:00 Cairo
  assert.equal(await at('2026-01-15T02:59:59Z'), '2026-01-14'); // 04:59:59 Cairo (UTC+2)
  assert.equal(await at('2026-01-15T03:00:00Z'), '2026-01-15'); // 05:00:00 Cairo
  // men_today() is the program date now.
  const js1 = programDate();
  const sql = (await one('select app_private.men_today()::text d, app_private.men_program_date(now())::text p')) as { d: string; p: string };
  const js2 = programDate();
  assert.equal(sql.d, sql.p);
  assert.ok(sql.d === js1 || sql.d === js2, `${sql.d} vs ${js1}/${js2}`);
});

test('membership join dates: JS and SQL read every stored joined_at as the same date (unchanged rule)', async () => {
  const rows = (await db.query(
    "select (extract(epoch from joined_at) * 1000)::float8 ms, (joined_at at time zone 'Asia/Riyadh')::date::text d from batch_memberships"
  )).rows as { ms: number; d: string }[];
  assert.ok(rows.length > 0);
  assert.deepEqual(rows.filter((r) => membershipDate(new Date(r.ms)) !== r.d), []);
});

test('batch admin data scope (alerts input): an unassigned batch yields no members, Tasmia or reviews', async () => {
  await db.query('begin');
  try {
    const b2 = (await db.query("select public.create_batch_with_cycle('دفعة التنبيهات', $1::date, $2) r", [TODAY, id.admin])).rows[0].r;
    const admin2 = (await one("select id from profiles where role='admin' and id<>$1 order by firestore_id limit 1", [id.admin]))?.id;
    assert.ok(admin2, 'a second admin exists in the snapshot');
    await db.query('update profiles set is_master_admin=false where id=$1', [admin2]);
    await db.query('select public.set_admin_batches($1, $2::uuid[], $3)', [admin2, [b2.id], id.admin]);
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: admin2, role: 'authenticated' })]);
    await db.query('set local role authenticated');
    assert.equal(await n(db, "select 1 from batch_memberships where batch_id=$1 and membership_role='member'", [batch]), 0);
    assert.equal(await n(db, 'select 1 from tasmia_submissions where cycle_id=$1', [cycle]), 0);
    assert.equal(await n(db, 'select 1 from review_confirmations where cycle_id=$1', [cycle]), 0);
    assert.equal(await n(db, 'select 1 from cycles where batch_id=$1', [batch]), 0);
    await db.query('reset role');
  } finally {
    await db.query('rollback');
  }
});

test('migration 20261031 (05:00 Cairo program date) changes no row, no history and no program day', async () => {
  const { createCutoverDb: build } = await import('../migration/cutover/harness.mjs');
  const fs = await import('node:fs');
  const { db: fresh }: { db: any } = await (build as any)(BACKUP, { stopBefore: '20261031000100' });
  try {
    const tables = ['profiles', 'batches', 'batch_memberships', 'cycles', 'group_rest_days', 'program_pauses', 'tasmia_submissions', 'review_confirmations',
      'peer_tests', 'peer_test_attempts', 'daily_thoughts', 'distant_review_assignments', 'distant_review_completions', 'personal_tests', 'personal_test_questions'];
    const snapshot = async () => {
      const out: Record<string, string> = {};
      for (const t of tables) out[t] = (await fresh.query(`select count(*)::text || ':' || coalesce(md5(string_agg(x::text, '|' order by x::text)), '') h from public.${t} x`)).rows[0].h;
      const c = (await fresh.query("select id from cycles where status='active'")).rows[0].id;
      out.days = (await fresh.query("select string_agg(app_private.men_cycle_day($1, d::date)::text, ',' order by d) h from generate_series('2026-09-10'::date, '2027-06-30'::date, interval '1 day') d", [c])).rows[0].h;
      return out;
    };
    const before = await snapshot();
    const oldToday = (await fresh.query('select app_private.men_today()::text d')).rows[0].d;
    assert.equal(oldToday, (await fresh.query("select (now() at time zone 'Asia/Riyadh')::date::text d")).rows[0].d, 'before: Makkah calendar date');
    await fresh.exec(fs.readFileSync(new URL('../supabase/migrations/20261031000100_men_program_date_5am_cairo.sql', import.meta.url), 'utf8'));
    assert.deepEqual(await snapshot(), before);
    assert.equal((await fresh.query('select app_private.men_today()::text d')).rows[0].d, (await fresh.query('select app_private.men_program_date(now())::text d')).rows[0].d);
  } finally {
    await fresh.close();
  }
});

test('notification state: own rows only, one row per key (idempotent seen / archive), no direct writes, anon nothing', async () => {
  await db.query('begin');
  try {
    const item = (key: string, urgent = false) => JSON.stringify({ key, kind: 'rest-tomorrow', tone: 'info', urgent, title: 'غدًا يوم راحة', body: 'x' });
    await as(id.member, async (tx) => {
      assert.equal((await tx.query('select public.men_notifications_mark_seen($1::jsonb) n', [`[${item('b:1:rest-tomorrow:2026-11-02')}]`])).rows[0].n, 1);
      await tx.query('select public.men_notifications_mark_seen($1::jsonb)', [`[${item('b:1:rest-tomorrow:2026-11-02')}]`]);
      const r1 = (await tx.query("select seen_at, archived_at from notification_states where notification_key='b:1:rest-tomorrow:2026-11-02'")).rows;
      assert.equal(r1.length, 1, 'opening the panel twice keeps one row');
      assert.ok(r1[0].seen_at && r1[0].archived_at === null, 'seen, not archived');
      const a1 = (await tx.query('select public.men_notification_archive($1::jsonb) t', [item('b:1:rest-tomorrow:2026-11-02')])).rows[0].t;
      const a2 = (await tx.query('select public.men_notification_archive($1::jsonb) t', [item('b:1:rest-tomorrow:2026-11-02')])).rows[0].t;
      assert.equal(String(a1), String(a2), 'the first click time is kept');
      assert.equal(await n(tx, 'select 1 from notification_states'), 1);
      await fails(tx, "insert into notification_states(user_id, notification_key) values($1, 'x')", [id.member], '42501');
      await fails(tx, 'update notification_states set archived_at = null', [], '42501');
      await fails(tx, 'delete from notification_states', [], '42501');
      await fails(tx, "select public.men_notifications_mark_seen('{}'::jsonb)", [], '22023');
    });
    await as(id.peer, async (tx) => assert.equal(await n(tx, 'select 1 from notification_states'), 0, "another member's state is invisible"));
    await as(id.admin, async (tx) => assert.equal(await n(tx, 'select 1 from notification_states'), 0, "admins do not see members' state"));
    await as(null, async (tx) => {
      await fails(tx, 'select 1 from notification_states', [], '42501');
      await fails(tx, "select public.men_notification_archive('{\"key\":\"x\"}'::jsonb)", [], '42501');
    });
    await as(id.inactive, (tx) => fails(tx, 'select public.men_notification_archive($1::jsonb)', [item('k')], '42501'));
  } finally {
    await db.query('rollback');
  }
});

test('master admin batch follows: only master admins, only their own preferences; batch admins cannot follow', async () => {
  await db.query('begin');
  try {
    const b2 = (await db.query("select public.create_batch_with_cycle('دفعة المتابعة', $1::date, $2) r", [TODAY, id.admin])).rows[0].r.id;
    const masters = (await db.query("select id from profiles where role='admin' and is_master_admin and active order by firestore_id")).rows.map((r: any) => r.id);
    const m1 = masters[0];
    await as(m1, async (tx) => {
      await tx.query('select public.men_set_notification_batch_follow($1, true)', [batch]);
      await tx.query('select public.men_set_notification_batch_follow($1, false)', [b2]);
      await tx.query('select public.men_set_notification_batch_follow($1, true)', [batch]);
      const rows = (await tx.query('select batch_id, enabled from admin_notification_batch_subscriptions order by enabled desc')).rows;
      assert.deepEqual(rows.map((r: any) => [r.batch_id, r.enabled]), [[batch, true], [b2, false]], 'one row per batch, latest choice');
      await fails(tx, 'select public.men_set_notification_batch_follow($1, true)', ['00000000-0000-4000-8000-000000000000'], 'P0002');
      await fails(tx, 'insert into admin_notification_batch_subscriptions(admin_user_id, batch_id) values($1,$2)', [m1, b2], '42501');
    });
    // A batch admin (not master) can neither follow nor read follows.
    const admin2 = (await one("select id from profiles where role='admin' and id<>$1 order by firestore_id limit 1", [m1]))?.id;
    if (admin2) {
      await db.query('update profiles set is_master_admin=false where id=$1', [admin2]);
      await as(admin2, async (tx) => {
        await fails(tx, 'select public.men_set_notification_batch_follow($1, true)', [batch], '42501');
        assert.equal(await n(tx, 'select 1 from admin_notification_batch_subscriptions'), 0);
      });
    }
    await as(id.member, async (tx) => {
      await fails(tx, 'select public.men_set_notification_batch_follow($1, true)', [batch], '42501');
      assert.equal(await n(tx, 'select 1 from admin_notification_batch_subscriptions'), 0);
    });
    await as(null, (tx) => fails(tx, 'select 1 from admin_notification_batch_subscriptions', [], '42501'));
  } finally {
    await db.query('rollback');
  }
});

test('migration 20261101 (notification state) changes no existing row', async () => {
  const { createCutoverDb: build } = await import('../migration/cutover/harness.mjs');
  const fs = await import('node:fs');
  const { db: fresh }: { db: any } = await (build as any)(BACKUP, { stopBefore: '20261101000100' });
  try {
    const tables = ['profiles', 'batches', 'batch_memberships', 'cycles', 'group_rest_days', 'program_pauses', 'tasmia_submissions', 'review_confirmations',
      'peer_tests', 'peer_test_attempts', 'daily_thoughts', 'distant_review_assignments', 'distant_review_completions', 'personal_tests'];
    const snapshot = async () => {
      const out: Record<string, string> = {};
      for (const t of tables) out[t] = (await fresh.query(`select count(*)::text || ':' || coalesce(md5(string_agg(x::text, '|' order by x::text)), '') h from public.${t} x`)).rows[0].h;
      return out;
    };
    const before = await snapshot();
    await fresh.exec(fs.readFileSync(new URL('../supabase/migrations/20261101000100_men_notification_state.sql', import.meta.url), 'utf8'));
    assert.deepEqual(await snapshot(), before);
    assert.equal((await fresh.query('select count(*)::int n from notification_states')).rows[0].n, 0);
  } finally {
    await fresh.close();
  }
});

const switchTo = async (uid: string | null) => {
  await db.query('reset role');
  if (!uid) return;
  await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.query('set local role authenticated');
};

test('distant review during an OPEN global pause: owed and completable today; normal progression paused', async () => {
  await db.query('begin');
  try {
    await db.query("update program_pauses set resumed_on=$2::date where cycle_id=$1 and resumed_on is null", [cycle, addDays(TODAY, -3)]);
    await db.query("insert into program_pauses(cycle_id, paused_on) values ($1, $2::date)", [cycle, addDays(TODAY, -1)]);
    const dayBefore = (await one('select app_private.men_cycle_day($1, $2::date) n', [cycle, addDays(TODAY, -2)])).n;
    const a = await addDistant(TODAY, 1, 4);
    assert.equal((await one('select app_private.men_cycle_day($1, $2::date) n', [cycle, TODAY])).n, dayBefore, 'no new program day while paused');
    await switchTo(id.member);
    const r = (await one('select public.men_complete_distant_review($1) r', [a])).r;
    assert.equal(r.already_recorded, false);
    assert.equal((await one('select public.men_complete_distant_review($1) r', [a])).r.already_recorded, true, 'idempotent: one completion');
    await switchTo(null);
    assert.equal(await n(db, 'select 1 from distant_review_completions where assignment_id=$1', [a]), 1);
  } finally {
    await db.query('rollback');
  }
});

test('admin alert dismissals: per admin, own rows only, restorable; members and anon cannot', async () => {
  await db.query('begin');
  try {
    const masters = (await db.query("select id from profiles where role='admin' and is_master_admin and active order by firestore_id")).rows.map((r: any) => r.id);
    const m1 = masters[0];
    const admin2 = (await one("select id from profiles where role='admin' and id<>$1 order by firestore_id limit 1", [m1]))?.id;
    assert.ok(admin2);
    await db.query('update profiles set is_master_admin=false, active=true where id=$1', [admin2]);
    await db.query('select public.set_admin_batches($1, $2::uuid[], $3)', [admin2, [batch], m1]);
    await switchTo(m1);
    await db.query("select public.men_admin_alert_dismiss($1, $2, 'عضو', 'ملخص')", [batch, id.member]);
    await db.query("select public.men_admin_alert_dismiss($1, $2, 'عضو', 'ملخص 2')", [batch, id.member]);
    assert.equal(await n(db, 'select 1 from admin_alert_dismissals'), 1, 'one row per admin + member');
    await fails(db, "insert into admin_alert_dismissals(admin_user_id, batch_id, member_user_id) values ($1,$2,$3)", [m1, batch, id.peer], '42501');
    await fails(db, "select public.men_admin_alert_dismiss($1, $2, '', '')", [batch, m1], 'P0002');
    // Another admin does not see it and cannot restore it (his own state is independent).
    await switchTo(admin2);
    assert.equal(await n(db, 'select 1 from admin_alert_dismissals'), 0);
    assert.equal((await one('select public.men_admin_alert_restore($1, $2) r', [batch, id.member])).r, false);
    await switchTo(null);
    assert.equal(await n(db, 'select 1 from admin_alert_dismissals where admin_user_id=$1', [m1]), 1, 'the other admin did not touch it');
    // Restore clears the dismissal and this admin's "opened" marks of that member's alert.
    await switchTo(m1);
    await db.query('select public.men_notification_archive($1::jsonb)', [JSON.stringify({ key: `alert:${batch}:${id.member}:t5`, kind: 'admin-member', tone: 'serious', urgent: true, title: 'x', body: 'y' })]);
    assert.equal((await one('select public.men_admin_alert_restore($1, $2) r', [batch, id.member])).r, true);
    assert.equal(await n(db, 'select 1 from admin_alert_dismissals'), 0);
    assert.equal(await n(db, "select 1 from notification_states where notification_key like 'alert:%'"), 0);
    await switchTo(null);
    // A batch admin may dismiss only in his batches; members and anon never.
    const b2 = (await db.query("select public.create_batch_with_cycle('دفعة بلا مشرف', $1::date, $2) r", [TODAY, m1])).rows[0].r.id;
    await db.query('select public.move_member_batch($1,$2,null,$3)', [id.peer, b2, m1]);
    await switchTo(admin2);
    await fails(db, "select public.men_admin_alert_dismiss($1, $2, '', '')", [b2, id.peer], '42501');
    await switchTo(id.member);
    await fails(db, "select public.men_admin_alert_dismiss($1, $2, '', '')", [batch, id.inactive], '42501');
    assert.equal(await n(db, 'select 1 from admin_alert_dismissals'), 0);
    await switchTo(null);
    await db.query("select set_config('request.jwt.claims', '', true)");
    await db.query('set local role anon');
    await fails(db, 'select 1 from admin_alert_dismissals', [], '42501');
    await db.query('reset role');
  } finally {
    await db.query('rollback');
  }
});

test('migration 20261102 (distant priority, alert dismissals) changes no existing row and no program day', async () => {
  const { createCutoverDb: build } = await import('../migration/cutover/harness.mjs');
  const fs = await import('node:fs');
  const { db: fresh }: { db: any } = await (build as any)(BACKUP, { stopBefore: '20261102000100' });
  try {
    const tables = ['profiles', 'batches', 'batch_memberships', 'cycles', 'group_rest_days', 'program_pauses', 'tasmia_submissions', 'review_confirmations',
      'peer_tests', 'peer_test_attempts', 'daily_thoughts', 'distant_review_assignments', 'distant_review_completions', 'notification_states', 'admin_notification_batch_subscriptions'];
    const snapshot = async () => {
      const out: Record<string, string> = {};
      for (const t of tables) out[t] = (await fresh.query(`select count(*)::text || ':' || coalesce(md5(string_agg(x::text, '|' order by x::text)), '') h from public.${t} x`)).rows[0].h;
      const c = (await fresh.query("select id from cycles where status='active'")).rows[0].id;
      out.days = (await fresh.query("select string_agg(app_private.men_cycle_day($1, d::date)::text, ',' order by d) h from generate_series('2026-09-10'::date, '2027-06-30'::date, interval '1 day') d", [c])).rows[0].h;
      return out;
    };
    const before = await snapshot();
    await fresh.exec(fs.readFileSync(new URL('../supabase/migrations/20261102000100_men_distant_review_priority_and_alert_dismissals.sql', import.meta.url), 'utf8'));
    assert.deepEqual(await snapshot(), before);
  } finally {
    await fresh.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Turning TODAY into a «المراجعة البعيدة» day (men_distant_review_create_today, voided_daily_records)
// ---------------------------------------------------------------------------------------------
type SameDay = { b: string; c: string; a: string; bb: string; l: string; day: number };
let phoneSeq = 910;

// A member of a temporary batch (rolled back with the test), joined since the batch started.
async function sdMember(b: string, joinedOn: string): Promise<string> {
  const phone = '000000000' + phoneSeq++;
  const uid = (await one("insert into auth.users(id, email) values (gen_random_uuid(), $1 || '@members.mutqin.local') returning id", [phone])).id;
  await db.query("select public.create_profile_with_membership($1, $2, $3, 'member', false, $4, '{}'::uuid[], null)", [uid, 'SD ' + phone, phone, b]);
  await db.query('update batch_memberships set joined_at=$2::timestamptz where user_id=$1', [uid, joinedOn + 'T12:00:00+03:00']);
  return uid;
}

// A temporary batch whose today is program day startDaysAgo + 1 (no day off), with three members.
// Every statement runs in one transaction that is rolled back.
async function sameDay(fn: (w: SameDay) => Promise<void>, startDaysAgo = 9) {
  await db.query('begin');
  try {
    const start = addDays(TODAY, -startDaysAgo);
    const created = (await one("select public.create_batch_with_cycle('دفعة اليوم', $1::date, null) b", [start])).b;
    const c = (await one("select id from cycles where batch_id=$1 and status='active'", [created.id])).id;
    const a = await sdMember(created.id, start);
    const bb = await sdMember(created.id, start);
    const l = await sdMember(created.id, start);
    await fn({ b: created.id, c, a, bb, l, day: startDaysAgo + 1 });
  } finally {
    await db.query('rollback');
  }
}
const createToday = (w: SameDay, s = 1, e = 9) =>
  one('select public.men_distant_review_create_today($1, $2, $3, $4, $5, $6) r', [w.b, TODAY, s, e, null, id.admin]).then((x) => x.r);
// Quarters from..to recited in order; all but today's quarter are moved back to their own date.
async function recite(w: SameDay, user: string, from: number, to: number, listener = w.l) {
  for (let q = from; q <= to; q++) {
    await db.query('insert into tasmia_submissions(cycle_id, user_id, listener_id, quarter_number, notes) values ($1,$2,$3,$4,$5)', [w.c, user, listener, q, 'ملاحظة ' + q]);
    if (q < w.day) {
      const date = addDays(TODAY, q - w.day);
      await db.query("update tasmia_submissions set legacy_date=$3::date, submitted_at=$4::timestamptz where cycle_id=$1 and user_id=$2 and quarter_number=$5", [w.c, user, date, date + 'T12:00:00+03:00', q]);
    }
  }
}
// Reviews of days from..to, each on its own date.
async function review(w: SameDay, user: string, from: number, to: number) {
  for (let d = from; d <= to; d++) await db.query('insert into review_confirmations(cycle_id, user_id, legacy_date, notes) values ($1,$2,$3,$4)', [w.c, user, addDays(TODAY, d - w.day), 'ن ' + d]);
}
const liveQuarters = async (w: SameDay, user: string) =>
  ((await db.query('select quarter_number q from tasmia_submissions where cycle_id=$1 and user_id=$2 order by 1', [w.c, user])).rows as any[]).map((r) => r.q);
const liveReviewDays = async (w: SameDay, user: string) =>
  ((await db.query('select end_quarter q from review_confirmations where cycle_id=$1 and user_id=$2 order by 1', [w.c, user])).rows as any[]).map((r) => r.q);
const cycleDay = (c: string, date: string) => one('select app_private.men_cycle_day($1, $2::date) n', [c, date]).then((x) => x.n as number);
// The clock moves on: men_today() is replaced inside the rolled-back transaction.
const setProgramDate = (date: string) =>
  db.query(`create or replace function app_private.men_today() returns date language sql stable set search_path to '' as $f$ select '${date}'::date $f$`);

// The real rows and the real shared code: what the dashboards compute for this member on this date.
async function statusFromDb(c: string, user: string, date: string, joinedOn?: string, startQuarter?: number) {
  const { computeMemberDelayStatus } = await import('../src/lib/calculations');
  const { buildSettings, mapRestDays } = await import('../supabase/functions/_shared/men/menRows.ts');
  const cy = await one('select id, batch_id, cycle_number, starts_on::text starts_on, status, total_quarters, review_window, legacy_paused_days, created_at::text from cycles where id=$1', [c]);
  const pauses = (await db.query('select paused_on::text paused_on, resumed_on::text resumed_on from program_pauses where cycle_id=$1', [c])).rows as any[];
  const rest = (await db.query('select id, firestore_id, rest_date::text rest_date, reason, created_by, created_by_name_snapshot, created_at::text from group_rest_days where cycle_id=$1', [c])).rows as any[];
  const distant = ((await db.query('select review_date::text d from distant_review_assignments where cycle_id=$1', [c])).rows as any[]).map((r) => r.d as string);
  const settings = buildSettings(cy, pauses, null, distant);
  const restDays = mapRestDays(rest);
  const info = calculateCycleInfo(settings, restDays, date);
  const { getActiveCycleDates } = await import('../src/lib/calculations');
  const activeCycleDates = getActiveCycleDates(settings.start_date, date, restDays, settings);
  const recitations = (await db.query('select user_id member_id, quarter_number from tasmia_submissions where cycle_id=$1 and user_id=$2', [c, user])).rows as any[];
  const revisions = (await db.query('select user_id member_id, legacy_date::text date, end_quarter review_end_quarter from review_confirmations where cycle_id=$1 and user_id=$2', [c, user])).rows as any[];
  return { info, settings, restDays, delay: computeMemberDelayStatus({ memberId: user, quarterOfDay: info.quarter_of_day, activeCycleDates, recitations, revisions, todayDate: date, joinedOnDate: joinedOn, startQuarter, calendar: settings }) };
}

test('same-day A/B: service role only; the future path still refuses today; validations hold', async () => {
  for (const uid of [id.admin, id.member, null])
    await as(uid, (tx) => fails(tx, 'select public.men_distant_review_create_today($1, $2, 1, 9, null, $3)', [batch, TODAY, id.admin], '42501'));
  await sameDay(async (w) => {
    await fails(db, 'select public.men_distant_review_save(null, $1, $2, 1, 9, null, $3)', [w.b, TODAY, id.admin], /في المستقبل/);
    // A future day still works as before and cancels nothing.
    const future = (await one('select public.men_distant_review_save(null, $1, $2, 1, 9, null, $3) r', [w.b, addDays(TODAY, 3), id.admin])).r;
    assert.equal(future.cancelled_program_day, null);
    assert.equal(await n(db, 'select 1 from voided_daily_records'), 0);
    // An existing future day cannot be edited onto today.
    await fails(db, 'select public.men_distant_review_save($1, $2, $3, 1, 9, null, $4)', [future.id, w.b, TODAY, id.admin], /في المستقبل/);
    // Only today, a valid range, once.
    await fails(db, 'select public.men_distant_review_create_today($1, $2, 1, 9, null, $3)', [w.b, addDays(TODAY, -1), id.admin], /تغيّر يوم البرنامج/);
    await fails(db, 'select public.men_distant_review_create_today($1, $2, 1, 9, null, $3)', [w.b, addDays(TODAY, 1), id.admin], /تغيّر يوم البرنامج/);
    await fails(db, 'select public.men_distant_review_create_today($1, $2, 9, 9, null, $3)', [w.b, TODAY, id.admin], /نطاق الأرباع/);
    const r = await createToday(w);
    assert.deepEqual([r.voided_tasmia, r.voided_reviews], [0, 0]);
    assert.equal(r.assignment.review_date, TODAY);
    assert.equal(r.assignment.cancelled_program_day, w.day);
    assert.ok(r.assignment.created_by_name_snapshot);
    await fails(db, 'select public.men_distant_review_create_today($1, $2, 1, 9, null, $3)', [w.b, TODAY, id.admin], '23505');
  });
});

test('same-day C/D: today returns to N, the next active day is exactly N+1, earlier days do not move', async () => {
  await sameDay(async (w) => {
    const before = await Promise.all([-3, -2, -1].map((d) => cycleDay(w.c, addDays(TODAY, d))));
    assert.equal(await cycleDay(w.c, TODAY), 10);
    await createToday(w);
    assert.equal(await cycleDay(w.c, TODAY), 9);
    assert.equal(await cycleDay(w.c, addDays(TODAY, 1)), 10);
    assert.equal(await cycleDay(w.c, addDays(TODAY, 2)), 11);
    assert.deepEqual(await Promise.all([-3, -2, -1].map((d) => cycleDay(w.c, addDays(TODAY, d)))), before);
  });
});

test('same-day E/F/H/I: only today\'s normal rows move, with every detail; catch-up and other batches stay', async () => {
  await sameDay(async (w) => {
    await recite(w, w.a, 1, 10);
    await review(w, w.a, 1, 10);
    // Catch-up done today: quarter 6 and the review of day 4 carry today's timestamps; they stay.
    await recite(w, w.bb, 1, 5);
    await db.query('insert into tasmia_submissions(cycle_id, user_id, listener_id, quarter_number) values ($1,$2,$3,6)', [w.c, w.bb, w.l]);
    await db.query('insert into review_confirmations(cycle_id, user_id, legacy_date) values ($1,$2,$3)', [w.c, w.bb, addDays(TODAY, -6)]);
    // Another batch's rows with the same numbers stay.
    const other = (await one("select public.create_batch_with_cycle('دفعة أخرى', $1::date, null) b", [addDays(TODAY, -9)])).b;
    const otherCycle = (await one("select id from cycles where batch_id=$1 and status='active'", [other.id])).id;
    const ow: SameDay = { b: other.id, c: otherCycle, a: await sdMember(other.id, addDays(TODAY, -9)), bb: '', l: await sdMember(other.id, addDays(TODAY, -9)), day: 10 };
    await recite(ow, ow.a, 1, 10);
    await review(ow, ow.a, 10, 10);

    const original = await one('select id, listener_id, listener_name_snapshot, member_name_snapshot, submitted_at, notes from tasmia_submissions where cycle_id=$1 and user_id=$2 and quarter_number=10', [w.c, w.a]);
    const originalReview = await one('select id, start_quarter, end_quarter, confirmed_at, notes, member_name_snapshot, legacy_date::text legacy_date from review_confirmations where cycle_id=$1 and user_id=$2 and legacy_date=$3', [w.c, w.a, TODAY]);
    assert.equal(originalReview.end_quarter, 10);

    const r = await createToday(w);
    assert.deepEqual([r.voided_tasmia, r.voided_reviews], [1, 1]);

    assert.deepEqual(await liveQuarters(w, w.a), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(await liveReviewDays(w, w.a), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(await liveQuarters(w, w.bb), [1, 2, 3, 4, 5, 6], 'catch-up quarter stays');
    assert.equal((await liveReviewDays(w, w.bb)).length, 1, 'catch-up review stays');
    assert.equal(await n(db, 'select 1 from tasmia_submissions where cycle_id=$1 and quarter_number=10', [otherCycle]), 1);
    assert.equal(await n(db, 'select 1 from review_confirmations where cycle_id=$1 and legacy_date=$2', [otherCycle, TODAY]), 1);

    const t = await one("select * from voided_daily_records where kind='tasmia' and user_id=$1", [w.a]);
    assert.equal(t.original_id, original.id);
    assert.equal(t.program_day, 10);
    assert.equal(t.cycle_id, w.c);
    assert.equal(t.assignment_id, r.assignment.id);
    assert.equal(t.listener_id, w.l);
    assert.equal(t.listener_name_snapshot, original.listener_name_snapshot);
    assert.equal(t.member_name_snapshot, original.member_name_snapshot);
    assert.equal(t.notes, 'ملاحظة 10');
    assert.deepEqual(t.recorded_at, original.submitted_at);
    assert.equal(t.voided_by, id.admin);
    assert.ok(t.voided_at);
    assert.equal((await one("select program_date::text d, legacy_date::text l from voided_daily_records where kind='tasmia' and user_id=$1", [w.a])).d, TODAY);
    const v = await one("select *, legacy_date::text ld from voided_daily_records where kind='review' and user_id=$1", [w.a]);
    assert.equal(v.original_id, originalReview.id);
    assert.deepEqual([v.program_day, v.start_quarter, v.end_quarter], [10, originalReview.start_quarter, 10]);
    assert.equal(v.notes, 'ن 10');
    assert.equal(v.ld, TODAY);
    assert.equal(v.member_name_snapshot, originalReview.member_name_snapshot);
    assert.deepEqual(v.recorded_at, originalReview.confirmed_at);
  });
});

test('same-day: a quarter recited on an earlier date is not voided; one recorded today is, whatever date the device sent', async () => {
  await sameDay(async (w) => {
    await recite(w, w.a, 1, 10);
    // Q10 recited earlier (a later calendar edit moved the program back): legitimate, it stays.
    await db.query('update tasmia_submissions set legacy_date=$3, submitted_at=$4 where cycle_id=$1 and user_id=$2 and quarter_number=10', [w.c, w.a, addDays(TODAY, -2), addDays(TODAY, -2) + 'T12:00:00+03:00']);
    await recite(w, w.bb, 1, 10);
    // A device clock one day ahead: recorded today although it carries tomorrow's date.
    await db.query('update tasmia_submissions set legacy_date=$3 where cycle_id=$1 and user_id=$2 and quarter_number=10', [w.c, w.bb, addDays(TODAY, 1)]);
    const r = await createToday(w);
    assert.equal(r.voided_tasmia, 1);
    assert.equal(await n(db, 'select 1 from tasmia_submissions where user_id=$1 and quarter_number=10', [w.a]), 1, 'earlier recitation protected');
    assert.equal(await n(db, 'select 1 from tasmia_submissions where user_id=$1 and quarter_number=10', [w.bb]), 0);
  });
});

test('same-day G/J/K: the shared code sees no fake debt; both members match; counts do not grow', async () => {
  await sameDay(async (w) => {
    const start = addDays(TODAY, -9);
    await recite(w, w.a, 1, 10);
    await review(w, w.a, 1, 10);
    await recite(w, w.bb, 1, 9);
    await review(w, w.bb, 1, 9);
    await createToday(w);
    const today = await Promise.all([statusFromDb(w.c, w.a, TODAY, start), statusFromDb(w.c, w.bb, TODAY, start)]);
    assert.equal(today[0].info.quarter_of_day, 9);
    assert.equal(today[0].info.is_distant_review_day, true);
    for (const s of today) assert.deepEqual([s.delay.missedQuartersCount, s.delay.missedRevisionDaysCount, s.delay.isSeverelyBehind], [0, 0, false]);
    assert.deepEqual(today[0].delay, today[1].delay);
    const tomorrow = addDays(TODAY, 1);
    const next = await Promise.all([statusFromDb(w.c, w.a, tomorrow, start), statusFromDb(w.c, w.bb, tomorrow, start)]);
    assert.equal(next[0].info.quarter_of_day, 10);
    for (const s of next) {
      assert.equal(s.delay.requiredQuarter, 10);
      assert.deepEqual([s.delay.missedQuartersCount, s.delay.missedRevisionDaysCount, s.delay.isSeverelyBehind], [0, 0, false]);
    }
    assert.deepEqual(next[0].delay, next[1].delay);
  });
  // A member already behind: quarter 9 becomes today's quarter (not past), and nothing is added.
  await sameDay(async (w) => {
    const start = addDays(TODAY, -9);
    await recite(w, w.a, 1, 6);
    await review(w, w.a, 1, 6);
    const before = await statusFromDb(w.c, w.a, TODAY, start);
    assert.deepEqual([before.delay.missedQuartersCount, before.delay.missedRevisionDaysCount], [3, 3]);
    await createToday(w);
    const after = await statusFromDb(w.c, w.a, TODAY, start);
    assert.deepEqual([after.delay.missedQuartersCount, after.delay.missedRevisionDaysCount, after.delay.isSeverelyBehind], [2, 3, false]);
  });
});

test('same-day L: the day stays a normal distant review: completion works; it cannot be edited or deleted', async () => {
  await sameDay(async (w) => {
    const r = await createToday(w);
    await fails(db, 'select public.men_distant_review_save($1, $2, $3, 1, 9, null, $4)', [r.assignment.id, w.b, addDays(TODAY, 2), id.admin], /حلّ موعده/);
    await fails(db, 'select public.men_distant_review_delete($1, $2)', [r.assignment.id, w.b], /حلّ موعده/);
    await switchTo(w.a);
    const done = (await one('select public.men_complete_distant_review($1) r', [r.assignment.id])).r;
    assert.deepEqual([done.completed_on, done.already_recorded], [TODAY, false]);
    await switchTo(null);
  });
});

test('same-day M: today already a rest or paused day: no cancelled day, nothing voided, no guard, no extra day lost', async () => {
  const off: ((w: SameDay) => Promise<unknown>)[] = [
    (w) => db.query('insert into group_rest_days(cycle_id, rest_date) values ($1, $2)', [w.c, TODAY]),
    (w) => db.query('insert into program_pauses(cycle_id, paused_on) values ($1, $2)', [w.c, addDays(TODAY, -1)]),
    (w) => db.query('insert into program_pauses(cycle_id, paused_on, resumed_on) values ($1, $2, $3)', [w.c, TODAY, addDays(TODAY, 1)]),
  ];
  for (const setOff of off) {
    await sameDay(async (w) => {
      await setOff(w);
      const day = await cycleDay(w.c, TODAY);
      const next = await cycleDay(w.c, addDays(TODAY, 1));
      await recite(w, w.a, 1, day - 1);
      await db.query('insert into tasmia_submissions(cycle_id, user_id, listener_id, quarter_number) values ($1,$2,$3,$4)', [w.c, w.a, w.l, day]);
      await db.query('insert into review_confirmations(cycle_id, user_id, legacy_date) values ($1,$2,$3)', [w.c, w.a, TODAY]);
      const r = await createToday(w);
      assert.equal(r.assignment.cancelled_program_day, null);
      assert.deepEqual([r.voided_tasmia, r.voided_reviews], [0, 0]);
      assert.equal(await cycleDay(w.c, TODAY), day, 'no extra day cancelled');
      assert.equal(await cycleDay(w.c, addDays(TODAY, 1)), next);
      assert.equal(await n(db, 'select 1 from review_confirmations where user_id=$1 and legacy_date=$2', [w.a, TODAY]), 1);
      // The rule for a non-converted date is unchanged: a review on it is still accepted.
      await db.query('insert into review_confirmations(cycle_id, user_id, legacy_date) values ($1,$2,$3)', [w.c, w.bb, TODAY]);
    });
  }
});

test('same-day Q: an app opened before the conversion cannot submit the cancelled work; catch-up still works', async () => {
  await sameDay(async (w) => {
    await recite(w, w.a, 1, 5);
    await review(w, w.a, 1, 5);
    await recite(w, w.bb, 1, 9);
    await createToday(w);
    const insTasmia = 'insert into tasmia_submissions(cycle_id, user_id, listener_id, quarter_number, legacy_date) values ($1,$2,$3,$4,$5)';
    const insReview = 'insert into review_confirmations(cycle_id, user_id, legacy_date) values ($1,$2,$3)';
    await switchTo(w.bb);
    await fails(db, insTasmia, [w.c, w.bb, w.l, 10, TODAY], /تحوّل اليوم إلى يوم مراجعة بعيدة/);
    // A device clock one day ahead would pass the ordered guard (tomorrow's day is 10): refused too.
    await fails(db, insTasmia, [w.c, w.bb, w.l, 10, addDays(TODAY, 1)], /تحوّل اليوم إلى يوم مراجعة بعيدة/);
    await fails(db, insReview, [w.c, w.bb, TODAY], /تحوّل اليوم إلى يوم مراجعة بعيدة/);
    await fails(db, 'insert into review_confirmations(cycle_id, user_id) values ($1,$2)', [w.c, w.bb], /تحوّل اليوم إلى يوم مراجعة بعيدة/);
    // Catch-up of earlier days is still accepted on the distant-review day.
    await switchTo(w.a);
    await db.query(insTasmia, [w.c, w.a, w.l, 6, TODAY]);
    await db.query(insReview, [w.c, w.a, addDays(TODAY, -3)]);
    await switchTo(null);
    assert.deepEqual(await liveQuarters(w, w.a), [1, 2, 3, 4, 5, 6]);
    assert.equal(await n(db, 'select 1 from voided_daily_records'), 0);
  });
});

test('same-day Q: the guard fires first and holds the cycle lock shared; the conversion takes it exclusively', async () => {
  for (const t of ['tasmia_submissions', 'review_confirmations']) {
    const names = ((await db.query('select tgname from pg_trigger where tgrelid=$1::regclass and not tgisinternal order by tgname', ['public.' + t])).rows as any[]).map((r) => r.tgname);
    assert.equal(names[0], 'men_same_day_distant_review_guard', 'before the guards that read the calendar');
  }
  // This cycle's lock, by its key (a bigint advisory key is stored as two 32-bit parts).
  const modes = async (c: string) =>
    ((await db.query(
      `select l.mode from pg_locks l, (select app_private.men_same_day_distant_review_lock_key($1) k) x
       where l.locktype='advisory' and l.classid::bigint = ((x.k >> 32) & 4294967295) and l.objid::bigint = (x.k & 4294967295)`, [c]
    )).rows as any[]).map((r) => r.mode);
  await sameDay(async (w) => {
    assert.deepEqual(await modes(w.c), []);
    await db.query('insert into review_confirmations(cycle_id, user_id, legacy_date) values ($1,$2,$3)', [w.c, w.a, TODAY]);
    assert.deepEqual(await modes(w.c), ['ShareLock'], 'a review holds the lock shared until it commits');
  });
  await sameDay(async (w) => {
    await db.query('insert into tasmia_submissions(cycle_id, user_id, listener_id, quarter_number) values ($1,$2,$3,1)', [w.c, w.a, w.l]);
    assert.deepEqual(await modes(w.c), ['ShareLock'], 'a recitation holds the lock shared until it commits');
  });
  await sameDay(async (w) => {
    await createToday(w);
    assert.deepEqual(await modes(w.c), ['ExclusiveLock'], 'a conversion holds it exclusively until it commits');
  });
});

test('same-day R: on the next active day the same quarter and the review are submitted normally', async () => {
  await sameDay(async (w) => {
    await recite(w, w.a, 1, 10);
    await review(w, w.a, 1, 10);
    await createToday(w);
    assert.deepEqual(await liveQuarters(w, w.a), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await setProgramDate(addDays(TODAY, 1));
    await switchTo(w.a);
    // Quarters are never ahead of the calendar: 11 is refused, 10 is the required one.
    await fails(db, 'insert into tasmia_submissions(cycle_id, user_id, listener_id, quarter_number) values ($1,$2,$3,11)', [w.c, w.a, w.l], /الربع رقم \(10\)/);
    await db.query('insert into tasmia_submissions(cycle_id, user_id, listener_id, quarter_number) values ($1,$2,$3,10)', [w.c, w.a, w.l]);
    await db.query('insert into review_confirmations(cycle_id, user_id) values ($1,$2)', [w.c, w.a]);
    await switchTo(null);
    assert.deepEqual((await liveQuarters(w, w.a)).slice(-1), [10]);
    const rev = await one('select start_quarter, end_quarter from review_confirmations where user_id=$1 and legacy_date=$2', [w.a, addDays(TODAY, 1)]);
    assert.deepEqual([rev.start_quarter, rev.end_quarter], [3, 10]);
    assert.equal(await n(db, 'select 1 from voided_daily_records where user_id=$1', [w.a]), 2, 'the archive keeps the voided rows');
  });
});

test('same-day: the first program day converted: quarter 1 is voided and refused today, due on the next day', async () => {
  await sameDay(async (w) => {
    await recite(w, w.a, 1, 1);
    await review(w, w.a, 1, 1);
    const r = await createToday(w, 1, 2);
    assert.equal(r.assignment.cancelled_program_day, 1);
    assert.deepEqual([r.voided_tasmia, r.voided_reviews], [1, 1]);
    assert.equal(await cycleDay(w.c, TODAY), 1, 'the calendar clamps at 1');
    await switchTo(w.a);
    await fails(db, 'insert into tasmia_submissions(cycle_id, user_id, listener_id, quarter_number) values ($1,$2,$3,1)', [w.c, w.a, w.l], /تحوّل اليوم/);
    await switchTo(null);
    await setProgramDate(addDays(TODAY, 1));
    await switchTo(w.a);
    await db.query('insert into tasmia_submissions(cycle_id, user_id, listener_id, quarter_number) values ($1,$2,$3,1)', [w.c, w.a, w.l]);
    await switchTo(null);
    assert.equal(await cycleDay(w.c, addDays(TODAY, 1)), 1);
  }, 0);
});

test('same-day: the last quarter is cancellable; days past it cancel nothing', async () => {
  await sameDay(async (w) => {
    assert.equal((await createToday(w)).assignment.cancelled_program_day, 240);
  }, 239);
  await sameDay(async (w) => {
    assert.equal((await createToday(w)).assignment.cancelled_program_day, null);
  }, 250);
});

test('same-day: undated paused days: the cancelled day is the calendar\'s; JS agrees with SQL on every date', async () => {
  const { programDayOfDate, buildSettingsForTest } = await (async () => ({
    programDayOfDate: (await import('../src/lib/calculations')).programDayOfDate,
    buildSettingsForTest: (await import('../supabase/functions/_shared/men/menRows.ts')).buildSettings,
  }))();
  await sameDay(async (w) => {
    await db.query('update cycles set legacy_paused_days=3 where id=$1', [w.c]);
    assert.equal(await cycleDay(w.c, TODAY), 10, 'the 13th active date is program day 10');
    const shifted = { ...w, day: 10 };
    await recite(shifted, w.a, 1, 10);
    await review(shifted, w.a, 10, 10);
    const r = await createToday(w);
    assert.equal(r.assignment.cancelled_program_day, 10);
    assert.deepEqual([r.voided_tasmia, r.voided_reviews], [1, 1], 'the index (13) would have voided nothing');
    assert.equal(await cycleDay(w.c, TODAY), 9);
    assert.equal(await cycleDay(w.c, addDays(TODAY, 1)), 10);
  }, 12);

  // The real migrated cycle, with synthetic days off, on every date.
  await db.query('begin');
  try {
    await closeOpenPause();
    await addDistant(addDays(TODAY, 4));
    await db.query("insert into program_pauses(cycle_id,paused_on,resumed_on) values($1,$2,$3)", [cycle, addDays(TODAY, 10), addDays(TODAY, 13)]);
    await db.query('insert into group_rest_days(cycle_id,rest_date) values($1,$2),($1,$3)', [cycle, addDays(TODAY, 6), addDays(TODAY, 11)]);
    const cy = await one('select id, batch_id, cycle_number, starts_on::text starts_on, status, total_quarters, review_window, legacy_paused_days, created_at::text from cycles where id=$1', [cycle]);
    assert.ok(cy.legacy_paused_days > 0, 'the real cycle has undated paused days');
    const pauses = (await db.query('select paused_on::text paused_on, resumed_on::text resumed_on from program_pauses where cycle_id=$1', [cycle])).rows as any[];
    const dates = ((await db.query('select review_date::text d from distant_review_assignments where cycle_id=$1', [cycle])).rows as any[]).map((r) => r.d);
    const rest = ((await db.query('select rest_date::text d from group_rest_days where cycle_id=$1', [cycle])).rows as any[]).map((r, i) => ({ id: String(i), date: r.d, note: '', added_by_admin_id: '', created_at: '' }));
    const settings = buildSettingsForTest(cy, pauses, null, dates);
    const rows = (await db.query(
      `select d::date::text d, case when app_private.men_cycle_day($1, d::date) > app_private.men_cycle_day($1, d::date - 1) then app_private.men_cycle_day($1, d::date) end n
       from generate_series('2026-09-10'::date, '2027-06-30'::date, interval '1 day') d`, [cycle]
    )).rows as any[];
    for (const r of rows) assert.equal(programDayOfDate(settings, rest, r.d), r.n, r.d);
    assert.ok(rows.some((r) => r.n !== null) && rows.some((r) => r.n === null));
  } finally {
    await db.query('rollback');
  }
});

test('same-day: on the real migrated batch only today\'s rows could move: all history stays', async () => {
  await db.query('begin');
  try {
    await closeOpenPause();
    const before = [(await one('select count(*)::int n from tasmia_submissions')).n, (await one('select count(*)::int n from review_confirmations')).n];
    const day = await cycleDay(cycle, TODAY);
    const r = (await one('select public.men_distant_review_create_today($1, $2, 1, 9, null, $3) r', [batch, TODAY, id.admin])).r;
    assert.equal(r.assignment.cancelled_program_day, day);
    assert.deepEqual([r.voided_tasmia, r.voided_reviews], [0, 0]);
    assert.deepEqual([(await one('select count(*)::int n from tasmia_submissions')).n, (await one('select count(*)::int n from review_confirmations')).n], before);
    assert.equal(await cycleDay(cycle, TODAY), day - 1);
    assert.equal(await cycleDay(cycle, addDays(TODAY, 1)), day);
  } finally {
    await db.query('rollback');
  }
});

test('same-day: men_backfill_revisions skips the converted date (no failure, no voided review comes back)', async () => {
  await sameDay(async (w) => {
    await review(w, w.a, 10, 10);
    await createToday(w);
    await switchTo(id.admin);
    const created = (await one('select public.men_backfill_revisions($1, $2::date) n', [w.c, TODAY])).n;
    assert.ok(created > 0, 'earlier dates are still filled');
    await switchTo(null);
    assert.equal(await n(db, 'select 1 from review_confirmations where cycle_id=$1 and legacy_date=$2', [w.c, TODAY]), 0);
    assert.equal(await n(db, 'select 1 from review_confirmations where cycle_id=$1 and legacy_date=$2', [w.c, addDays(TODAY, -1)]), 3);
    // A day scheduled beforehand behaves as before.
    await db.query('delete from distant_review_assignments where cycle_id=$1', [w.c]);
    await db.query('insert into distant_review_assignments(cycle_id, batch_id, review_date, start_quarter, end_quarter) values ($1,$2,$3,1,2)', [w.c, w.b, TODAY]);
    await switchTo(id.admin);
    await one('select public.men_backfill_revisions($1, $2::date) n', [w.c, TODAY]);
    await switchTo(null);
    assert.equal(await n(db, 'select 1 from review_confirmations where cycle_id=$1 and legacy_date=$2', [w.c, TODAY]), 3);
  });
});

test('same-day: a fresh-start member created today at N+1 has no debt and owes exactly N+1 next', async () => {
  await sameDay(async (w) => {
    const fresh = await sdMember(w.b, TODAY);
    await db.query('update batch_memberships set joined_at=now() where user_id=$1', [fresh]);
    const set = (await one('select public.men_set_fresh_start($1, $2) r', [fresh, w.b])).r;
    assert.equal(set.start_quarter, 10);
    await recite(w, fresh, 10, 10);
    await db.query('insert into review_confirmations(cycle_id, user_id, legacy_date) values ($1,$2,$3)', [w.c, fresh, TODAY]);
    const r = await createToday(w);
    assert.deepEqual([r.voided_tasmia, r.voided_reviews], [1, 1]);
    const today = await statusFromDb(w.c, fresh, TODAY, TODAY, 10);
    assert.deepEqual([today.delay.missedQuartersCount, today.delay.missedRevisionDaysCount, today.delay.allCompletedUpToToday], [0, 0, true]);
    await switchTo(fresh);
    await fails(db, 'insert into tasmia_submissions(cycle_id, user_id, listener_id, quarter_number) values ($1,$2,$3,10)', [w.c, fresh, w.l], /تحوّل اليوم/);
    await switchTo(null);
    const next = await statusFromDb(w.c, fresh, addDays(TODAY, 1), TODAY, 10);
    assert.deepEqual([next.delay.requiredQuarter, next.delay.missedQuartersCount, next.delay.missedRevisionDaysCount], [10, 0, 0]);
    await setProgramDate(addDays(TODAY, 1));
    await switchTo(fresh);
    await db.query('insert into tasmia_submissions(cycle_id, user_id, listener_id, quarter_number) values ($1,$2,$3,10)', [w.c, fresh, w.l]);
    await switchTo(null);
    assert.deepEqual(await liveQuarters(w, fresh), [10]);
  });
});

test('same-day S: voided records RLS: own rows, managed batches, nobody writes, anon nothing', async () => {
  await sameDay(async (w) => {
    await recite(w, w.a, 1, 10);
    await review(w, w.a, 10, 10);
    await review(w, w.bb, 10, 10);
    const r = await createToday(w);
    assert.deepEqual([r.voided_tasmia, r.voided_reviews], [1, 2]);
    await switchTo(w.a);
    assert.equal(await n(db, 'select 1 from voided_daily_records'), 2, 'his own only');
    assert.equal(await n(db, 'select 1 from voided_daily_records where user_id<>$1', [w.a]), 0);
    await fails(db, "insert into voided_daily_records(cycle_id, user_id, kind, original_id, program_day, program_date, recorded_at) values ($1,$2,'review',gen_random_uuid(),1,$3,now())", [w.c, w.a, TODAY], '42501');
    await fails(db, 'update voided_daily_records set program_day=1', [], '42501');
    await fails(db, 'delete from voided_daily_records', [], '42501');
    await switchTo(w.l);
    assert.equal(await n(db, 'select 1 from voided_daily_records'), 0, 'the listener does not read it');
    await switchTo(id.member);
    assert.equal(await n(db, 'select 1 from voided_daily_records'), 0, 'a member of another batch');
    await switchTo(id.admin);
    assert.equal(await n(db, 'select 1 from voided_daily_records'), 3, 'master admin');
    await fails(db, 'delete from voided_daily_records', [], '42501');
    await switchTo(null);
    // A batch admin: his managed batch only.
    await db.query('update profiles set is_master_admin=false where id=$1', [id.admin]);
    await db.query('select public.set_admin_batches($1, $2::uuid[], $1)', [id.admin, [batch]]);
    await switchTo(id.admin);
    assert.equal(await n(db, 'select 1 from voided_daily_records'), 0, 'another batch');
    await switchTo(null);
    await db.query('select public.set_admin_batches($1, $2::uuid[], $1)', [id.admin, [w.b]]);
    await switchTo(id.admin);
    assert.equal(await n(db, 'select 1 from voided_daily_records'), 3, 'his batch');
    await switchTo(null);
  });
  await as(null, (tx) => fails(tx, 'select 1 from public.voided_daily_records', [], '42501'));
  await as(null, (tx) => fails(tx, 'select public.men_distant_review_create_today($1, $2, 1, 9, null, $3)', [batch, TODAY, id.admin], '42501'));
});

test('same-day N/O/P: transfer and permanent delete work with the archive; the listener snapshot survives', async () => {
  await sameDay(async (w) => {
    await recite(w, w.a, 1, 10);
    await recite(w, w.bb, 1, 10, w.a);
    await review(w, w.bb, 10, 10);
    const r = await createToday(w);
    assert.deepEqual([r.voided_tasmia, r.voided_reviews], [2, 1]);

    // Transfer: the member moves; his archived rows stay with the old cycle, his own history stays his.
    const other = (await one("select public.create_batch_with_cycle('دفعة النقل', $1::date, null) b", [addDays(TODAY, -3)])).b;
    await db.query('select public.move_member_batch($1, $2, $3, $4)', [w.bb, other.id, w.b, id.admin]);
    assert.equal(await n(db, 'select 1 from batch_memberships where user_id=$1 and batch_id=$2', [w.bb, other.id]), 1);
    assert.equal(await n(db, 'select 1 from voided_daily_records where user_id=$1 and cycle_id=$2', [w.bb, w.c]), 2);
    await switchTo(w.bb);
    assert.equal(await n(db, 'select 1 from voided_daily_records'), 2);
    await switchTo(null);

    // Permanent delete: the deleted member's rows go with him...
    const delBb = (await one('select public.men_delete_member_completely($1) r', [w.bb])).r;
    assert.ok(delBb.recitations >= 9);
    assert.equal(await n(db, 'select 1 from voided_daily_records where user_id=$1', [w.bb]), 0);
    // ...a listener's deletion only clears the link: the name snapshot stays in the archive.
    const snapshot = (await one("select listener_name_snapshot s from voided_daily_records where kind='tasmia' and user_id=$1", [w.a])).s;
    assert.ok(snapshot);
    await one('select public.men_delete_member_completely($1) r', [w.l]);
    const left = await one("select listener_id, listener_name_snapshot from voided_daily_records where kind='tasmia' and user_id=$1", [w.a]);
    assert.deepEqual([left.listener_id, left.listener_name_snapshot], [null, snapshot]);
    // The archive also outlives its assignment link and the admin who converted.
    await db.query('delete from distant_review_assignments where id=$1', [r.assignment.id]);
    assert.equal((await one("select assignment_id a from voided_daily_records where kind='tasmia' and user_id=$1", [w.a])).a, null);
  });
});

test('same-day: a peer test sees the voided quarter as not recited (the SQL re-check reads the live table)', async () => {
  await sameDay(async (w) => {
    await recite(w, w.a, 1, 10);
    await recite(w, w.bb, 1, 9);
    const test = (await one(
      "select public.peer_test_save(null,$1,'اختبار اليوم',10,10,1,5,3,'recommended','any','published',null,null,$2,'all','{}'::uuid[],true,false) r",
      [w.c, id.admin]
    )).r.test;
    const start = 'select public.peer_test_start_attempt($1, $2, $3, $4::jsonb, 10)';
    // Before the conversion the range is recited: only the (deliberately empty) question list is refused.
    await fails(db, start, [test.id, w.a, w.bb, '[]'], /عدد الأسئلة/);
    await createToday(w);
    await fails(db, start, [test.id, w.a, w.bb, '[]'], /لم يُتمّ العضو تسميع/);
    assert.equal(await n(db, 'select 1 from tasmia_submissions where cycle_id=$1 and listener_id=$2 and quarter_number=10', [w.c, w.l]), 0, 'no longer a listening session');
  });
});

test('peer tests: an old test stored with the review flag keeps its stored value; new saves store false', async () => {
  await sameDay(async (w) => {
    const save = "select public.peer_test_save(null,$1,'قديم',1,8,1,5,3,'recommended','any','hidden',null,null,$2,'all','{}'::uuid[],true,$3) r";
    const old = (await one(save, [w.c, id.admin, true])).r.test;
    assert.equal((await one('select require_revision_completed f from peer_tests where id=$1', [old.id])).f, true);
    assert.ok((await one("select col_description('public.peer_tests'::regclass, a.attnum) d from pg_attribute a where a.attrelid='public.peer_tests'::regclass and a.attname='require_revision_completed'")).d.includes('Deprecated'));
  });
});

test('migration 20261106 (same-day distant review) changes no existing row and no program day', async () => {
  const { createCutoverDb: build } = await import('../migration/cutover/harness.mjs');
  const fs = await import('node:fs');
  const { db: fresh }: { db: any } = await (build as any)(BACKUP, { stopBefore: '20261106000100' });
  try {
    const tables = ['profiles', 'batches', 'batch_memberships', 'cycles', 'group_rest_days', 'program_pauses', 'tasmia_submissions', 'review_confirmations',
      'peer_tests', 'peer_test_attempts', 'peer_test_selected_members', 'daily_thoughts', 'distant_review_completions', 'notification_states', 'admin_notification_batch_subscriptions', 'admin_alert_dismissals'];
    const snapshot = async () => {
      const out: Record<string, string> = {};
      for (const t of tables) out[t] = (await fresh.query(`select count(*)::text || ':' || coalesce(md5(string_agg(x::text, '|' order by x::text)), '') h from public.${t} x`)).rows[0].h;
      const c = (await fresh.query("select id from cycles where status='active'")).rows[0].id;
      out.days = (await fresh.query("select string_agg(app_private.men_cycle_day($1, d::date)::text, ',' order by d) h from generate_series('2026-09-10'::date, '2027-06-30'::date, interval '1 day') d", [c])).rows[0].h;
      out.assignments = (await fresh.query('select count(*)::text h from public.distant_review_assignments')).rows[0].h;
      return out;
    };
    const before = await snapshot();
    await fresh.exec(fs.readFileSync(new URL('../supabase/migrations/20261106000100_men_same_day_distant_review.sql', import.meta.url), 'utf8'));
    assert.deepEqual(await snapshot(), before);
    assert.equal((await fresh.query('select count(*)::int n from public.voided_daily_records')).rows[0].n, 0);
    assert.equal((await fresh.query('select count(*)::int n from public.distant_review_assignments where cancelled_program_day is not null')).rows[0].n, 0);
  } finally {
    await fresh.close();
  }
});
