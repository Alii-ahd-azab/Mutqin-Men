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
    'review_confirmations', 'peer_tests', 'peer_test_attempts', 'peer_test_selected_members', 'personal_tests', 'daily_thoughts'])
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
    const pt = await a.client.rpc('men_save_personal_test', { p_test: {
      range_type: 'surah', range_label: 'سورة الفاتحة', start_surah: 1, start_surah_name: 'الفاتحة', end_surah: 1, end_surah_name: 'الفاتحة',
      questions_count: 1, lines_per_question: 2, difficulty: 'any',
      questions: [{ start_surah: 1, start_surah_name: 'الفاتحة', start_ayah: 1, end_surah: 1, end_surah_name: 'الفاتحة', end_ayah: 7, errors_count: 1 }] } });
    const ptRow = pt.data ? (await a.client.from('personal_tests').select('grade').eq('id', pt.data).single()).data : null;
    record('personal test saved with server-computed grade', !pt.error && Number(ptRow?.grade) === 85, pt.error?.message);
    const b = await signIn(B);
    const peek = b.error ? null : await b.client.from('personal_tests').select('id').eq('id', pt.data);
    record('personal tests are private to their owner', !!peek && !peek.error && (peek.data || []).length === 0);
    const del = await a.client.from('personal_tests').delete().eq('id', pt.data).select('id');
    record('owner deletes own personal test', (del.data || []).length === 1);

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
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
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
      }
    }

    // Real batch's peer tests were never touched.
    const realAfter = JSON.stringify((await service.from('peer_tests').select('id, status, updated_at').eq('cycle_id', program.cycle.id).order('id')).data);
    record('real batch peer tests untouched', realAfter === realTests);

    // ---- Personal tests through the Edge Function (generation) and the owner RPC (save) ----
    const meta = await invoke(a.client, 'peer-tests', { action: 'personal-meta' });
    record('personal-test metadata', meta.status === 200 && meta.data?.surahs?.length === 114 && meta.data?.quartersList?.length === 240);
    const pgen = await invoke(a.client, 'peer-tests', { action: 'personal-generate', range_type: 'juz', start_juz: 30, end_juz: 30, questions_count: 2, lines_per_question: 3, difficulty: 'any' });
    record('personal-test generation', pgen.status === 200 && pgen.data?.questions?.length === 2 && !!pgen.data?.setup);
    if (pgen.data?.setup) {
      const questions = pgen.data.questions.map((q: any, i: number) => ({ ...q, errors_count: i }));
      const saved = await a.client.rpc('men_save_personal_test', { p_test: { ...pgen.data.setup, questions } });
      const row = saved.data ? (await a.client.from('personal_tests').select('grade, range_label').eq('id', saved.data).single()).data : null;
      record('generated personal test saved (grade computed in SQL)', !saved.error && Number(row?.grade) === 93 && /الجزء 30/.test(row?.range_label || ''), saved.error?.message);
      if (saved.data) await a.client.from('personal_tests').delete().eq('id', saved.data);
    }

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
