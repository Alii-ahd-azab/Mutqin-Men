import {
  User,
  Batch,
  AdminAccount,
  AdminAccountUpdate,
  NewAccountPayload,
  BatchBootstrap,
  RecitationLog,
  RevisionLog,
  PeerTest,
  PeerTestAttempt,
  PeerTestAttemptQuestion,
  PeerTestCandidate,
  PeerTestQuestion,
  PeerTestSaveInput,
  DistantReviewAssignment,
  DistantReviewInput,
} from '../types';
import { supabase } from '../lib/supabase';
import { programDate, calculateCycleInfo } from '../lib/calculations';
import { phoneToAuthEmail } from '../lib/authHelpers';
import { loadActiveCycle, loadProgram } from '../../supabase/functions/_shared/men/menData.ts';
import { computeBatchDelays } from '../../supabase/functions/_shared/men/batchDelays.ts';
import { buildBatchAdminAlerts, type BatchAdminAlert } from '../lib/notifications';
import { mapUser, PROFILE_COLUMNS, type ProfileRow } from '../../supabase/functions/_shared/men/menRows.ts';

/*
 * Mutqin for Men data layer — same architecture and API as Mutqin for Sisters:
 *   reads          → supabase-js under Row Level Security, one batch at a time
 *   simple writes  → direct inserts/updates checked by RLS and database guards
 *   multi-step     → RPCs (SECURITY DEFINER functions that check the caller)
 *   privileged     → Edge Functions (admin-users, admin-actions, peer-tests)
 * Men rows are mapped by the shared Men loader (date-based reviews, legacy order, undated paused
 * days), and Men extras (past pause periods, revision backfill) are kept.
 */

type BatchRow = {
  id: string;
  name: string;
  created_at: string;
  archived_at: string | null;
};

const BATCH_COLUMNS = 'id, name, created_at, archived_at';

type EdgeFunction = 'admin-users' | 'admin-actions' | 'peer-tests';

/* Calls an Edge Function and surfaces the server's Arabic error message. */
async function invokeFunction<T>(name: EdgeFunction, body: Record<string, unknown>, fallbackMessage: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
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

// The program date: changes at 05:00 Africa/Cairo, whatever the device's time zone.
const today = () => programDate();

function distantReviewBody(payload: DistantReviewInput) {
  const start = Number(payload.start_quarter);
  const end = Number(payload.end_quarter);
  if (!payload.review_date || !/^\d{4}-\d{2}-\d{2}$/.test(payload.review_date)) throw new Error('يرجى تحديد تاريخ المراجعة البعيدة');
  // «إلى الربع» is the stopping boundary (the beginning of that quarter): it must come after «من الربع».
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 240 || start >= end) {
    throw new Error('نطاق الأرباع غير صالح: «إلى الربع» هو موضع التوقف (بداية ذلك الربع)، فيجب أن يكون بعد «من الربع» وضمن 1–240.');
  }
  return { review_date: payload.review_date, start_quarter: start, end_quarter: end, note: (payload.note || '').trim() };
}

function requireBatchId(batchId: string | undefined | null): string {
  if (!batchId) throw new Error('يرجى اختيار الدفعة أولاً');
  return batchId;
}

const ROWS_PAGE_SIZE = 1000;

/* PostgREST returns at most 1000 rows per request: read in pages until the last (short) page. */
async function fetchAllRows<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += ROWS_PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + ROWS_PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...((data || []) as T[]));
    if (!data || data.length < ROWS_PAGE_SIZE) return rows;
  }
}

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

async function getBatch(batchId: string): Promise<Batch> {
  const { data, error } = await supabase.from('batches').select(BATCH_COLUMNS).eq('id', batchId).maybeSingle();
  if (error) throw error;
  // RLS hides batches the caller cannot access, so "not found" also means "not authorized".
  if (!data) throw new Error('لا تملك صلاحية الوصول لهذه الدفعة');
  return data as BatchRow;
}

