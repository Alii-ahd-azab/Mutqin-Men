// Production smoke test of the Men runtime (Sisters architecture, Phase 2 parity), through real Supabase
// Auth sessions and the publishable key (exactly what the browser uses). Temporary smoke accounts and a
// temporary smoke batch are created, used and deleted (with every row they wrote); real members' data
// and the real batch's peer tests are never written.
//
//   MEN_CUTOVER_APPROVED_PROJECT=uaublandjewfzmhnbflc BCRYPTJS_PATH=<path to bcryptjs> \
//   npx tsx --env-file=.env.local migration/cutover/smoke.ts --project uaublandjewfzmhnbflc
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { loadBatchIds, loadProgram } from '../../supabase/functions/_shared/men/menData.ts';
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
const SMOKE_BATCH_NAME = `SMOKE ${randomBytes(4).toString('hex')}`;

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

async function createSmokeAccount(key: string, phone: string, role: 'member' | 'admin', batchId: string, opts: { bcrypt?: boolean } = {}): Promise<Smoke> {
  const pw = password();
  const { data, error } = await service.auth.admin.createUser({
    email: phoneToAuthEmail(phone),
    email_confirm: true,
    ...(opts.bcrypt ? { password_hash: bcrypt.hashSync(pw, 10) } : { password: pw }),
  });
  if (error || !data.user) throw new Error(`createUser ${key}: ${error?.message}`);
  const s: Smoke = { key, id: data.user.id, phone, password: pw, role };
  created.push(s);
  const { error: profileError } = await service.rpc('create_profile_with_membership', {
    p_id: s.id, p_full_name: `SMOKE ${key}`, p_phone: phone, p_role: role, p_is_master_admin: role === 'admin',
    p_member_batch_id: role === 'member' ? batchId : null, p_admin_batch_ids: [], p_actor: null,
  });
  if (profileError) throw new Error(`profile ${key}: ${profileError.message}`);
  return s;
}

async function signIn(s: Smoke) {
  const storage = new Map<string, string>();
  const client = browserClient(storage);
  const { error } = await client.auth.signInWithPassword({ email: phoneToAuthEmail(s.phone), password: s.password });
  return { client, storage, error };
}

async function counts() {
  const c = async (t: string) => (await service.from(t).select('*', { count: 'exact', head: true })).count;
  const out: Record<string, number | null> = {};
  for (const t of ['profiles', 'batches', 'cycles', 'batch_memberships', 'batch_membership_transfers', 'tasmia_submissions',
    'review_confirmations', 'peer_tests', 'peer_test_attempts', 'peer_test_selected_members', 'personal_tests', 'daily_thoughts',
    'group_rest_days', 'program_pauses', 'distant_review_assignments', 'distant_review_completions'])
    out[t] = await c(t);
  return out;
}

const invoke = async (client: SupabaseClient, name: string, body: Record<string, unknown>) => {
  const { data, error } = await client.functions.invoke(name, { body });
  let status = 200;
  let message = data?.error as string | undefined;
  const ctx = (error as { context?: unknown } | null)?.context;
  if (ctx instanceof Response) {
    status = ctx.status;
    message = (await ctx.json().catch(() => ({})))?.error;
  } else if (error) status = 0;
  return { data, status, message };
};

