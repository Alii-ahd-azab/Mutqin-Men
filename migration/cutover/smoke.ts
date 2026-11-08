// Production smoke test of the Men runtime (Sisters architecture, Phase 2 parity), through real Supabase
// Auth sessions and the publishable key (exactly what the browser uses).
//
// Isolation: every successful write happens inside temporary «SMOKE <run>» batches created by this run,
// by temporary SMOKE accounts that belong only to those batches (the temporary master admin belongs to
// no batch). Permission checks that must be refused target temporary batches too. The real batches,
// cycles, accounts and tests are only read: once before (preflight, deny-list, per-row fingerprint) and
// once after (fingerprint). Every request body and direct write payload is checked against the deny-list
// and the run aborts before sending anything that names a pre-existing record.
//
// Cleanup runs in `finally` (also after a failed check or a thrown error; not if the process is killed):
// every temporary account (tracked, in a temporary batch, or on a smoke phone), then every temporary
// batch with its cycles, tests and rows. It then confirms that no row anywhere references a temporary
// id, that row counts and the Auth user count are back, and that every pre-existing row is unchanged.
//
//   MEN_CUTOVER_APPROVED_PROJECT=uaublandjewfzmhnbflc BCRYPTJS_PATH=<path to bcryptjs> \
//   npx tsx --env-file=.env.local migration/cutover/smoke.ts --project uaublandjewfzmhnbflc
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { loadProgram } from '../../supabase/functions/_shared/men/menData.ts';
import { phoneToAuthEmail } from '../../supabase/functions/_shared/men/authIdentity.ts';
import { computeBatchDelays } from '../../supabase/functions/_shared/men/batchDelays.ts';
import { programDate } from '../../supabase/functions/_shared/logic/programDate.ts';
import { buildBatchAdminAlerts } from '../../supabase/functions/_shared/logic/notifications.ts';
// @ts-ignore - shared ESM tooling
import { authAdmin, requireApproval, requireProjectArg } from './production.mjs';

const project = requireProjectArg(process.argv.slice(2));
requireApproval(project);
const bcrypt = createRequire(import.meta.url)(process.env.BCRYPTJS_PATH || 'bcryptjs');
const service: SupabaseClient = authAdmin(project);
const url = process.env.SUPABASE_URL as string;
const publishable = process.env.SUPABASE_PUBLISHABLE_KEY as string;

const results: { check: string; ok: boolean; detail?: string }[] = [];
const record = (check: string, ok: boolean, detail?: string) => results.push({ check, ok, detail });
const password = () => randomBytes(12).toString('base64url');
const RUN = randomBytes(4).toString('hex');
const SMOKE_BATCH_NAME = `SMOKE ${RUN}`;

// Every phone this run creates or tries to create (refused attempts included).
const PHONES = {
  A: '000000000001', B: '000000000002', D: '000000000003', E: '000000000004', F: '000000000005', F2: '000000000006',
  C: '000000000007', H: '000000000008', memberCreate: '000000000009', memberAdminCreate: '000000000010',
  hOther: '000000000011', G: '000000000014', hFreshOther: '000000000015', V1: '000000000051', V2: '000000000052',
  P1: '000000000061', P2: '000000000062', P3: '000000000063',
} as const;
const SMOKE_PHONES: string[] = Object.values(PHONES);
const SMOKE_EMAILS = new Set(SMOKE_PHONES.map((p) => phoneToAuthEmail(p).toLowerCase()));

// Every public table the app (or this run) can write, with its key columns (fingerprint and counts).
const TABLES: Record<string, string> = {
  profiles: 'id', batches: 'id', cycles: 'id', batch_memberships: 'id', batch_membership_transfers: 'id',
  tasmia_submissions: 'id', review_confirmations: 'id', peer_tests: 'id', peer_test_attempts: 'id',
  peer_test_attempt_questions: 'attempt_id,question_number', peer_test_selected_members: 'test_id,user_id',
  personal_tests: 'id', personal_test_questions: 'test_id,question_number', daily_thoughts: 'id', group_rest_days: 'id',
  program_pauses: 'id', distant_review_assignments: 'id', distant_review_completions: 'id',
  notification_states: 'user_id,notification_key', admin_notification_batch_subscriptions: 'admin_user_id,batch_id',
  admin_alert_dismissals: 'admin_user_id,batch_id,member_user_id', voided_daily_records: 'id',
};

// Ids of every record that existed before the run (deny-list) and of every temporary record (allow-list).
const realIds = new Set<string>();
const tempBatchIds = new Set<string>();
const tempCycleIds = new Set<string>();

// Refuses (before sending) any request or write payload that names a pre-existing record.
function safe<T>(payload: T): T {
  const s = JSON.stringify(payload) ?? '';
  for (const id of realIds) if (s.includes(id)) throw new Error('isolation guard: a request named a pre-existing production record; aborted before sending it');
  return payload;
}

// Browser-like client with a storage object, so sessions persist across "page reloads".
function browserClient(storage: Map<string, string>) {
  return createClient(url, publishable, {
    auth: {
      persistSession: true,
      autoRefreshToken: false,
      storage: {
        getItem: (k) => storage.get(k) ?? null,
        setItem: (k, v) => void storage.set(k, v),
        removeItem: (k) => void storage.delete(k),
      },
    },
  });
}

type Smoke = { key: string; id: string; phone: string; password: string; role: 'member' | 'admin' };
const created: Smoke[] = [];

async function createSmokeAccount(key: string, phone: string, role: 'member' | 'admin', batchId: string | null, opts: { bcrypt?: boolean } = {}): Promise<Smoke> {
  if (role === 'member' && (!batchId || !tempBatchIds.has(batchId))) throw new Error(`isolation guard: member ${key} must belong to a temporary batch`);
  const pw = password();
  const { data, error } = await service.auth.admin.createUser({
    email: phoneToAuthEmail(phone),
    email_confirm: true,
    ...(opts.bcrypt ? { password_hash: bcrypt.hashSync(pw, 10) } : { password: pw }),
  });
  if (error || !data.user) throw new Error(`createUser ${key}: ${error?.message}`);
  const s: Smoke = { key, id: data.user.id, phone, password: pw, role };
  created.push(s);
  const { error: profileError } = await service.rpc('create_profile_with_membership', safe({
    p_id: s.id, p_full_name: `SMOKE ${key}`, p_phone: phone, p_role: role, p_is_master_admin: role === 'admin',
    p_member_batch_id: role === 'member' ? batchId : null, p_admin_batch_ids: [], p_actor: null,
  }));
  if (profileError) throw new Error(`profile ${key}: ${profileError.message}`);
  return s;
}

async function signIn(s: Smoke) {
  const storage = new Map<string, string>();
  const client = browserClient(storage);
  const { error } = await client.auth.signInWithPassword({ email: phoneToAuthEmail(s.phone), password: s.password });
  return { client, storage, error };
}

// ---- Read-only fingerprint: every row of every table, hashed (nothing is printed but counts) ----
const stable = (v: unknown) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
const md5 = (s: string) => createHash('md5').update(s).digest('hex');
type Row = Record<string, unknown>;

async function fetchAll(table: string, keys: string[]) {
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    let q = service.from(table).select('*');
    for (const k of keys) q = q.order(k);
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(`read ${table}: ${error.message}`);
    rows.push(...(data as Row[]));
    if (data.length < 1000) return rows;
  }
}

async function snapshot() {
  const raw: Record<string, Row[]> = {};
  const hashes: Record<string, Map<string, string>> = {};
  for (const [table, keyList] of Object.entries(TABLES)) {
    const keys = keyList.split(',');
    raw[table] = await fetchAll(table, keys);
    hashes[table] = new Map(raw[table].map((r) => [keys.map((k) => String(r[k])).join('|'), md5(stable(r))]));
  }
  const counts = Object.fromEntries(Object.entries(raw).map(([t, rows]) => [t, rows.length]));
  return { raw, hashes, counts };
}

const listAuthUsers = async (): Promise<User[]> => {
  const { data, error } = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(`listUsers: ${error.message}`);
  return data.users;
};

const invoke = async (client: SupabaseClient, name: string, body: Record<string, unknown>) => {
  const { data, error } = await client.functions.invoke(name, { body: safe(body) });
  let status = 200;
  let message = data?.error as string | undefined;
  const ctx = (error as { context?: unknown } | null)?.context;
  if (ctx instanceof Response) {
    status = ctx.status;
    message = (await ctx.json().catch(() => ({})))?.error;
  } else if (error) status = 0;
  return { data, status, message };
};

// An account created by a call that was expected to be refused is still tracked for cleanup.
function track(res: { data?: { user?: { id?: string } } }, key: string, phone: string) {
  const id = res.data?.user?.id;
  if (id && !created.some((c) => c.id === id)) created.push({ key, id, phone, password: '', role: 'member' });
}

