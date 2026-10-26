import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import {
  corsHeaders,
  json,
  HttpError,
  isUuid,
  createAdminClient,
  getActiveCaller,
  canManageBatch,
  errorResponse,
  type ActiveCaller,
} from '../_shared/auth.ts';
import {
  calculateCycleInfo,
  calculateMemberRevisionStatus,
  getActiveCycleDates,
  joinedOnDateFromTimestamp,
} from '../_shared/logic/calculations.ts';
import { computeMemberDelayStatus, type MemberDelayStatus } from '../_shared/logic/memberDelayStatus.ts';
import { loadProgram, type ProgramState } from '../_shared/men/menData.ts';
import { estimateRangeLines, generateTestQuestions, type TestQuestion } from '../_shared/peer-tests/testGenerator.ts';
import {
  evaluateCandidate,
  isInAudience,
  isPeerTestLive,
  nextTasmiaQuarter,
  type CandidateEvaluation,
  type PassedAttempt,
  type PeerTestRow,
} from '../_shared/peer-tests/eligibility.ts';
import { RuleError, parsePersonalSetup, generatePersonalQuestions, personalMeta } from '../_shared/peer-tests/personalTests.ts';

/*
 * PEER TESTING (الاختبارات المتبادلة) + personal self-test generation.
 *
 * Same flow as Mutqin for Sisters: members (examiners) and admins call this function; it re-checks
 * every rule server-side and writes only through service-role-only database functions; pass/fail
 * is computed in SQL from the stored questions. Men rules on top: selected-audience tests, the
 * two prerequisite flags, partial ranges, and the Men program calendar (date-based reviews,
 * undated paused days) through the shared Men program loader.
 */

type CycleRow = {
  id: string;
  batch_id: string;
  cycle_number: number;
  starts_on: string;
  status: string;
};

type BatchMember = {
  id: string;
  name: string;
};

type BatchProgress = {
  today: string;
  quarterOfDay: number;
  members: BatchMember[];
  delayById: Map<string, MemberDelayStatus>;
  completedById: Map<string, Set<number>>;
  program: ProgramState;
  activeDates: string[];
};

// The halaqah runs on Makkah time.
function programToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function toInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

async function loadTest(admin: SupabaseClient, testId: unknown): Promise<{ test: PeerTestRow; cycle: CycleRow; selected: Set<string> }> {
  if (!isUuid(testId)) throw new HttpError('معرف الاختبار غير صالح', 400);

  const { data: test, error } = await admin.from('peer_tests').select('*').eq('id', testId).maybeSingle();
  if (error) throw new HttpError(error.message, 500);
  if (!test) throw new HttpError('الاختبار غير موجود', 404);

  const [cycleRes, selectedRes] = await Promise.all([
    admin.from('cycles').select('id, batch_id, cycle_number, starts_on, status').eq('id', test.cycle_id).single(),
    admin.from('peer_test_selected_members').select('user_id').eq('test_id', test.id),
  ]);
  if (cycleRes.error || !cycleRes.data) throw new HttpError('دورة الاختبار غير موجودة', 404);
  if (selectedRes.error) throw new HttpError(selectedRes.error.message, 500);

  return {
    test: test as PeerTestRow,
    cycle: cycleRes.data as CycleRow,
    selected: new Set((selectedRes.data || []).map((r) => r.user_id as string)),
  };
}

async function loadActiveCycle(admin: SupabaseClient, batchId: string): Promise<CycleRow> {
  const { data, error } = await admin
    .from('cycles')
    .select('id, batch_id, cycle_number, starts_on, status')
    .eq('batch_id', batchId)
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw new HttpError(error.message, 500);
  if (!data) throw new HttpError('لا توجد دورة نشطة لهذه الدفعة', 400);
  return data as CycleRow;
}

/*
 * Progress of every active member of the cycle's batch, computed with the SAME shared code as the
 * dashboards (Men program loader + computeMemberDelayStatus).
 */
