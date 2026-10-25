import {
  User,
  GroupSettings,
  RestDay,
  RecitationLog,
  RevisionLog,
  CycleInfo,
  TestDefinition,
  TestAttempt,
  TestQuestion,
} from '../types';
import { supabase } from '../lib/supabase';
import { formatDate, calculateCycleInfo, calculateMemberRequiredQuarter } from '../lib/calculations';
import { isInTestAudience } from '../lib/testGenerator';
import { phoneToAuthEmail } from '../lib/authIdentity';
import { loadBatchIds, loadProgram, type ProgramState } from '../lib/menData';
import { mapUser, PROFILE_COLUMNS, type ProfileRow } from '../lib/menRows';

/*
 * Mutqin for Men data layer — same architecture as Mutqin for Sisters:
 *   reads          → supabase-js under Row Level Security
 *   simple writes  → direct inserts/updates checked by RLS and database guards
 *   multi-step     → RPCs (SECURITY DEFINER functions that check the caller)
 *   privileged     → Edge Functions (admin-users, admin-actions, peer-tests)
 * Method names and result shapes are those the Men UI already uses.
 */

// ---------------------------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------------------------

type EdgeFunction = 'admin-users' | 'admin-actions' | 'peer-tests';

/* Calls an Edge Function and surfaces the server's Arabic error message (Sisters invokeFunction). */
async function invokeFunction<T>(name: EdgeFunction, body: Record<string, unknown>, fallbackMessage: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body: { ...body, client_date: today() } });
  if (error) {
    let message = fallbackMessage;
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      try {
        const payload = await context.json();
        if (payload?.error) message = String(payload.error);
      } catch {
        // keep fallback message
      }
    }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data as T;
}

/** Database errors raised by our guards/RPCs carry Arabic messages that are safe to show. */
function dbError(error: { code?: string; message: string }, fallback: string): Error {
  if (error.code === '42501') return new Error('غير مصرح لك بتنفيذ هذا الإجراء');
  if (error.code === '23514' || error.code === 'P0001' || error.code === 'P0002') return new Error(error.message);
  console.error(fallback, error);
  return new Error(fallback);
}

const today = () => formatDate(new Date());

async function getCurrentAuthUser() {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error) throw error;
  if (!user) throw new Error('يجب تسجيل الدخول أولاً');
  return user;
}

async function getCurrentProfile(): Promise<ProfileRow> {
  const user = await getCurrentAuthUser();
  const { data, error } = await supabase.from('profiles').select(PROFILE_COLUMNS).eq('id', user.id).single();
  if (error) throw error;
  return data as ProfileRow;
}

/*
 * One program load is shared by the requests the dashboard makes together (bootstrap, recitations,
 * revisions); every later call starts a fresh load, so data is never stale after a write.
 */
let inFlight: Promise<ProgramState> | null = null;
let lastState: ProgramState | null = null;

