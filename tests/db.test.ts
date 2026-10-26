// Sisters-style runtime on the real migrated Men data (local PGlite; never production):
// RLS reads/writes per role, Men insert guards, browser RPCs and Edge-Function-only RPCs.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCycleInfo } from '../src/lib/calculations';
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

test('personal tests: saved by RPC with server-computed grade, private, deletable by owner', async () => {
  const payload = {
    range_type: 'surah', range_label: 'سورة الفاتحة', start_surah: 1, start_surah_name: 'الفاتحة', end_surah: 1,
    end_surah_name: 'الفاتحة', questions_count: 2, lines_per_question: 3, difficulty: 'any', notes: ' جيد ',
    questions: [
      { start_surah: 1, start_surah_name: 'الفاتحة', start_ayah: 1, end_surah: 1, end_surah_name: 'الفاتحة', end_ayah: 3, errors_count: 1, grade: 100 },
      { start_surah: 1, start_surah_name: 'الفاتحة', start_ayah: 4, end_surah: 1, end_surah_name: 'الفاتحة', end_ayah: 7, errors_count: 0 },
    ],
  };
  await as(id.member, async (tx) => {
    const tid = (await tx.query('select public.men_save_personal_test($1) as id', [JSON.stringify(payload)])).rows[0].id;
    const t = (await tx.query('select grade::float8 g, grade_label l, total_errors e, notes from personal_tests where id=$1', [tid])).rows[0];
    assert.deepEqual(t, { g: 93, l: 'ممتاز', e: 1, notes: 'جيد' });
    assert.equal(await n(tx, 'select 1 from personal_test_questions where test_id=$1', [tid]), 2);
    await fails(tx, 'select public.men_save_personal_test($1)', [JSON.stringify({ ...payload, questions_count: 3 })], /عدد الأسئلة/);
    assert.equal((await tx.query('delete from personal_tests where id=$1', [tid])).affectedRows, 1);
  });
  await as(id.inactive, (tx) => fails(tx, 'select public.men_save_personal_test($1)', [JSON.stringify(payload)], /مُعلّق/));
});

test('Edge-Function RPCs are service-role only and behave', async () => {
  await as(id.admin, async (tx) => {
    for (const sql of [
      "select public.men_delete_member_completely('" + id.peer + "')",
      "select public.men_peer_test_set_status('" + id.peer + "','show')",
      "select public.start_next_cycle('" + batch + "', current_date, null)",
    ])
      await fails(tx, sql, [], '42501');
  });
  await asService(async (tx) => {
    // Test lifecycle
    const saved = (await tx.query('select public.men_peer_test_save($1,null,$2,$3,$4) r', [cycle,
      JSON.stringify({ title: 'تجريبي', range_start: 1, range_end: 8, questions_count: 2, lines_per_question: 5, max_errors: 3,
        test_type: 'recommended', difficulty: 'any', is_active: true, audience: 'selected',
        require_all_quarters_completed: false, require_revision_completed: false }),
      [id.member, id.peer], id.admin])).rows[0].r;
    const testId = saved.test.id;
    assert.equal(saved.versioned, false);
    assert.equal(await n(tx, "select 1 from peer_tests where cycle_id=$1 and status='published'", [cycle]), 1);
    assert.deepEqual((await tx.query('select array_agg(user_id::text order by position) a from peer_test_selected_members where test_id=$1', [testId])).rows[0].a, [id.member, id.peer]);
    const q = (k: number) => ({ question_number: k, start_surah: 1, start_surah_name: 'الفاتحة', start_ayah: k, end_surah: 1,
      end_surah_name: 'الفاتحة', end_ayah: k, start_page: 1, start_line: 1, end_page: 1, end_line: 2, actual_lines: 2, errors_count: k });
    const att = (await tx.query('select public.men_peer_test_record_attempt($1,$2) r', [JSON.stringify({
      test_id: testId, candidate_id: id.member, candidate_name: 'a', examiner_id: id.peer, examiner_name: 'b',
      date: '2026-10-26', effective_range_end: 8, covers_full_range: true }), JSON.stringify([q(1), q(2)])])).rows[0].r;
    assert.equal(att.attempt.status, 'passed');
    assert.equal(att.attempt.total_errors, 3);
    await fails(tx, 'select public.men_peer_test_record_attempt($1,$2)', [JSON.stringify({
      test_id: testId, candidate_id: id.member, candidate_name: 'a', examiner_id: id.peer, examiner_name: 'b', date: '2026-10-26' }),
      JSON.stringify([q(1), q(2)])], /انتظار دقيقة/);
    // Material change with attempts → new version, old hidden
    const v2 = (await tx.query('select public.men_peer_test_save($1,$2,$3,$4,$5) r', [cycle, testId,
      JSON.stringify({ title: 'تجريبي', range_start: 1, range_end: 16, questions_count: 2, lines_per_question: 5, max_errors: null,
        test_type: 'recommended', difficulty: 'any', is_active: true, audience: 'all',
        require_all_quarters_completed: false, require_revision_completed: false }), [], id.admin])).rows[0].r;
    assert.equal(v2.versioned, true);
    assert.notEqual(v2.test.id, testId);
    assert.equal((await tx.query('select status from peer_tests where id=$1', [testId])).rows[0].status, 'hidden');
    assert.equal((await tx.query("select public.men_peer_test_set_status($1,'finish') r", [v2.test.id])).rows[0].r.test.status, 'finished');
    await fails(tx, "select public.men_peer_test_set_status($1,'show')", [v2.test.id], /منتهٍ/);

    // Role change and deletion
    await tx.query("select public.men_set_account_role($1,'admin',$2,$3)", [id.peer, batch, id.admin]);
    assert.deepEqual((await tx.query("select role, is_master_admin from profiles where id=$1", [id.peer])).rows[0], { role: 'admin', is_master_admin: true });
    await fails(tx, 'select public.men_delete_member_completely($1)', [id.peer], /المشرف/);
    await tx.query("select public.men_set_account_role($1,'member',$2,$3)", [id.peer, batch, id.admin]);
    const counts = (await tx.query('select public.men_delete_member_completely($1) r', [id.peer])).rows[0].r;
    assert.ok(counts.recitations >= 0);
    assert.equal(await n(tx, 'select 1 from profiles where id=$1', [id.peer]), 0);

    // Sisters' non-destructive cycle restart
    const next = (await tx.query("select public.start_next_cycle($1, '2026-10-26', $2, $3) r", [batch, id.admin, cycle])).rows[0].r;
    assert.equal(next.cycle.cycle_number, 2);
    assert.equal((await tx.query('select status from cycles where id=$1', [cycle])).rows[0].status, 'archived');
    assert.equal(await n(tx, 'select 1 from tasmia_submissions where cycle_id=$1', [cycle]) > 0, true, 'history kept');
  });
});