/*
 * Peer tests of one cycle. RLS returns all of them to the batch's admins and only the LIVE one(s)
 * of their audience to the batch's members. Men: each test carries its selected members.
 */
async function getPeerTestsForCycle(cycleId: string): Promise<PeerTest[]> {
  const { data, error } = await supabase.from('peer_tests').select('*').eq('cycle_id', cycleId).order('created_at', { ascending: false });
  if (error) throw error;
  const tests = (data || []) as Omit<PeerTest, 'selected_member_ids'>[];
  const selectedByTest = new Map<string, string[]>();
  if (tests.length) {
    const rows = await fetchAllRows<{ test_id: string; user_id: string }>((from, to) =>
      supabase
        .from('peer_test_selected_members')
        .select('test_id, user_id')
        .in('test_id', tests.map((t) => t.id))
        .order('position', { ascending: true })
        .range(from, to)
    );
    for (const row of rows) {
      const list = selectedByTest.get(row.test_id) || [];
      list.push(row.user_id);
      selectedByTest.set(row.test_id, list);
    }
  }
  return tests.map((t) => ({ ...t, selected_member_ids: selectedByTest.get(t.id) || [] }));
}

async function getPeerTestAttemptsForTests(testIds: string[]): Promise<PeerTestAttempt[]> {
  if (testIds.length === 0) return [];
  return fetchAllRows<PeerTestAttempt>((from, to) =>
    supabase
      .from('peer_test_attempts')
      .select('*')
      .in('test_id', testIds)
      .neq('status', 'cancelled')
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, to)
  );
}