async function main() {
  // ---- Preflight (read-only): fingerprint, deny-list, no leftovers from an earlier run ----
  const before = await snapshot();
  for (const t of ['profiles', 'batches', 'cycles', 'peer_tests', 'distant_review_assignments'])
    for (const r of before.raw[t]) realIds.add(String(r.id));
  const authBefore = await listAuthUsers();
  for (const u of authBefore) realIds.add(u.id);
  const leftovers = before.raw.batches.filter((b) => /^SMOKE /.test(String(b.name))).length
    + before.raw.profiles.filter((p) => SMOKE_PHONES.includes(String(p.phone)) || /^SMOKE /.test(String(p.full_name))).length
    + authBefore.filter((u) => SMOKE_EMAILS.has((u.email ?? '').toLowerCase())).length;
  if (leftovers) throw new Error(`preflight: ${leftovers} SMOKE record(s) from an earlier run exist; nothing was written. Inspect them first.`);
  if (!realIds.size) throw new Error('preflight: the deny-list is empty; nothing was written');

  try {
    const today = programDate();
    const plus = (n: number) => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

    // ---- Temporary master admin (belongs to no batch) ----
    const E = await createSmokeAccount('E', PHONES.E, 'admin', null);
    const e = await signIn(E);
    record('admin login', !e.error, e.error?.message);
    if (e.error) throw new Error('admin login failed');

    const createTempBatch = async (suffix: string, start: string) => {
      const r = await invoke(e.client, 'admin-actions', { action: 'create-batch', name: SMOKE_BATCH_NAME + suffix, start_date: start });
      const id = r.data?.batch?.id as string | undefined;
      if (id) tempBatchIds.add(id);
      const cycle = id ? (await service.from('cycles').select('id, cycle_number, status').eq('batch_id', id).single()).data : null;
      if (cycle) tempCycleIds.add(cycle.id);
      return { r, id, cycle };
    };

    // ---- Temporary batch M: the members' starting batch (and the "unassigned batch" for the batch admin).
    // It starts two days ago, so quarter 1 is due and quarter 2 cannot be skipped to. ----
    const m = await createTempBatch(' M', plus(-2));
    record('master admin creates a temporary batch with its first active cycle', !!m.id && m.cycle?.status === 'active' && m.cycle.cycle_number === 1, `${m.r.status} ${m.r.message ?? ''}`);
    if (!m.id || !m.cycle) throw new Error('could not create the temporary batch M');
    const batchId = m.id;
    const mCycle = m.cycle.id as string;

    const A = await createSmokeAccount('A', PHONES.A, 'member', batchId, { bcrypt: true });
    const B = await createSmokeAccount('B', PHONES.B, 'member', batchId);
    const C = await createSmokeAccount('C', PHONES.C, 'member', batchId);
    const D = await createSmokeAccount('D', PHONES.D, 'member', batchId);
    await service.from('profiles').update({ active: false }).eq('id', safe(D.id));

    // ---- Auth ----
    const a = await signIn(A);
    record('member login with an imported bcrypt hash (same path as the 30 migrated users)', !a.error, a.error?.message);
    const reload = browserClient(a.storage);
    const { data: persisted } = await reload.auth.getUser();
    record('session persists across a reload', persisted.user?.id === A.id);
    const wrong = await browserClient(new Map()).auth.signInWithPassword({ email: phoneToAuthEmail(A.phone), password: 'wrong-password' });
    record('wrong password rejected', !!wrong.error);
    const b = await signIn(B);

    // B records first, so the member-isolation reads below have another member's rows to not see.
    const bReview = await b.client.from('review_confirmations').insert(safe({ cycle_id: mCycle, user_id: B.id }));
    const bTasmia = await b.client.from('tasmia_submissions').insert(safe({ cycle_id: mCycle, user_id: B.id, listener_id: C.id, quarter_number: 1 }));
    record('another member records a review and quarter 1 in the temporary batch', !bReview.error && !bTasmia.error, bReview.error?.message || bTasmia.error?.message);

    // ---- Member reads (RLS) ----
    const memberState = await loadProgram(a.client, batchId);
    record('member dashboard loads (cycle, settings, users)', !!memberState.cycle.id && memberState.users.length > 0);
    record('member sees no other members\' recitations', memberState.recitationLogs.every((r) => r.member_id === A.id || r.listener_id === A.id) && !memberState.recitationLogs.some((r) => r.member_id === B.id));
    record('member sees no other members\' reviews', memberState.revisionLogs.every((r) => r.member_id === A.id));
    const memberBatches = (await a.client.from('batches').select('id')).data || [];
    record('member sees only his own batch', memberBatches.length === 1 && memberBatches[0].id === batchId);

    // ---- Member writes (database guards) ----
    const review = await a.client.from('review_confirmations').insert(safe({ cycle_id: mCycle, user_id: A.id })).select('start_quarter, end_quarter, legacy_date').single();
    record('member records today\'s review', !review.error, review.error?.message);
    record('the review is dated with the program date (05:00 Africa/Cairo)', review.data?.legacy_date === programDate(), `${review.data?.legacy_date} vs ${programDate()}`);
    const dup = await a.client.from('review_confirmations').insert(safe({ cycle_id: mCycle, user_id: A.id }));
    record('duplicate review for the same date rejected', dup.error?.code === '23505');
    const skip = await a.client.from('tasmia_submissions').insert(safe({ cycle_id: mCycle, user_id: A.id, listener_id: B.id, quarter_number: 2 }));
    record('skipping a quarter rejected', !!skip.error && /الربع/.test(skip.error.message), skip.error?.message);
    const tasmia = await a.client.from('tasmia_submissions').insert(safe({ cycle_id: mCycle, user_id: A.id, listener_id: B.id, quarter_number: 1 }));
    record('member records quarter 1 with a smoke listener', !tasmia.error, tasmia.error?.message);
    const forOther = await a.client.from('review_confirmations').insert(safe({ cycle_id: mCycle, user_id: C.id }));
    record('member cannot write for another member', !!forOther.error);
    const promote = await a.client.from('profiles').update({ role: 'admin' }).eq('id', safe(A.id));
    record('member cannot change own role', !!promote.error || !(await service.from('profiles').select('role').eq('id', A.id).single()).data?.role.includes('admin'));
    const svc = await a.client.rpc('men_delete_member_completely', safe({ p_user_id: C.id }));
    record('member cannot call service-role functions', !!svc.error);
    // «اختبر نفسك» retired: its history stays (owner-readable), its write paths are closed.
    const pt = await a.client.rpc('men_save_personal_test', { p_test: {} });
    record('«اختبر نفسك» retired: the save RPC is closed to members', !!pt.error && /permission denied/i.test(pt.error.message), pt.error?.message);
    const ptDel = await a.client.from('personal_tests').delete().eq('member_id', safe(A.id)).select('id');
    record('«اختبر نفسك» retired: members cannot delete personal-test history', !!ptDel.error && /permission denied/i.test(ptDel.error.message), ptDel.error?.message);
    const ptRead = await a.client.from('personal_tests').select('id');
    record('personal-test history stays readable by its owner', !ptRead.error, ptRead.error?.message);

    // ---- Notification interaction state (own rows only; one row per key; RPC-only writes) ----
    const nItem = { key: 'smoke:rest-tomorrow', kind: 'rest-tomorrow', tone: 'info', urgent: false, title: 'غدًا يوم راحة', body: 'x' };
    const seen1 = await a.client.rpc('men_notifications_mark_seen', { p_items: [nItem] });
    const seen2 = await a.client.rpc('men_notifications_mark_seen', { p_items: [nItem] });
    const arch = await a.client.rpc('men_notification_archive', { p_item: nItem });
    const aRows = (await a.client.from('notification_states').select('notification_key, seen_at, archived_at')).data || [];
    record('notification state: seen then archived, one row per key', !seen1.error && !seen2.error && !arch.error && aRows.length === 1 && !!aRows[0].seen_at && !!aRows[0].archived_at, seen1.error?.message || arch.error?.message);
    const bPeek = b.error ? null : (await b.client.from('notification_states').select('notification_key')).data;
    record("another member cannot read a member's notification state", !!bPeek && bPeek.length === 0);
    const directWrite = await a.client.from('notification_states').insert(safe({ user_id: B.id, notification_key: 'x' }));
    record('notification state cannot be written directly (RPC only, own rows)', !!directWrite.error);
    const memberFollow = await a.client.rpc('men_set_notification_batch_follow', safe({ p_batch_id: batchId, p_enabled: true }));
    record('members cannot follow batches', !!memberFollow.error);

    const stored = await service.from('review_confirmations').select('id, member_name_snapshot').eq('user_id', A.id);
    record('member write is stored in Men Supabase', (stored.data || []).length === 1 && stored.data![0].member_name_snapshot === 'SMOKE A');

    // ---- Inactive member ----
    const d = await signIn(D);
    const dProfile = d.error ? null : await d.client.from('profiles').select('id, active');
    record('inactive member sees only own profile (app signs them out, as in Sisters)', !!dProfile && dProfile.data?.length === 1 && dProfile.data[0].active === false);
    const dWrite = d.error ? { error: true } : await d.client.from('review_confirmations').insert(safe({ cycle_id: mCycle, user_id: D.id }));
    record('inactive member cannot record', !!dWrite.error);

    // ---- Unauthenticated ----
    const anon = createClient(url, publishable, { auth: { persistSession: false } });
    const anonRead = await anon.from('profiles').select('id').limit(1);
    record('unauthenticated access to profiles denied', !!anonRead.error || (anonRead.data || []).length === 0);
    const anonTasmia = await anon.from('tasmia_submissions').select('id').limit(1);
    record('unauthenticated access to recitations denied', !!anonTasmia.error || (anonTasmia.data || []).length === 0);

    // ---- Admin (program) ----
    const adminState = await loadProgram(e.client, batchId);
    record('admin dashboard sees the whole batch', adminState.revisionLogs.some((r) => r.member_id === A.id) && adminState.revisionLogs.some((r) => r.member_id === B.id)
      && adminState.recitationLogs.some((r) => r.member_id === B.id) && adminState.users.some((u) => u.id === D.id));
    const rest = await e.client.from('group_rest_days').insert(safe({ cycle_id: mCycle, rest_date: '2027-12-31', reason: 'SMOKE', created_by: E.id })).select('id').single();
    const restDel = rest.data ? await e.client.from('group_rest_days').delete().eq('id', rest.data.id).select('id') : null;
    record('admin adds and deletes a rest day', !rest.error && (restDel?.data || []).length === 1, rest.error?.message);
    const memberRest = await a.client.from('group_rest_days').insert(safe({ cycle_id: mCycle, rest_date: '2027-12-30', reason: 'x', created_by: A.id }));
    record('member cannot add rest days', !!memberRest.error);

    for (const f of ['admin-users', 'admin-actions', 'peer-tests']) {
      const r = await fetch(`${url}/functions/v1/${f}`, { method: 'OPTIONS' });
      record(`Edge Function ${f} deployed`, r.status === 200, `HTTP ${r.status}`);
    }

    // ---- admin-users: account lifecycle (incl. Men member ↔ admin switch) ----
    const memberCreate = await invoke(a.client, 'admin-users', { action: 'create', name: 'SMOKE x', phone: PHONES.memberCreate, password: 'abcdef12', role: 'member', batch_id: batchId });
    track(memberCreate, 'refused-member-create', PHONES.memberCreate);
    record('admin-users refuses a member caller', memberCreate.status === 403, `${memberCreate.status} ${memberCreate.message}`);
    const fPassword = password();
    const fCreate = await invoke(e.client, 'admin-users', { action: 'create', name: 'SMOKE F', phone: PHONES.F, password: fPassword, role: 'member', batch_id: batchId });
    if (fCreate.data?.user?.id) created.push({ key: 'F', id: fCreate.data.user.id, phone: PHONES.F, password: fPassword, role: 'member' });
    record('admin-users creates a member (Auth + profile + membership)', fCreate.status === 201 || !!fCreate.data?.user?.id, `${fCreate.status} ${fCreate.message ?? ''}`);
    const F = created.find((c) => c.key === 'F');
    if (F) {
      const fLogin = await signIn(F);
      record('new member can sign in', !fLogin.error, fLogin.error?.message);
      const dupPhone = await invoke(e.client, 'admin-users', { action: 'create', name: 'SMOKE dup', phone: PHONES.F, password: 'abcdef12', role: 'member', batch_id: batchId });
      track(dupPhone, 'refused-dup', PHONES.F);
      record('admin-users rejects a duplicate phone', dupPhone.status === 409 || dupPhone.status === 400, `${dupPhone.status} ${dupPhone.message}`);
      const newPw = password();
      const upd = await invoke(e.client, 'admin-users', { action: 'update', user_id: F.id, name: 'SMOKE F2', phone: PHONES.F2, password: newPw });
      F.phone = PHONES.F2;
      F.password = newPw;
      const relogin = await signIn(F);
      record('admin-users updates name, phone (login identity) and password', upd.status === 200 && !relogin.error && upd.data?.user?.name === 'SMOKE F2', `${upd.status} ${upd.message ?? relogin.error?.message ?? ''}`);
      const deact = await invoke(e.client, 'admin-users', { action: 'update', user_id: F.id, is_active: false });
      const react = await invoke(e.client, 'admin-users', { action: 'update', user_id: F.id, is_active: true });
      record('admin-users excludes and reactivates (membership kept)', deact.data?.user?.is_active === false && react.data?.user?.is_active === true);
      const toAdmin = await invoke(e.client, 'admin-users', { action: 'update', user_id: F.id, role: 'admin' });
      const toMember = await invoke(e.client, 'admin-users', { action: 'update', user_id: F.id, role: 'member', batch_id: batchId });
      const membership = await service.from('batch_memberships').select('membership_role, batch_id').eq('user_id', F.id);
      record('admin-users switches member ↔ admin (Men)', toAdmin.data?.user?.role === 'admin' && toAdmin.data?.user?.is_master_admin === true
        && toMember.data?.user?.role === 'member' && membership.data?.length === 1 && membership.data[0].batch_id === batchId,
        `${toAdmin.message ?? ''} ${toMember.message ?? ''}`);
      const memberDelete = await invoke(a.client, 'admin-users', { action: 'delete', user_id: F.id });
      record('admin-users refuses deletion by a member', memberDelete.status === 403);
      const delF = await invoke(e.client, 'admin-users', { action: 'delete', user_id: F.id });
      const gone = await service.from('profiles').select('id').eq('id', F.id);
      const authGone = await service.auth.admin.getUserById(F.id);
      record('admin-users deletes the member completely (profile and login)', delF.status === 200 && (gone.data || []).length === 0 && !!authGone.error, `${delF.status} ${delF.message ?? ''}`);
    }
    const delMaster = await invoke(e.client, 'admin-users', { action: 'delete', user_id: E.id });
    record('admin cannot delete his own account', delMaster.status === 400);

    // ---- admin-actions: factory reset guard (on the temporary batch M), batch creation ----
    const memberReset = await invoke(a.client, 'admin-actions', { action: 'factory-reset', batch_id: batchId, cycle_id: mCycle });
    record('admin-actions refuses a member caller', memberReset.status === 403, `${memberReset.status} ${memberReset.message}`);
    const staleReset = await invoke(e.client, 'admin-actions', { action: 'factory-reset', batch_id: batchId, cycle_id: '00000000-0000-4000-8000-000000000000' });
    const cycleAfter = await service.from('cycles').select('id, status').eq('id', mCycle).single();
    record('admin-actions runs start_next_cycle (stale-cycle guard: nothing reset)', staleReset.status === 400 && /تغيّرت الدورة/.test(staleReset.message || '') && cycleAfter.data?.status === 'active', `${staleReset.status} ${staleReset.message}`);
    const unknown = await invoke(e.client, 'admin-actions', { action: 'nope' });
    record('admin-actions rejects unknown actions', unknown.status === 400);
    const memberBatch = await invoke(a.client, 'admin-actions', { action: 'create-batch', name: SMOKE_BATCH_NAME + ' x', start_date: today });
    if (memberBatch.data?.batch?.id) tempBatchIds.add(memberBatch.data.batch.id);
    record('create-batch refuses a member caller', memberBatch.status === 403);
    // The smoke batch S starts two days ago, so quarter 2 is already due (the mandatory-test block is
    // then the only reason to refuse it) while nobody is far enough behind to be «مؤهل للإقصاء».
    const s = await createTempBatch('', plus(-2));
    const smokeBatchId = s.id ?? null;
    const smokeCycle = s.cycle;
    record('master admin creates a batch with its first active cycle', !!smokeBatchId && smokeCycle?.status === 'active' && smokeCycle.cycle_number === 1, `${s.r.status} ${s.r.message ?? ''}`);
    const eBatches = (await e.client.from('batches').select('id')).data || [];
    record('master admin sees every batch', eBatches.length >= 2);

    if (smokeBatchId && smokeCycle) {
      const S = smokeBatchId;

      // ---- Batch admin (Sisters): created by the master admin, limited to the smoke batch S ----
      const hPassword = password();
      const hCreate = await invoke(e.client, 'admin-users', { action: 'create', name: 'SMOKE H', phone: PHONES.H, password: hPassword, role: 'admin', is_master_admin: false, batch_ids: [S] });
      if (hCreate.data?.user?.id) created.push({ key: 'H', id: hCreate.data.user.id, phone: PHONES.H, password: hPassword, role: 'admin' });
      const H = created.find((c) => c.key === 'H');
      record('master admin creates a batch admin', !!H && hCreate.data?.user?.is_master_admin === false, `${hCreate.status} ${hCreate.message ?? ''}`);
      const memberAdminCreate = await invoke(a.client, 'admin-users', { action: 'create', name: 'SMOKE x', phone: PHONES.memberAdminCreate, password: 'abcdef12', role: 'admin', is_master_admin: true });
      track(memberAdminCreate, 'refused-admin-create', PHONES.memberAdminCreate);
      record('members cannot create admins', memberAdminCreate.status === 403);
      if (H) {
        const h = await signIn(H);
        const hBatches = (await h.client.from('batches').select('id')).data || [];
        record('batch admin sees only his assigned batch', hBatches.length === 1 && hBatches[0].id === S);
        // M (unassigned to him) has rows: the service role sees them, he must not.
        const mRows = (await service.from('tasmia_submissions').select('id').eq('cycle_id', mCycle)).data || [];
        const hMain = (await h.client.from('tasmia_submissions').select('id').eq('cycle_id', mCycle).limit(1)).data || [];
        record('batch admin cannot read another batch', mRows.length > 0 && hMain.length === 0);
        // Serious alerts are computed from what RLS lets the batch admin read: his batch only.
        const hAlerts = async (id: string) => {
          try {
            const p = await loadProgram(h.client, id);
            const { members, delayById } = computeBatchDelays(p, programDate());
            return { members: members.length, alerts: buildBatchAdminAlerts({ id, name: '' }, members, delayById).length };
          } catch (err) {
            return { error: (err as Error).message };
          }
        };
        const hOwn = await hAlerts(S);
        const hUnassigned = await hAlerts(batchId);
        record('batch admin alerts: his batch is readable, an unassigned batch yields no data (RLS)', !('error' in hOwn) && 'error' in hUnassigned, JSON.stringify({ hOwn, hUnassigned }));
        const hOther = await invoke(h.client, 'admin-users', { action: 'create', name: 'SMOKE x', phone: PHONES.hOther, password: 'abcdef12', role: 'member', batch_id: batchId });
        track(hOther, 'refused-h-other', PHONES.hOther);
        record('batch admin cannot add members to another batch', hOther.status === 403, `${hOther.status} ${hOther.message}`);
        const hMaster = await invoke(h.client, 'admin-users', { action: 'update', user_id: H.id, is_master_admin: true });
        record('batch admin cannot promote himself to master', hMaster.status === 403);
        const hFollow = await h.client.rpc('men_set_notification_batch_follow', safe({ p_batch_id: S, p_enabled: true }));
        record('batch admins cannot opt into batch follows (their scope is their assignments)', !!hFollow.error && /متابعة الدفعات متاحة للمشرف العام فقط/.test(hFollow.error.message), hFollow.error?.message);
        const eFollow = await e.client.rpc('men_set_notification_batch_follow', safe({ p_batch_id: S, p_enabled: true }));
        const eRows = (await e.client.from('admin_notification_batch_subscriptions').select('batch_id, enabled')).data || [];
        const hRows = (await h.client.from('admin_notification_batch_subscriptions').select('batch_id')).data || [];
        record('master admin follows a batch (stored, readable only by himself)', !eFollow.error && eRows.length === 1 && eRows[0].batch_id === S && eRows[0].enabled && hRows.length === 0, eFollow.error?.message);
        const reassign = await invoke(e.client, 'admin-users', { action: 'set-admin-batches', user_id: H.id, batch_ids: [S] });
        record('master admin sets batch-admin assignments', reassign.status === 200, `${reassign.status} ${reassign.message ?? ''}`);
        const adminList = (await e.client.from('batch_memberships').select('batch_id').eq('user_id', H.id).eq('membership_role', 'admin')).data || [];
        record('admin list shows the batch admin\'s assignment', adminList.length === 1 && adminList[0].batch_id === S);

        // ---- Move members from M to S (Sisters transfer; both temporary) ----
        const memberMove = await invoke(a.client, 'admin-users', { action: 'move-member-batch', user_id: B.id, destination_batch_id: S });
        record('members cannot move members', memberMove.status === 403);
        const hMoveFromMain = await invoke(h.client, 'admin-users', { action: 'move-member-batch', user_id: B.id, destination_batch_id: S });
        record('batch admin cannot move a member out of a batch he does not manage', hMoveFromMain.status === 403);
        let movedAll = true;
        for (const mem of [A, B, C]) {
          const mv = await invoke(e.client, 'admin-users', { action: 'move-member-batch', user_id: mem.id, destination_batch_id: S });
          movedAll &&= mv.status === 200;
        }
        const moved = (await service.from('batch_memberships').select('user_id').eq('batch_id', S).eq('membership_role', 'member')).data || [];
        record('master admin moves members to another batch (same account, membership moved)', movedAll && moved.length === 3);
        const aOldHistory = (await service.from('review_confirmations').select('id').eq('user_id', A.id).eq('cycle_id', mCycle)).data || [];
        record('moved member keeps his history on the old batch', aOldHistory.length === 1);
        const transfers = (await service.from('batch_membership_transfers').select('from_batch_id, to_batch_id').in('user_id', [A.id, B.id, C.id])).data || [];
        record('transfers are logged', transfers.length === 3 && transfers.every((t) => t.from_batch_id === batchId && t.to_batch_id === S));

        // Fresh sessions after the move (RLS reads the new membership).
        const a2 = await signIn(A);
        const b2 = await signIn(B);
        const c2 = await signIn(C);
        const aBatch = (await a2.client.from('batches').select('id')).data || [];
        record('moved member now sees the new batch only', aBatch.length === 1 && aBatch[0].id === S);

        // ---- Listener correction (Sisters) ----
        const q1 = await a2.client.from('tasmia_submissions').insert(safe({ cycle_id: smokeCycle.id, user_id: A.id, listener_id: B.id, quarter_number: 1 })).select('id').single();
        record('member records in the new batch', !q1.error, q1.error?.message);
        if (q1.data) {
          const corr = await a2.client.rpc('correct_tasmia_listener', safe({ p_submission_id: q1.data.id, p_new_listener_id: C.id }));
          const row = (await service.from('tasmia_submissions').select('listener_id, listener_name_snapshot, listener_changed_at').eq('id', q1.data.id).single()).data;
          record('member corrects the listener once', !corr.error && row?.listener_id === C.id && row.listener_name_snapshot === 'SMOKE C' && !!row.listener_changed_at, corr.error?.message);
          const again = await a2.client.rpc('correct_tasmia_listener', safe({ p_submission_id: q1.data.id, p_new_listener_id: B.id }));
          record('second listener correction refused', !!again.error && /مسبقًا/.test(again.error.message), again.error?.message);
          const notMine = await b2.client.rpc('correct_tasmia_listener', safe({ p_submission_id: q1.data.id, p_new_listener_id: C.id }));
          record('a member cannot correct another member\'s recitation', !!notMine.error);
        }

        // ---- Peer tests (Sisters model + Men audience) administered by the batch admin ----
        const save = await invoke(h.client, 'peer-tests', {
          action: 'admin-save', batch_id: S, title: 'SMOKE TEST', range_start: 1, range_end: 1, questions_count: 1, lines_per_question: 3,
          max_errors: 2, test_type: 'mandatory', difficulty: 'any', visibility: 'now', visible_from: null, visible_until: null,
          audience: 'selected', selected_member_ids: [A.id, B.id], require_all_quarters_completed: true, require_revision_completed: false,
        });
        const testId = save.data?.test?.id as string | undefined;
        record('batch admin saves a live mandatory test for selected members', save.status === 200 && !!testId && save.data.test.status === 'published', `${save.status} ${save.message ?? ''}`);
        const selected = testId ? (await service.from('peer_test_selected_members').select('user_id').eq('test_id', testId)).data || [] : [];
        record('selected audience stored', selected.length === 2);
        const overlap = await invoke(h.client, 'peer-tests', {
          action: 'admin-save', batch_id: S, title: 'SMOKE x', range_start: 1, range_end: 1, questions_count: 1, lines_per_question: 3,
          test_type: 'recommended', visibility: 'now', audience: 'all', selected_member_ids: [],
        });
        record('a second live test in the same batch is refused', overlap.status === 400, `${overlap.status} ${overlap.message}`);
        const hMainTest = await invoke(h.client, 'peer-tests', { action: 'admin-save', batch_id: batchId, title: 'SMOKE x', range_start: 1, range_end: 1, questions_count: 1, lines_per_question: 3, visibility: 'draft', audience: 'all' });
        record('batch admin cannot manage another batch\'s tests', hMainTest.status === 403);

        if (testId) {
          const preview = await invoke(h.client, 'peer-tests', { action: 'admin-preview', test_id: testId });
          record('peer-tests admin-preview', preview.status === 200 && preview.data?.questions?.length === 1);
          const cVisible = (await c2.client.from('peer_tests').select('id').eq('id', testId)).data || [];
          const bVisible = (await b2.client.from('peer_tests').select('id').eq('id', testId)).data || [];
          record('live test visible only to its audience', cVisible.length === 0 && bVisible.length === 1);

          const bq1 = await b2.client.from('tasmia_submissions').insert(safe({ cycle_id: smokeCycle.id, user_id: B.id, listener_id: A.id, quarter_number: 1 }));
          record('candidate recites the test range', !bq1.error, bq1.error?.message);
          const blocked = await b2.client.from('tasmia_submissions').insert(safe({ cycle_id: smokeCycle.id, user_id: B.id, listener_id: A.id, quarter_number: 2 }));
          record('mandatory test blocks the next quarter until passed', !!blocked.error && /الاختبار الإلزامي/.test(blocked.error.message), blocked.error?.message);
          const impact = await invoke(h.client, 'peer-tests', { action: 'admin-impact', test_id: testId });
          record('peer-tests admin-impact counts the blocked member', impact.status === 200 && impact.data?.blocked_members?.some((x: { id: string }) => x.id === B.id), JSON.stringify(impact.data));

          const cCand = await invoke(c2.client, 'peer-tests', { action: 'candidates', test_id: testId });
          record('member outside the audience cannot examine', cCand.status === 403);
          const cand = await invoke(a2.client, 'peer-tests', { action: 'candidates', test_id: testId });
          const bStatus = cand.data?.candidates?.find((x: { id: string }) => x.id === B.id);
          record('peer-tests candidates (examiner view)', cand.status === 200 && bStatus?.is_eligible === true && !cand.data.candidates.some((x: { id: string }) => x.id === C.id), JSON.stringify(bStatus?.reasons ?? cand.message));
          const selfStart = await invoke(b2.client, 'peer-tests', { action: 'start', test_id: testId, candidate_id: B.id });
          record('member cannot test himself', selfStart.status === 400);
          const start = await invoke(a2.client, 'peer-tests', { action: 'start', test_id: testId, candidate_id: B.id });
          const attemptId = start.data?.attempt_id as string | undefined;
          record('peer-tests start stores the session and questions', start.status === 200 && !!attemptId && start.data.questions?.length === 1 && start.data.covers_full_range === true, `${start.status} ${start.message ?? ''}`);
          if (attemptId) {
            const geo = await service.from('peer_test_attempt_questions').select('actual_lines, legacy_incomplete').eq('attempt_id', attemptId);
            record('attempt questions stored with full geometry', (geo.data || []).length === 1 && geo.data!.every((g) => g.actual_lines > 0 && !g.legacy_incomplete));
            const otherSubmit = await invoke(b2.client, 'peer-tests', { action: 'submit', attempt_id: attemptId, errors: [0], question_notes: [''] });
            record('only the examiner can submit', otherSubmit.status === 404);
            const sub = await invoke(a2.client, 'peer-tests', { action: 'submit', attempt_id: attemptId, errors: [1], question_notes: ['SMOKE'], notes: 'SMOKE' });
            record('peer-tests submit (pass computed in SQL)', sub.status === 200 && sub.data?.attempt?.status === 'passed' && sub.data.attempt.total_errors === 1, `${sub.status} ${sub.message ?? ''}`);
            const again = await invoke(a2.client, 'peer-tests', { action: 'start', test_id: testId, candidate_id: B.id });
            record('a passed candidate cannot be tested again', again.status === 400);
            const unblocked = await b2.client.from('tasmia_submissions').insert(safe({ cycle_id: smokeCycle.id, user_id: B.id, listener_id: A.id, quarter_number: 2 }));
            record('after passing, the next quarter is not blocked by the test', !unblocked.error || !/الاختبار الإلزامي/.test(unblocked.error.message), unblocked.error?.message);
            const bAttempts = (await b2.client.from('peer_test_attempts').select('candidate_id, examiner_id')).data || [];
            record('candidate sees own attempts only', bAttempts.length >= 1 && bAttempts.every((t) => t.candidate_id === B.id || t.examiner_id === B.id));
          }
          const finish = await invoke(h.client, 'peer-tests', { action: 'admin-status', test_id: testId, status_action: 'finish' });
          record('peer-tests finish', finish.status === 200 && finish.data?.test?.status === 'finished');
          const bTests = (await b2.client.from('peer_tests').select('id, status')).data || [];
          record('member sees only live tests (the finished test is hidden from its audience)', !bTests.some((t) => t.id === testId) && bTests.every((t) => t.status === 'published'), JSON.stringify(bTests.map((t) => t.status)));
          const reshow = await invoke(h.client, 'peer-tests', { action: 'admin-status', test_id: testId, status_action: 'show' });
          record('finished test cannot be shown again', reshow.status === 400);

          // Men partial range: a test without the whole-range requirement covers what was recited.
          const partial = await invoke(h.client, 'peer-tests', {
            action: 'admin-save', batch_id: S, title: 'SMOKE PARTIAL', range_start: 1, range_end: 8, questions_count: 1, lines_per_question: 3,
            test_type: 'recommended', visibility: 'now', audience: 'all', selected_member_ids: [], require_all_quarters_completed: false,
          });
          const pid = partial.data?.test?.id as string | undefined;
          const pc = pid ? await invoke(a2.client, 'peer-tests', { action: 'candidates', test_id: pid }) : null;
          const pb = pc?.data?.candidates?.find((x: { id: string }) => x.id === B.id);
          const bDone = (await service.from('tasmia_submissions').select('quarter_number').eq('user_id', B.id).eq('cycle_id', smokeCycle.id)).data?.length ?? 0;
          record('partial-range test: candidate tested on the recited part only', !!pb && pb.is_eligible === true && pb.effective_range_end === bDone && pb.covers_full_range === false, JSON.stringify(pb));
          if (pid) await invoke(h.client, 'peer-tests', { action: 'admin-status', test_id: pid, status_action: 'finish' });
        }

        // ---- Fresh-start member (created at the batch's current quarter, no earlier debt) ----
        const dayOfS = 3; // the smoke batch started two days ago: today is its day 3
        const gPassword = password();
        const gCreate = await invoke(h.client, 'admin-users', { action: 'create', name: 'SMOKE G', phone: PHONES.G, password: gPassword, role: 'member', batch_id: S, fresh_start: true });
        if (gCreate.data?.user?.id) created.push({ key: 'G', id: gCreate.data.user.id, phone: PHONES.G, password: gPassword, role: 'member' });
        const G = created.find((c) => c.key === 'G');
        record('batch admin creates a fresh-start member at the batch quarter', !!G && gCreate.data?.start_quarter === dayOfS, `${gCreate.status} ${JSON.stringify(gCreate.data?.start_quarter)} ${gCreate.message ?? ''}`);
        const hFreshOther = await invoke(h.client, 'admin-users', { action: 'create', name: 'SMOKE x', phone: PHONES.hFreshOther, password: 'abcdef12', role: 'member', batch_id: batchId, fresh_start: true });
        track(hFreshOther, 'refused-h-fresh-other', PHONES.hFreshOther);
        record('fresh-start creation respects batch scope', hFreshOther.status === 403);
        const gMembership = G ? (await service.from('batch_memberships').select('start_quarter, start_cycle_id').eq('user_id', G.id).single()).data : null;
        record('fresh-start baseline stored on the membership', gMembership?.start_quarter === dayOfS && gMembership?.start_cycle_id === smokeCycle.id, JSON.stringify(gMembership));
        if (G) {
          const g = await signIn(G);
          const g1 = await g.client.from('tasmia_submissions').insert(safe({ cycle_id: smokeCycle.id, user_id: G.id, listener_id: A.id, quarter_number: 1 }));
          record('fresh-start member does not owe quarter 1', !!g1.error && new RegExp(`\\(${dayOfS}\\)`).test(g1.error.message), g1.error?.message);
          const gSkip = await g.client.from('tasmia_submissions').insert(safe({ cycle_id: smokeCycle.id, user_id: G.id, listener_id: A.id, quarter_number: dayOfS + 1 }));
          record('fresh-start member cannot skip his first quarter', !!gSkip.error, gSkip.error?.message);
          const gOk = await g.client.from('tasmia_submissions').insert(safe({ cycle_id: smokeCycle.id, user_id: G.id, listener_id: A.id, quarter_number: dayOfS }));
          record('fresh-start member records his first quarter', !gOk.error, gOk.error?.message);
          const gState = await loadProgram(g.client, S);
          const me = gState.users.find((u) => u.id === G.id);
          record('loader exposes the baseline and the join date', me?.batch_start_quarter === dayOfS && !!me?.batch_joined_at);
        }
        const normal = (await service.from('batch_memberships').select('start_quarter').in('user_id', [A.id, B.id, C.id])).data || [];
        record('members created without the option keep the normal baseline', normal.length === 3 && normal.every((x) => x.start_quarter === null));

        // ---- Rename batch (master: any; batch admin: assigned only; member/anon: never) ----
        const mName = (await service.from('batches').select('name').eq('id', batchId).single()).data?.name;
        const eRename = await invoke(e.client, 'admin-actions', { action: 'rename-batch', batch_id: S, name: SMOKE_BATCH_NAME + ' م' });
        record('master admin renames a batch', eRename.status === 200 && eRename.data?.batch?.name === SMOKE_BATCH_NAME + ' م' && eRename.data.batch.id === S, `${eRename.status} ${eRename.message ?? ''}`);
        const hRename = await invoke(h.client, 'admin-actions', { action: 'rename-batch', batch_id: S, name: '  ' + SMOKE_BATCH_NAME + '   ب ' });
        record('assigned batch admin renames his batch (trimmed)', hRename.status === 200 && hRename.data?.batch?.name === SMOKE_BATCH_NAME + ' ب', `${hRename.status} ${hRename.data?.batch?.name}`);
        const hOtherRename = await invoke(h.client, 'admin-actions', { action: 'rename-batch', batch_id: batchId, name: SMOKE_BATCH_NAME + ' y' });
        record('batch admin cannot rename an unassigned batch', hOtherRename.status === 403, `${hOtherRename.status}`);
        const aRename = await invoke(a2.client, 'admin-actions', { action: 'rename-batch', batch_id: S, name: SMOKE_BATCH_NAME + ' z' });
        record('member cannot rename a batch', aRename.status === 403, `${aRename.status}`);
        const anonRename = await invoke(createClient(url, publishable, { auth: { persistSession: false } }), 'admin-actions', { action: 'rename-batch', batch_id: S, name: SMOKE_BATCH_NAME + ' z' });
        record('unauthenticated rename denied', anonRename.status === 401 || anonRename.status === 403, `${anonRename.status}`);
        const blank = await invoke(e.client, 'admin-actions', { action: 'rename-batch', batch_id: S, name: '   ' });
        record('whitespace-only name refused', blank.status === 400);
        const dupName = await invoke(e.client, 'admin-actions', { action: 'rename-batch', batch_id: S, name: mName });
        record('duplicate batch name refused', dupName.status === 409);
        const afterRename = (await service.from('cycles').select('id, status').eq('batch_id', S)).data || [];
        const sMembers = (await service.from('batch_memberships').select('user_id').eq('batch_id', S)).data || [];
        record('rename changes only the name (same id, cycle and members)', afterRename.length === 1 && afterRename[0].id === smokeCycle.id && sMembers.length >= 4);
        record('the other (unassigned) batch\'s name untouched', (await service.from('batches').select('name').eq('id', batchId).single()).data?.name === mName);

        // ---- «المراجعة البعيدة»: one manual date per call, future-only management, member debt ----
        const dr = (client: SupabaseClient, body: Record<string, unknown>) => invoke(client, 'admin-actions', body);
        const d1 = await dr(h.client, { action: 'distant-review-create', batch_id: S, review_date: plus(1), start_quarter: 1, end_quarter: 12, note: 'SMOKE مراجعة' });
        record('batch admin schedules one distant-review day in his batch', d1.status === 200 && d1.data?.assignment?.review_date === plus(1) && d1.data.assignment.note === 'SMOKE مراجعة', `${d1.status} ${d1.message ?? ''}`);
        const d2 = await dr(h.client, { action: 'distant-review-create', batch_id: S, review_date: plus(8), start_quarter: 20, end_quarter: 30 });
        record('a second day is a separate manual assignment', d2.status === 200 && d2.data?.assignment?.id !== d1.data?.assignment?.id);
        const sDays = (await service.from('distant_review_assignments').select('review_date').eq('batch_id', S)).data || [];
        record('no recurrence: exactly the two chosen dates exist', sDays.length === 2);
        record('duplicate date refused', (await dr(h.client, { action: 'distant-review-create', batch_id: S, review_date: plus(1), start_quarter: 1, end_quarter: 2 })).status === 409);
        record('past date refused', (await dr(h.client, { action: 'distant-review-create', batch_id: S, review_date: plus(-1), start_quarter: 1, end_quarter: 2 })).status === 400);
        record('from = to refused (TO is the stopping boundary)', (await dr(h.client, { action: 'distant-review-create', batch_id: S, review_date: plus(3), start_quarter: 9, end_quarter: 9 })).status === 400);
        record('from > to refused', (await dr(h.client, { action: 'distant-review-create', batch_id: S, review_date: plus(3), start_quarter: 13, end_quarter: 12 })).status === 400);
        record('quarter 241 refused', (await dr(h.client, { action: 'distant-review-create', batch_id: S, review_date: plus(3), start_quarter: 1, end_quarter: 241 })).status === 400);
        const restOnD1 = await h.client.from('group_rest_days').insert(safe({ cycle_id: smokeCycle.id, rest_date: plus(1), created_by: H.id }));
        record('a rest day may share a distant-review date (the distant review takes priority)', !restOnD1.error, restOnD1.error?.message);
        await h.client.from('group_rest_days').insert(safe({ cycle_id: smokeCycle.id, rest_date: plus(5), created_by: H.id }));
        const onRest = await dr(h.client, { action: 'distant-review-create', batch_id: S, review_date: plus(5), start_quarter: 1, end_quarter: 2 });
        record('a distant review may be scheduled on a rest day', onRest.status === 200, `${onRest.status} ${onRest.message}`);
        const onRestDel = await dr(h.client, { action: 'distant-review-delete', assignment_id: onRest.data?.assignment?.id });
        record('deleting that future distant review removes it', onRestDel.status === 200 && ((await service.from('distant_review_assignments').select('id').eq('batch_id', S).eq('review_date', plus(5))).data || []).length === 0);
        const id1 = d1.data?.assignment?.id;
        const id2 = d2.data?.assignment?.id;
        const ed = await dr(h.client, { action: 'distant-review-update', assignment_id: id1, review_date: plus(2), start_quarter: 2, end_quarter: 14, note: 'SMOKE تعديل' });
        record('future assignment edited (date, range, note)', ed.status === 200 && ed.data?.assignment?.review_date === plus(2) && ed.data.assignment.start_quarter === 2 && ed.data.assignment.end_quarter === 14);
        record('edit onto another distant date refused', (await dr(h.client, { action: 'distant-review-update', assignment_id: id1, review_date: plus(8), start_quarter: 1, end_quarter: 2 })).status === 409);
        record('member cannot schedule', (await dr(a2.client, { action: 'distant-review-create', batch_id: S, review_date: plus(4), start_quarter: 1, end_quarter: 2 })).status === 403);
        record('member cannot delete', (await dr(a2.client, { action: 'distant-review-delete', assignment_id: id1 })).status === 403);
        const anonDr = await dr(createClient(url, publishable, { auth: { persistSession: false } }), { action: 'distant-review-create', batch_id: S, review_date: plus(4), start_quarter: 1, end_quarter: 2 });
        record('unauthenticated scheduling denied', anonDr.status === 401 || anonDr.status === 403, `${anonDr.status}`);
        record('batch admin cannot schedule in an unassigned batch', (await dr(h.client, { action: 'distant-review-create', batch_id: batchId, review_date: plus(4), start_quarter: 1, end_quarter: 2 })).status === 403);
        // M is a temporary batch the batch admin does not manage: the master schedules there.
        const e3 = await dr(e.client, { action: 'distant-review-create', batch_id: batchId, review_date: plus(3), start_quarter: 100, end_quarter: 120 });
        record('master admin schedules in any batch', e3.status === 200, `${e3.status} ${e3.message ?? ''}`);
        const id3 = e3.data?.assignment?.id;
        record('batch admin cannot edit an unassigned batch\'s day', (await dr(h.client, { action: 'distant-review-update', assignment_id: id3, review_date: plus(4), start_quarter: 1, end_quarter: 2 })).status === 403);
        record('batch admin cannot delete an unassigned batch\'s day', (await dr(h.client, { action: 'distant-review-delete', assignment_id: id3 })).status === 403);
        record('master admin edits any batch\'s future day', (await dr(e.client, { action: 'distant-review-update', assignment_id: id3, review_date: plus(4), start_quarter: 100, end_quarter: 110 })).status === 200);
        record('master admin deletes any batch\'s future day', (await dr(e.client, { action: 'distant-review-delete', assignment_id: id3 })).status === 200);
        const del2 = await dr(h.client, { action: 'distant-review-delete', assignment_id: id2 });
        const left = (await service.from('distant_review_assignments').select('id').eq('batch_id', S)).data || [];
        record('batch admin deletes a future day; the other stays', del2.status === 200 && left.length === 1 && left[0].id === id1);

        // Today's and a past day (written by the service role: the API only schedules future dates).
        await service.from('batch_memberships').update({ joined_at: new Date(Date.parse(plus(-3) + 'T00:00:00Z')).toISOString() }).in('user_id', safe([A.id, B.id]));
        const sBefore = await loadProgram(a2.client, S);
        const { calculateCycleInfo: cci, calculateMemberDistantReviewStatus: mds, joinedOnDateFromTimestamp: jd } = await import('../../supabase/functions/_shared/logic/calculations.ts');
        const quarterBefore = cci(sBefore.settings, sBefore.restDays, today).quarter_of_day;
        const ins = await service.from('distant_review_assignments')
          .insert(safe([{ cycle_id: smokeCycle.id, batch_id: S, review_date: plus(-1), start_quarter: 1, end_quarter: 4 }, { cycle_id: smokeCycle.id, batch_id: S, review_date: today, start_quarter: 5, end_quarter: 8, note: 'SMOKE اليوم' }]))
          .select('id, review_date');
        const dy = ins.data?.find((r) => r.review_date === plus(-1))?.id;
        const dt = ins.data?.find((r) => r.review_date === today)?.id;
        const aState = await loadProgram(a2.client, S);
        const aInfo = cci(aState.settings, aState.restDays, today);
        record('distant-review days pause normal progression (program day shifts by two)', aInfo.is_distant_review_day && aInfo.quarter_of_day === quarterBefore - 2, `${quarterBefore} → ${aInfo.quarter_of_day}`);
        const rev = await a2.client.from('review_confirmations').insert(safe({ cycle_id: smokeCycle.id, user_id: A.id })).select('end_quarter').single();
        record('normal review on a distant day stores the shifted program day (DB = JS)', !rev.error && rev.data?.end_quarter === aInfo.cycle_day, `${rev.data?.end_quarter} vs ${aInfo.cycle_day} ${rev.error?.message ?? ''}`);
        const aMe = aState.users.find((u) => u.id === A.id);
        const aDistant = mds(A.id, aState.distantReviews.filter((x) => x.cycle_id === smokeCycle.id), aState.distantCompletions, aState.settings, aState.restDays, today, jd(aMe?.batch_joined_at));
        record('member sees today\'s distant review and the missed one as overdue', aDistant.todayAssignment?.id === dt && aDistant.overdue.map((x) => x.id).join() === dy, JSON.stringify({ t: aDistant.todayAssignment?.id, o: aDistant.overdue.map((x) => x.id) }));

        // Overdue reviews (normal or distant) never block a candidate, even when a caller still sends the old flag.
        const rt = await invoke(h.client, 'peer-tests', {
          action: 'admin-save', batch_id: S, title: 'SMOKE REVIEW REQ', range_start: 1, range_end: 1, questions_count: 1, lines_per_question: 3,
          test_type: 'recommended', visibility: 'now', audience: 'all', selected_member_ids: [], require_all_quarters_completed: false, require_revision_completed: true,
        });
        const rtId = rt.data?.test?.id as string | undefined;
        const rc = rtId ? await invoke(a2.client, 'peer-tests', { action: 'candidates', test_id: rtId }) : null;
        const bReasons: string[] = rc?.data?.candidates?.find((x: { id: string }) => x.id === B.id)?.reasons || [];
        record('peer test: review debt is not a reason, and the old flag is not stored', !!rc && rc.status === 200 && !bReasons.some((r) => /مراجع/.test(r)) && rt.data?.test?.require_revision_completed === false, JSON.stringify(bReasons));

        const ct = await a2.client.rpc('men_complete_distant_review', safe({ p_assignment_id: dt }));
        record('member confirms today\'s distant review', !ct.error && ct.data?.completed_on === today && ct.data.already_recorded === false, ct.error?.message);
        const ct2 = await a2.client.rpc('men_complete_distant_review', safe({ p_assignment_id: dt }));
        record('confirmation is idempotent', !ct2.error && ct2.data?.already_recorded === true);
        const cy = await a2.client.rpc('men_complete_distant_review', safe({ p_assignment_id: dy }));
        record('late confirmation keeps assigned and actual dates', !cy.error && cy.data?.completed_on === today, cy.error?.message);
        const cf = await a2.client.rpc('men_complete_distant_review', safe({ p_assignment_id: id1 }));
        record('future distant review cannot be confirmed', !!cf.error);
        const aAfter = await loadProgram(a2.client, S);
        const aDone = mds(A.id, aAfter.distantReviews.filter((x) => x.cycle_id === smokeCycle.id), aAfter.distantCompletions, aAfter.settings, aAfter.restDays, today, jd(aMe?.batch_joined_at));
        record('debt cleared after completion; member sees only his completions', aDone.outstanding.length === 0 && aAfter.distantCompletions.length === 2 && aAfter.distantCompletions.every((x) => x.member_id === A.id));
        const bState = await loadProgram(b2.client, S);
        record('another member\'s completions are not visible to him', bState.distantCompletions.length === 0);
        const hState = await loadProgram(h.client, S);
        record('batch admin sees completion statistics of his batch', hState.distantCompletions.filter((x) => x.assignment_id === dt).length === 1);
        const pastEdit = await dr(h.client, { action: 'distant-review-update', assignment_id: dt, review_date: plus(9), start_quarter: 1, end_quarter: 2 });
        const pastDel = await dr(e.client, { action: 'distant-review-delete', assignment_id: dy });
        record('today\'s and past days are view-only (no edit, no delete)', pastEdit.status === 400 && pastDel.status === 400, `${pastEdit.status} ${pastDel.status}`);
        if (rtId) await invoke(h.client, 'peer-tests', { action: 'admin-status', test_id: rtId, status_action: 'finish' });

        // ---- Today converted into a «المراجعة البعيدة» day (its own temporary batch SD; program day 10 today) ----
        const sd = await createTempBatch(' SD', plus(-9));
        const SD = sd.id;
        const sdCycle = sd.cycle?.id as string | undefined;
        record('master admin creates the temporary same-day batch', !!SD && !!sdCycle, `${sd.r.status} ${sd.r.message ?? ''}`);
        if (SD && sdCycle) {
          const V1 = await createSmokeAccount('V1', PHONES.V1, 'member', SD);
          const V2 = await createSmokeAccount('V2', PHONES.V2, 'member', SD);
          await service.from('batch_memberships').update({ joined_at: plus(-9) + 'T12:00:00+03:00' }).in('user_id', safe([V1.id, V2.id]));
          const seed = async (user: string, listener: string, upTo: number) => {
            for (let q = 1; q <= upTo; q++) {
              const t = await service.from('tasmia_submissions').insert(safe({ cycle_id: sdCycle, user_id: user, listener_id: listener, quarter_number: q }));
              if (t.error) throw new Error('seed tasmia: ' + t.error.message);
              if (q < 10) await service.from('tasmia_submissions').update({ legacy_date: plus(q - 10), submitted_at: plus(q - 10) + 'T12:00:00+03:00' }).eq('cycle_id', sdCycle).eq('user_id', user).eq('quarter_number', q);
              const r = await service.from('review_confirmations').insert(safe({ cycle_id: sdCycle, user_id: user, legacy_date: plus(q - 10) }));
              if (r.error) throw new Error('seed review: ' + r.error.message);
            }
          };
          await seed(V1.id, V2.id, 10); // already submitted today's quarter and review
          await seed(V2.id, V1.id, 9); // did nothing today
          const conv = await dr(e.client, { action: 'distant-review-create', batch_id: SD, review_date: today, start_quarter: 1, end_quarter: 9 });
          record('admin-actions converts today; today\'s normal rows are voided', conv.status === 200 && conv.data?.voided_tasmia === 1 && conv.data?.voided_reviews === 1 && conv.data?.assignment?.cancelled_program_day === 10, JSON.stringify(conv.data).slice(0, 200));
          const sdState = await loadProgram(service, SD);
          const sdNow = computeBatchDelays(sdState, today);
          record('today returns to program day 9; both members are in the same state', sdNow.cycleInfo.quarter_of_day === 9 && !sdNow.activeDates.includes(today) && JSON.stringify(sdNow.delayById.get(V1.id)) === JSON.stringify(sdNow.delayById.get(V2.id)));
          const sdNext = computeBatchDelays(sdState, plus(1));
          record('the next day is exactly day 10 and nobody has debt', sdNext.cycleInfo.quarter_of_day === 10 && sdNext.delayById.get(V1.id)?.requiredQuarter === 10 && sdNext.delayById.get(V1.id)?.missedQuartersCount === 0 && sdNext.delayById.get(V2.id)?.missedRevisionDaysCount === 0);
          const v1 = await signIn(V1);
          const v2 = await signIn(V2);
          record('he reads his voided records', ((await v1.client.from('voided_daily_records').select('kind')).data || []).length === 2);
          record('another member does not', ((await v2.client.from('voided_daily_records').select('kind')).data || []).length === 0);
          record('anon denied: voided_daily_records', !!(await createClient(url, publishable, { auth: { persistSession: false } }).from('voided_daily_records').select('*')).error);
          record('an app opened earlier cannot submit the cancelled quarter', !!(await v1.client.from('tasmia_submissions').insert(safe({ cycle_id: sdCycle, user_id: V1.id, listener_id: V2.id, quarter_number: 10, legacy_date: today }))).error);
          record('an app opened earlier cannot submit the cancelled review', !!(await v1.client.from('review_confirmations').insert(safe({ cycle_id: sdCycle, user_id: V1.id, legacy_date: today }))).error);
          const sdDel = await dr(e.client, { action: 'distant-review-delete', assignment_id: conv.data?.assignment?.id });
          record('the converted day cannot be deleted', sdDel.status === 400, `${sdDel.status}`);
          const sdDone = await v1.client.rpc('men_complete_distant_review', safe({ p_assignment_id: conv.data?.assignment?.id }));
          record('the distant review of the converted day completes normally', !sdDone.error && sdDone.data?.already_recorded === false, sdDone.error?.message);
        }
      }
    }

    // ---- Mandatory checkpoint vs candidate rule (temporary batch PT, program day 10) ----
    // P1 finished the test range (1..4) long ago and the checkpoint stops him at quarter 5, so quarters
    // 5..9 are «owed» only because he may not recite them: he must still be able to take the test.
    // P3 genuinely has not finished the range. P2 examines.
    const ptb = await createTempBatch(' PT', plus(-9));
    const ptCycle = ptb.cycle?.id as string | undefined;
    record('master admin creates the temporary checkpoint batch', !!ptb.id && !!ptCycle, `${ptb.r.status} ${ptb.r.message ?? ''}`);
    if (ptb.id && ptCycle) {
      const P1 = await createSmokeAccount('P1', PHONES.P1, 'member', ptb.id);
      const P2 = await createSmokeAccount('P2', PHONES.P2, 'member', ptb.id);
      const P3 = await createSmokeAccount('P3', PHONES.P3, 'member', ptb.id);
      await service.from('batch_memberships').update({ joined_at: plus(-9) + 'T12:00:00+03:00' }).in('user_id', safe([P1.id, P2.id, P3.id]));
      const seedQ = async (user: string, listener: string, upTo: number) => {
        for (let q = 1; q <= upTo; q++) {
          const t = await service.from('tasmia_submissions').insert(safe({ cycle_id: ptCycle, user_id: user, listener_id: listener, quarter_number: q }));
          if (t.error) throw new Error('seed checkpoint tasmia: ' + t.error.message);
          await service.from('tasmia_submissions').update({ legacy_date: plus(q - 10), submitted_at: plus(q - 10) + 'T12:00:00+03:00' }).eq('cycle_id', ptCycle).eq('user_id', user).eq('quarter_number', q);
        }
      };
      await seedQ(P1.id, P2.id, 4);
      await seedQ(P3.id, P2.id, 2);
      const ptSave = await invoke(e.client, 'peer-tests', {
        action: 'admin-save', batch_id: ptb.id, title: 'SMOKE CHECKPOINT', range_start: 1, range_end: 4, questions_count: 1, lines_per_question: 3,
        max_errors: 2, test_type: 'mandatory', difficulty: 'any', visibility: 'now', visible_from: null, visible_until: null,
        audience: 'all', selected_member_ids: [], require_all_quarters_completed: true, require_revision_completed: false,
      });
      const ptTest = ptSave.data?.test?.id as string | undefined;
      record('master admin publishes a mandatory test of quarters 1..4 (whole range required)', ptSave.status === 200 && !!ptTest && ptSave.data.test.status === 'published', `${ptSave.status} ${ptSave.message ?? ''}`);
      const ptNow = computeBatchDelays(await loadProgram(service, ptb.id), today);
      const p1Delay = ptNow.delayById.get(P1.id);
      record('P1 reproduces the production state: range done, next quarter 5, 4+ quarters after the range counted as owed',
        ptNow.cycleInfo.quarter_of_day === 10 && p1Delay?.requiredQuarter === 5 && (p1Delay?.missedQuartersCount ?? 0) >= 4 && p1Delay?.isSeverelyBehindRecitation === true,
        JSON.stringify({ day: ptNow.cycleInfo.quarter_of_day, next: p1Delay?.requiredQuarter, owed: p1Delay?.missedQuartersCount }));
      const p1s = await signIn(P1);
      const p2s = await signIn(P2);
      const stopped = await p1s.client.from('tasmia_submissions').insert(safe({ cycle_id: ptCycle, user_id: P1.id, listener_id: P2.id, quarter_number: 5 }));
      record('the checkpoint stops him at quarter 5 until he passes', !!stopped.error && /الاختبار الإلزامي/.test(stopped.error.message), stopped.error?.message);
      if (ptTest) {
        const list = await invoke(p2s.client, 'peer-tests', { action: 'candidates', test_id: ptTest });
        const c1 = list.data?.candidates?.find((x: { id: string }) => x.id === P1.id);
        const c3 = list.data?.candidates?.find((x: { id: string }) => x.id === P3.id);
        record('deployed peer-tests: the member stopped by the checkpoint is eligible (no range or exclusion reason)', list.status === 200 && c1?.is_eligible === true && c1.reasons.length === 0 && c1.missing_quarters === 0, JSON.stringify(c1?.reasons ?? list.message));
        record('a member who has not finished the range stays ineligible with the exact range reason', c3?.is_eligible === false && c3.reasons.includes('لم يُتمّ تسميع جميع أرباع النطاق بعد (متبقٍ 2 من الأرباع 1 إلى 4)'), JSON.stringify(c3?.reasons));
        const st3 = await invoke(p2s.client, 'peer-tests', { action: 'start', test_id: ptTest, candidate_id: P3.id });
        record('starting the test with the incomplete member is refused', st3.status === 400, `${st3.status} ${st3.message ?? ''}`);
        const st1 = await invoke(p2s.client, 'peer-tests', { action: 'start', test_id: ptTest, candidate_id: P1.id });
        record('the examiner starts the test with the checkpoint-stopped member', st1.status === 200 && !!st1.data?.attempt_id && st1.data.covers_full_range === true, `${st1.status} ${st1.message ?? ''}`);
        if (st1.data?.attempt_id) {
          const sb = await invoke(p2s.client, 'peer-tests', { action: 'submit', attempt_id: st1.data.attempt_id, errors: [0], question_notes: [''] });
          record('he passes', sb.status === 200 && sb.data?.attempt?.status === 'passed', `${sb.status} ${sb.message ?? ''}`);
          const q5 = await p1s.client.from('tasmia_submissions').insert(safe({ cycle_id: ptCycle, user_id: P1.id, listener_id: P2.id, quarter_number: 5 }));
          record("after passing, his Tasmi'a resumes at quarter 5", !q5.error, q5.error?.message);
        }
        await invoke(e.client, 'peer-tests', { action: 'admin-status', test_id: ptTest, status_action: 'finish' });
      }
    }

    // ---- «اختبر نفسك» retired: its Edge Function actions are gone ----
    const meta = await invoke(a.client, 'peer-tests', { action: 'personal-meta' });
    const pgen = await invoke(a.client, 'peer-tests', { action: 'personal-generate', range_type: 'juz', start_juz: 30, end_juz: 30, questions_count: 2, lines_per_question: 3 });
    record('personal-test Edge Function actions removed', meta.status === 400 && pgen.status === 400, `${meta.status} ${pgen.status}`);

    await a.client.auth.signOut();
    const { data: afterLogout } = await browserClient(a.storage).auth.getUser();
    record('logout ends the session', !afterLogout.user);
  } catch (err) {
    record('smoke ran to the end without an exception', false, (err as Error).message);
  } finally {
    // ---- Cleanup: every temporary account, then every temporary batch with its rows ----
    const cleanupErrors: string[] = [];
    const note = (what: string, msg?: string) => { if (msg) cleanupErrors.push(`${what}: ${msg}`); };
    try {
      // Sweep, in case a response was lost: batches named for this run, accounts in temporary batches,
      // profiles and logins on smoke phones (the preflight proved none existed before the run).
      for (const bt of (await service.from('batches').select('id').like('name', `${SMOKE_BATCH_NAME}%`)).data || []) tempBatchIds.add(bt.id);
      const tb = [...tempBatchIds].filter((id) => !realIds.has(id));
      for (const cy of tb.length ? (await service.from('cycles').select('id').in('batch_id', tb)).data || [] : []) tempCycleIds.add(cy.id);
      const accountIds = new Set<string>(created.map((c) => c.id));
      for (const r of tb.length ? (await service.from('batch_memberships').select('user_id').in('batch_id', tb)).data || [] : []) accountIds.add(r.user_id);
      for (const r of (await service.from('profiles').select('id').in('phone', SMOKE_PHONES)).data || []) accountIds.add(r.id);
      for (const u of await listAuthUsers()) if (SMOKE_EMAILS.has((u.email ?? '').toLowerCase())) accountIds.add(u.id);

      for (const id of accountIds) {
        if (realIds.has(id)) { note('account', 'a pre-existing account was found in a temporary scope and was NOT deleted'); continue; }
        const { data: prof } = await service.from('profiles').select('role, is_master_admin').eq('id', id).maybeSingle();
        if (prof?.role === 'admin' && prof.is_master_admin) note('unset master', (await service.from('profiles').update({ is_master_admin: false }).eq('id', id)).error?.message);
        if (prof) {
          const { error } = await service.rpc('men_delete_member_completely', { p_user_id: id });
          if (error && !/غير موجود/.test(error.message)) note('delete profile', error.message);
        }
        const { error: authError } = await service.auth.admin.deleteUser(id);
        if (authError && !/not.found/i.test(authError.message)) note('delete login', authError.message);
      }
      for (const id of tb) {
        const cycles = ((await service.from('cycles').select('id').eq('batch_id', id)).data || []).map((c) => c.id);
        if (cycles.length) {
          const tests = ((await service.from('peer_tests').select('id').in('cycle_id', cycles)).data || []).map((t) => t.id);
          if (tests.length) {
            note('delete attempts', (await service.from('peer_test_attempts').delete().in('test_id', tests)).error?.message);
            note('delete tests', (await service.from('peer_tests').delete().in('id', tests)).error?.message);
          }
        }
        note('delete thoughts', (await service.from('daily_thoughts').delete().eq('batch_id', id)).error?.message);
        note('delete cycles', (await service.from('cycles').delete().eq('batch_id', id)).error?.message);
        note('delete batch', (await service.from('batches').delete().eq('id', id)).error?.message);
      }
      record('cleanup ran without errors', cleanupErrors.length === 0, cleanupErrors.join(' | '));

      // ---- Verification: nothing temporary remains, pre-existing data unchanged ----
      const after = await snapshot();
      const authAfter = await listAuthUsers();
      const tempIds = new Set<string>([...accountIds, ...tb, ...tempCycleIds]);
      const residual: Record<string, number> = {};
      for (const [t, rows] of Object.entries(after.raw)) {
        const n = rows.filter((r) => Object.values(r).some((v) => typeof v === 'string' && tempIds.has(v))).length;
        if (n) residual[t] = n;
      }
      const leftBatches = after.raw.batches.filter((x) => String(x.name).startsWith(SMOKE_BATCH_NAME)).length;
      const leftProfiles = after.raw.profiles.filter((p) => SMOKE_PHONES.includes(String(p.phone))).length;
      const leftLogins = authAfter.filter((u) => tempIds.has(u.id) || SMOKE_EMAILS.has((u.email ?? '').toLowerCase())).length;
      record('every temporary account, login, batch, cycle and row is gone', !Object.keys(residual).length && !leftBatches && !leftProfiles && !leftLogins,
        JSON.stringify({ residual, leftBatches, leftProfiles, leftLogins, accounts: accountIds.size, batches: tb.length, cycles: tempCycleIds.size }));
      record('row counts and Auth user count restored', JSON.stringify(after.counts) === JSON.stringify(before.counts) && authAfter.length === authBefore.length,
        JSON.stringify({ before: before.counts, after: after.counts, authBefore: authBefore.length, authAfter: authAfter.length }));
      const diff: Record<string, { added: number; removed: number; changed: number }> = {};
      for (const t of Object.keys(TABLES)) {
        const x = before.hashes[t], y = after.hashes[t];
        const added = [...y.keys()].filter((k) => !x.has(k)).length;
        const removed = [...x.keys()].filter((k) => !y.has(k)).length;
        const changed = [...x.keys()].filter((k) => y.has(k) && x.get(k) !== y.get(k)).length;
        if (added || removed || changed) diff[t] = { added, removed, changed };
      }
      record(`every pre-existing production row unchanged (per-row hash, ${Object.keys(TABLES).length} tables)`, !Object.keys(diff).length,
        Object.keys(diff).length ? JSON.stringify(diff) + ' (a real member or admin acting during the run also shows here)' : undefined);
    } catch (err) {
      record('cleanup and verification completed', false, (err as Error).message);
    }
  }
  console.log(JSON.stringify(results, null, 1));
  console.log(`${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
