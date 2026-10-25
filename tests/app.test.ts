// Phase F: end-to-end API workflows on the migrated Men data (Supabase schema in local PGlite).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './support';
import { phoneToAuthEmail } from '../src/lib/authIdentity';

const TODAY = '2026-10-26';
let t: Awaited<ReturnType<typeof startTestApp>>;
const ids: Record<string, string> = {};
const tok: Record<string, string> = {};
const UUID = /^[0-9a-f-]{36}$/;

before(async () => {
  t = await startTestApp();
  const one = async (sql: string) => (await t.pglite.query(sql)).rows[0] as any;
  ids.admin = (await one("select id from profiles where role='admin' and active order by firestore_id limit 1")).id;
  ids.inactive = (await one("select id from profiles where role='member' and not active order by firestore_id limit 1")).id;
  // A member who recited quarter 1 (eligible for a 1..8 test) and an active colleague.
  ids.member = (await one(`select p.id from profiles p where p.role='member' and p.active
      and exists(select 1 from tasmia_submissions s where s.user_id=p.id and s.quarter_number=1) order by p.firestore_id limit 1`)).id;
  ids.peer = (await one(`select p.id from profiles p where p.role='member' and p.active and p.id<>'${ids.member}' order by p.firestore_id limit 1`)).id;
  for (const k of Object.keys(ids)) tok[k] = t.auth.tokenFor(ids[k]);
});
after(() => t?.close());

const get = (path: string, token?: string) => t.call('GET', path, { token, date: TODAY });
const send = (method: string, path: string, token: string | undefined, body?: unknown) => t.call(method, path, { token, body, date: TODAY });

test('unauthenticated access: data routes reject, public config served, legacy login retired', async () => {
  for (const p of ['/api/bootstrap', '/api/recitations', '/api/revisions', '/api/tests', '/api/tests/attempts', '/api/personal-tests', '/api/auth/me'])
    assert.equal((await get(p)).status, 401, p);
  assert.equal((await get('/api/admin/stats')).status, 403);
  assert.equal((await get('/api/bootstrap', 'forged-token')).status, 401);
  const cfg = await get('/api/public-config');
  assert.deepEqual(Object.keys(cfg.body).sort(), ['supabasePublishableKey', 'supabaseUrl']);
  assert.equal((await send('POST', '/api/auth/login', undefined, { phone: '1', password: 'x' })).status, 410);
  assert.deepEqual((await get('/api/status')).body, { backend: 'supabase', connected: true });
});

test('session user and bootstrap reflect the migrated data', async () => {
  const me = await get('/api/auth/me', tok.member);
  assert.equal(me.status, 200);
  assert.match(me.body.user.id, UUID);
  assert.equal(me.body.user.role, 'member');
  assert.equal('password_hash' in me.body.user, false);

  const b = (await get('/api/bootstrap', tok.member)).body;
  assert.equal(b.users.length, 30);
  assert.equal(b.settings.start_date, '2026-09-17');
  assert.equal(b.settings.is_paused, true);
  assert.equal(b.settings.paused_at, '2026-10-24');
  assert.equal(b.settings.total_paused_days, 6);
  assert.ok(b.settings.daily_thought.length > 0);
  assert.equal(b.cycleInfo.is_paused, true);
  assert.equal(b.activeTest?.is_active, true);
  assert.ok(b.testAttempts.every((a: any) => a.candidate_id === ids.member || a.examiner_id === ids.member));

  const a = (await get('/api/bootstrap', tok.admin)).body;
  assert.equal(a.tests.length, 3);
  assert.equal(a.testAttempts.length, 15);
  assert.equal((await get('/api/recitations', tok.member)).body.recitations.length, 388);
  assert.equal((await get('/api/revisions', tok.member)).body.revisions.length, 486);
  assert.equal((await get('/api/tests/attempts', tok.admin)).body.attempts.length, 15);
  const own = (await get('/api/tests/attempts', tok.member)).body.attempts;
  assert.ok(own.every((x: any) => x.candidate_id === ids.member || x.examiner_id === ids.member));
});

