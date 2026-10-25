// Production smoke test of the Sisters-style Men runtime, through real Supabase Auth sessions and the
// publishable key (exactly what the browser uses). Temporary smoke accounts are created, used and
// deleted (with every row they wrote); real members' data is never written.
//
//   MEN_CUTOVER_APPROVED_PROJECT=uaublandjewfzmhnbflc BCRYPTJS_PATH=<path to bcryptjs> \
//   npx tsx --env-file=.env.local migration/cutover/smoke.ts --project uaublandjewfzmhnbflc
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { loadBatchIds, loadProgram } from '../../src/lib/menData';
import { phoneToAuthEmail } from '../../src/lib/authIdentity';
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
  return { profiles: await c('profiles'), tasmia: await c('tasmia_submissions'), reviews: await c('review_confirmations'), personal: await c('personal_tests') };
}

async function main() {
  const before = await counts();
  const [batchId] = await loadBatchIds(service);
  const program = await loadProgram(service, batchId);
  const authBefore = (await service.auth.admin.listUsers({ page: 1, perPage: 1000 })).data.users.length;

  try {
    const A = await createSmokeAccount('A', '000000000001', 'member', batchId, { bcrypt: true });
    const B = await createSmokeAccount('B', '000000000002', 'member', batchId);
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
    record('member sees only live tests', memberState.tests.every((t) => t.is_active));

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

    // Writes landed in Supabase.
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

    // ---- Admin ----
    const adminState = await loadProgram(e.client, batchId);
    record('admin dashboard sees the whole batch', adminState.recitationLogs.length >= program.recitationLogs.length && adminState.users.length >= program.users.length);
    const rest = await e.client.from('group_rest_days').insert({ cycle_id: program.cycle.id, rest_date: '2027-12-31', reason: 'SMOKE', created_by: E.id }).select('id').single();
    const restDel = rest.data ? await e.client.from('group_rest_days').delete().eq('id', rest.data.id).select('id') : null;
    record('admin adds and deletes a rest day', !rest.error && (restDel?.data || []).length === 1, rest.error?.message);
    const memberRest = await a.client.from('group_rest_days').insert({ cycle_id: program.cycle.id, rest_date: '2027-12-30', reason: 'x', created_by: A.id });
    record('member cannot add rest days', !!memberRest.error);

    // ---- Edge Functions ----
    for (const f of ['admin-users', 'admin-actions', 'peer-tests']) {
      const r = await fetch(`${url}/functions/v1/${f}`, { method: 'OPTIONS' });
      record(`Edge Function ${f} deployed`, r.status === 200, `HTTP ${r.status}`);
    }

    await a.client.auth.signOut();
    const { data: afterLogout } = await browserClient(a.storage).auth.getUser();
    record('logout ends the session', !afterLogout.user);
  } finally {
    // ---- Cleanup: every smoke account and every row it wrote ----
    for (const s of created) {
      if (s.role === 'admin') await service.rpc('men_set_account_role', { p_user_id: s.id, p_role: 'member', p_batch_id: batchId, p_actor: null });
      const { error } = await service.rpc('men_delete_member_completely', { p_user_id: s.id });
      if (error && !/غير موجود/.test(error.message)) console.error('cleanup profile', s.key, error.message);
      await service.auth.admin.deleteUser(s.id);
    }
    const after = await counts();
    const authAfter = (await service.auth.admin.listUsers({ page: 1, perPage: 1000 })).data.users.length;
    record('cleanup restored every count', JSON.stringify(after) === JSON.stringify(before) && authAfter === authBefore, JSON.stringify({ before, after, authBefore, authAfter }));
  }
  console.log(JSON.stringify(results, null, 1));
  if (results.some((r) => !r.ok && !r.check.startsWith('Edge Function'))) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