/* Loads everything one batch's dashboard needs, in a single pass. */
async function buildBootstrap(batchId: string): Promise<BatchBootstrap> {
  const [batch, program] = await Promise.all([getBatch(batchId), loadProgram(supabase, batchId)]);
  const peerTests = await getPeerTestsForCycle(program.cycle.id);
  const peerTestAttempts = await getPeerTestAttemptsForTests(peerTests.map((t) => t.id));
  const todayStr = today();
  // Newest first, as the dashboards list them.
  const byNewest = <T extends { created_at: string }>(rows: T[]) =>
    [...rows].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const recitations = byNewest(program.recitationLogs);
  const revisions = byNewest(program.revisionLogs);
  return {
    batch,
    cycle_id: program.cycle.id,
    cycleInfo: calculateCycleInfo(program.settings, program.restDays, todayStr),
    settings: program.settings,
    restDays: program.restDays,
    users: program.users,
    recitations,
    revisions,
    todayRecitations: recitations.filter((r) => r.date === todayStr),
    todayRevisions: revisions.filter((r) => r.date === todayStr),
    distantReviews: program.distantReviews,
    distantCompletions: program.distantCompletions,
    peerTests,
    peerTestAttempts,
  };
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

export const api = {
  // ============ AUTH ============
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

  // ============ BATCHES & BOOTSTRAP ============

  /*
   * Batches the current user may open. RLS decides: master admins get all, batch admins their
   * assigned ones, members their single batch.
   */
  async getAccessibleBatches(): Promise<{ batches: Batch[] }> {
    const { data, error } = await supabase.from('batches').select(BATCH_COLUMNS).is('archived_at', null).order('created_at', { ascending: true });
    if (error) throw error;
    return { batches: (data || []) as BatchRow[] };
  },

  async getBootstrap(params: { batch_id: string }): Promise<BatchBootstrap> {
    return buildBootstrap(requireBatchId(params.batch_id));
  },

  async getRecitations(params: { batch_id: string; member_id?: string; reciter_id?: string; date?: string }): Promise<{ recitations: RecitationLog[] }> {
    let recitations = (await buildBootstrap(requireBatchId(params.batch_id))).recitations;
    const memberId = params.member_id || params.reciter_id;
    if (memberId) recitations = recitations.filter((r) => r.member_id === memberId);
    if (params.date) recitations = recitations.filter((r) => r.date === params.date);
    return { recitations };
  },

  async getRevisions(params: { batch_id: string; member_id?: string; date?: string }): Promise<{ revisions: RevisionLog[] }> {
    let revisions = (await buildBootstrap(requireBatchId(params.batch_id))).revisions;
    if (params.member_id) revisions = revisions.filter((r) => r.member_id === params.member_id);
    if (params.date) revisions = revisions.filter((r) => r.date === params.date);
    return { revisions };
  },

  // ============ RECITATION & REVISION ============

  async recordRecitation(
    batchId: string,
    payload: { quarter_number: number; listener_id: string; notes?: string; date?: string }
  ): Promise<{ message: string }> {
    const [cycle, user] = await Promise.all([loadActiveCycle(supabase, requireBatchId(batchId)), getCurrentAuthUser()]);
    const notes = payload.notes && String(payload.notes).trim() ? String(payload.notes).trim() : null;
    // Order, listener, mandatory-test and account rules are enforced by the database guard.
    const { error } = await supabase.from('tasmia_submissions').insert({
      cycle_id: cycle.id,
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

  /*
   * The member's one listener correction (within 12 hours of submitting). All rules are checked
   * by the database function; only the listener changes.
   */
  async correctRecitationListener(
    submissionId: string,
    newListenerId: string
  ): Promise<{ id: string; listener_id: string; listener_name_snapshot: string; listener_changed_at: string }> {
    const { data, error } = await supabase.rpc('correct_tasmia_listener', {
      p_submission_id: submissionId,
      p_new_listener_id: newListenerId,
    });
    if (error) throw dbError(error, 'تعذر تعديل المستمع');
    return data;
  },

  async recordRevision(batchId: string, payload: { notes?: string; date?: string }): Promise<{ message: string; already_recorded?: boolean }> {
    const [cycle, user] = await Promise.all([loadActiveCycle(supabase, requireBatchId(batchId)), getCurrentAuthUser()]);
    const todayStr = today();
    const date = payload.date && /^\d{4}-\d{2}-\d{2}$/.test(payload.date) ? payload.date : todayStr;
    const notes = payload.notes && String(payload.notes).trim() ? String(payload.notes).trim() : null;
    // Men: reviews are date-based; the quarters are computed by the database guard.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data, error } = await supabase
        .from('review_confirmations')
        .insert({ cycle_id: cycle.id, user_id: user.id, notes, legacy_date: date })
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

  // ============ ACCOUNTS (Edge Function admin-users) ============

  async adminAddMember(payload: NewAccountPayload): Promise<{ user: User; message: string }> {
    if (!payload.name?.trim() || !payload.phone?.trim() || !payload.password?.trim()) throw new Error('الاسم ورقم الهاتف وكلمة المرور مطلوبة');
    if (payload.password.trim().length < 6) throw new Error('يجب ألا تقل كلمة المرور عن 6 خانات');
    if (payload.role === 'member' && !payload.batch_id) throw new Error('يرجى اختيار دفعة العضو');
    if (payload.role === 'admin' && !payload.is_master_admin && (!payload.batch_ids || payload.batch_ids.length === 0)) {
      throw new Error('يرجى اختيار دفعة واحدة على الأقل لمشرف الدفعة');
    }
    return invokeFunction('admin-users', { action: 'create', ...payload }, 'فشل حفظ بيانات الحساب الجديد، يرجى المحاولة ثانية.');
  },

  /*
   * ALL account changes (name, phone, password, active/excluded, master flag, batch assignments,
   * Men member <-> admin switch) go through the Edge Function, which verifies that the caller
   * manages this account. The browser has no UPDATE access to profiles.
   */
  async adminUpdateMember(id: string, payload: AdminAccountUpdate): Promise<{ user: User; message: string }> {
    if (payload.password && payload.password.trim() && payload.password.trim().length < 6) {
      throw new Error('يجب ألا تقل كلمة المرور عن 6 خانات');
    }
    if (payload.batch_ids !== undefined && payload.batch_ids.length === 0) throw new Error('يرجى اختيار دفعة واحدة على الأقل');
    return invokeFunction('admin-users', { action: 'update', user_id: id, ...payload }, 'فشل تحديث بيانات الحساب، يرجى المحاولة مرة أخرى.');
  },

  async adminDeleteMemberCompletely(id: string): Promise<{ success: boolean; message: string }> {
    return invokeFunction('admin-users', { action: 'delete', user_id: id }, 'فشل حذف الحساب وسجلاته، يرجى المحاولة مرة أخرى.');
  },

  /* Master admin only: every admin account with its batch assignments. */
  async adminListAdmins(): Promise<{ admins: AdminAccount[] }> {
    const [profilesResult, membershipsResult] = await Promise.all([
      supabase.from('profiles').select(PROFILE_COLUMNS).eq('role', 'admin').order('created_at', { ascending: true }),
      supabase.from('batch_memberships').select('user_id, batch_id').eq('membership_role', 'admin'),
    ]);
    if (profilesResult.error) throw profilesResult.error;
    if (membershipsResult.error) throw membershipsResult.error;
    const batchesByUser = new Map<string, string[]>();
    for (const row of (membershipsResult.data || []) as { user_id: string; batch_id: string }[]) {
      const list = batchesByUser.get(row.user_id) || [];
      list.push(row.batch_id);
      batchesByUser.set(row.user_id, list);
    }
    return {
      admins: ((profilesResult.data || []) as ProfileRow[]).map((row) => ({
        user: mapUser(row),
        is_master_admin: !!row.is_master_admin,
        batch_ids: batchesByUser.get(row.id) || [],
      })),
    };
  },

  /*
   * Moves a member to another batch. The server determines his current batch, checks permissions
   * on both batches and moves only his current membership.
   */
  async adminMoveMemberBatch(userId: string, destinationBatchId: string): Promise<{ success: boolean; message: string }> {
    if (!destinationBatchId) throw new Error('يرجى اختيار الدفعة الجديدة');
    return invokeFunction(
      'admin-users',
      { action: 'move-member-batch', user_id: userId, destination_batch_id: destinationBatchId },
      'تعذر نقل العضو. حاول مرة أخرى.'
    );
  },

  async adminSetAdminBatches(userId: string, batchIds: string[]): Promise<{ message: string }> {
    if (batchIds.length === 0) throw new Error('يرجى اختيار دفعة واحدة على الأقل');
    return invokeFunction('admin-users', { action: 'set-admin-batches', user_id: userId, batch_ids: batchIds }, 'تعذر تحديث صلاحيات المشرف.');
  },

  // ============ BATCH PROGRAM (direct RLS writes, as in Sisters) ============

  async adminCreateBatch(payload: { name: string; start_date: string }): Promise<{ batch: Batch; message: string }> {
    if (!payload.name.trim()) throw new Error('اسم الدفعة مطلوب');
    if (!payload.start_date) throw new Error('تاريخ البداية مطلوب');
    return invokeFunction(
      'admin-actions',
      { action: 'create-batch', name: payload.name.trim(), start_date: payload.start_date },
      'تعذر إنشاء الدفعة. حاول مرة أخرى.'
    );
  },

  /* Master admin: any batch; batch admin: an assigned batch only (checked by admin-actions). */
  async adminRenameBatch(batchId: string, name: string): Promise<{ batch: Batch; message: string }> {
    const clean = String(name || '').replace(/\s+/g, ' ').trim();
    if (!clean) throw new Error('اسم الدفعة مطلوب');
    if (clean.length > 60) throw new Error('اسم الدفعة طويل جدًا (60 حرفًا كحد أقصى)');
    return invokeFunction(
      'admin-actions',
      { action: 'rename-batch', batch_id: requireBatchId(batchId), name: clean },
      'تعذر تعديل اسم الدفعة. حاول مرة أخرى.'
    );
  },

  async adminAddRestDay(batchId: string, payload: { date: string; note: string }): Promise<{ message: string }> {
    if (!payload.date || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) throw new Error('يرجى تحديد تاريخ صحيح ليوم الاستدراك والراحة (YYYY-MM-DD)');
    const [cycle, profile] = await Promise.all([loadActiveCycle(supabase, requireBatchId(batchId)), getCurrentProfile()]);
    const { error } = await supabase.from('group_rest_days').insert({
      cycle_id: cycle.id,
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

  /*
   * «المراجعة البعيدة»: one manually chosen day per call (no recurrence). admin-actions checks the
   * batch; the database allows only future dates and refuses a date that is a rest day.
   */
  async adminCreateDistantReview(batchId: string, payload: DistantReviewInput): Promise<{ assignment: DistantReviewAssignment; message: string }> {
    return invokeFunction(
      'admin-actions',
      { action: 'distant-review-create', batch_id: requireBatchId(batchId), ...distantReviewBody(payload) },
      'تعذر إضافة يوم المراجعة البعيدة. حاول مرة أخرى.'
    );
  },

  async adminUpdateDistantReview(assignmentId: string, payload: DistantReviewInput): Promise<{ message: string }> {
    return invokeFunction(
      'admin-actions',
      { action: 'distant-review-update', assignment_id: assignmentId, ...distantReviewBody(payload) },
      'تعذر تعديل يوم المراجعة البعيدة. حاول مرة أخرى.'
    );
  },

  async adminDeleteDistantReview(assignmentId: string): Promise<{ message: string }> {
    return invokeFunction(
      'admin-actions',
      { action: 'distant-review-delete', assignment_id: assignmentId },
      'تعذر حذف يوم المراجعة البعيدة. حاول مرة أخرى.'
    );
  },

  /* Member: confirm one owed distant review (identity: assignment + member; idempotent). */
  async completeDistantReview(assignmentId: string): Promise<{ message: string; already_recorded: boolean }> {
    const { data, error } = await supabase.rpc('men_complete_distant_review', { p_assignment_id: assignmentId });
    if (error) throw dbError(error, 'تعذر حفظ إتمام المراجعة البعيدة. حاول مرة أخرى.');
    return data?.already_recorded
      ? { message: 'تم تأكيد هذه المراجعة البعيدة مسبقًا.', already_recorded: true }
      : { message: 'تم تسجيل إتمام المراجعة البعيدة بنجاح، تقبل الله منك.', already_recorded: false };
  },

  async adminDeleteRestDay(id: string): Promise<{ success: boolean; message: string }> {
    const { data, error } = await supabase.from('group_rest_days').delete().eq('id', id).select('id');
    if (error) throw dbError(error, 'فشل حذف يوم الاستدراك، يرجى المحاولة ثانية.');
    if (!data?.length) throw new Error('يوم الاستدراك غير موجود');
    return { success: true, message: 'تم حذف يوم الاستدراك والراحة' };
  },

  async adminPause(batchId: string): Promise<{ message: string }> {
    const [program, profile] = await Promise.all([loadProgram(supabase, requireBatchId(batchId)), getCurrentProfile()]);
    if (program.settings.is_paused) return { message: 'البرنامج متوقف مؤقتًا بالفعل.' };
    const { error } = await supabase.from('program_pauses').insert({ cycle_id: program.cycle.id, paused_on: today(), created_by: profile.id });
    if (error) {
      if (error.code === '23505') return { message: 'البرنامج متوقف مؤقتًا بالفعل.' };
      throw dbError(error, 'فشل حفظ تفعيل الإيقاف المؤقت، يرجى المحاولة ثانية.');
    }
    return { message: 'تم تفعيل الإيقاف المؤقت للبرنامج وتجميد عداد الدورة لجميع الأعضاء بنجاح.' };
  },

  async adminResume(batchId: string): Promise<{ message: string }> {
    const cycle = await loadActiveCycle(supabase, requireBatchId(batchId));
    // The resume day is active; resuming on the pause day records no paused period.
    const { data, error } = await supabase
      .from('program_pauses')
      .update({ resumed_on: today() })
      .eq('cycle_id', cycle.id)
      .is('resumed_on', null)
      .select('id');
    if (error) throw dbError(error, 'فشل حفظ استئناف البرنامج، يرجى المحاولة ثانية.');
    if (!data?.length) return { message: 'البرنامج غير متوقف حاليًا.' };
    return { message: 'تم استئناف البرنامج بنجاح ومواصلة الدورة.' };
  },

  /* Men: records a finished pause period in the past (both ends inclusive). */
  async adminAddPausePeriod(batchId: string, from: string, to: string): Promise<{ message: string }> {
    const cycle = await loadActiveCycle(supabase, requireBatchId(batchId));
    const { error } = await supabase.rpc('men_add_past_pause_period', { p_cycle_id: cycle.id, p_from: from, p_to: to });
    if (error) throw dbError(error, 'فشل حفظ فترة الإيقاف. حاول مرة أخرى.');
    return { message: 'تم تسجيل فترة الإيقاف.' };
  },

  /* Men: adds the missing revision records of the batch up to a date (idempotent). */
  async adminBackfillRevisions(batchId: string, until: string): Promise<{ created: number; message: string }> {
    const cycle = await loadActiveCycle(supabase, requireBatchId(batchId));
    const { data, error } = await supabase.rpc('men_backfill_revisions', { p_cycle_id: cycle.id, p_until: until });
    if (error) throw dbError(error, 'تعذر حفظ السجلات الناقصة. أعد المحاولة (آمنة ولا تكرر).');
    const created = Number(data) || 0;
    return { created, message: `تمت إضافة ${created} سجل مراجعة ناقص حتى ${until}.` };
  },

  async adminUpdateSettings(batchId: string, payload: { start_date?: string }): Promise<{ message: string }> {
    const cycle = await loadActiveCycle(supabase, requireBatchId(batchId));
    if (payload.start_date && /^\d{4}-\d{2}-\d{2}$/.test(payload.start_date)) {
      const { data, error } = await supabase.from('cycles').update({ starts_on: payload.start_date }).eq('id', cycle.id).select('id');
      if (error) throw dbError(error, 'فشل حفظ إعدادات المجموعة، يرجى المحاولة ثانية.');
      if (!data?.length) throw new Error('هذا الإجراء مخصص للمشرف فقط');
    }
    return { message: 'تم تحديث إعدادات المجموعة بنجاح' };
  },

  async adminUpdateDailyThought(batchId: string, payload: { daily_thought: string }): Promise<{ message: string }> {
    const id = requireBatchId(batchId);
    const profile = await getCurrentProfile();
    const clean = sanitizeThought(payload.daily_thought || '');
    const { error } = clean
      ? await supabase.from('daily_thoughts').insert({
          batch_id: id,
          content_html: clean,
          published_by: profile.id,
          published_by_name_snapshot: profile.full_name.trim(),
          is_published: true,
        })
      : // Saving an empty thought hides it.
        await supabase.from('daily_thoughts').update({ is_published: false }).eq('batch_id', id).eq('is_published', true);
    if (error) throw dbError(error, 'فشل حفظ ونشر خاطرة اليوم، يرجى المحاولة ثانية.');
    return { message: 'تم حفظ ونشر خاطرة اليوم بنجاح لجميع الأعضاء' };
  },

  async adminDeleteDailyThought(batchId: string): Promise<{ message: string }> {
    const id = requireBatchId(batchId);
    const { error } = await supabase.from('daily_thoughts').update({ is_published: false }).eq('batch_id', id).eq('is_published', true);
    if (error) throw dbError(error, 'فشل حذف خاطرة اليوم، يرجى المحاولة ثانية.');
    return { message: 'تم حذف خاطرة اليوم بالكامل ولن تظهر في لوحة الأعضاء' };
  },

  /* Archives the selected batch's active cycle (history kept) and starts the next one. Other batches are never touched. */
  async adminFactoryReset(batchId: string, cycleId?: string): Promise<{ success: boolean; message: string }> {
    const data = await invokeFunction<{ message?: string }>(
      'admin-actions',
      { action: 'factory-reset', batch_id: requireBatchId(batchId), cycle_id: cycleId },
      'تعذر بدء دورة جديدة. حاول مرة أخرى.'
    );
    return { success: true, message: data?.message || 'تم بدء دورة جديدة' };
  },

  // ============ PEER TESTING ============
  // Reads use RLS; every write goes through the peer-tests Edge Function, which re-checks all rules.

  async getPeerTests(cycleId: string): Promise<{ tests: PeerTest[] }> {
    return { tests: await getPeerTestsForCycle(cycleId) };
  },

  async getPeerTestAttempts(testIds: string[]): Promise<{ attempts: PeerTestAttempt[] }> {
    return { attempts: await getPeerTestAttemptsForTests(testIds) };
  },

  async getPeerTestAttemptQuestions(attemptId: string): Promise<{ questions: PeerTestAttemptQuestion[] }> {
    const { data, error } = await supabase
      .from('peer_test_attempt_questions')
      .select('*')
      .eq('attempt_id', attemptId)
      .order('question_number', { ascending: true });
    if (error) throw error;
    return { questions: (data || []) as PeerTestAttemptQuestion[] };
  },

  async peerTestCandidates(testId: string): Promise<{ candidates: PeerTestCandidate[] }> {
    return invokeFunction('peer-tests', { action: 'candidates', test_id: testId }, 'تعذر تحميل قائمة الزملاء.');
  },

  async peerTestStart(testId: string, candidateId: string): Promise<{
    attempt_id: string;
    candidate: { id: string; name: string };
    effective_range_end: number;
    covers_full_range: boolean;
    questions: PeerTestQuestion[];
  }> {
    return invokeFunction('peer-tests', { action: 'start', test_id: testId, candidate_id: candidateId }, 'تعذر بدء الاختبار.');
  },

  async peerTestSubmit(payload: {
    attempt_id: string;
    errors: number[];
    question_notes: string[];
    notes?: string;
  }): Promise<{ attempt: PeerTestAttempt; message: string }> {
    return invokeFunction('peer-tests', { action: 'submit', ...payload }, 'تعذر اعتماد نتيجة الاختبار.');
  },

  async adminSavePeerTest(payload: PeerTestSaveInput): Promise<{ test: PeerTest; versioned: boolean; message: string }> {
    return invokeFunction('peer-tests', { action: 'admin-save', ...payload }, 'تعذر حفظ الاختبار.');
  },

  async adminSetPeerTestStatus(testId: string, statusAction: 'show' | 'hide' | 'finish'): Promise<{ test: PeerTest; message: string }> {
    return invokeFunction('peer-tests', { action: 'admin-status', test_id: testId, status_action: statusAction }, 'تعذر تحديث حالة الاختبار.');
  },

  async adminPreviewPeerTest(testId: string): Promise<{ questions: PeerTestQuestion[] }> {
    return invokeFunction('peer-tests', { action: 'admin-preview', test_id: testId }, 'تعذر توليد عيّنة الأسئلة.');
  },

  /*
   * Batch admin: serious alerts (3+ overdue days) of the given batches, computed from each batch's
   * program state with the shared delay code. RLS returns only batches he manages, so another
   * batch yields no data and no alert.
   */
  async getBatchAdminAlerts(batches: Pick<Batch, 'id' | 'name'>[]): Promise<BatchAdminAlert[]> {
    const day = today();
    const lists = await Promise.all(
      batches.map(async (b) => {
        try {
          const program = await loadProgram(supabase, b.id);
          const { members, delayById } = computeBatchDelays(program, day);
          return buildBatchAdminAlerts(b, members, delayById);
        } catch {
          return []; // a batch without an active cycle has no alerts
        }
      })
    );
    return lists.flat();
  },

  async adminPeerTestImpact(testId: string): Promise<{ blocked_count: number; blocked_members: { id: string; name: string }[] }> {
    return invokeFunction('peer-tests', { action: 'admin-impact', test_id: testId }, 'تعذر حساب أثر الاختبار.');
  },
};