async function loadBatchProgress(admin: SupabaseClient, cycle: CycleRow): Promise<BatchProgress> {
  const program = await loadProgram(admin, cycle.batch_id);
  if (program.cycle.id !== cycle.id) throw new HttpError('دورة هذا الاختبار غير نشطة', 400);

  const today = programToday();
  const cycleInfo = calculateCycleInfo(program.settings, program.restDays, today);
  const activeDates = getActiveCycleDates(program.settings.start_date, today, program.restDays, program.settings);

  const members: BatchMember[] = [];
  const delayById = new Map<string, MemberDelayStatus>();
  const completedById = new Map<string, Set<number>>();
  for (const u of program.users) {
    if (u.role !== 'member' || !u.is_active || !u.batch_joined_at) continue;
    members.push({ id: u.id, name: u.name });
    delayById.set(
      u.id,
      computeMemberDelayStatus({
        memberId: u.id,
        quarterOfDay: cycleInfo.quarter_of_day,
        activeCycleDates: activeDates,
        recitations: program.recitationLogs,
        revisions: program.revisionLogs,
        todayDate: today,
        joinedOnDate: joinedOnDateFromTimestamp(u.batch_joined_at),
      })
    );
    completedById.set(u.id, new Set());
  }
  for (const r of program.recitationLogs) {
    completedById.get(r.member_id)?.add(r.quarter_number);
  }

  return { today, quarterOfDay: cycleInfo.quarter_of_day, members, delayById, completedById, program, activeDates };
}

async function passedAttemptsByCandidate(admin: SupabaseClient, testId: string): Promise<Map<string, PassedAttempt[]>> {
  const { data, error } = await admin
    .from('peer_test_attempts')
    .select('candidate_id, covers_full_range, effective_range_end')
    .eq('test_id', testId)
    .eq('status', 'passed');
  if (error) throw new HttpError(error.message, 500);
  const byCandidate = new Map<string, PassedAttempt[]>();
  for (const row of data || []) {
    const list = byCandidate.get(row.candidate_id) || [];
    list.push({ covers_full_range: row.covers_full_range, effective_range_end: row.effective_range_end });
    byCandidate.set(row.candidate_id, list);
  }
  return byCandidate;
}

function evaluate(
  test: PeerTestRow,
  selected: Set<string>,
  progress: BatchProgress,
  passed: Map<string, PassedAttempt[]>,
  memberId: string
): CandidateEvaluation {
  const revision = test.require_revision_completed
    ? calculateMemberRevisionStatus(
        memberId,
        progress.activeDates,
        progress.program.revisionLogs,
        progress.today,
        joinedOnDateFromTimestamp(progress.program.users.find((u) => u.id === memberId)?.batch_joined_at)
      )
    : undefined;
  return evaluateCandidate({
    test,
    completedQuarters: progress.completedById.get(memberId) || new Set(),
    passedAttempts: passed.get(memberId) || [],
    delay: progress.delayById.get(memberId)!,
    inAudience: isInAudience(test, selected, memberId),
    revision,
  });
}

// Examiner rule: an active member of the test's batch and (Men) of its audience. Elimination
// status is intentionally NOT checked for examiners.
function requireExaminer(caller: ActiveCaller, cycle: CycleRow, test: PeerTestRow, selected: Set<string>) {
  if (caller.role !== 'member' || caller.memberBatchId !== cycle.batch_id) {
    throw new HttpError('الاختبارات المتبادلة متاحة لأعضاء هذه الدفعة فقط', 403);
  }
  if (cycle.status !== 'active' || !isPeerTestLive(test)) {
    throw new HttpError('الاختبار غير متاح حاليًا', 400);
  }
  if (!isInAudience(test, selected, caller.id)) {
    throw new HttpError('لست ضمن قائمة الأعضاء المخولين بالمشاركة في هذا الاختبار', 403);
  }
}

