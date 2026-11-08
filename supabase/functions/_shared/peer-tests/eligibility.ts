// Peer-testing rules (pure functions, unit-tested; used by the Edge Function).
// Same model as Mutqin for Sisters. Two rules are deliberately SEPARATE:
//   * a CANDIDATE must have recited the range, must not have passed already,
//     and must not be severely behind in Tasmi'a. Overdue self-revision never
//     prevents him from taking a test;
//   * an EXAMINER only needs to be an active member of the test's batch (and,
//     Men rule, of its audience) — being «مؤهل للإقصاء» does NOT prevent him
//     from examining others.
// Men additions: selected-audience tests, the full-range prerequisite, and a
// partially recited range (effective_range_end / covers_full_range) when the
// test does not require the whole range.

import { SEVERE_DELAY_THRESHOLD, type MemberDelayStatus } from '../logic/memberDelayStatus.ts';

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

/**
 * Arabic reason when overdue Tasmi'a blocks a candidate, otherwise null.
 * Overdue self-revision is deliberately not a reason.
 */
export function tasmiaDelayReason(delay: MemberDelayStatus): string | null {
  return delay.isSeverelyBehindRecitation
    ? `مؤهل للإقصاء بسبب تأخر التسميع (${delay.missedQuartersCount} أرباع فائتة)`
    : null;
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

/** A pass that lifts the mandatory checkpoint (legacy passes without range data count as full). */
export const passesFullRange = (attempts: PassedAttempt[]): boolean => attempts.some((a) => a.covers_full_range !== false);

/**
 * THE mandatory-test checkpoint, same rule as the Tasmi'a guard in the database: a live mandatory
 * test of his audience that he has not passed (full range) stops him from reciting the quarters
 * after its range. Tests of quarters before a fresh start never apply. Used by the candidate rule,
 * the admin impact count and the member dashboard.
 */
export function isBlockedByMandatoryTest(input: {
  test: Pick<PeerTestRow, 'test_type' | 'status' | 'visible_from' | 'visible_until' | 'range_start' | 'range_end'>;
  inAudience: boolean;
  hasPassedFull: boolean;
  /** The quarter he would recite next (nextTasmiaQuarter). */
  nextQuarter: number;
  /** Fresh start: first quarter owed (default 1). */
  startQuarter?: number;
  now?: Date;
}): boolean {
  return (
    input.test.test_type === 'mandatory' &&
    isPeerTestLive(input.test, input.now) &&
    input.inAudience &&
    !input.hasPassedFull &&
    input.nextQuarter > input.test.range_end &&
    input.test.range_start >= (input.startQuarter ?? 1)
  );
}

export function evaluateCandidate(input: {
  test: Pick<PeerTestRow, 'range_start' | 'range_end' | 'require_all_quarters_completed'> &
    Partial<Pick<PeerTestRow, 'test_type' | 'status' | 'visible_from' | 'visible_until'>>;
  completedQuarters: Set<number>;
  passedAttempts: PassedAttempt[];
  delay: MemberDelayStatus;
  inAudience: boolean;
  /**
   * The batch's quarter of the day and his starting quarter. With them, quarters that THIS test's
   * checkpoint forbids him to recite are not counted against him: finishing the range must lead to
   * the test, never to an exclusion that keeps him out of it. (The Edge Function always passes it.)
   */
  gate?: { quarterOfDay: number; startQuarter?: number; now?: Date };
}): CandidateEvaluation {
  const { test } = input;
  const reasons: string[] = [];

  if (!input.inAudience) {
    reasons.push('ليس ضمن الأعضاء المشمولين بهذا الاختبار');
  }

  // Legacy attempts without range data count as covering the full range.
  const hasPassedFull = passesFullRange(input.passedAttempts);
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

  // While this test's checkpoint blocks him, every quarter he still owes lies after the range
  // (that is what triggers the checkpoint), so none of them is his delay: only overdue quarters he
  // was allowed to recite (up to the range end) count.
  const gated =
    !!input.gate &&
    !!input.test.test_type &&
    !!input.test.status &&
    isBlockedByMandatoryTest({
      test: input.test as Pick<PeerTestRow, 'test_type' | 'status' | 'visible_from' | 'visible_until' | 'range_start' | 'range_end'>,
      inAudience: input.inAudience,
      hasPassedFull,
      nextQuarter: nextTasmiaQuarter(input.delay, input.gate.quarterOfDay),
      startQuarter: input.gate.startQuarter,
      now: input.gate.now,
    });
  const ownOverdue = gated
    ? input.delay.missedQuarters.filter((q) => q <= test.range_end && q < input.gate!.quarterOfDay).length
    : input.delay.missedQuartersCount;
  const tasmiaDelay = gated
    ? ownOverdue >= SEVERE_DELAY_THRESHOLD
      ? `مؤهل للإقصاء بسبب تأخر التسميع (${ownOverdue} أرباع فائتة)`
      : null
    : tasmiaDelayReason(input.delay);
  if (tasmiaDelay) {
    reasons.push(tasmiaDelay);
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