function loadState(): Promise<ProgramState> {
  if (!inFlight) {
    inFlight = (async () => {
      const batches = await loadBatchIds(supabase);
      if (!batches.length) throw new Error('لا توجد دفعة متاحة لحسابك');
      return loadProgram(supabase, batches[0]);
    })()
      .then((state) => {
        lastState = state;
        return state;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

async function currentState(): Promise<ProgramState> {
  return lastState || loadState();
}

function activeTestFor(state: ProgramState, user: User | undefined): TestDefinition | null {
  const raw = state.tests.find((t) => t.is_active && !t.is_finished) || null;
  if (!raw || !user) return null;
  return user.role === 'admin' || isInTestAudience(raw, user.id) ? raw : null;
}

// Server-side HTML sanitization of the former API, applied before storing (defense in depth;
// DailyThoughtCard also sanitizes when rendering).
function sanitizeThought(input: string): string {
  if (!input || typeof input !== 'string') return '';
  return input
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<\/?(iframe|object|embed|link|meta|style|form|input|button|applet|frame|frameset)\b[^>]*>/gi, '')
    .replace(/\s*on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:[^"'\s]*/gi, '')
    .trim();
}

// Personal-test generation result kept until the member finishes (the save RPC needs the resolved range).
let lastPersonalTest: { setup: Record<string, unknown>; questions: TestQuestion[] } | null = null;

// ---------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------
export const api = {
  // Auth
  async login(phone: string, password: string): Promise<{ user: User }> {
    const { data, error } = await supabase.auth.signInWithPassword({ email: phoneToAuthEmail(phone), password });
    if (error || !data.user) {
      throw new Error(
        (error as { status?: number } | null)?.status === 429
          ? 'محاولات كثيرة، يرجى الانتظار قليلًا ثم المحاولة مجددًا'
          : 'رقم الهاتف أو كلمة المرور غير صحيحة'
      );
    }
    try {
      const profile = await getCurrentProfile();
      // Same as Mutqin for Sisters: inactive accounts cannot sign in.
      if (!profile.active) {
        await supabase.auth.signOut();
        throw new Error('هذا الحساب غير نشط حاليًا. يرجى التواصل مع المشرف.');
      }
      return { user: mapUser(profile) };
    } catch (e) {
      await supabase.auth.signOut();
      throw e instanceof Error && e.message ? e : new Error('تعذر تحميل بيانات الحساب');
    }
  },

  async logout(): Promise<void> {
    lastState = null;
    lastPersonalTest = null;
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  },

  async getMe(): Promise<{ user: User }> {
    return { user: mapUser(await getCurrentProfile()) };
  },

  async changePassword(payload: { currentPassword: string; newPassword: string; confirmPassword?: string }): Promise<{ message: string }> {
    const newPassword = String(payload.newPassword || '').trim();
    if (!payload.currentPassword || !newPassword) throw new Error('يرجى إدخال كلمة المرور الحالية وكلمة المرور الجديدة');
    if (newPassword.length < 6) throw new Error('يجب ألا تقل كلمة المرور الجديدة عن 6 خانات');
    if (payload.confirmPassword !== undefined && newPassword !== String(payload.confirmPassword).trim()) {
      throw new Error('كلمة المرور الجديدة وتأكيدها غير متطابقين');
    }
    const profile = await getCurrentProfile();
    const { error: verifyError } = await supabase.auth.signInWithPassword({
      email: phoneToAuthEmail(profile.phone),
      password: payload.currentPassword,
    });
    if (verifyError) throw new Error('كلمة المرور الحالية غير صحيحة');
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw new Error('تعذر حفظ كلمة المرور الجديدة، يرجى المحاولة ثانية.');
    return { message: 'تم تغيير كلمة المرور بنجاح' };
  },

  // Bootstrap
  async getBootstrap(_params?: { client_date?: string }): Promise<{
    cycleInfo: CycleInfo;
    settings: GroupSettings;
    restDays: RestDay[];
    users: User[];
    todayRecitations: RecitationLog[];
    todayRevisions: RevisionLog[];
    tests?: TestDefinition[];
    activeTest?: TestDefinition | null;
    testAttempts?: TestAttempt[];
  }> {
    const [state, auth] = await Promise.all([loadState(), getCurrentAuthUser()]);
    const user = state.users.find((u) => u.id === auth.id);
    const todayStr = today();
    const activeTest = activeTestFor(state, user);
    const isAdmin = user?.role === 'admin';
    return {
      cycleInfo: calculateCycleInfo(state.settings, state.restDays, todayStr),
      settings: state.settings,
      restDays: state.restDays,
      users: state.users,
      todayRecitations: state.recitationLogs.filter((r) => r.date === todayStr),
      todayRevisions: state.revisionLogs.filter((r) => r.date === todayStr),
      // RLS already limits members to the live test(s) of their audience and their own attempts.
      tests: isAdmin ? state.tests : activeTest ? [activeTest] : [],
      activeTest,
      testAttempts: isAdmin
        ? state.testAttempts
        : state.testAttempts.filter((a) => a.candidate_id === auth.id || a.examiner_id === auth.id),
    };
  },

  // Recitations
  async getRecitations(params?: { member_id?: string; reciter_id?: string; date?: string }): Promise<{ recitations: RecitationLog[] }> {
    let logs = [...(await loadState()).recitationLogs];
    const member = params?.member_id || params?.reciter_id;
    if (member) logs = logs.filter((l) => l.member_id === member || l.reciter_id === member);
    if (params?.date) logs = logs.filter((l) => l.date === params.date);
    logs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return { recitations: logs };
  },

  async recordRecitation(payload: { quarter_number: number; listener_id: string; notes?: string; date?: string }): Promise<{ message: string }> {
    const [state, user] = await Promise.all([currentState(), getCurrentAuthUser()]);
    const notes = payload.notes && String(payload.notes).trim() ? String(payload.notes).trim() : null;
    // Order, listener, mandatory-test and account rules are enforced by the database guard.
    const { error } = await supabase.from('tasmia_submissions').insert({
      cycle_id: state.cycle.id,
      user_id: user.id,
      listener_id: payload.listener_id || null,
      quarter_number: payload.quarter_number,
      notes,
      legacy_date: payload.date && /^\d{4}-\d{2}-\d{2}$/.test(payload.date) ? payload.date : today(),
    });
    if (error) {
      if (error.code === '23505') throw new Error(`الربع رقم (${payload.quarter_number}) مسجل ومكتمل لديك بالفعل.`);
      throw dbError(error, 'فشل حفظ سجل التسميع. يرجى التحقق من اتصال الإنترنت والمحاولة مرة أخرى.');
    }
    return { message: `تم تسجيل إتمام تسميع الربع ${payload.quarter_number} بنجاح وتقبل الله منكم!` };
  },

  // Revisions
  async getRevisions(params?: { member_id?: string; date?: string }): Promise<{ revisions: RevisionLog[] }> {
    let logs = [...(await loadState()).revisionLogs];
    if (params?.member_id) logs = logs.filter((l) => l.member_id === params.member_id);
    if (params?.date) logs = logs.filter((l) => l.date === params.date);
    logs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return { revisions: logs };
  },

  async recordRevision(payload: { notes?: string; date?: string }): Promise<{ message: string; already_recorded?: boolean }> {
    const [state, user] = await Promise.all([currentState(), getCurrentAuthUser()]);
    const todayStr = today();
    const date = payload.date && /^\d{4}-\d{2}-\d{2}$/.test(payload.date) ? payload.date : todayStr;
    const notes = payload.notes && String(payload.notes).trim() ? String(payload.notes).trim() : null;
    // Quarters are computed by the database guard; one review per member per date.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data, error } = await supabase
        .from('review_confirmations')
        .insert({ cycle_id: state.cycle.id, user_id: user.id, notes, legacy_date: date })
        .select('start_quarter, end_quarter')
        .single();
      if (!error) {
        return {
          message: `تم تسجيل إتمام مراجعة ${date === todayStr ? 'اليوم' : `يوم ${date}`} (من الربع ${data.start_quarter} إلى ${data.end_quarter}) بنجاح`,
        };
      }
      // Idempotent: a retry after a lost response must look like success, not an error.
      if (error.code === '23505') return { message: 'تم تأكيد مراجعة هذا اليوم مسبقًا.', already_recorded: true };
      if (error.code) throw dbError(error, 'فشل حفظ سجل المراجعة. يرجى المحاولة مرة أخرى.');
      lastErr = error; // network failure: retry
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
    throw lastErr instanceof Error ? lastErr : new Error('تعذر الاتصال بالخادم');
  },

  // Admin: members (Edge Function admin-users)
  async adminAddMember(payload: { name: string; phone: string; password: string; role: 'member' | 'admin' }): Promise<{ user: User; message: string }> {
    if (!payload.name?.trim() || !payload.phone?.trim() || !payload.password?.trim()) throw new Error('الاسم ورقم الهاتف وكلمة المرور مطلوبة');
    if (payload.password.trim().length < 6) throw new Error('يجب ألا تقل كلمة المرور عن 6 خانات');
    const state = await currentState();
    return invokeFunction('admin-users', { action: 'create', ...payload, batch_id: state.batchId }, 'فشل حفظ بيانات العضو الجديد، يرجى المحاولة ثانية.');
  },

  async adminUpdateMember(
    id: string,
    payload: { name?: string; phone?: string; password?: string; role?: 'member' | 'admin'; is_active?: boolean }
  ): Promise<{ user: User; message: string }> {
    if (payload.password && payload.password.trim() && payload.password.trim().length < 6) {
      throw new Error('يجب ألا تقل كلمة المرور عن 6 خانات');
    }
    const state = await currentState();
    return invokeFunction('admin-users', { action: 'update', user_id: id, ...payload, batch_id: state.batchId }, 'فشل تحديث بيانات العضو، يرجى المحاولة مرة أخرى.');
  },

  async adminDeleteMemberCompletely(id: string): Promise<{ success: boolean; message: string }> {
    return invokeFunction('admin-users', { action: 'delete', user_id: id }, 'فشل حذف العضو وسجلاته، يرجى المحاولة مرة أخرى.');
  },

  // Admin: program (direct RLS writes, as in Sisters)
  async adminAddRestDay(payload: { date: string; note: string }): Promise<{ restDay?: RestDay; message: string }> {
    if (!payload.date || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) throw new Error('يرجى تحديد تاريخ صحيح ليوم الاستدراك والراحة (YYYY-MM-DD)');
    const [state, profile] = await Promise.all([currentState(), getCurrentProfile()]);
    const { error } = await supabase.from('group_rest_days').insert({
      cycle_id: state.cycle.id,
      rest_date: payload.date,
      reason: payload.note ? String(payload.note).trim() : 'يوم استدراك وراحة للمجموعة',
      created_by: profile.id,
      created_by_name_snapshot: profile.full_name.trim(),
    });
    if (error) {
      if (error.code === '23505') throw new Error('هذا التاريخ مسجل بالفعل كيوم استدراك وراحة');
      throw dbError(error, 'فشل حفظ يوم الاستدراك والراحة، يرجى المحاولة ثانية.');
    }
    return { message: 'تمت إضافة يوم الاستدراك والراحة بنجاح' };
  },

  async adminDeleteRestDay(id: string): Promise<{ success: boolean; message: string }> {
    const { data, error } = await supabase.from('group_rest_days').delete().eq('id', id).select('id');
    if (error) throw dbError(error, 'فشل حذف يوم الاستدراك، يرجى المحاولة ثانية.');
    if (!data?.length) throw new Error('يوم الاستدراك غير موجود');
    return { success: true, message: 'تم حذف يوم الاستدراك والراحة' };
  },

  async adminPause(): Promise<{ message: string }> {
    const [state, profile] = await Promise.all([loadState(), getCurrentProfile()]);
    if (state.settings.is_paused) return { message: 'البرنامج متوقف مؤقتًا بالفعل.' };
    const { error } = await supabase.from('program_pauses').insert({ cycle_id: state.cycle.id, paused_on: today(), created_by: profile.id });
    if (error) {
      if (error.code === '23505') return { message: 'البرنامج متوقف مؤقتًا بالفعل.' };
      throw dbError(error, 'فشل حفظ تفعيل الإيقاف المؤقت، يرجى المحاولة ثانية.');
    }
    return { message: 'تم تفعيل الإيقاف المؤقت للبرنامج وتجميد عداد الدورة لجميع الأعضاء بنجاح.' };
  },

  async adminResume(): Promise<{ message: string }> {
    const state = await loadState();
    if (!state.settings.is_paused) return { message: 'البرنامج غير متوقف حاليًا.' };
    // The resume day is active; resuming on the pause day records no paused period (as before).
    const { error } = await supabase
      .from('program_pauses')
      .update({ resumed_on: today() })
      .eq('cycle_id', state.cycle.id)
      .is('resumed_on', null);
    if (error) throw dbError(error, 'فشل حفظ استئناف البرنامج، يرجى المحاولة ثانية.');
    return { message: 'تم استئناف البرنامج بنجاح ومواصلة الدورة.' };
  },

  async adminAddPausePeriod(from: string, to: string): Promise<{ message: string }> {
    const state = await currentState();
    const { error } = await supabase.rpc('men_add_past_pause_period', { p_cycle_id: state.cycle.id, p_from: from, p_to: to });
    if (error) throw dbError(error, 'فشل حفظ فترة الإيقاف. حاول مرة أخرى.');
    return { message: 'تم تسجيل فترة الإيقاف.' };
  },

  async adminBackfillRevisions(until: string): Promise<{ created: number; message: string }> {
    const state = await currentState();
    const { data, error } = await supabase.rpc('men_backfill_revisions', { p_cycle_id: state.cycle.id, p_until: until });
    if (error) throw dbError(error, 'تعذر حفظ السجلات الناقصة. أعد المحاولة (آمنة ولا تكرر).');
    const created = Number(data) || 0;
    return { created, message: `تمت إضافة ${created} سجل مراجعة ناقص حتى ${until}.` };
  },

  async adminUpdateSettings(payload: { start_date?: string }): Promise<{ settings: GroupSettings; message: string }> {
    const state = await currentState();
    if (payload.start_date && /^\d{4}-\d{2}-\d{2}$/.test(payload.start_date)) {
      const { data, error } = await supabase.from('cycles').update({ starts_on: payload.start_date }).eq('id', state.cycle.id).select('id');
      if (error) throw dbError(error, 'فشل حفظ إعدادات المجموعة، يرجى المحاولة ثانية.');
      if (!data?.length) throw new Error('هذا الإجراء مخصص للمشرف فقط');
    }
    return { settings: (await loadState()).settings, message: 'تم تحديث إعدادات المجموعة بنجاح' };
  },

  async adminUpdateDailyThought(payload: { daily_thought: string }): Promise<{ settings: GroupSettings; message: string }> {
    const [state, profile] = await Promise.all([currentState(), getCurrentProfile()]);
    const clean = sanitizeThought(payload.daily_thought || '');
    const { error } = clean
      ? await supabase.from('daily_thoughts').insert({
          batch_id: state.batchId,
          content_html: clean,
          published_by: profile.id,
          published_by_name_snapshot: profile.full_name.trim(),
          is_published: true,
        })
      : // Saving an empty thought hides it, as the previous empty value did.
        await supabase.from('daily_thoughts').update({ is_published: false }).eq('batch_id', state.batchId).eq('is_published', true);
    if (error) throw dbError(error, 'فشل حفظ ونشر خاطرة اليوم، يرجى المحاولة ثانية.');
    return { settings: (await loadState()).settings, message: 'تم حفظ ونشر خاطرة اليوم بنجاح لجميع الأعضاء' };
  },

  async adminDeleteDailyThought(): Promise<{ settings: GroupSettings; message: string }> {
    const state = await currentState();
    const { error } = await supabase.from('daily_thoughts').update({ is_published: false }).eq('batch_id', state.batchId).eq('is_published', true);
    if (error) throw dbError(error, 'فشل حذف خاطرة اليوم، يرجى المحاولة ثانية.');
    return { settings: (await loadState()).settings, message: 'تم حذف خاطرة اليوم بالكامل ولن تظهر في لوحة الأعضاء' };
  },

  /* Same as Mutqin for Sisters: archives the current cycle (history kept) and starts a new one on day 1. */
  async adminFactoryReset(): Promise<{ success: boolean; message: string; cycleInfo: CycleInfo; settings: GroupSettings }> {
    const state = await loadState();
    const data = await invokeFunction<{ message?: string }>(
      'admin-actions',
      { action: 'factory-reset', batch_id: state.batchId, cycle_id: state.cycle.id },
      'تعذر بدء دورة جديدة. حاول مرة أخرى.'
    );
    const next = await loadState();
    return {
      success: true,
      message: data?.message || 'تم بدء دورة جديدة',
      settings: next.settings,
      cycleInfo: calculateCycleInfo(next.settings, next.restDays, today()),
    };
  },

  async adminGetStats(): Promise<{
    total_members: number;
    completed_recitation_count: number;
    completed_revision_count: number;
    pending_recitation_today: any[];
    pending_revision_today: any[];
    member_stats: any[];
  }> {
    const db = await loadState();
    const todayStr = today();
    const cycleInfo = calculateCycleInfo(db.settings, db.restDays, todayStr);
    const members = db.users.filter((u) => u.role === 'member' && u.is_active);
    const memberStats = members.map((m) => {
      const todayRecitation = db.recitationLogs.find((r) => (r.member_id === m.id || r.reciter_id === m.id) && r.date === todayStr);
      const todayRevision = db.revisionLogs.find((r) => r.member_id === m.id && r.date === todayStr);
      const quarterStatus = calculateMemberRequiredQuarter(m.id, cycleInfo.quarter_of_day, db.recitationLogs);
      return {
        id: m.id,
        name: m.name,
        phone: m.phone,
        has_recited_today: !!todayRecitation,
        recited_quarter: todayRecitation?.quarter_number,
        listener_name: todayRecitation?.listener_name,
        has_reviewed_today: !!todayRevision,
        total_recitations: db.recitationLogs.filter((r) => r.member_id === m.id || r.reciter_id === m.id).length,
        total_revisions: db.revisionLogs.filter((r) => r.member_id === m.id).length,
        required_quarter: quarterStatus.requiredQuarter,
        is_behind: quarterStatus.isBehind,
        missed_quarters_count: quarterStatus.pastMissedQuartersCount,
        missed_quarters: quarterStatus.pastMissedQuarters,
      };
    });
    return {
      total_members: members.length,
      completed_recitation_count: memberStats.filter((m) => m.has_recited_today).length,
      completed_revision_count: memberStats.filter((m) => m.has_reviewed_today).length,
      pending_recitation_today: memberStats.filter((m) => !m.has_recited_today),
      pending_revision_today: memberStats.filter((m) => !m.has_reviewed_today),
      member_stats: memberStats,
    };
  },

  async getBackendStatus(): Promise<{ backend: string; connected: boolean }> {
    const { error } = await supabase.from('batches').select('id').limit(1);
    return { backend: 'supabase', connected: !error };
  },

  // Peer testing (reads: RLS; everything else: Edge Function peer-tests)
  async getTests(): Promise<{ tests: TestDefinition[]; activeTest: TestDefinition | null }> {
    const [state, auth] = await Promise.all([loadState(), getCurrentAuthUser()]);
    const user = state.users.find((u) => u.id === auth.id);
    const activeTest = activeTestFor(state, user);
    return { tests: user?.role === 'admin' ? state.tests : activeTest ? [activeTest] : [], activeTest };
  },

  async adminSaveTest(payload: Partial<TestDefinition>): Promise<{ success: boolean; message: string; test: TestDefinition }> {
    return invokeFunction('peer-tests', { action: 'admin-save', ...payload }, 'فشل حفظ الاختبار، يرجى المحاولة ثانية.');
  },

  async adminToggleTestStatus(id: string, is_active: boolean): Promise<{ success: boolean; message: string; test: TestDefinition }> {
    return invokeFunction('peer-tests', { action: 'admin-status', test_id: id, is_active }, 'فشل تعديل حالة الاختبار، يرجى المحاولة ثانية.');
  },

  async adminFinishTest(id: string): Promise<{ success: boolean; message: string; test: TestDefinition }> {
    return invokeFunction('peer-tests', { action: 'admin-finish', test_id: id }, 'فشل إنهاء الاختبار، يرجى المحاولة ثانية.');
  },

  async adminPreviewTestQuestions(testId: string): Promise<{ test_id: string; questions: TestQuestion[] }> {
    return invokeFunction('peer-tests', { action: 'admin-preview', test_id: testId }, 'تعذر توليد عيّنة الأسئلة.');
  },

  async adminGetTestImpact(testId: string): Promise<{
    test_id: string;
    test_type: 'mandatory' | 'recommended';
    range_start: number;
    range_end: number;
    blocked_count: number;
    blocked_members: { id: string; name: string }[];
  }> {
    return invokeFunction('peer-tests', { action: 'admin-impact', test_id: testId }, 'تعذر حساب أثر الاختبار.');
  },

  async getEligibleCandidates(testId: string): Promise<{
    test: TestDefinition;
    candidates: {
      id: string;
      name: string;
      phone: string;
      is_eligible: boolean;
      ineligibility_reasons: string[];
      has_passed: boolean;
      attempts_count: number;
      effective_range_end?: number;
      covers_full_range?: boolean;
    }[];
  }> {
    return invokeFunction('peer-tests', { action: 'candidates', test_id: testId }, 'تعذر تحميل قائمة المرشحين.');
  },

  async generateTestQuestions(testId: string, candidateId?: string): Promise<{ test_id: string; effective_range_end?: number; questions: TestQuestion[] }> {
    return invokeFunction('peer-tests', { action: 'generate', test_id: testId, candidate_id: candidateId }, 'تعذر توليد الأسئلة.');
  },

  async recordTestAttempt(payload: {
    test_id: string;
    candidate_id: string;
    questions_results: { start_surah: number; start_ayah: number; end_surah: number; end_ayah: number; errors_count: number; notes?: string }[];
    notes?: string;
  }): Promise<{ success: boolean; message: string; attempt: TestAttempt }> {
    return invokeFunction('peer-tests', { action: 'submit', ...payload }, 'فشل حفظ نتيجة الاختبار، يرجى المحاولة ثانية.');
  },

  async getTestAttempts(params?: { test_id?: string; candidate_id?: string; examiner_id?: string }): Promise<{ attempts: TestAttempt[] }> {
    // RLS returns everything to admins and only their own attempts to members.
    let attempts = [...(await loadState()).testAttempts];
    if (params?.test_id) attempts = attempts.filter((a) => a.test_id === params.test_id);
    if (params?.candidate_id) attempts = attempts.filter((a) => a.candidate_id === params.candidate_id);
    if (params?.examiner_id) attempts = attempts.filter((a) => a.examiner_id === params.examiner_id);
    return { attempts };
  },

  // Personal self-tests (generation: Edge Function; storage: owner-only RLS + RPC)
  async personalTestSurahs(): Promise<{ surahs: { number: number; name: string; ayah_count: number }[] }> {
    const meta = await this.personalTestMeta();
    return { surahs: meta.surahs };
  },

  async personalTestMeta(): Promise<{
    surahs: { number: number; name: string; ayah_count: number }[];
    juzList: {
      juz: number;
      start_surah: number;
      start_surah_name: string;
      start_ayah: number;
      end_surah: number;
      end_surah_name: string;
      end_ayah: number;
      label: string;
    }[];
    quartersList: { quarter: number; juz: number; surahName: string; ayahNumber: number; label: string }[];
  }> {
    return invokeFunction('peer-tests', { action: 'personal-meta' }, 'تعذّر تحميل بيانات نطاقات الاختبار');
  },

  async personalTestGenerate(setup: {
    range_type?: 'surah' | 'juz' | 'quarter';
    start_surah?: number;
    end_surah?: number;
    start_juz?: number;
    end_juz?: number;
    start_quarter?: number;
    end_quarter?: number;
    questions_count: number;
    lines_per_question: number;
    difficulty: string;
  }): Promise<{ questions: TestQuestion[]; points_per_error: number; range_label?: string }> {
    const result = await invokeFunction<{ questions: TestQuestion[]; points_per_error: number; range_label: string; setup: Record<string, unknown> }>(
      'peer-tests',
      { action: 'personal-generate', ...setup },
      'تعذّر توليد الأسئلة'
    );
    lastPersonalTest = { setup: result.setup, questions: result.questions };
    return result;
  },

  async personalTestSave(payload: any): Promise<{ success: boolean; record: any }> {
    const generated = lastPersonalTest;
    const results: any[] = Array.isArray(payload?.questions_results) ? payload.questions_results : [];
    if (!generated || results.length !== generated.questions.length) throw new Error('عدد الأسئلة المرسلة لا يطابق عدد أسئلة الاختبار');
    const questions = generated.questions.map((q, i) => ({
      start_surah: q.start_surah,
      start_surah_name: q.start_surah_name,
      start_ayah: q.start_ayah,
      end_surah: q.end_surah,
      end_surah_name: q.end_surah_name,
      end_ayah: q.end_ayah,
      errors_count: Number(results[i]?.errors_count),
      difficulty_level: q.difficulty_level,
    }));
    const { data: id, error } = await supabase.rpc('men_save_personal_test', {
      p_test: { ...generated.setup, notes: payload?.notes || '', date: today(), questions },
    });
    if (error) throw dbError(error, 'تعذّر حفظ نتيجة اختبارك الشخصي، يرجى المحاولة مرة أخرى.');
    lastPersonalTest = null;
    const history = await this.personalTestHistory();
    return { success: true, record: history.records.find((r: any) => r.id === id) };
  },

  async personalTestHistory(): Promise<{ records: any[]; stats: { count: number; average: number; best: number } }> {
    const user = await getCurrentAuthUser();
    const { data, error } = await supabase
      .from('personal_tests')
      .select(
        'id, member_id, range_type, range_label, start_juz, end_juz, start_quarter, end_quarter, start_surah, start_surah_name, end_surah, end_surah_name, questions_count, lines_per_question, difficulty, total_errors, grade, grade_label, notes, date, created_at, questions:personal_test_questions(question_number, start_surah, start_surah_name, start_ayah, end_surah, end_surah_name, end_ayah, errors_count, grade, difficulty_level)'
      )
      .eq('member_id', user.id)
      .order('created_at', { ascending: false });
    if (error) throw dbError(error, 'تعذّر تحميل سجل اختباراتك الشخصية.');
    const all = (data || []).map((r: any) => {
      const record: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) if (v !== null) record[k] = v;
      record.grade = Number(r.grade);
      record.created_at = new Date(r.created_at).toISOString();
      record.questions = [...(r.questions || [])]
        .sort((a: any, b: any) => a.question_number - b.question_number)
        .map((q: any) => {
          const { difficulty_level, ...rest } = q;
          return { ...rest, grade: Number(q.grade), ...(difficulty_level ? { difficulty_level } : {}) };
        });
      return record;
    });
    const grades = all.map((r) => r.grade as number);
    return {
      records: all.slice(0, 100),
      stats: {
        count: all.length,
        average: all.length ? Math.round(grades.reduce((a, g) => a + g, 0) / all.length) : 0,
        best: all.length ? Math.max(...grades) : 0,
      },
    };
  },

  async personalTestDelete(id: string): Promise<{ success: boolean }> {
    const { data, error } = await supabase.from('personal_tests').delete().eq('id', id).select('id');
    if (error) throw dbError(error, 'تعذّر حذف السجل.');
    if (!data?.length) throw new Error('السجل غير موجود');
    return { success: true };
  },
};