function requireManager(caller: ActiveCaller, batchId: string) {
  if (caller.role !== 'admin' || !canManageBatch(caller, batchId)) {
    throw new HttpError('لا تملك صلاحية إدارة اختبارات هذه الدفعة', 403);
  }
}

function questionPayload(questions: TestQuestion[]) {
  return questions.map((q) => ({
    question_number: q.question_number,
    start_surah: q.start_surah,
    start_surah_name: q.start_surah_name,
    start_ayah: q.start_ayah,
    end_surah: q.end_surah,
    end_surah_name: q.end_surah_name,
    end_ayah: q.end_ayah,
    start_page: q.start_page,
    start_line: q.start_line,
    end_page: q.end_page,
    end_line: q.end_line,
    actual_lines: q.actual_lines,
    difficulty_level: q.difficulty_level,
  }));
}

function generateOrFail(
  test: Pick<PeerTestRow, 'range_start' | 'range_end' | 'questions_count' | 'lines_per_question' | 'difficulty'>,
  rangeEnd: number = test.range_end
) {
  const questions = generateTestQuestions(
    test.range_start,
    rangeEnd,
    test.questions_count,
    test.lines_per_question,
    test.difficulty || 'any'
  );
  if (questions.length < test.questions_count) {
    throw new HttpError('النطاق لا يتسع لهذا العدد من الأسئلة بهذا الطول', 422);
  }
  return questions;
}

