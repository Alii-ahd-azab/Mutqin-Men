// Men peer-test and personal-test rules (pure functions; used by the peer-tests Edge Function and the
// unit tests). Ported unchanged from the former Express routes so Men behavior is preserved.
import type { TestDefinition, User, TestAttemptQuestionResult } from './types.ts';
import { calculateCycleInfo, calculateMemberRequiredQuarter, getActiveCycleDates, calculateMemberRevisionStatus } from './calculations.ts';
import {
  ALL_VERSES,
  ALL_QUARTERS,
  estimateRangeLines,
  isInTestAudience,
  getQuarterStartIndex,
  getQuarterEndIndex,
  getVerseIndexBySurahAyah,
  getAbsoluteLineStart,
  getAbsoluteLineEnd,
  getSurahs,
  getJuzList,
  generateQuestionsInVerseRange,
  type TestDifficulty,
} from './testGenerator.ts';
import type { ProgramState } from './menData.ts';

export class RuleError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function parseStrictInteger(val: unknown): number | null {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}

export interface CandidateStatus {
  is_eligible: boolean;
  reasons: string[];
  has_passed: boolean;
  attempts_count: number;
  effective_range_end: number;
  covers_full_range: boolean;
}

/** Unified candidate eligibility (identical for listing candidates, generating and submitting). */
export function computeCandidateStatus(db: ProgramState, test: TestDefinition, member: User, todayStr: string): CandidateStatus {
  const attempts = (db.testAttempts || []).filter((a) => a.test_id === test.id && a.candidate_id === member.id);
  // Full pass only if covers_full_range !== false (legacy attempts count as full range)
  const hasPassedFull = attempts.some((a) => a.passed && a.covers_full_range !== false);
  const reasons: string[] = [];
  let isEligible = true;

  if (!member.is_active || member.role !== 'member') {
    isEligible = false;
    reasons.push('العضو غير نشط أو ليس عضواً عادياً في المقرأة');
  }
  if (!isInTestAudience(test, member.id)) {
    isEligible = false;
    reasons.push('العضو ليس ضمن الجمهور المستهدف لهذا الاختبار');
  }
  if (hasPassedFull) {
    isEligible = false;
    reasons.push('اجتاز العضو هذا الاختبار بنجاح مسبقاً');
  }

  const memberLogs = (db.recitationLogs || []).filter((l) => l.member_id === member.id || l.reciter_id === member.id);
  const completedQuarterSet = new Set<number>(memberLogs.map((l) => l.quarter_number));
  let lastCompletedConsecutive = 0;
  while (completedQuarterSet.has(lastCompletedConsecutive + 1)) lastCompletedConsecutive++;

  const requireAllQuarters = !!test.prerequisites?.require_all_quarters_completed;
  let effectiveRangeEnd = test.range_end;
  let coversFullRange = true;

  if (requireAllQuarters) {
    let missingInRange = 0;
    for (let q = test.range_start; q <= test.range_end; q++) if (!completedQuarterSet.has(q)) missingInRange++;
    if (missingInRange > 0) {
      isEligible = false;
      reasons.push(`لم يتم تسميع جميع أرباع نطاق الاختبار بعد (متبقٍ ${missingInRange} ربع من الأرباع ${test.range_start} إلى ${test.range_end})`);
    }
  } else {
    if (lastCompletedConsecutive < test.range_start) {
      isEligible = false;
      reasons.push(
        `لم يتم تسميع بداية نطاق الاختبار بعد (أتمّ حتى الربع ${lastCompletedConsecutive} ويبدأ الاختبار من الربع ${test.range_start})`
      );
    }
    effectiveRangeEnd = Math.min(test.range_end, lastCompletedConsecutive);
    coversFullRange = effectiveRangeEnd === test.range_end;
    const hasPassedAtOrAbove = attempts.some(
      (a) =>
        a.passed &&
        (a.covers_full_range !== false || (typeof a.effective_range_end === 'number' && a.effective_range_end >= effectiveRangeEnd))
    );
    if (!hasPassedFull && hasPassedAtOrAbove) {
      isEligible = false;
      reasons.push(`اجتاز العضو الاختبار لهذا النطاق مسبقًا (حتى الربع ${effectiveRangeEnd})، ويمكن إعادة اختباره بعد إتمام أرباع إضافية`);
    }
  }

  if (test.prerequisites?.require_revision_completed) {
    const activeCycleDates = getActiveCycleDates(db.settings.start_date, todayStr, db.restDays, db.settings);
    const revisionStatus = calculateMemberRevisionStatus(member.id, activeCycleDates, db.revisionLogs, todayStr);
    if (revisionStatus.missedRevisionDaysCount > 0) {
      isEligible = false;
      reasons.push(`توجد أيام مراجعة فائتة (${revisionStatus.missedRevisionDaysCount} يوم)`);
    }
    if (!revisionStatus.hasReviewedToday) {
      isEligible = false;
      reasons.push('لم يتم تأكيد مراجعة اليوم بعد');
    }
  }

  return {
    is_eligible: isEligible && reasons.length === 0,
    reasons,
    has_passed: hasPassedFull,
    attempts_count: attempts.length,
    effective_range_end: effectiveRangeEnd,
    covers_full_range: coversFullRange,
  };
}

