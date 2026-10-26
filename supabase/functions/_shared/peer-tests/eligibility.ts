// Peer-testing rules (pure functions, unit-tested; used by the Edge Function).
// Same model as Mutqin for Sisters. Two rules are deliberately SEPARATE:
//   * a CANDIDATE must have recited the range, must not have passed already,
//     and must not be «مؤهل للإقصاء»;
//   * an EXAMINER only needs to be an active member of the test's batch (and,
//     Men rule, of its audience) — being «مؤهل للإقصاء» does NOT prevent him
//     from examining others.
// Men additions: selected-audience tests, the two prerequisite flags, and a
// partially recited range (effective_range_end / covers_full_range) when the
// test does not require the whole range.

import type { MemberDelayStatus } from '../logic/memberDelayStatus.ts';

export interface PeerTestRow {
  id: string;
  cycle_id: string;
  title: string;
  range_start: number;
  range_end: number;
  questions_count: number;
  lines_per_question: number;
  max_errors: number | null;
  test_type: 'mandatory' | 'recommended';
  difficulty: 'any' | 'easy' | 'medium' | 'hard' | 'mixed';
  status: 'draft' | 'published' | 'hidden' | 'finished';
  visible_from: string | null;
  visible_until: string | null;
  // Men
  audience: 'all' | 'selected';
  require_all_quarters_completed: boolean;
  require_revision_completed: boolean;
}

/** A passed attempt of the candidate (only what the range rule needs). */
export interface PassedAttempt {
  covers_full_range: boolean | null;
  effective_range_end: number | null;
}

/** Published and inside its show window (same rule as the database). */
export function isPeerTestLive(
  test: Pick<PeerTestRow, 'status' | 'visible_from' | 'visible_until'>,
  now: Date = new Date()
): boolean {
  if (test.status !== 'published') return false;
  const t = now.getTime();
  if (test.visible_from && Date.parse(test.visible_from) > t) return false;
  if (test.visible_until && Date.parse(test.visible_until) <= t) return false;
  return true;
}

/** Men: is this member part of the test's audience? */
export function isInAudience(
  test: Pick<PeerTestRow, 'audience'>,
  selectedMemberIds: ReadonlySet<string>,
  memberId: string
): boolean {
  return test.audience !== 'selected' || selectedMemberIds.has(memberId);
}

/** Arabic reason when a member is «مؤهل للإقصاء», otherwise null. */
export function eliminationReason(delay: MemberDelayStatus): string | null {
  if (delay.isSeverelyBehindRecitation && delay.isSeverelyBehindRevision) {
    return `مؤهل للإقصاء بسبب تأخر التسميع (${delay.missedQuartersCount} أرباع فائتة) والمراجعة (${delay.missedRevisionDaysCount} أيام فائتة)`;
  }
  if (delay.isSeverelyBehindRecitation) {
    return `مؤهل للإقصاء بسبب تأخر التسميع (${delay.missedQuartersCount} أرباع فائتة)`;
  }
  if (delay.isSeverelyBehindRevision) {
    return `مؤهل للإقصاء بسبب تأخر المراجعة (${delay.missedRevisionDaysCount} أيام فائتة)`;
  }
  return null;
}

/** Quarters of the range [start..end] the member has not recited yet. */
export function missingRangeQuarters(
  rangeStart: number,
  rangeEnd: number,
  completedQuarters: Set<number>
): number[] {
  const missing: number[] = [];
  for (let q = rangeStart; q <= rangeEnd; q++) {
    if (!completedQuarters.has(q)) missing.push(q);
  }
  return missing;
}

export interface CandidateEvaluation {
  is_eligible: boolean;
  reasons: string[];
  has_passed: boolean;
  missing_quarters: number;
  is_eliminable: boolean;
  /** Last quarter the questions cover (the whole range unless partial ranges are allowed). */
  effective_range_end: number;
  covers_full_range: boolean;
}

export function evaluateCandidate(input: {
  test: Pick<PeerTestRow, 'range_start' | 'range_end' | 'require_all_quarters_completed' | 'require_revision_completed'>;
  completedQuarters: Set<number>;
  passedAttempts: PassedAttempt[];
  delay: MemberDelayStatus;
  inAudience: boolean;
  /** Needed only when the test requires the revision to be complete. */
  revision?: { missedRevisionDaysCount: number; hasReviewedToday: boolean };
}): CandidateEvaluation {
  const { test } = input;
  const reasons: string[] = [];

  if (!input.inAudience) {
    reasons.push('ليس ضمن الأعضاء المشمولين بهذا الاختبار');
  }

  // Legacy attempts without range data count as covering the full range.
  const hasPassedFull = input.passedAttempts.some((a) => a.covers_full_range !== false);
  if (hasPassedFull) {
    reasons.push('سبق له اجتياز هذا الاختبار');
  }

  let effectiveRangeEnd = test.range_end;
  let missingCount = 0;

  if (test.require_all_quarters_completed) {
    const missing = missingRangeQuarters(test.range_start, test.range_end, input.completedQuarters);
    missingCount = missing.length;
    if (missing.length > 0) {
      reasons.push(
        `لم يُتمّ تسميع جميع أرباع النطاق بعد (متبقٍ ${missing.length} من الأرباع ${test.range_start} إلى ${test.range_end})`
      );
    }
  } else {
    // The questions cover the consecutive recited part of the range.
    let lastConsecutive = 0;
    while (input.completedQuarters.has(lastConsecutive + 1)) lastConsecutive++;
    effectiveRangeEnd = Math.min(test.range_end, lastConsecutive);
    missingCount = missingRangeQuarters(test.range_start, test.range_end, input.completedQuarters).length;
    if (lastConsecutive < test.range_start) {
      effectiveRangeEnd = test.range_end;
      reasons.push(
        `لم يُسمّع بداية نطاق الاختبار بعد (أتمّ حتى الربع ${lastConsecutive} ويبدأ الاختبار من الربع ${test.range_start})`
      );
    } else if (
      !hasPassedFull &&
      input.passedAttempts.some(
        (a) => typeof a.effective_range_end === 'number' && a.effective_range_end >= effectiveRangeEnd
      )
    ) {
      reasons.push(
        `سبق له اجتياز الاختبار لهذا النطاق (حتى الربع ${effectiveRangeEnd})، ويمكن إعادة اختباره بعد إتمام أرباع إضافية`
      );
    }
  }

  if (test.require_revision_completed && input.revision) {
    if (input.revision.missedRevisionDaysCount > 0) {
      reasons.push(`توجد أيام مراجعة فائتة (${input.revision.missedRevisionDaysCount} يوم)`);
    }
    if (!input.revision.hasReviewedToday) {
      reasons.push('لم يؤكد مراجعة اليوم بعد');
    }
  }

  const elimination = eliminationReason(input.delay);
  if (elimination) {
    reasons.push(elimination);
  }

  return {
    is_eligible: reasons.length === 0,
    reasons,
    has_passed: hasPassedFull,
    missing_quarters: missingCount,
    is_eliminable: input.delay.isSeverelyBehind,
    effective_range_end: effectiveRangeEnd,
    covers_full_range: effectiveRangeEnd === test.range_end,
  };
}

/**
 * The quarter the member would recite next: his first missing quarter,
 * or tomorrow's quarter when he is fully caught up.
 */
export function nextTasmiaQuarter(delay: MemberDelayStatus, quarterOfDay: number): number {
  return delay.allCompletedUpToToday ? quarterOfDay + 1 : delay.requiredQuarter;
}