// Arabic messages raised by our SQL functions are safe to show.
function rpcError(error: { code?: string; message: string; details?: string | null }, label: string): never {
  console.error(`peer-tests ${label} failed`, { code: error.code, message: error.message, details: error.details });
  if (error.code === '23514' || error.code === 'P0002' || error.code === 'P0001') {
    throw new HttpError(error.message, 400);
  }
  throw new HttpError('تعذر تنفيذ العملية. حاول مرة أخرى.', 500);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'طريقة الطلب غير مسموحة' }, 405);
  }

  try {
    const admin = createAdminClient();
    const caller = await getActiveCaller(req, admin);
    const body = await req.json();
    const action = body?.action;

    /*
     * ============ PERSONAL SELF-TESTS (Men) ============
     * Nothing is stored here; saving is an owner-checked RPC.
     */
    if (action === 'personal-meta') {
      return json(personalMeta());
    }
    if (action === 'personal-generate') {
      return json(generatePersonalQuestions(parsePersonalSetup(body)));
    }

    /*
     * ============ MEMBER (EXAMINER) ACTIONS ============
     */

    // Candidates list with eligibility and Arabic reasons.
    if (action === 'candidates') {
      const { test, cycle, selected } = await loadTest(admin, body.test_id);
      requireExaminer(caller, cycle, test, selected);

      const [progress, passed] = await Promise.all([loadBatchProgress(admin, cycle), passedAttemptsByCandidate(admin, test.id)]);

      const candidates = progress.members
        .filter((m) => m.id !== caller.id && isInAudience(test, selected, m.id))
        .map((m) => ({ id: m.id, name: m.name, ...evaluate(test, selected, progress, passed, m.id) }))
        .sort((a, b) => Number(b.is_eligible) - Number(a.is_eligible) || a.name.localeCompare(b.name, 'ar'));

      return json({ candidates });
    }

    // Start a session: re-check both people, generate and store questions.
    if (action === 'start') {
      const { test, cycle, selected } = await loadTest(admin, body.test_id);
      requireExaminer(caller, cycle, test, selected);

      const candidateId = body.candidate_id;
      if (!isUuid(candidateId) || candidateId === caller.id) {
        throw new HttpError('يرجى اختيار زميل آخر لاختباره', 400);
      }

      const [progress, passed] = await Promise.all([loadBatchProgress(admin, cycle), passedAttemptsByCandidate(admin, test.id)]);
      const candidate = progress.members.find((m) => m.id === candidateId);
      if (!candidate) {
        throw new HttpError('العضو المُختبَر يجب أن يكون عضوًا نشطًا في هذه الدفعة', 400);
      }

      const evaluation = evaluate(test, selected, progress, passed, candidate.id);
      if (!evaluation.is_eligible) {
        throw new HttpError(`العضو غير مستوفٍ لشروط الاختبار: ${evaluation.reasons.join('، ')}`, 400);
      }

      const questions = generateOrFail(test, evaluation.effective_range_end);

      const { data: attemptId, error } = await admin.rpc('peer_test_start_attempt', {
        p_test_id: test.id,
        p_candidate_id: candidate.id,
        p_examiner_id: caller.id,
        p_questions: questionPayload(questions),
        p_effective_range_end: evaluation.effective_range_end,
      });
      if (error || !attemptId) rpcError(error || { message: 'no attempt id' }, 'start');

      return json({
        attempt_id: attemptId,
        candidate: { id: candidate.id, name: candidate.name },
        effective_range_end: evaluation.effective_range_end,
        covers_full_range: evaluation.covers_full_range,
        questions,
      });
    }

    // Submit error counts only; pass/fail is computed in SQL.
    if (action === 'submit') {
      if (!isUuid(body.attempt_id)) throw new HttpError('معرف جلسة الاختبار غير صالح', 400);

      const { data: attempt, error: attemptError } = await admin
        .from('peer_test_attempts')
        .select('id, test_id, candidate_id, examiner_id, status')
        .eq('id', body.attempt_id)
        .maybeSingle();
      if (attemptError) throw new HttpError(attemptError.message, 500);
      if (!attempt || attempt.examiner_id !== caller.id) {
        throw new HttpError('جلسة الاختبار غير موجودة', 404);
      }

      const { test, cycle, selected } = await loadTest(admin, attempt.test_id);
      requireExaminer(caller, cycle, test, selected);

      // The candidate's elimination status is re-checked at submission time.
      const progress = await loadBatchProgress(admin, cycle);
      if (!progress.delayById.has(attempt.candidate_id)) {
        throw new HttpError('العضو المُختبَر لم يعد عضوًا نشطًا في هذه الدفعة', 400);
      }
      const evaluation = evaluate(test, selected, progress, new Map(), attempt.candidate_id);
      if (!evaluation.is_eligible) {
        throw new HttpError(`العضو غير مستوفٍ لشروط الاختبار: ${evaluation.reasons.join('، ')}`, 400);
      }

      const errors = Array.isArray(body.errors) ? body.errors.map(toInt) : [];
      if (errors.some((e: number | null) => e === null)) {
        throw new HttpError('عدد الأخطاء يجب أن يكون رقمًا صحيحًا', 400);
      }
      const questionNotes = Array.isArray(body.question_notes)
        ? body.question_notes.map((n: unknown) => (n == null ? '' : String(n).slice(0, 300)))
        : [];

      const { data, error } = await admin.rpc('peer_test_submit_attempt', {
        p_attempt_id: attempt.id,
        p_examiner_id: caller.id,
        p_errors: errors,
        p_question_notes: questionNotes,
        p_notes: body.notes ? String(body.notes).slice(0, 300) : null,
      });
      if (error || !data) rpcError(error || { message: 'no result' }, 'submit');

      const result = (data as { attempt: { status: string } }).attempt;
      return json({
        attempt: result,
        message:
          result.status === 'passed'
            ? 'تم اعتماد النتيجة: اجتاز العضو الاختبار بنجاح'
            : 'تم اعتماد النتيجة: لم يجتز العضو الاختبار (تجاوز حد الأخطاء المسموح)',
      });
    }

    /*
     * ============ ADMIN ACTIONS (master or batch admin of that batch) ============
     */

    if (action === 'admin-save') {
      if (!isUuid(body.batch_id)) throw new HttpError('معرف الدفعة غير صالح', 400);
      requireManager(caller, body.batch_id);
      const cycle = await loadActiveCycle(admin, body.batch_id);

      const rangeStart = toInt(body.range_start);
      const rangeEnd = toInt(body.range_end);
      const questionsCount = toInt(body.questions_count);
      const linesPerQuestion = toInt(body.lines_per_question);
      if (rangeStart === null || rangeStart < 1 || rangeStart > 240 || rangeEnd === null || rangeEnd < 1 || rangeEnd > 240) {
        throw new HttpError('بداية ونهاية النطاق يجب أن تكونا بين الربع 1 والربع 240', 400);
      }
      if (rangeStart > rangeEnd) throw new HttpError('بداية النطاق يجب أن تسبق نهايته أو تساويها', 400);
      if (questionsCount === null || questionsCount < 1 || questionsCount > 50) {
        throw new HttpError('عدد الأسئلة يجب أن يكون بين 1 و 50', 400);
      }
      if (linesPerQuestion === null || linesPerQuestion < 1 || linesPerQuestion > 60) {
        throw new HttpError('عدد الأسطر لكل سؤال يجب أن يكون بين 1 و 60', 400);
      }
      if (questionsCount * linesPerQuestion > 0.8 * estimateRangeLines(rangeStart, rangeEnd)) {
        throw new HttpError('النطاق لا يتسع لهذا العدد من الأسئلة بهذا الطول، قلّل العدد أو الأسطر أو وسّع النطاق', 400);
      }

      let maxErrors: number | null = null;
      if (body.max_errors !== null && body.max_errors !== undefined && body.max_errors !== '') {
        maxErrors = toInt(body.max_errors);
        if (maxErrors === null || maxErrors < 0 || maxErrors > 100) {
          throw new HttpError('حد الأخطاء يجب أن يكون بين 0 و 100', 400);
        }
      }

      const testType = body.test_type === 'recommended' ? 'recommended' : 'mandatory';
      const difficulty = ['any', 'easy', 'medium', 'hard', 'mixed'].includes(body.difficulty) ? body.difficulty : 'any';

      // Men: audience and prerequisites. Selected members must belong to this batch (checked in SQL too).
      const audience = body.audience === 'selected' ? 'selected' : 'all';
      const selectedIds: string[] = Array.isArray(body.selected_member_ids)
        ? Array.from(new Set(body.selected_member_ids.filter(isUuid) as string[]))
        : [];
      if (audience === 'selected' && selectedIds.length === 0) {
        throw new HttpError('يرجى تحديد عضو واحد على الأقل في قائمة الأعضاء المختارين، أو اختيار (كل الأعضاء)', 400);
      }

      const parseTime = (v: unknown): string | null => {
        if (v === null || v === undefined || v === '') return null;
        const t = Date.parse(String(v));
        if (Number.isNaN(t)) throw new HttpError('تاريخ العرض غير صالح', 400);
        return new Date(t).toISOString();
      };

      let status: 'draft' | 'published' | 'hidden';
      let visibleFrom: string | null = null;
      const visibleUntil: string | null = parseTime(body.visible_until);
      switch (body.visibility) {
        case 'now':
          status = 'published';
          break;
        case 'schedule':
          status = 'published';
          visibleFrom = parseTime(body.visible_from);
          if (!visibleFrom) throw new HttpError('يرجى تحديد موعد بدء العرض', 400);
          break;
        case 'hidden':
          status = 'hidden';
          visibleFrom = parseTime(body.visible_from);
          break;
        default:
          status = 'draft';
          visibleFrom = parseTime(body.visible_from);
      }
      if (visibleFrom && visibleUntil && Date.parse(visibleFrom) >= Date.parse(visibleUntil)) {
        throw new HttpError('موعد انتهاء العرض يجب أن يكون بعد موعد بدئه', 400);
      }

      // The range must be able to hold the questions.
      generateOrFail({
        range_start: rangeStart,
        range_end: rangeEnd,
        questions_count: questionsCount,
        lines_per_question: linesPerQuestion,
        difficulty,
      });

      const title = String(body.title || '').trim().slice(0, 120) || `اختبار الأرباع (${rangeStart} - ${rangeEnd})`;

      const { data, error } = await admin.rpc('peer_test_save', {
        p_test_id: isUuid(body.test_id) ? body.test_id : null,
        p_cycle_id: cycle.id,
        p_title: title,
        p_range_start: rangeStart,
        p_range_end: rangeEnd,
        p_questions_count: questionsCount,
        p_lines_per_question: linesPerQuestion,
        p_max_errors: maxErrors,
        p_test_type: testType,
        p_difficulty: difficulty,
        p_status: status,
        p_visible_from: visibleFrom,
        p_visible_until: visibleUntil,
        p_actor: caller.id,
        p_audience: audience,
        p_selected_member_ids: audience === 'selected' ? selectedIds : [],
        p_require_all_quarters_completed: body.require_all_quarters_completed === true,
        p_require_revision_completed: body.require_revision_completed === true,
      });
      if (error || !data) rpcError(error || { message: 'no result' }, 'admin-save');

      const saved = data as { test: PeerTestRow; versioned: boolean };
      return json({
        ...saved,
        message: saved.versioned
          ? 'لوجود نتائج سابقة، حُفظت التعديلات كاختبار جديد وأُنهي الاختبار السابق مع الاحتفاظ بنتائجه'
          : 'تم حفظ الاختبار بنجاح',
      });
    }

    if (action === 'admin-status') {
      const { test, cycle } = await loadTest(admin, body.test_id);
      requireManager(caller, cycle.batch_id);
      if (!['show', 'hide', 'finish'].includes(body.status_action)) {
        throw new HttpError('إجراء غير معروف', 400);
      }
      const { data, error } = await admin.rpc('peer_test_set_status', {
        p_test_id: test.id,
        p_action: body.status_action,
        p_actor: caller.id,
      });
      if (error || !data) rpcError(error || { message: 'no result' }, 'admin-status');
      const messages: Record<string, string> = {
        show: 'أصبح الاختبار ظاهرًا الآن',
        hide: 'تم إخفاء الاختبار',
        finish: 'تم إنهاء الاختبار نهائيًا',
      };
      return json({ ...(data as object), message: messages[body.status_action] });
    }

    if (action === 'admin-preview') {
      const { test, cycle } = await loadTest(admin, body.test_id);
      requireManager(caller, cycle.batch_id);
      return json({ questions: generateOrFail(test) });
    }

    // How many members (of the test's audience) would be blocked right now by this mandatory test.
    if (action === 'admin-impact') {
      const { test, cycle, selected } = await loadTest(admin, body.test_id);
      requireManager(caller, cycle.batch_id);
      const [progress, passed] = await Promise.all([loadBatchProgress(admin, cycle), passedAttemptsByCandidate(admin, test.id)]);
      const blocked = progress.members.filter(
        (m) =>
          isInAudience(test, selected, m.id) &&
          !(passed.get(m.id) || []).some((a) => a.covers_full_range !== false) &&
          nextTasmiaQuarter(progress.delayById.get(m.id)!, progress.quarterOfDay) > test.range_end
      );
      return json({
        blocked_count: test.test_type === 'mandatory' ? blocked.length : 0,
        blocked_members: test.test_type === 'mandatory' ? blocked.map((m) => ({ id: m.id, name: m.name })) : [],
      });
    }

    return json({ error: 'إجراء غير معروف' }, 400);
  } catch (error) {
    if (error instanceof RuleError) return json({ error: error.message }, error.status);
    return errorResponse(error, 'peer-tests');
  }
});