async function main() {
  const before = await counts();
  const [batchId] = await loadBatchIds(service);
  const program = await loadProgram(service, batchId);
  const realTests = JSON.stringify((await service.from('peer_tests').select('id, status, updated_at').eq('cycle_id', program.cycle.id).order('id')).data);
  const authBefore = (await service.auth.admin.listUsers({ page: 1, perPage: 1000 })).data.users.length;
  let smokeBatchId: string | null = null;
  const extraBatchIds: (string | undefined)[] = [];

  try {
    const A = await createSmokeAccount('A', '000000000001', 'member', batchId, { bcrypt: true });
    const B = await createSmokeAccount('B', '000000000002', 'member', batchId);
    const C = await createSmokeAccount('C', '000000000007', 'member', batchId);
    const D = await createSmokeAccount('D', '000000000003', 'member', batchId);
    const E = await createSmokeAccount('E', '000000000004', 'admin', batchId);
    await service.from('profiles').update({ active: false }).eq('id', D.id);

    // ---- Auth ----
    const a = await signIn(A);
    record('member login with an imported bcrypt hash (same path as the 30 migrated users)', !a.error, a.error?.message);
    const reload = browserClient(a.storage);
    const { data: persisted } = await reload.auth.getUser();
    record('session persists across a reload', persisted.user?.id === A.id);
    const wrong = await browserClient(new Map()).auth.signInWithPassword({ email: phoneToAuthEmail(A.phone), password: 'wrong-password' });
    record('wrong password rejected', !!wrong.error);
    const e = await signIn(E);
    record('admin login', !e.error, e.error?.message);

    // ---- Member reads (RLS) ----
    const memberState = await loadProgram(a.client, batchId);
    record('member dashboard loads (cycle, settings, users)', !!memberState.cycle.id && memberState.users.length > 0);
    record('member sees no other members\' recitations', memberState.recitationLogs.every((r) => r.member_id === A.id || r.listener_id === A.id));
    record('member sees no other members\' reviews', memberState.revisionLogs.every((r) => r.member_id === A.id));
    const memberTests = (await a.client.from('peer_tests').select('status')).data || [];
    record('member sees only live tests', memberTests.every((t) => t.status === 'published'));
    const memberBatches = (await a.client.from('batches').select('id')).data || [];
    record('member sees only his own batch', memberBatches.length === 1 && memberBatches[0].id === batchId);

    // ---- Member writes (database guards) ----
    const review = await a.client.from('review_confirmations').insert({ cycle_id: program.cycle.id, user_id: A.id }).select('start_quarter, end_quarter, legacy_date').single();
    record('member records today\'s review', !review.error, review.error?.message);
    record('the review is dated with the program date (05:00 Africa/Cairo)', review.data?.legacy_date === programDate(), `${review.data?.legacy_date} vs ${programDate()}`);
    const dup = await a.client.from('review_confirmations').insert({ cycle_id: program.cycle.id, user_id: A.id });
    record('duplicate review for the same date rejected', dup.error?.code === '23505');
    const skip = await a.client.from('tasmia_submissions').insert({ cycle_id: program.cycle.id, user_id: A.id, listener_id: B.id, quarter_number: 2 });
    record('skipping a quarter rejected', !!skip.error && /الربع/.test(skip.error.message), skip.error?.message);
    const tasmia = await a.client.from('tasmia_submissions').insert({ cycle_id: program.cycle.id, user_id: A.id, listener_id: B.id, quarter_number: 1 });
    record('member records quarter 1 with a smoke listener', !tasmia.error || /الاختبار الإلزامي/.test(tasmia.error.message), tasmia.error?.message);
    const forOther = await a.client.from('review_confirmations').insert({ cycle_id: program.cycle.id, user_id: B.id });
    record('member cannot write for another member', !!forOther.error);
    const promote = await a.client.from('profiles').update({ role: 'admin' }).eq('id', A.id);
    record('member cannot change own role', !!promote.error || !(await service.from('profiles').select('role').eq('id', A.id).single()).data?.role.includes('admin'));
    const svc = await a.client.rpc('men_delete_member_completely', { p_user_id: B.id });
    record('member cannot call service-role functions', !!svc.error);
    // «اختبر نفسك» retired: its history stays (owner-readable), its write paths are closed.
    const pt = await a.client.rpc('men_save_personal_test', { p_test: {} });
    record('«اختبر نفسك» retired: the save RPC is closed to members', !!pt.error && /permission denied/i.test(pt.error.message), pt.error?.message);
    const ptDel = await a.client.from('personal_tests').delete().eq('member_id', A.id).select('id');
    record('«اختبر نفسك» retired: members cannot delete personal-test history', !!ptDel.error && /permission denied/i.test(ptDel.error.message), ptDel.error?.message);
    const ptRead = await a.client.from('personal_tests').select('id');
    record('personal-test history stays readable by its owner', !ptRead.error, ptRead.error?.message);
    const b = await signIn(B);

    const stored = await service.from('review_confirmations').select('id, member_name_snapshot').eq('user_id', A.id);
    record('member write is stored in Men Supabase', (stored.data || []).length === 1 && stored.data![0].member_name_snapshot === 'SMOKE A');

    // ---- Inactive member ----
    const d = await signIn(D);
    const dProfile = d.error ? null : await d.client.from('profiles').select('id, active');
    record('inactive member sees only own profile (app signs them out, as in Sisters)', !!dProfile && dProfile.data?.length === 1 && dProfile.data[0].active === false);
    const dWrite = d.error ? { error: true } : await d.client.from('review_confirmations').insert({ cycle_id: program.cycle.id, user_id: D.id });
    record('inactive member cannot record', !!dWrite.error);

    // ---- Unauthenticated ----
    const anon = createClient(url, publishable, { auth: { persistSession: false } });
    const anonRead = await anon.from('profiles').select('id').limit(1);
    record('unauthenticated access to profiles denied', !!anonRead.error || (anonRead.data || []).length === 0);
    const anonTasmia = await anon.from('tasmia_submissions').select('id').limit(1);
    record('unauthenticated access to recitations denied', !!anonTasmia.error || (anonTasmia.data || []).length === 0);

    // ---- Admin (program) ----
    const adminState = await loadProgram(e.client, batchId);
    record('admin dashboard sees the whole batch', adminState.recitationLogs.length >= program.recitationLogs.length && adminState.users.length >= program.users.length);
    const rest = await e.client.from('group_rest_days').insert({ cycle_id: program.cycle.id, rest_date: '2027-12-31', reason: 'SMOKE', created_by: E.id }).select('id').single();
    const restDel = rest.data ? await e.client.from('group_rest_days').delete().eq('id', rest.data.id).select('id') : null;
    record('admin adds and deletes a rest day', !rest.error && (restDel?.data || []).length === 1, rest.error?.message);
    const memberRest = await a.client.from('group_rest_days').insert({ cycle_id: program.cycle.id, rest_date: '2027-12-30', reason: 'x', created_by: A.id });
    record('member cannot add rest days', !!memberRest.error);

    for (const f of ['admin-users', 'admin-actions', 'peer-tests']) {
      const r = await fetch(`${url}/functions/v1/${f}`, { method: 'OPTIONS' });
      record(`Edge Function ${f} deployed`, r.status === 200, `HTTP ${r.status}`);
    }

    // ---- admin-users: account lifecycle (incl. Men member ↔ admin switch) ----
    const memberCreate = await invoke(a.client, 'admin-users', { action: 'create', name: 'x', phone: '000000000009', password: 'abcdef12', role: 'member', batch_id: batchId });
    record('admin-users refuses a member caller', memberCreate.status === 403, `${memberCreate.status} ${memberCreate.message}`);
    const fPassword = password();
    const fCreate = await invoke(e.client, 'admin-users', { action: 'create', name: 'SMOKE F', phone: '000000000005', password: fPassword, role: 'member', batch_id: batchId });
    if (fCreate.data?.user?.id) created.push({ key: 'F', id: fCreate.data.user.id, phone: '000000000005', password: fPassword, role: 'member' });
    record('admin-users creates a member (Auth + profile + membership)', fCreate.status === 201 || !!fCreate.data?.user?.id, `${fCreate.status} ${fCreate.message ?? ''}`);
    const F = created.find((c) => c.key === 'F');
    if (F) {
      const fLogin = await signIn(F);
      record('new member can sign in', !fLogin.error, fLogin.error?.message);
      const dupPhone = await invoke(e.client, 'admin-users', { action: 'create', name: 'dup', phone: '000000000005', password: 'abcdef12', role: 'member', batch_id: batchId });
      record('admin-users rejects a duplicate phone', dupPhone.status === 409 || dupPhone.status === 400, `${dupPhone.status} ${dupPhone.message}`);
      const newPw = password();
      const upd = await invoke(e.client, 'admin-users', { action: 'update', user_id: F.id, name: 'SMOKE F2', phone: '000000000006', password: newPw });
      F.phone = '000000000006';
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

    // ---- admin-actions: factory reset guard, batch creation (Sisters multi-batch) ----
    const memberReset = await invoke(a.client, 'admin-actions', { action: 'factory-reset', batch_id: batchId, cycle_id: program.cycle.id });
    record('admin-actions refuses a member caller', memberReset.status === 403, `${memberReset.status} ${memberReset.message}`);
    const staleReset = await invoke(e.client, 'admin-actions', { action: 'factory-reset', batch_id: batchId, cycle_id: '00000000-0000-4000-8000-000000000000' });
    const cycleAfter = await service.from('cycles').select('id, status').eq('id', program.cycle.id).single();
    record('admin-actions runs start_next_cycle (stale-cycle guard: nothing reset)', staleReset.status === 400 && /تغيّرت الدورة/.test(staleReset.message || '') && cycleAfter.data?.status === 'active', `${staleReset.status} ${staleReset.message}`);
    const unknown = await invoke(e.client, 'admin-actions', { action: 'nope' });
    record('admin-actions rejects unknown actions', unknown.status === 400);
    const today = programDate();
    const memberBatch = await invoke(a.client, 'admin-actions', { action: 'create-batch', name: 'x', start_date: today });
    record('create-batch refuses a member caller', memberBatch.status === 403);
    // The smoke batch starts two days ago, so quarter 2 is already due (the mandatory-test block is
    // then the only reason to refuse it) while nobody is far enough behind to be «مؤهل للإقصاء».
    const twoDaysAgo = new Date(Date.parse(today + 'T00:00:00Z') - 2 * 86400000).toISOString().slice(0, 10);
    const newBatch = await invoke(e.client, 'admin-actions', { action: 'create-batch', name: SMOKE_BATCH_NAME, start_date: twoDaysAgo });
    smokeBatchId = newBatch.data?.batch?.id ?? null;
    const smokeCycle = smokeBatchId ? (await service.from('cycles').select('id, cycle_number, status').eq('batch_id', smokeBatchId).single()).data : null;
    record('master admin creates a batch with its first active cycle', !!smokeBatchId && smokeCycle?.status === 'active' && smokeCycle.cycle_number === 1, `${newBatch.status} ${newBatch.message ?? ''}`);
    const eBatches = (await e.client.from('batches').select('id')).data || [];
    record('master admin sees every batch', eBatches.length >= 2);

    if (smokeBatchId && smokeCycle) {
      const S = smokeBatchId;

      // ---- Batch admin (Sisters): created by the master admin, limited to the smoke batch ----
      const hPassword = password();
      const hCreate = await invoke(e.client, 'admin-users', { action: 'create', name: 'SMOKE H', phone: '000000000008', password: hPassword, role: 'admin', is_master_admin: false, batch_ids: [S] });
      if (hCreate.data?.user?.id) created.push({ key: 'H', id: hCreate.data.user.id, phone: '000000000008', password: hPassword, role: 'admin' });
      const H = created.find((c) => c.key === 'H');
      record('master admin creates a batch admin', !!H && hCreate.data?.user?.is_master_admin === false, `${hCreate.status} ${hCreate.message ?? ''}`);
      const memberAdminCreate = await invoke(a.client, 'admin-users', { action: 'create', name: 'x', phone: '000000000010', password: 'abcdef12', role: 'admin', is_master_admin: true });
      record('members cannot create admins', memberAdminCreate.status === 403);
      if (H) {
        const h = await signIn(H);
        const hBatches = (await h.client.from('batches').select('id')).data || [];
        record('batch admin sees only his assigned batch', hBatches.length === 1 && hBatches[0].id === S);
        const hMain = (await h.client.from('tasmia_submissions').select('id').eq('cycle_id', program.cycle.id).limit(1)).data || [];
        record('batch admin cannot read another batch', hMain.length === 0);
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
        const hReal = await hAlerts(batchId);
        record('batch admin alerts: his batch is readable, an unassigned batch yields no data (RLS)', !('error' in hOwn) && 'error' in hReal, JSON.stringify({ hOwn, hReal }));
        const hOther = await invoke(h.client, 'admin-users', { action: 'create', name: 'x', phone: '000000000011', password: 'abcdef12', role: 'member', batch_id: batchId });
        record('batch admin cannot add members to another batch', hOther.status === 403, `${hOther.status} ${hOther.message}`);
        const hMaster = await invoke(h.client, 'admin-users', { action: 'update', user_id: H.id, is_master_admin: true });
        record('batch admin cannot promote himself to master', hMaster.status === 403);
        const reassign = await invoke(e.client, 'admin-users', { action: 'set-admin-batches', user_id: H.id, batch_ids: [S] });
        record('master admin sets batch-admin assignments', reassign.status === 200, `${reassign.status} ${reassign.message ?? ''}`);
        const adminList = (await e.client.from('batch_memberships').select('batch_id').eq('user_id', H.id).eq('membership_role', 'admin')).data || [];
        record('admin list shows the batch admin\'s assignment', adminList.length === 1 && adminList[0].batch_id === S);

        // ---- Move members to the smoke batch (Sisters transfer) ----
        const memberMove = await invoke(a.client, 'admin-users', { action: 'move-member-batch', user_id: B.id, destination_batch_id: S });
        record('members cannot move members', memberMove.status === 403);
        const hMoveFromMain = await invoke(h.client, 'admin-users', { action: 'move-member-batch', user_id: B.id, destination_batch_id: S });
        record('batch admin cannot move a member out of a batch he does not manage', hMoveFromMain.status === 403);
        let movedAll = true;
        for (const m of [A, B, C]) {
          const mv = await invoke(e.client, 'admin-users', { action: 'move-member-batch', user_id: m.id, destination_batch_id: S });
          movedAll &&= mv.status === 200;
        }
        const moved = (await service.from('batch_memberships').select('user_id').eq('batch_id', S).eq('membership_role', 'member')).data || [];
        record('master admin moves members to another batch (same account, membership moved)', movedAll && moved.length === 3);
        const aOldHistory = (await service.from('review_confirmations').select('id').eq('user_id', A.id).eq('cycle_id', program.cycle.id)).data || [];
        record('moved member keeps his history on the old batch', aOldHistory.length === 1);
        const transfers = (await service.from('batch_membership_transfers').select('id').in('user_id', [A.id, B.id, C.id])).data || [];
        record('transfers are logged', transfers.length === 3);

        // Fresh sessions after the move (RLS reads the new membership).
        const a2 = await signIn(A);
        const b2 = await signIn(B);
        const c2 = await signIn(C);
        const aBatch = (await a2.client.from('batches').select('id')).data || [];
        record('moved member now sees the new batch only', aBatch.length === 1 && aBatch[0].id === S);

        // ---- Listener correction (Sisters) ----
        const q1 = await a2.client.from('tasmia_submissions').insert({ cycle_id: smokeCycle.id, user_id: A.id, listener_id: B.id, quarter_number: 1 }).select('id').single();
        record('member records in the new batch', !q1.error, q1.error?.message);
        if (q1.data) {
          const corr = await a2.client.rpc('correct_tasmia_listener', { p_submission_id: q1.data.id, p_new_listener_id: C.id });
          const row = (await service.from('tasmia_submissions').select('listener_id, listener_name_snapshot, listener_changed_at').eq('id', q1.data.id).single()).data;
          record('member corrects the listener once', !corr.error && row?.listener_id === C.id && row.listener_name_snapshot === 'SMOKE C' && !!row.listener_changed_at, corr.error?.message);
          const again = await a2.client.rpc('correct_tasmia_listener', { p_submission_id: q1.data.id, p_new_listener_id: B.id });
          record('second listener correction refused', !!again.error && /مسبقًا/.test(again.error.message), again.error?.message);
          const notMine = await b2.client.rpc('correct_tasmia_listener', { p_submission_id: q1.data.id, p_new_listener_id: C.id });
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
          action: 'admin-save', batch_id: S, title: 'x', range_start: 1, range_end: 1, questions_count: 1, lines_per_question: 3,
          test_type: 'recommended', visibility: 'now', audience: 'all', selected_member_ids: [],
        });
        record('a second live test in the same batch is refused', overlap.status === 400, `${overlap.status} ${overlap.message}`);
        const hMainTest = await invoke(h.client, 'peer-tests', { action: 'admin-save', batch_id: batchId, title: 'x', range_start: 1, range_end: 1, questions_count: 1, lines_per_question: 3, visibility: 'draft', audience: 'all' });
        record('batch admin cannot manage another batch\'s tests', hMainTest.status === 403);

        if (testId) {
          const preview = await invoke(h.client, 'peer-tests', { action: 'admin-preview', test_id: testId });
          record('peer-tests admin-preview', preview.status === 200 && preview.data?.questions?.length === 1);
          const cVisible = (await c2.client.from('peer_tests').select('id').eq('id', testId)).data || [];
          const bVisible = (await b2.client.from('peer_tests').select('id').eq('id', testId)).data || [];
          record('live test visible only to its audience', cVisible.length === 0 && bVisible.length === 1);

          const bq1 = await b2.client.from('tasmia_submissions').insert({ cycle_id: smokeCycle.id, user_id: B.id, listener_id: A.id, quarter_number: 1 });
          record('candidate recites the test range', !bq1.error, bq1.error?.message);
          const blocked = await b2.client.from('tasmia_submissions').insert({ cycle_id: smokeCycle.id, user_id: B.id, listener_id: A.id, quarter_number: 2 });
          record('mandatory test blocks the next quarter until passed', !!blocked.error && /الاختبار الإلزامي/.test(blocked.error.message), blocked.error?.message);
          const impact = await invoke(h.client, 'peer-tests', { action: 'admin-impact', test_id: testId });
          record('peer-tests admin-impact counts the blocked member', impact.status === 200 && impact.data?.blocked_members?.some((m: { id: string }) => m.id === B.id), JSON.stringify(impact.data));

          const cCand = await invoke(c2.client, 'peer-tests', { action: 'candidates', test_id: testId });
          record('member outside the audience cannot examine', cCand.status === 403);
          const cand = await invoke(a2.client, 'peer-tests', { action: 'candidates', test_id: testId });
          const bStatus = cand.data?.candidates?.find((c: { id: string }) => c.id === B.id);
          record('peer-tests candidates (examiner view)', cand.status === 200 && bStatus?.is_eligible === true && !cand.data.candidates.some((c: { id: string }) => c.id === C.id), JSON.stringify(bStatus?.reasons ?? cand.message));
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
            const unblocked = await b2.client.from('tasmia_submissions').insert({ cycle_id: smokeCycle.id, user_id: B.id, listener_id: A.id, quarter_number: 2 });
            record('after passing, the next quarter is not blocked by the test', !unblocked.error || !/الاختبار الإلزامي/.test(unblocked.error.message), unblocked.error?.message);
            const bAttempts = (await b2.client.from('peer_test_attempts').select('candidate_id, examiner_id')).data || [];
            record('candidate sees own attempts only', bAttempts.length >= 1 && bAttempts.every((t) => t.candidate_id === B.id || t.examiner_id === B.id));
          }
          const finish = await invoke(h.client, 'peer-tests', { action: 'admin-status', test_id: testId, status_action: 'finish' });
          record('peer-tests finish', finish.status === 200 && finish.data?.test?.status === 'finished');
          const reshow = await invoke(h.client, 'peer-tests', { action: 'admin-status', test_id: testId, status_action: 'show' });
          record('finished test cannot be shown again', reshow.status === 400);

          // Men partial range: a test without the whole-range requirement covers what was recited.
          const partial = await invoke(h.client, 'peer-tests', {
            action: 'admin-save', batch_id: S, title: 'SMOKE PARTIAL', range_start: 1, range_end: 8, questions_count: 1, lines_per_question: 3,
            test_type: 'recommended', visibility: 'now', audience: 'all', selected_member_ids: [], require_all_quarters_completed: false,
          });
          const pid = partial.data?.test?.id as string | undefined;
          const pc = pid ? await invoke(a2.client, 'peer-tests', { action: 'candidates', test_id: pid }) : null;
          const pb = pc?.data?.candidates?.find((c: { id: string }) => c.id === B.id);
          const bDone = (await service.from('tasmia_submissions').select('quarter_number').eq('user_id', B.id).eq('cycle_id', smokeCycle.id)).data?.length ?? 0;
          record('partial-range test: candidate tested on the recited part only', !!pb && pb.is_eligible === true && pb.effective_range_end === bDone && pb.covers_full_range === false, JSON.stringify(pb));
          if (pid) await invoke(h.client, 'peer-tests', { action: 'admin-status', test_id: pid, status_action: 'finish' });
        }

        // ---- Fresh-start member (created at the batch's current quarter, no earlier debt) ----
        const dayOfS = 3; // the smoke batch started two days ago: today is its day 3
        const gPassword = password();
        const gCreate = await invoke(h.client, 'admin-users', { action: 'create', name: 'SMOKE G', phone: '000000000014', password: gPassword, role: 'member', batch_id: S, fresh_start: true });
        if (gCreate.data?.user?.id) created.push({ key: 'G', id: gCreate.data.user.id, phone: '000000000014', password: gPassword, role: 'member' });
        const G = created.find((c) => c.key === 'G');
        record('batch admin creates a fresh-start member at the batch quarter', !!G && gCreate.data?.start_quarter === dayOfS, `${gCreate.status} ${JSON.stringify(gCreate.data?.start_quarter)} ${gCreate.message ?? ''}`);
        const hFreshOther = await invoke(h.client, 'admin-users', { action: 'create', name: 'x', phone: '000000000015', password: 'abcdef12', role: 'member', batch_id: batchId, fresh_start: true });
        record('fresh-start creation respects batch scope', hFreshOther.status === 403);
        const gMembership = G ? (await service.from('batch_memberships').select('start_quarter, start_cycle_id').eq('user_id', G.id).single()).data : null;
        record('fresh-start baseline stored on the membership', gMembership?.start_quarter === dayOfS && gMembership?.start_cycle_id === smokeCycle.id, JSON.stringify(gMembership));
        if (G) {
          const g = await signIn(G);
          const g1 = await g.client.from('tasmia_submissions').insert({ cycle_id: smokeCycle.id, user_id: G.id, listener_id: A.id, quarter_number: 1 });
          record('fresh-start member does not owe quarter 1', !!g1.error && new RegExp(`\\(${dayOfS}\\)`).test(g1.error.message), g1.error?.message);
          const gSkip = await g.client.from('tasmia_submissions').insert({ cycle_id: smokeCycle.id, user_id: G.id, listener_id: A.id, quarter_number: dayOfS + 1 });
          record('fresh-start member cannot skip his first quarter', !!gSkip.error, gSkip.error?.message);
          const gOk = await g.client.from('tasmia_submissions').insert({ cycle_id: smokeCycle.id, user_id: G.id, listener_id: A.id, quarter_number: dayOfS });
          record('fresh-start member records his first quarter', !gOk.error, gOk.error?.message);
          const gState = await loadProgram(g.client, S);
          const me = gState.users.find((u) => u.id === G.id);
          record('loader exposes the baseline and the join date', me?.batch_start_quarter === dayOfS && !!me?.batch_joined_at);
        }
        const normal = (await service.from('batch_memberships').select('start_quarter').in('user_id', [A.id, B.id, C.id])).data || [];
        record('members created without the option keep the normal baseline', normal.length === 3 && normal.every((m) => m.start_quarter === null));

        // ---- Rename batch (master: any; batch admin: assigned only; member/anon: never) ----
        const mainName = (await service.from('batches').select('name').eq('id', batchId).single()).data?.name;
        const eRename = await invoke(e.client, 'admin-actions', { action: 'rename-batch', batch_id: S, name: SMOKE_BATCH_NAME + ' م' });
        record('master admin renames a batch', eRename.status === 200 && eRename.data?.batch?.name === SMOKE_BATCH_NAME + ' م' && eRename.data.batch.id === S, `${eRename.status} ${eRename.message ?? ''}`);
        const hRename = await invoke(h.client, 'admin-actions', { action: 'rename-batch', batch_id: S, name: '  ' + SMOKE_BATCH_NAME + '   ب ' });
        record('assigned batch admin renames his batch (trimmed)', hRename.status === 200 && hRename.data?.batch?.name === SMOKE_BATCH_NAME + ' ب', `${hRename.status} ${hRename.data?.batch?.name}`);
        const hOtherRename = await invoke(h.client, 'admin-actions', { action: 'rename-batch', batch_id: batchId, name: 'x' });
        record('batch admin cannot rename an unassigned batch', hOtherRename.status === 403, `${hOtherRename.status}`);
        const aRename = await invoke(a2.client, 'admin-actions', { action: 'rename-batch', batch_id: S, name: 'x' });
        record('member cannot rename a batch', aRename.status === 403, `${aRename.status}`);
        const anonRename = await invoke(createClient(url, publishable, { auth: { persistSession: false } }), 'admin-actions', { action: 'rename-batch', batch_id: S, name: 'x' });
        record('unauthenticated rename denied', anonRename.status === 401 || anonRename.status === 403, `${anonRename.status}`);
        const blank = await invoke(e.client, 'admin-actions', { action: 'rename-batch', batch_id: S, name: '   ' });
        record('whitespace-only name refused', blank.status === 400);
        const dupName = await invoke(e.client, 'admin-actions', { action: 'rename-batch', batch_id: S, name: mainName });
        record('duplicate batch name refused', dupName.status === 409);
        const afterRename = (await service.from('cycles').select('id, status').eq('batch_id', S)).data || [];
        const sMembers = (await service.from('batch_memberships').select('user_id').eq('batch_id', S)).data || [];
        record('rename changes only the name (same id, cycle and members)', afterRename.length === 1 && afterRename[0].id === smokeCycle.id && sMembers.length >= 4);
        record('main batch name untouched', (await service.from('batches').select('name').eq('id', batchId).single()).data?.name === mainName);

        // ---- «المراجعة البعيدة»: one manual date per call, future-only management, member debt ----
        const plus = (n: number) => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
        const dr = (client: SupabaseClient, body: Record<string, unknown>) => invoke(client, 'admin-actions', body);
        const d1 = await dr(h.client, { action: 'distant-review-create', batch_id: S, review_date: plus(1), start_quarter: 1, end_quarter: 12, note: 'SMOKE مراجعة' });
        record('batch admin schedules one distant-review day in his batch', d1.status === 200 && d1.data?.assignment?.review_date === plus(1) && d1.data.assignment.note === 'SMOKE مراجعة', `${d1.status} ${d1.message ?? ''}`);
        const d2 = await dr(h.client, { action: 'distant-review-create', batch_id: S, review_date: plus(8), start_quarter: 20, end_quarter: 30 });
        record('a second day is a separate manual assignment', d2.status === 200 && d2.data?.assignment?.id !== d1.data?.assignment?.id);
        const sDays = (await service.from('distant_review_assignments').select('review_date').eq('batch_id', S)).data || [];
        record('no recurrence: exactly the two chosen dates exist', sDays.length === 2);
        record('duplicate date refused', (await dr(h.client, { action: 'distant-review-create', batch_id: S, review_date: plus(1), start_quarter: 1, end_quarter: 2 })).status === 409);
        record('today refused (future dates only)', (await dr(h.client, { action: 'distant-review-create', batch_id: S, review_date: today, start_quarter: 1, end_quarter: 2 })).status === 400);
        record('past date refused', (await dr(h.client, { action: 'distant-review-create', batch_id: S, review_date: plus(-1), start_quarter: 1, end_quarter: 2 })).status === 400);
        record('from = to refused (TO is the stopping boundary)', (await dr(h.client, { action: 'distant-review-create', batch_id: S, review_date: plus(3), start_quarter: 9, end_quarter: 9 })).status === 400);
        record('from > to refused', (await dr(h.client, { action: 'distant-review-create', batch_id: S, review_date: plus(3), start_quarter: 13, end_quarter: 12 })).status === 400);
        record('quarter 241 refused', (await dr(h.client, { action: 'distant-review-create', batch_id: S, review_date: plus(3), start_quarter: 1, end_quarter: 241 })).status === 400);
        const restOnD1 = await h.client.from('group_rest_days').insert({ cycle_id: smokeCycle.id, rest_date: plus(1), created_by: H.id });
        record('rest day refused on a distant-review date', !!restOnD1.error && /مراجعة بعيدة/.test(restOnD1.error.message), restOnD1.error?.message);
        await h.client.from('group_rest_days').insert({ cycle_id: smokeCycle.id, rest_date: plus(5), created_by: H.id });
        const onRest = await dr(h.client, { action: 'distant-review-create', batch_id: S, review_date: plus(5), start_quarter: 1, end_quarter: 2 });
        record('distant review refused on a rest day', onRest.status === 400 && /استدراك وراحة/.test(onRest.message || ''), `${onRest.status} ${onRest.message}`);
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
        // A second temporary batch the batch admin does not manage: the master schedules there.
        const s3 = await invoke(e.client, 'admin-actions', { action: 'create-batch', name: SMOKE_BATCH_NAME + ' 3', start_date: today });
        extraBatchIds.push(s3.data?.batch?.id);
        const e3 = await dr(e.client, { action: 'distant-review-create', batch_id: s3.data?.batch?.id, review_date: plus(3), start_quarter: 100, end_quarter: 120 });
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
        await service.from('batch_memberships').update({ joined_at: new Date(Date.parse(plus(-3) + 'T00:00:00Z')).toISOString() }).in('user_id', [A.id, B.id]);
        const sBefore = await loadProgram(a2.client, S);
        const { calculateCycleInfo: cci, calculateMemberDistantReviewStatus: mds, joinedOnDateFromTimestamp: jd } = await import('../../supabase/functions/_shared/logic/calculations.ts');
        const quarterBefore = cci(sBefore.settings, sBefore.restDays, today).quarter_of_day;
        const ins = await service.from('distant_review_assignments')
          .insert([{ cycle_id: smokeCycle.id, batch_id: S, review_date: plus(-1), start_quarter: 1, end_quarter: 4 }, { cycle_id: smokeCycle.id, batch_id: S, review_date: today, start_quarter: 5, end_quarter: 8, note: 'SMOKE اليوم' }])
          .select('id, review_date');
        const dy = ins.data?.find((r) => r.review_date === plus(-1))?.id;
        const dt = ins.data?.find((r) => r.review_date === today)?.id;
        const aState = await loadProgram(a2.client, S);
        const aInfo = cci(aState.settings, aState.restDays, today);
        record('distant-review days pause normal progression (program day shifts by two)', aInfo.is_distant_review_day && aInfo.quarter_of_day === quarterBefore - 2, `${quarterBefore} → ${aInfo.quarter_of_day}`);
        const rev = await a2.client.from('review_confirmations').insert({ cycle_id: smokeCycle.id, user_id: A.id }).select('end_quarter').single();
        record('normal review on a distant day stores the shifted program day (DB = JS)', !rev.error && rev.data?.end_quarter === aInfo.cycle_day, `${rev.data?.end_quarter} vs ${aInfo.cycle_day} ${rev.error?.message ?? ''}`);
        const aMe = aState.users.find((u) => u.id === A.id);
        const aDistant = mds(A.id, aState.distantReviews.filter((x) => x.cycle_id === smokeCycle.id), aState.distantCompletions, aState.settings, aState.restDays, today, jd(aMe?.batch_joined_at));
        record('member sees today\'s distant review and the missed one as overdue', aDistant.todayAssignment?.id === dt && aDistant.overdue.map((x) => x.id).join() === dy, JSON.stringify({ t: aDistant.todayAssignment?.id, o: aDistant.overdue.map((x) => x.id) }));

        // Peer-test prerequisite: distant-review debt blocks a test that requires completed reviews.
        const rt = await invoke(h.client, 'peer-tests', {
          action: 'admin-save', batch_id: S, title: 'SMOKE REVIEW REQ', range_start: 1, range_end: 1, questions_count: 1, lines_per_question: 3,
          test_type: 'recommended', visibility: 'now', audience: 'all', selected_member_ids: [], require_all_quarters_completed: false, require_revision_completed: true,
        });
        const rtId = rt.data?.test?.id as string | undefined;
        const rc = rtId ? await invoke(a2.client, 'peer-tests', { action: 'candidates', test_id: rtId }) : null;
        const bReasons: string[] = rc?.data?.candidates?.find((c: { id: string }) => c.id === B.id)?.reasons || [];
        record('peer test requiring reviews: distant-review debt blocks', bReasons.some((r) => /مراجعات بعيدة متأخرة \(1\)/.test(r)) && bReasons.some((r) => /المراجعة البعيدة لليوم/.test(r)) && !bReasons.some((r) => /لم يؤكد مراجعة اليوم بعد/.test(r)), JSON.stringify(bReasons));

        const ct = await a2.client.rpc('men_complete_distant_review', { p_assignment_id: dt });
        record('member confirms today\'s distant review', !ct.error && ct.data?.completed_on === today && ct.data.already_recorded === false, ct.error?.message);
        const ct2 = await a2.client.rpc('men_complete_distant_review', { p_assignment_id: dt });
        record('confirmation is idempotent', !ct2.error && ct2.data?.already_recorded === true);
        const cy = await a2.client.rpc('men_complete_distant_review', { p_assignment_id: dy });
        record('late confirmation keeps assigned and actual dates', !cy.error && cy.data?.completed_on === today, cy.error?.message);
        const cf = await a2.client.rpc('men_complete_distant_review', { p_assignment_id: id1 });
        record('future distant review cannot be confirmed', !!cf.error);
        const aAfter = await loadProgram(a2.client, S);
        const aDone = mds(A.id, aAfter.distantReviews.filter((x) => x.cycle_id === smokeCycle.id), aAfter.distantCompletions, aAfter.settings, aAfter.restDays, today, jd(aMe?.batch_joined_at));
        record('debt cleared after completion; member sees only his completions', aDone.outstanding.length === 0 && aAfter.distantCompletions.length === 2 && aAfter.distantCompletions.every((c) => c.member_id === A.id));
        const bState = await loadProgram(b2.client, S);
        record('another member\'s completions are not visible to him', bState.distantCompletions.length === 0);
        const hState = await loadProgram(h.client, S);
        record('batch admin sees completion statistics of his batch', hState.distantCompletions.filter((c) => c.assignment_id === dt).length === 1);
        const pastEdit = await dr(h.client, { action: 'distant-review-update', assignment_id: dt, review_date: plus(9), start_quarter: 1, end_quarter: 2 });
        const pastDel = await dr(e.client, { action: 'distant-review-delete', assignment_id: dy });
        record('today\'s and past days are view-only (no edit, no delete)', pastEdit.status === 400 && pastDel.status === 400, `${pastEdit.status} ${pastDel.status}`);
        if (rtId) await invoke(h.client, 'peer-tests', { action: 'admin-status', test_id: rtId, status_action: 'finish' });
      }
    }

    // Real batch's peer tests were never touched.
    const realAfter = JSON.stringify((await service.from('peer_tests').select('id, status, updated_at').eq('cycle_id', program.cycle.id).order('id')).data);
    record('real batch peer tests untouched', realAfter === realTests);

    // ---- «اختبر نفسك» retired: its Edge Function actions are gone ----
    const meta = await invoke(a.client, 'peer-tests', { action: 'personal-meta' });
    const pgen = await invoke(a.client, 'peer-tests', { action: 'personal-generate', range_type: 'juz', start_juz: 30, end_juz: 30, questions_count: 2, lines_per_question: 3 });
    record('personal-test Edge Function actions removed', meta.status === 400 && pgen.status === 400, `${meta.status} ${pgen.status}`);

    await a.client.auth.signOut();
    const { data: afterLogout } = await browserClient(a.storage).auth.getUser();
    record('logout ends the session', !afterLogout.user);
  } finally {
    // ---- Cleanup: every smoke account, every row it wrote, and the smoke batch ----
    for (const s of created) {
      const { data: prof } = await service.from('profiles').select('role, is_master_admin').eq('id', s.id).maybeSingle();
      if (prof?.role === 'admin' && prof.is_master_admin) await service.from('profiles').update({ is_master_admin: false }).eq('id', s.id);
      const { error } = await service.rpc('men_delete_member_completely', { p_user_id: s.id });
      if (error && !/غير موجود/.test(error.message)) console.error('cleanup profile', s.key, error.message);
      await service.auth.admin.deleteUser(s.id);
    }
    for (const extra of extraBatchIds) {
      if (!extra) continue;
      await service.from('cycles').delete().eq('batch_id', extra);
      const { error } = await service.from('batches').delete().eq('id', extra);
      if (error) console.error('cleanup extra batch', error.message);
    }
    if (smokeBatchId) {
      const cycles = ((await service.from('cycles').select('id').eq('batch_id', smokeBatchId)).data || []).map((c) => c.id);
      if (cycles.length) {
        const tests = ((await service.from('peer_tests').select('id').in('cycle_id', cycles)).data || []).map((t) => t.id);
        if (tests.length) {
          await service.from('peer_test_attempts').delete().in('test_id', tests);
          await service.from('peer_tests').delete().in('id', tests);
        }
      }
      await service.from('daily_thoughts').delete().eq('batch_id', smokeBatchId);
      await service.from('cycles').delete().eq('batch_id', smokeBatchId);
      const { error } = await service.from('batches').delete().eq('id', smokeBatchId);
      if (error) console.error('cleanup batch', error.message);
    }
    const after = await counts();
    const authAfter = (await service.auth.admin.listUsers({ page: 1, perPage: 1000 })).data.users.length;
    record('cleanup restored every count', JSON.stringify(after) === JSON.stringify(before) && authAfter === authBefore, JSON.stringify({ before, after, authBefore, authAfter }));
  }
  console.log(JSON.stringify(results, null, 1));
  console.log(`${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