test('pause, resume and dated pause periods', async () => {
  let r = await send('POST', '/api/admin/pause', tok.member);
  assert.equal(r.status, 403);
  r = await send('POST', '/api/admin/resume', tok.admin);
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.is_paused, false);
  assert.deepEqual(r.body.settings.pause_periods, [{ from: '2026-10-24', to: '2026-10-25' }]);
  // pause + same-day resume records no period (as before)
  assert.equal((await send('POST', '/api/admin/pause', tok.admin)).body.settings.paused_at, TODAY);
  r = await send('POST', '/api/admin/resume', tok.admin);
  assert.deepEqual(r.body.settings.pause_periods, [{ from: '2026-10-24', to: '2026-10-25' }]);
  r = await send('POST', '/api/admin/pause-periods', tok.admin, { from: '2026-10-01', to: '2026-10-02' });
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.total_paused_days, 4);
  assert.equal(r.body.settings.pause_periods.length, 2);
  assert.equal((await send('POST', '/api/admin/pause-periods', tok.admin, { from: '2026-10-05', to: '2026-10-01' })).status, 400);
});

test('rest days, start date and daily thought', async () => {
  let r = await send('POST', '/api/admin/rest-days', tok.admin, { date: '2026-10-30', note: 'راحة' });
  assert.equal(r.status, 201);
  const restId = r.body.restDay.id;
  assert.match(restId, UUID);
  assert.equal((await send('POST', '/api/admin/rest-days', tok.admin, { date: '2026-10-30' })).status, 400);
  assert.ok((await get('/api/bootstrap', tok.member)).body.restDays.some((d: any) => d.id === restId && d.added_by_admin_id === ids.admin));
  assert.equal((await send('DELETE', `/api/admin/rest-days/${restId}`, tok.admin)).status, 200);
  assert.equal((await send('DELETE', `/api/admin/rest-days/${restId}`, tok.admin)).status, 404);
  assert.equal((await send('DELETE', '/api/admin/rest-days/rest_legacy_id', tok.admin)).status, 404);

  r = await send('PUT', '/api/admin/settings', tok.admin, { start_date: '2026-09-18' });
  assert.equal(r.body.settings.start_date, '2026-09-18');
  r = await send('PUT', '/api/admin/settings', tok.admin, { start_date: '2026-09-17' });
  assert.equal(r.body.settings.start_date, '2026-09-17');

  r = await send('PUT', '/api/admin/daily-thought', tok.admin, { daily_thought: '<p onclick="x()">خاطرة</p><script>bad()</script>' });
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.daily_thought, '<p>خاطرة</p>');
  assert.match(r.body.settings.daily_thought_updated_by, /\S/);
  r = await send('DELETE', '/api/admin/daily-thought', tok.admin);
  assert.equal(r.body.settings.daily_thought, '');
  assert.equal('daily_thought_updated_by' in r.body.settings, false);
});

test('daily revision is idempotent per member and date', async () => {
  let r = await send('POST', '/api/revisions', tok.member, {});
  assert.equal(r.status, 201);
  assert.equal(r.body.revision.date, TODAY);
  r = await send('POST', '/api/revisions', tok.member, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.already_recorded, true);
  assert.equal((await send('POST', '/api/revisions', tok.admin, {})).status, 403);
  assert.equal((await send('POST', '/api/revisions', tok.inactive, {})).status, 403);
  assert.equal((await send('POST', '/api/revisions', tok.member, { date: '2026-12-01' })).status, 400);
  const row = (await t.pglite.query("select program_day, firestore_id, legacy_occurrence from review_confirmations where user_id=$1 and legacy_date=$2", [ids.member, TODAY])).rows[0] as any;
  assert.deepEqual(row, { program_day: null, firestore_id: null, legacy_occurrence: 0 });

  r = await send('POST', '/api/admin/backfill-revisions', tok.admin, { until: '2026-09-20' });
  assert.equal(r.status, 200);
  const again = await send('POST', '/api/admin/backfill-revisions', tok.admin, { until: '2026-09-20' });
  assert.equal(again.body.created, 0);
});