/** Members who would be blocked right now by a mandatory test (admin impact preview). */
export function blockedMembers(db: ProgramState, test: TestDefinition, todayStr: string): { id: string; name: string }[] {
  const cycleInfo = calculateCycleInfo(db.settings, db.restDays, todayStr);
  return db.users
    .filter((u) => u.role === 'member' && u.is_active && isInTestAudience(test, u.id))
    .filter((m) => {
      const status = calculateMemberRequiredQuarter(m.id, cycleInfo.quarter_of_day, db.recitationLogs);
      if (status.requiredQuarter <= test.range_end) return false;
      return !(db.testAttempts || []).some(
        (a) => a.test_id === test.id && a.candidate_id === m.id && a.passed && a.covers_full_range !== false
      );
    })
    .map((m) => ({ id: m.id, name: m.name }));
}

export interface TestInput {
  title: string;
  range_start: number;
  range_end: number;
  questions_count: number;
  lines_per_question: number;
  max_errors: number | null;
  test_type: 'mandatory' | 'recommended';
  difficulty: 'any' | 'easy' | 'medium' | 'hard' | 'mixed';
  audience: 'all' | 'selected';
  selected_member_ids: string[];
  is_active: boolean;
  require_all_quarters_completed: boolean;
  require_revision_completed: boolean;
}

