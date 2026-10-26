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
import { loadBatchIds, loadProgram, type ProgramState } from '../_shared/men/menData.ts';
import { mapTests, mapAttempts, type TestRow, type AttemptRow } from '../_shared/men/menRows.ts';
import { generateTestQuestions } from '../_shared/men/testGenerator.ts';
import { isInTestAudience } from '../_shared/men/testGenerator.ts';
import type { TestDefinition, User } from '../_shared/men/types.ts';
import {
  RuleError,
  computeCandidateStatus,
  blockedMembers,
  validateTestInput,
  verifyAttemptQuestions,
  parsePersonalSetup,
  generatePersonalQuestions,
  personalMeta,
} from '../_shared/men/peerRules.ts';

/*
 * PEER TESTING (الاختبارات المتبادلة) + personal self-test generation.
 *
 * Members (examiners) and admins call this function; it re-checks every Men rule server-side and
 * writes only through service-role-only database functions. Reads elsewhere use RLS.
 */

// The halaqah runs on Makkah time; a browser may send its local date (accepted within one day).
function programToday(clientDate: unknown): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  if (typeof clientDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(clientDate)) {
    const diff = Math.abs(Date.parse(clientDate + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z'));
    if (diff <= 86400000) return clientDate;
  }
  return today;
}

/** The caller's batch: a member's own batch, or (admins) the first batch they manage. */
async function callerBatchId(admin: SupabaseClient, caller: ActiveCaller): Promise<string> {
  if (caller.role === 'member') {
    if (!caller.memberBatchId) throw new HttpError('حسابك غير مرتبط بدفعة', 403);
    return caller.memberBatchId;
  }
  const ids = (await loadBatchIds(admin)).filter((id) => canManageBatch(caller, id));
  if (!ids.length) throw new HttpError('لا تملك صلاحية إدارة أي دفعة', 403);
  return ids[0];
}

function findTest(state: ProgramState, testId: unknown): TestDefinition {
  const test = isUuid(testId) ? state.tests.find((t) => t.id === testId) : undefined;
  if (!test) throw new HttpError('الاختبار غير موجود', 404);
  return test;
}

function requireManager(caller: ActiveCaller, batchId: string) {
  if (caller.role !== 'admin' || !canManageBatch(caller, batchId)) {
    throw new HttpError('هذا الإجراء مخصص للمشرف فقط', 403);
  }
}

// Examiners: active members in the test's audience (admins may also view candidates/questions).
function requireParticipant(caller: ActiveCaller, user: User | undefined, test: TestDefinition) {
  if (caller.role === 'admin') return;
  if (!user || user.role !== 'member' || !user.is_active || !isInTestAudience(test, user.id)) {
    throw new HttpError('لست ضمن قائمة الأعضاء المخولين بالمشاركة في هذا الاختبار', 403);
  }
}

// Arabic messages raised by our SQL functions are safe to show.
function rpcError(error: { code?: string; message: string; hint?: string | null }, label: string): never {
  console.error(`peer-tests ${label} failed`, { code: error.code, message: error.message });
  if (error.hint === 'duplicate_attempt') throw new HttpError(error.message, 429);
  if (error.code === '23514' || error.code === 'P0002' || error.code === 'P0001') throw new HttpError(error.message, 400);
  throw new HttpError('تعذر تنفيذ العملية. حاول مرة أخرى.', 500);
}

async function loadSelected(admin: SupabaseClient, testId: string) {
  const { data, error } = await admin.from('peer_test_selected_members').select('test_id, user_id, position').eq('test_id', testId);
  if (error) throw new HttpError(error.message, 500);
  return data || [];
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
    const today = programToday(body?.client_date);

    // ============ PERSONAL SELF-TESTS (no stored data here; saving is an RLS-checked RPC) ============
    if (action === 'personal-meta') {
      return json(personalMeta());
    }
    if (action === 'personal-generate') {
      return json(generatePersonalQuestions(parsePersonalSetup(body)));
    }

    const batchId = await callerBatchId(admin, caller);
    const state = await loadProgram(admin, batchId);
    const me = state.users.find((u) => u.id === caller.id);

    // ============ MEMBER (EXAMINER) ACTIONS ============

    if (action === 'candidates') {
      const test = findTest(state, body.test_id);
      requireParticipant(caller, me, test);
      const candidates = state.users
        .filter((u) => u.role === 'member' && u.is_active && u.id !== caller.id && isInTestAudience(test, u.id))
        .map((m) => {
          const s = computeCandidateStatus(state, test, m, today);
          return {
            id: m.id,
            name: m.name,
            phone: m.phone,
            is_eligible: s.is_eligible,
            ineligibility_reasons: s.reasons,
            has_passed: s.has_passed,
            attempts_count: s.attempts_count,
            effective_range_end: s.effective_range_end,
            covers_full_range: s.covers_full_range,
          };
        });
      return json({ test, candidates });
    }

    if (action === 'generate') {
      const test = findTest(state, body.test_id);
      requireParticipant(caller, me, test);
      let effectiveRangeEnd = test.range_end;
      if (body.candidate_id) {
        const candidate = state.users.find((u) => u.id === body.candidate_id && u.is_active);
        if (!candidate) throw new HttpError('العضو المختبَر غير موجود', 404);
        const s = computeCandidateStatus(state, test, candidate, today);
        if (!s.is_eligible) throw new HttpError(`العضو غير مؤهل للاختبار: ${s.reasons.join('، ')}`, 400);
        effectiveRangeEnd = s.effective_range_end;
      }
      const questions = generateTestQuestions(test.range_start, effectiveRangeEnd, test.questions_count, test.lines_per_question, test.difficulty || 'any');
      if (questions.length < test.questions_count) throw new HttpError('النطاق لا يتسع لهذا العدد من الأسئلة بهذا الطول', 422);
      return json({ test_id: test.id, effective_range_end: effectiveRangeEnd, questions });
    }

    if (action === 'submit') {
      if (!body.test_id || !body.candidate_id) throw new HttpError('يرجى تحديد الاختبار والعضو المُختبَر', 400);
      const test = findTest(state, body.test_id);
      if (!test.is_active) throw new HttpError('هذا الاختبار غير مفعّل حالياً', 400);
      if (!me || me.role !== 'member' || !me.is_active) throw new HttpError('يجب أن يكون المُختبِر عضواً نشطاً في المقرأة', 403);
      if (!isInTestAudience(test, me.id)) throw new HttpError('أنت لست ضمن قائمة الأعضاء المخولين بإجراء هذا الاختبار', 403);
      if (me.id === body.candidate_id) throw new HttpError('لا يمكن للعضو اختبار نفسه؛ يجب أن يختبرك زميل في المقرأة', 400);
      const candidate = state.users.find((u) => u.id === body.candidate_id);
      if (!candidate || candidate.role !== 'member' || !candidate.is_active) {
        throw new HttpError('العضو المُختبَر غير موجود أو حسابه غير نشط', 404);
      }
      if (!isInTestAudience(test, candidate.id)) throw new HttpError('العضو المُختبَر ليس ضمن قائمة الأعضاء المشمولين بهذا الاختبار', 400);

      const status = computeCandidateStatus(state, test, candidate, today);
      if (status.has_passed) throw new HttpError('العضو اجتاز هذا الاختبار بالفعل بنجاح ولا يحتاج لإعادته', 400);
      if (!status.is_eligible) throw new HttpError(`العضو غير مؤهل لخوض هذا الاختبار حالياً: ${status.reasons.join('، ')}`, 400);

      const questions = verifyAttemptQuestions(test, status.effective_range_end, body.questions_results);
      const notes = body.notes ? String(body.notes).trim().slice(0, 300) : '';
      const { data, error } = await admin.rpc('men_peer_test_record_attempt', {
        p_attempt: {
          test_id: test.id,
          candidate_id: candidate.id,
          candidate_name: candidate.name,
          examiner_id: me.id,
          examiner_name: me.name,
          date: today,
          notes,
          effective_range_end: status.effective_range_end,
          covers_full_range: status.covers_full_range,
        },
        p_questions: questions,
      });
      if (error || !data) rpcError(error || { message: 'no result' }, 'submit');

      const row = (data as { attempt: AttemptRow }).attempt;
      const attempt = mapAttempts([row], questions.map((q) => ({ ...q, attempt_id: row.id, notes: q.notes ?? null })))[0];
      return json({
        success: true,
        message: attempt.passed
          ? 'تم تسجيل الاختبار بنجاح واجتياز العضو للاختبار!'
          : 'تم تسجيل الاختبار (لم يجتز العضو بنجاح بسبب تجاوز حد الأخطاء المسموح).',
        attempt,
      });
    }

    // ============ ADMIN ACTIONS ============

    if (action === 'admin-save') {
      requireManager(caller, batchId);
      const input = validateTestInput(body, new Set(state.users.map((u) => u.id)));
      const { selected_member_ids, ...test } = input;
      const { data, error } = await admin.rpc('men_peer_test_save', {
        p_cycle_id: state.cycle.id,
        p_test_id: isUuid(body.id) && state.tests.some((t) => t.id === body.id) ? body.id : null,
        p_test: test,
        p_selected: selected_member_ids,
        p_actor: caller.id,
      });
      if (error || !data) rpcError(error || { message: 'no result' }, 'admin-save');
      const saved = data as { test: TestRow; versioned: boolean };
      return json({
        success: true,
        message: saved.versioned
          ? 'نظراً لوجود محاولات سابقة، تم حفظ التعديلات كاختبار جديد وأرشفة الاختبار السابق لحفظ سجل النتائج.'
          : 'تم حفظ الاختبار بنجاح.',
        test: mapTests([saved.test], await loadSelected(admin, saved.test.id))[0],
      });
    }

    if (action === 'admin-status' || action === 'admin-finish') {
      requireManager(caller, batchId);
      const test = findTest(state, body.test_id);
      const statusAction = action === 'admin-finish' ? 'finish' : body.is_active ? 'show' : 'hide';
      const { data, error } = await admin.rpc('men_peer_test_set_status', { p_test_id: test.id, p_action: statusAction });
      if (error || !data) rpcError(error || { message: 'no result' }, action);
      const messages: Record<string, string> = {
        show: 'تم تفعيل الاختبار بنجاح',
        hide: 'تم إيقاف الاختبار بنجاح',
        finish: 'تم إنهاء الاختبار نهائيًا بنجاح',
      };
      return json({
        success: true,
        message: messages[statusAction],
        test: mapTests([(data as { test: TestRow }).test], await loadSelected(admin, test.id))[0],
      });
    }

    if (action === 'admin-preview') {
      requireManager(caller, batchId);
      const test = findTest(state, body.test_id);
      const questions = generateTestQuestions(test.range_start, test.range_end, test.questions_count, test.lines_per_question, test.difficulty || 'any');
      if (questions.length < test.questions_count) throw new HttpError('النطاق لا يتسع لهذا العدد من الأسئلة بهذا الطول', 422);
      return json({ test_id: test.id, questions });
    }

    if (action === 'admin-impact') {
      requireManager(caller, batchId);
      const test = findTest(state, body.test_id);
      const blocked = blockedMembers(state, test, today);
      return json({
        test_id: test.id,
        test_type: test.test_type,
        range_start: test.range_start,
        range_end: test.range_end,
        blocked_count: blocked.length,
        blocked_members: blocked,
      });
    }

    return json({ error: 'إجراء غير معروف' }, 400);
  } catch (error) {
    if (error instanceof RuleError) return json({ error: error.message }, error.status);
    return errorResponse(error, 'peer-tests');
  }
});