test('recitation follows the sequential-quarter rules', async () => {
  const stats = (await get('/api/admin/stats', tok.admin)).body;
  const boot = (await get('/api/bootstrap', tok.admin)).body;
  const limit = boot.activeTest?.test_type === 'mandatory' ? boot.activeTest.range_end : 240;
  const candidate = stats.member_stats.find(
    (m: any) => m.missed_quarters_count > 0 && m.required_quarter <= limit && m.id !== ids.peer
  );
  assert.ok(candidate, 'a member who is behind exists in the snapshot');
  const token = t.auth.tokenFor(candidate.id);
  const listener = boot.users.find((u: any) => u.role === 'member' && u.is_active && u.id !== candidate.id);

  assert.equal((await send('POST', '/api/recitations', token, { quarter_number: candidate.required_quarter + 1, listener_id: listener.id })).status, 400);
  assert.equal((await send('POST', '/api/recitations', token, { quarter_number: candidate.required_quarter })).status, 400);
  assert.equal((await send('POST', '/api/recitations', token, { quarter_number: candidate.required_quarter, listener_id: candidate.id })).status, 400);
  const r = await send('POST', '/api/recitations', token, { quarter_number: candidate.required_quarter, listener_id: listener.id, notes: ' ملاحظة ' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.recitation.listener_name, listener.name);
  assert.equal(r.body.recitation.notes, 'ملاحظة');
  assert.equal(r.body.recitation.date, TODAY);
  assert.equal((await send('POST', '/api/recitations', token, { quarter_number: candidate.required_quarter, listener_id: listener.id })).status, 400);
  assert.equal((await send('POST', '/api/recitations', tok.admin, { quarter_number: 1, listener_id: listener.id })).status, 403);
  assert.equal((await get('/api/recitations', tok.member)).body.recitations.length, 389);
});

test('peer test lifecycle: save, eligibility, questions, attempt, privacy, finish', async () => {
  let r = await send('POST', '/api/admin/tests', tok.admin, {
    title: 'اختبار تجريبي', range_start: 1, range_end: 8, questions_count: 2, lines_per_question: 5,
    has_max_errors: true, max_errors_allowed: 3, test_type: 'recommended', difficulty: 'any',
    audience: 'selected', selected_member_ids: [ids.member, ids.peer], is_active: true,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const testId = r.body.test.id;
  assert.match(testId, UUID);
  const boot = (await get('/api/bootstrap', tok.admin)).body;
  assert.equal(boot.tests.filter((x: any) => x.is_active).length, 1, 'only one active test');
  assert.equal(boot.activeTest.id, testId);
  assert.deepEqual(boot.activeTest.selected_member_ids, [ids.member, ids.peer]);
  assert.equal((await get('/api/bootstrap', tok.inactive)).body.activeTest, null);

  const elig = await get(`/api/tests/${testId}/eligible-candidates`, tok.peer);
  assert.equal(elig.status, 200);
  const cand = elig.body.candidates.find((c: any) => c.id === ids.member);
  assert.equal(cand.is_eligible, true, JSON.stringify(cand));

  const gen = await get(`/api/tests/${testId}/generate-questions?candidate_id=${ids.member}`, tok.peer);
  assert.equal(gen.status, 200);
  const questions_results = gen.body.questions.map((q: any, i: number) => ({
    start_surah: q.start_surah, start_ayah: q.start_ayah, end_surah: q.end_surah, end_ayah: q.end_ayah, errors_count: i,
  }));
  assert.equal((await send('POST', '/api/tests/attempts', tok.member, { test_id: testId, candidate_id: ids.member, questions_results })).status, 400);
  r = await send('POST', '/api/tests/attempts', tok.peer, { test_id: testId, candidate_id: ids.member, questions_results, notes: 'جيد' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.attempt.passed, true);
  assert.equal(r.body.attempt.total_errors, 1);
  const attemptId = r.body.attempt.id;
  const q = (await t.pglite.query('select count(*)::int n from peer_test_attempt_questions where attempt_id=$1 and not legacy_incomplete and actual_lines > 0', [attemptId])).rows[0] as any;
  assert.equal(q.n, 2);
  assert.equal((await send('POST', '/api/tests/attempts', tok.peer, { test_id: testId, candidate_id: ids.member, questions_results })).status, 429);

  const seen = (await get(`/api/tests/attempts?test_id=${testId}`, tok.inactive)).body.attempts;
  assert.equal(seen.length, 0);
  const mine = (await get(`/api/tests/attempts?test_id=${testId}`, tok.member)).body.attempts;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].questions_results.length, 2);

  // Material change with attempts → new test version; old one archived (hidden).
  r = await send('POST', '/api/admin/tests', tok.admin, {
    id: testId, title: 'اختبار تجريبي', range_start: 1, range_end: 16, questions_count: 2, lines_per_question: 5,
    test_type: 'recommended', audience: 'all', is_active: true,
  });
  assert.notEqual(r.body.test.id, testId);
  const all = (await get('/api/tests', tok.admin)).body.tests;
  assert.equal(all.find((x: any) => x.id === testId).is_active, false);
  assert.equal((await send('PATCH', `/api/admin/tests/${r.body.test.id}/status`, tok.admin, { is_active: false })).status, 200);
  assert.equal((await send('POST', `/api/admin/tests/${r.body.test.id}/finish`, tok.admin)).status, 200);
  assert.equal((await send('PATCH', `/api/admin/tests/${r.body.test.id}/status`, tok.admin, { is_active: true })).status, 400);
  assert.equal((await get('/api/admin/tests/' + testId + '/impact', tok.admin)).status, 200);
  assert.equal((await get('/api/admin/tests/' + testId + '/preview-questions', tok.admin)).status, 200);
});

test('member administration with Supabase Auth identities', async () => {
  let r = await send('POST', '/api/admin/members', tok.admin, { name: 'عضو جديد', phone: '0555 000111', password: 'secret12', role: 'member' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const newId = r.body.user.id;
  assert.equal(t.auth.emails.get(newId), phoneToAuthEmail('0555000111'));
  assert.equal((await send('POST', '/api/admin/members', tok.admin, { name: 'x', phone: '0555000111', password: 'secret12' })).status, 400);
  assert.equal((await send('POST', '/api/admin/members', tok.admin, { name: 'x', phone: '0555000999', password: '123' })).status, 400);
  assert.equal((await send('POST', '/api/admin/members', tok.member, { name: 'x', phone: '0555000998', password: 'secret12' })).status, 403);

  t.auth.failNextCreate = true;
  assert.equal((await send('POST', '/api/admin/members', tok.admin, { name: 'x', phone: '0555000997', password: 'secret12' })).status, 500);
  assert.equal(((await t.pglite.query("select count(*)::int n from profiles where phone='0555000997'")).rows[0] as any).n, 0);

  const b = (await get('/api/bootstrap', tok.admin)).body;
  assert.ok(b.users.some((u: any) => u.id === newId && u.is_active));

  r = await send('PATCH', `/api/admin/members/${newId}`, tok.admin, { name: 'اسم معدل', phone: '0555000222', is_active: false });
  assert.equal(r.status, 200);
  assert.equal(t.auth.emails.get(newId), phoneToAuthEmail('0555000222'));
  const deact = (await t.pglite.query('select active, deactivated_at is not null as stamped from profiles where id=$1', [newId])).rows[0] as any;
  assert.deepEqual(deact, { active: false, stamped: true });
  r = await send('PATCH', `/api/admin/members/${newId}`, tok.admin, { role: 'admin' });
  const role = (await t.pglite.query('select p.is_master_admin, m.membership_role from profiles p join batch_memberships m on m.user_id=p.id where p.id=$1', [newId])).rows[0] as any;
  assert.deepEqual(role, { is_master_admin: true, membership_role: 'admin' });
  assert.equal((await send('DELETE', `/api/admin/members/${newId}/completely`, tok.admin)).status, 400, 'admins cannot be deleted');
  await send('PATCH', `/api/admin/members/${newId}`, tok.admin, { role: 'member' });

  const memberToken = t.auth.tokenFor(newId);
  assert.equal((await send('PATCH', `/api/admin/members/${newId}`, tok.admin, { password: 'newpass1' })).status, 200);
  assert.equal((await get('/api/auth/me', memberToken)).status, 401, 'password reset ends sessions');

  r = await send('DELETE', `/api/admin/members/${newId}/completely`, tok.admin);
  assert.equal(r.status, 200);
  assert.ok(t.auth.deleted.includes(newId));
  assert.equal((await send('DELETE', `/api/admin/members/${newId}/completely`, tok.admin)).status, 404);
});

test('personal self-tests are private to their owner', async () => {
  const setup = { range_type: 'surah', start_surah: 1, end_surah: 2, questions_count: 2, lines_per_question: 3, difficulty: 'any' };
  const gen = await send('POST', '/api/personal-tests/generate', tok.member, setup);
  assert.equal(gen.status, 200);
  const questions_results = gen.body.questions.map((q: any) => ({ ...q, errors_count: 1 }));
  const saved = await send('POST', '/api/personal-tests', tok.member, { ...setup, questions_results });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const id = saved.body.record.id;
  assert.match(id, UUID);
  const hist = await get('/api/personal-tests', tok.member);
  assert.equal(hist.body.records.length, 1);
  assert.equal(hist.body.records[0].questions.length, 2);
  assert.equal(hist.body.records[0].grade, 85);
  assert.equal((await get('/api/personal-tests', tok.peer)).body.records.length, 0);
  assert.equal((await send('DELETE', `/api/personal-tests/${id}`, tok.peer)).status, 404);
  assert.equal((await send('DELETE', `/api/personal-tests/${id}`, tok.member)).status, 200);
  assert.equal((await get('/api/personal-tests', tok.inactive)).status, 403);
});

test('change password verifies the current password and ends sessions', async () => {
  const me = (await get('/api/auth/me', tok.peer)).body.user;
  t.auth.passwords.set(phoneToAuthEmail(me.phone), 'old-secret');
  t.auth.emails.set(me.id, phoneToAuthEmail(me.phone));
  assert.equal((await send('POST', '/api/auth/change-password', tok.peer, { currentPassword: 'wrong', newPassword: 'abcdef1' })).status, 400);
  assert.equal((await send('POST', '/api/auth/change-password', tok.peer, { currentPassword: 'old-secret', newPassword: 'abc' })).status, 400);
  const r = await send('POST', '/api/auth/change-password', tok.peer, { currentPassword: 'old-secret', newPassword: 'abcdef1', confirmPassword: 'abcdef1' });
  assert.equal(r.status, 200);
  assert.equal(await t.auth.verifyPassword(phoneToAuthEmail(me.phone), 'abcdef1'), true);
  assert.equal((await get('/api/auth/me', tok.peer)).status, 401);
});

test('factory reset clears cycle activity atomically and keeps members', async () => {
  const r = await send('POST', '/api/admin/factory-reset', tok.admin);
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.start_date, TODAY);
  assert.equal(r.body.settings.is_paused, false);
  assert.equal(r.body.settings.total_paused_days, 0);
  assert.equal('pause_periods' in r.body.settings, false);
  const b = (await get('/api/bootstrap', tok.admin)).body;
  assert.equal(b.users.length, 30);
  assert.equal(b.testAttempts.length, 0);
  assert.equal((await get('/api/recitations', tok.admin)).body.recitations.length, 0);
  assert.equal((await get('/api/revisions', tok.admin)).body.revisions.length, 0);
});