/** Validates an admin's test definition exactly as the former POST /api/admin/tests did. */
export function validateTestInput(body: any, knownUserIds: Set<string>): TestInput {
  const rStart = parseStrictInteger(body?.range_start);
  const rEnd = parseStrictInteger(body?.range_end);
  const qCount = parseStrictInteger(body?.questions_count);
  const lPerQ = parseStrictInteger(body?.lines_per_question);
  if (rStart === null || rStart < 1 || rStart > 240) throw new RuleError('بداية نطاق الاختبار يجب أن تكون عدداً صحيحاً بين 1 و 240');
  if (rEnd === null || rEnd < 1 || rEnd > 240) throw new RuleError('نهاية نطاق الاختبار يجب أن تكون عدداً صحيحاً بين 1 و 240');
  if (rStart > rEnd) throw new RuleError('بداية النطاق يجب أن تكون أقل من أو تساوي نهاية النطاق');
  if (qCount === null || qCount < 1 || qCount > 50) throw new RuleError('عدد الأسئلة يجب أن يكون عدداً صحيحاً بين 1 و 50');
  if (lPerQ === null || lPerQ < 1 || lPerQ > 60) throw new RuleError('عدد الأسطر لكل سؤال يجب أن يكون عدداً صحيحاً بين 1 و 60');
  if (qCount * lPerQ > 0.8 * estimateRangeLines(rStart, rEnd)) {
    throw new RuleError('النطاق لا يتسع لهذا العدد من الأسئلة بهذا الطول، قلّل العدد أو الأسطر أو وسّع النطاق');
  }
  // A blank title falls back to the default (the database requires a title).
  const title = (body?.title ? String(body.title).trim().slice(0, 120) : '') || `اختبار الأرباع (${rStart} - ${rEnd})`;

  let maxErrors: number | null = null;
  if (body?.has_max_errors) {
    const parsed = parseStrictInteger(body.max_errors_allowed);
    if (parsed === null || parsed < 0 || parsed > 100) throw new RuleError('الحد الأقصى للأخطاء يجب أن يكون عدداً صحيحاً بين 0 و 100');
    maxErrors = parsed;
  }
  const audience: 'all' | 'selected' = body?.audience === 'all' ? 'all' : 'selected';
  const selected: string[] = Array.isArray(body?.selected_member_ids)
    ? [...new Set<string>(body.selected_member_ids.map(String).filter(Boolean))]
    : [];
  if (audience === 'selected' && selected.length === 0) {
    throw new RuleError('يرجى تحديد عضو واحد على الأقل في قائمة الأعضاء المختارين، أو اختيار (كل الأعضاء)');
  }
  if (selected.some((m) => !knownUserIds.has(m))) throw new RuleError('قائمة الأعضاء المختارين تحتوي على عضو غير موجود');

  const difficulties = ['any', 'easy', 'medium', 'hard', 'mixed'] as const;
  return {
    title,
    range_start: rStart,
    range_end: rEnd,
    questions_count: qCount,
    lines_per_question: lPerQ,
    max_errors: maxErrors,
    test_type: body?.test_type === 'mandatory' ? 'mandatory' : 'recommended',
    difficulty: difficulties.includes(body?.difficulty) ? body.difficulty : 'any',
    audience,
    selected_member_ids: selected,
    is_active: body?.is_active !== undefined ? !!body.is_active : true,
    require_all_quarters_completed: !!body?.prerequisites?.require_all_quarters_completed,
    require_revision_completed: !!body?.prerequisites?.require_revision_completed,
  };
}

export interface VerifiedQuestion extends TestAttemptQuestionResult {
  start_surah: number;
  end_surah: number;
  start_page: number;
  start_line: number;
  end_page: number;
  end_line: number;
  actual_lines: number;
}

