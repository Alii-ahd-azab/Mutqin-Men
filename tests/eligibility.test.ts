// Peer-test candidate rules (pure; no network): overdue self-revision never blocks a candidate; only
// overdue Tasmi'a does, at the Men threshold (4+). Delay statuses come from the same shared code the
// Edge Function uses. Audience, ranges and passes are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateCandidate, isPeerTestLive, nextTasmiaQuarter, tasmiaDelayReason, type PassedAttempt } from '../supabase/functions/_shared/peer-tests/eligibility.ts';
import { computeMemberDelayStatus, SEVERE_DELAY_THRESHOLD } from '../supabase/functions/_shared/logic/memberDelayStatus.ts';

const TODAY = '2026-10-30';
const DATES = Array.from({ length: 30 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
const TEST = { range_start: 1, range_end: 5, require_all_quarters_completed: true };
const source = (f: string) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

/** A member on program day 30 with these overdue counts (quarters 1..5 of the range always recited). */
function member(overdueTasmia: number, overdueRevision: number) {
  const missedQuarters = new Set(Array.from({ length: overdueTasmia }, (_, i) => 6 + i));
  const quarters = Array.from({ length: 30 }, (_, i) => i + 1).filter((q) => !missedQuarters.has(q));
  const recitations = quarters.map((q) => ({ member_id: 'm', quarter_number: q }));
  const missedDates = new Set(DATES.slice(0, overdueRevision));
  const revisions = DATES.filter((d) => !missedDates.has(d)).map((date) => ({ member_id: 'm', date }));
  const delay = computeMemberDelayStatus({ memberId: 'm', quarterOfDay: 30, activeCycleDates: DATES, recitations, revisions, todayDate: TODAY });
  return { delay, completedQuarters: new Set(quarters) };
}
const evaluate = (t: number, r: number, passedAttempts: PassedAttempt[] = [], over: Partial<typeof TEST> = {}) =>
  evaluateCandidate({ test: { ...TEST, ...over }, passedAttempts, inAudience: true, ...member(t, r) });

test('1. no overdue Tasmi\'a, no overdue revision: eligible', () => {
  assert.deepEqual(evaluate(0, 0).reasons, []);
  assert.equal(evaluate(0, 0).is_eligible, true);
});

for (const days of [1, 3, 4, 5, 20]) {
  test(`2-4. no overdue Tasmi'a + ${days} overdue revision day(s): still eligible`, () => {
    const e = evaluate(0, days);
    assert.equal(member(0, days).delay.missedRevisionDaysCount, days);
    assert.equal(e.is_eligible, true);
    assert.deepEqual(e.reasons, []);
  });
}

test('5-6. Men threshold is unchanged: 2 and 3 overdue quarters do not block, 4+ blocks', () => {
  assert.equal(SEVERE_DELAY_THRESHOLD, 4);
  assert.equal(evaluate(2, 0).is_eligible, true);
  assert.equal(evaluate(3, 0).is_eligible, true);
  const e = evaluate(4, 0);
  assert.equal(e.is_eligible, false);
  assert.deepEqual(e.reasons, ['مؤهل للإقصاء بسبب تأخر التسميع (4 أرباع فائتة)']);
  assert.equal(evaluate(9, 0).is_eligible, false);
});

test('7. both overdue: blocked because of Tasmi\'a, and the reason does not mention revision', () => {
  const e = evaluate(5, 10);
  assert.equal(e.is_eligible, false);
  assert.equal(e.reasons.length, 1);
  assert.match(e.reasons[0], /تأخر التسميع \(5 أرباع فائتة\)/);
  assert.doesNotMatch(e.reasons.join(), /المراجعة/);
  assert.equal(tasmiaDelayReason(member(0, 9).delay), null);
});

test('8. is_eliminable still reports the general status (information, not a block)', () => {
  const e = evaluate(0, 5);
  assert.equal(member(0, 5).delay.isSeverelyBehind, true);
  assert.equal(e.is_eliminable, true);
  assert.equal(e.is_eligible, true);
});

test('«إتمام المراجعة»: a test stored with the old flag no longer blocks anyone because of reviews', () => {
  const old = { ...TEST, require_revision_completed: true };
  const e = evaluateCandidate({ test: old, passedAttempts: [], inAudience: true, ...member(0, 10) });
  assert.equal(e.is_eligible, true);
  assert.deepEqual(e.reasons, []);
  // The eligibility code has no revision path left.
  const eligibility = source('supabase/functions/_shared/peer-tests/eligibility.ts');
  assert.doesNotMatch(eligibility, /require_revision_completed|hasReviewedToday|distantOverdueCount|isSeverelyBehindRevision/);
  const edge = source('supabase/functions/peer-tests/index.ts');
  assert.doesNotMatch(edge, /calculateMemberRevisionStatus|calculateMemberDistantReviewStatus|test\.require_revision_completed/);
  assert.match(edge, /p_require_revision_completed: false/);
});

test('9. range completion is unchanged: a missing range quarter blocks when the whole range is required', () => {
  const m = member(0, 0);
  m.completedQuarters.delete(3);
  const e = evaluateCandidate({ test: TEST, passedAttempts: [], inAudience: true, ...m });
  assert.equal(e.is_eligible, false);
  assert.equal(e.missing_quarters, 1);
  assert.match(e.reasons[0], /جميع أرباع النطاق/);
});

test('partial ranges are unchanged: the questions cover the consecutive recited part', () => {
  const m = member(0, 7);
  for (const q of [4, 5]) m.completedQuarters.delete(q);
  const e = evaluateCandidate({ test: { ...TEST, require_all_quarters_completed: false }, passedAttempts: [], inAudience: true, ...m });
  assert.equal(e.is_eligible, true);
  assert.equal(e.effective_range_end, 3);
  assert.equal(e.covers_full_range, false);
});

test('10. already passed is unchanged: a full pass blocks for good, a partial pass until more is recited', () => {
  const full = evaluate(0, 5, [{ covers_full_range: true, effective_range_end: 5 }]);
  assert.equal(full.is_eligible, false);
  assert.equal(full.has_passed, true);
  assert.deepEqual(full.reasons, ['سبق له اجتياز هذا الاختبار']);
  const m = member(0, 5);
  for (const q of [4, 5]) m.completedQuarters.delete(q);
  const partial = evaluateCandidate({ test: { ...TEST, require_all_quarters_completed: false }, passedAttempts: [{ covers_full_range: false, effective_range_end: 3 }], inAudience: true, ...m });
  assert.equal(partial.is_eligible, false);
  assert.match(partial.reasons[0], /سبق له اجتياز الاختبار لهذا النطاق/);
});

test('audience is unchanged: a member outside the selected audience is not a candidate', () => {
  const e = evaluateCandidate({ test: TEST, passedAttempts: [], inAudience: false, ...member(0, 0) });
  assert.equal(e.is_eligible, false);
  assert.match(e.reasons[0], /المشمولين/);
});

test('11. examiner rule is unchanged: it does not read any delay status', () => {
  const src = source('supabase/functions/peer-tests/index.ts');
  const fn = src.slice(src.indexOf('function requireExaminer'), src.indexOf('function requireManager'));
  assert.ok(fn.length > 0);
  assert.doesNotMatch(fn, /delay|evaluate/i);
  assert.match(fn, /caller\.role !== 'member' \|\| caller\.memberBatchId !== cycle\.batch_id/);
  assert.match(fn, /isPeerTestLive\(test\)/);
});

test('12. candidate list, start and submit all use the one evaluate() → evaluateCandidate path', () => {
  const src = source('supabase/functions/peer-tests/index.ts');
  assert.equal(src.match(/evaluateCandidate\(\{/g)?.length, 1);
  assert.equal(src.match(/\.\.\.evaluate\(test, selected, progress, passed, m\.id\)/g)?.length, 1, 'candidates');
  assert.equal(src.match(/= evaluate\(test, selected, progress, passed, candidate\.id\)/g)?.length, 1, 'start');
  assert.equal(src.match(/= evaluate\(test, selected, progress, new Map\(\), attempt\.candidate_id\)/g)?.length, 1, 'submit');
});

test('mandatory-test Tasmi\'a blocking and the live window are unchanged', () => {
  assert.equal(nextTasmiaQuarter(member(0, 0).delay, 30), 31);
  assert.equal(nextTasmiaQuarter(member(3, 5).delay, 30), 6);
  assert.equal(isPeerTestLive({ status: 'published', visible_from: null, visible_until: null }), true);
  assert.equal(isPeerTestLive({ status: 'hidden', visible_from: null, visible_until: null }), false);
});

test('UI: members see the corrected conditions; admins are no longer offered «إتمام المراجعة»', () => {
  const card = source('src/components/TestConditionsCard.tsx');
  assert.doesNotMatch(card, /تأخر التسميع أو المراجعة/);
  assert.match(card, /ألا يكون العضو مؤهلًا/);
  assert.match(card, /ولا يمنع تأخر المراجعة الذاتية من دخول الاختبار/);
  const admin = source('src/components/AdminPeerTestsTab.tsx');
  assert.doesNotMatch(admin, /require_revision_completed|إتمام المراجعة/);
  assert.match(admin, /إتمام تسميع جميع أرباع النطاق/);
});