/** Re-validates the examiner's submitted question boundaries against the Mushaf (never trusts the client). */
export function verifyAttemptQuestions(test: TestDefinition, effectiveRangeEnd: number, results: unknown): VerifiedQuestion[] {
  if (!Array.isArray(results) || results.length === 0) throw new RuleError('يجب إرسال بيانات أسئلة الاختبار');
  if (results.length !== test.questions_count) {
    throw new RuleError(`عدد الأسئلة المرسلة (${results.length}) لا يطابق عدد أسئلة الاختبار المطلوب بالضبط (${test.questions_count})`);
  }
  const minVerseIdx = getQuarterStartIndex(test.range_start);
  const maxVerseIdx = getQuarterEndIndex(effectiveRangeEnd);
  const out: VerifiedQuestion[] = [];
  let prevEnd = -1;
  for (let i = 0; i < results.length; i++) {
    const q = results[i] as Record<string, unknown>;
    const sSurah = parseStrictInteger(q?.start_surah);
    const sAyah = parseStrictInteger(q?.start_ayah);
    const eSurah = parseStrictInteger(q?.end_surah);
    const eAyah = parseStrictInteger(q?.end_ayah);
    const qErrors = parseStrictInteger(q?.errors_count);
    if (sSurah === null || sAyah === null || eSurah === null || eAyah === null) {
      throw new RuleError(`بيانات السورة أو الآية غير صالحة في السؤال رقم ${i + 1}`);
    }
    const startIdx = getVerseIndexBySurahAyah(sSurah, sAyah);
    const endIdx = getVerseIndexBySurahAyah(eSurah, eAyah);
    if (startIdx === undefined || endIdx === undefined) throw new RuleError(`الآية المحددة غير موجودة في المصحف الشريف في السؤال رقم ${i + 1}`);
    if (startIdx > endIdx) throw new RuleError(`بداية السؤال يجب أن تسبق نهايته في السؤال رقم ${i + 1}`);
    if (startIdx < minVerseIdx || endIdx > maxVerseIdx) {
      throw new RuleError(`السؤال رقم ${i + 1} يقع خارج نطاق أرباع الاختبار (${test.range_start} إلى ${effectiveRangeEnd})`);
    }
    if (i > 0 && startIdx <= prevEnd) throw new RuleError(`يوجد تداخل بين السؤال رقم ${i + 1} والسؤال السابق له`);
    prevEnd = endIdx;
    if (qErrors === null || qErrors < 0 || qErrors > 99) {
      throw new RuleError(`عدد الأخطاء يجب أن يكون رقماً صحيحاً بين 0 و 99 في السؤال رقم ${i + 1}`);
    }
    const s = ALL_VERSES[startIdx];
    const e = ALL_VERSES[endIdx];
    const notes = q.notes ? String(q.notes).trim().slice(0, 300) : '';
    out.push({
      question_number: i + 1,
      start_surah: s.surah,
      start_surah_name: s.surah_name,
      start_ayah: s.ayah,
      end_surah: e.surah,
      end_surah_name: e.surah_name,
      end_ayah: e.ayah,
      errors_count: qErrors,
      ...(notes ? { notes } : {}),
      // Mushaf geometry, computed exactly as the question generator does.
      start_page: s.page,
      start_line: s.line_start,
      end_page: e.page_end,
      end_line: e.line_end,
      actual_lines: getAbsoluteLineEnd(e) - getAbsoluteLineStart(s) + 1,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Personal self-tests (اختبر نفسك)
// ---------------------------------------------------------------------------------------------
export const POINTS_PER_ERROR = 15;
const MAX_QUESTIONS = 30;
const MAX_LINES = 30;
const DIFFICULTIES = ['any', 'easy', 'medium', 'hard', 'mixed'];

export interface PersonalSetup {
  range_type: 'surah' | 'juz' | 'quarter';
  lo: number;
  hi: number;
  sS: number;
  eS: number;
  sSName: string;
  eSName: string;
  start_juz?: number;
  end_juz?: number;
  start_quarter?: number;
  end_quarter?: number;
  range_label: string;
  count: number;
  lines: number;
  difficulty: TestDifficulty;
}

function strictInt(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

/** Parses a personal-test setup exactly as the former /api/personal-tests routes did. */
export function parsePersonalSetup(body: any): PersonalSetup {
  const rangeType = (body?.range_type || 'surah') as 'surah' | 'juz' | 'quarter';
  const count = strictInt(body?.questions_count);
  const lines = strictInt(body?.lines_per_question);
  const difficulty = (body?.difficulty ?? 'any') as string;
  if (count === null || count < 1 || count > MAX_QUESTIONS) throw new RuleError(`عدد الأسئلة يجب أن يكون رقمًا صحيحًا بين 1 و ${MAX_QUESTIONS}`);
  if (lines === null || lines < 1 || lines > MAX_LINES) throw new RuleError(`طول السؤال يجب أن يكون رقمًا صحيحًا بين 1 و ${MAX_LINES} سطرًا`);
  if (!DIFFICULTIES.includes(difficulty)) throw new RuleError('مستوى الصعوبة غير صالح');

  const fromQuarters = (sQ: number, eQ: number) => {
    const lo = getQuarterStartIndex(sQ);
    const hi = getQuarterEndIndex(eQ);
    return { lo, hi, sV: ALL_VERSES[lo], eV: ALL_VERSES[hi] };
  };
  const base = { count, lines, difficulty: difficulty as TestDifficulty };

  if (rangeType === 'quarter') {
    const sQ = strictInt(body?.start_quarter);
    const eQ = strictInt(body?.end_quarter);
    if (sQ === null || eQ === null || sQ < 1 || eQ > 240 || sQ > eQ) {
      throw new RuleError('نطاق الأرباع غير صالح (يجب أن يكون ربع البداية بين 1 و 240 وقبل أو يساوي ربع النهاية)');
    }
    const { lo, hi, sV, eV } = fromQuarters(sQ, eQ);
    const range_label = sQ === eQ ? `الربع ${sQ} (${sV.surah_name})` : `الأرباع ${sQ} ← ${eQ} (${sV.surah_name} إلى ${eV.surah_name})`;
    return { ...base, range_type: 'quarter', lo, hi, sS: sV.surah, eS: eV.surah, sSName: sV.surah_name, eSName: eV.surah_name, start_quarter: sQ, end_quarter: eQ, range_label };
  }
  if (rangeType === 'juz') {
    const sJ = strictInt(body?.start_juz);
    const eJ = strictInt(body?.end_juz);
    if (sJ === null || eJ === null || sJ < 1 || eJ > 30 || sJ > eJ) {
      throw new RuleError('نطاق الأجزاء غير صالح (يجب أن يكون جزء البداية بين 1 و 30 وقبل أو يساوي جزء النهاية)');
    }
    const sQ = (sJ - 1) * 8 + 1;
    const eQ = eJ * 8;
    const { lo, hi, sV, eV } = fromQuarters(sQ, eQ);
    const range_label = sJ === eJ ? `الجزء ${sJ} (${sV.surah_name})` : `الأجزاء ${sJ} ← ${eJ} (${sV.surah_name} إلى ${eV.surah_name})`;
    return { ...base, range_type: 'juz', lo, hi, sS: sV.surah, eS: eV.surah, sSName: sV.surah_name, eSName: eV.surah_name, start_juz: sJ, end_juz: eJ, start_quarter: sQ, end_quarter: eQ, range_label };
  }
  const surahs = getSurahs();
  const sS = strictInt(body?.start_surah);
  const eS = strictInt(body?.end_surah);
  if (sS === null || eS === null || sS < 1 || eS > 114 || sS > eS) {
    throw new RuleError('نطاق السور غير صالح (يجب أن تكون سورة البداية قبل أو تساوي سورة النهاية)');
  }
  const sSName = surahs[sS - 1].name;
  const eSName = surahs[eS - 1].name;
  return {
    ...base,
    range_type: 'surah',
    lo: surahs[sS - 1].first_idx,
    hi: surahs[eS - 1].last_idx,
    sS,
    eS,
    sSName,
    eSName,
    range_label: sS === eS ? `سورة ${sSName}` : `سورة ${sSName} ← سورة ${eSName}`,
  };
}

export function generatePersonalQuestions(setup: PersonalSetup) {
  const questions = generateQuestionsInVerseRange(setup.lo, setup.hi, setup.count, setup.lines, setup.difficulty);
  if (questions.length < setup.count) {
    throw new RuleError('النطاق المختار لا يتسع لهذا العدد من الأسئلة بهذا الطول. وسّع النطاق أو قلّل عدد الأسئلة أو أسطر السؤال.', 422);
  }
  return {
    questions,
    points_per_error: POINTS_PER_ERROR,
    range_label: setup.range_label,
    // Resolved range, sent back with the results to the men_save_personal_test RPC.
    setup: {
      range_type: setup.range_type,
      range_label: setup.range_label,
      start_surah: setup.sS,
      start_surah_name: setup.sSName,
      end_surah: setup.eS,
      end_surah_name: setup.eSName,
      start_juz: setup.start_juz ?? null,
      end_juz: setup.end_juz ?? null,
      start_quarter: setup.start_quarter ?? null,
      end_quarter: setup.end_quarter ?? null,
      questions_count: setup.count,
      lines_per_question: setup.lines,
      difficulty: setup.difficulty,
    },
  };
}

export function personalMeta() {
  return {
    surahs: getSurahs().map((s) => ({ number: s.number, name: s.name, ayah_count: s.ayah_count })),
    juzList: getJuzList(),
    quartersList: ALL_QUARTERS.map((q) => ({
      quarter: q.quarter,
      juz: q.juz,
      surahName: q.surahName,
      ayahNumber: q.ayahNumber,
      label: `الربع ${q.quarter} — سورة ${q.surahName} (${q.ayahNumber})`,
    })),
  };
}
