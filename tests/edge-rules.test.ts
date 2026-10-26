// Rules shared by the web app and the Edge Functions (pure; no network): the Men program mapping,
// the Sisters delay / elimination status with the Men threshold, peer-test eligibility with the Men
// rules, question generation and personal self-tests. Imports the very files that are deployed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCandidate,
  eliminationReason,
  isInAudience,
  isPeerTestLive,
  nextTasmiaQuarter,
} from '../supabase/functions/_shared/peer-tests/eligibility.ts';
import { RuleError, parsePersonalSetup, generatePersonalQuestions } from '../supabase/functions/_shared/peer-tests/personalTests.ts';
import { generateTestQuestions, estimateRangeLines } from '../supabase/functions/_shared/peer-tests/testGenerator.ts';
import { computeMemberDelayStatus, SEVERE_DELAY_THRESHOLD, type MemberDelayStatus } from '../supabase/functions/_shared/logic/memberDelayStatus.ts';
import { buildSettings, mapUser } from '../supabase/functions/_shared/men/menRows.ts';

const cycle = { id: 'c', batch_id: 'b', cycle_number: 1, starts_on: '2026-09-17', status: 'active', total_quarters: 240, review_window: 8, legacy_paused_days: 6, created_at: '2026-09-01T00:00:00Z' };
const test8 = { range_start: 1, range_end: 8, require_all_quarters_completed: false, require_revision_completed: false };
const okDelay: MemberDelayStatus = {
  requiredQuarter: 9,
  isBehind: false,
  allCompletedUpToToday: true,
  missedQuarters: [],
  missedQuartersCount: 0,
  missedRevisionDaysCount: 0,
  missedRevisionDates: [],
  isSeverelyBehindRecitation: false,
  isSeverelyBehindRevision: false,
  isSeverelyBehind: false,
  severeReasons: [],
};
const quarters = (...q: number[]) => new Set(q);

test('settings mapping: open pause, closed periods (inclusive), same-day resume ignored, thought', () => {
  const s = buildSettings(cycle, [
    { paused_on: '2026-10-24', resumed_on: null },
    { paused_on: '2026-10-01', resumed_on: '2026-10-03' },
    { paused_on: '2026-10-10', resumed_on: '2026-10-10' },
  ], { content_html: '<p>x</p>', published_at: '2026-10-09T08:48:41.432+00:00', published_by_name_snapshot: 'م' });
  assert.equal(s.is_paused, true);
  assert.equal(s.paused_at, '2026-10-24');
  assert.deepEqual(s.pause_periods, [{ from: '2026-10-01', to: '2026-10-02' }]);
  assert.equal(s.daily_thought_updated_at, '2026-10-09T08:48:41.432Z');
  assert.equal(s.total_paused_days, 6);
});

test('user mapping carries the Sisters account fields', () => {
  const u = mapUser({ id: 'u', full_name: ' أحمد ', phone: ' 05 ', role: 'admin', active: true, created_at: '2026-09-01T00:00:00Z', is_master_admin: true, firestore_id: null });
  assert.deepEqual(u, { id: 'u', name: 'أحمد', phone: '05', role: 'admin', is_active: true, created_at: '2026-09-01T00:00:00.000Z', auth_uid: 'u', is_master_admin: true });
});

test('delay status: Men elimination threshold is more than 3 (4+) missed past items', () => {
  assert.equal(SEVERE_DELAY_THRESHOLD, 4);
  const dates = ['2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22'];
  const status = (reviewed: string[]) =>
    computeMemberDelayStatus({
      memberId: 'a',
      quarterOfDay: 6,
      activeCycleDates: dates,
      recitations: [1, 2, 3, 4, 5, 6].map((q) => ({ member_id: 'a', quarter_number: q })),
      revisions: reviewed.map((date) => ({ member_id: 'a', date })),
      todayDate: '2026-09-22',
    });
  assert.equal(status(dates.slice(3)).missedRevisionDaysCount, 3);
  assert.equal(status(dates.slice(3)).isSeverelyBehind, false);
  assert.equal(status(dates.slice(4)).missedRevisionDaysCount, 4);
  assert.equal(status(dates.slice(4)).isSeverelyBehind, true);
  // Days before the member joined his current batch are not owed.
  const joined = computeMemberDelayStatus({
    memberId: 'a', quarterOfDay: 6, activeCycleDates: dates, recitations: [], revisions: [], todayDate: '2026-09-22', joinedOnDate: '2026-09-21',
  });
  assert.equal(joined.missedRevisionDaysCount, 1); // only 2026-09-21 is owed
});

test('live window, audience and next quarter', () => {
  const now = new Date('2026-10-26T12:00:00Z');
  assert.equal(isPeerTestLive({ status: 'published', visible_from: null, visible_until: null }, now), true);
  assert.equal(isPeerTestLive({ status: 'published', visible_from: '2026-10-27T00:00:00Z', visible_until: null }, now), false);
  assert.equal(isPeerTestLive({ status: 'published', visible_from: null, visible_until: '2026-10-26T11:00:00Z' }, now), false);
  assert.equal(isPeerTestLive({ status: 'hidden', visible_from: null, visible_until: null }, now), false);
  assert.equal(isInAudience({ audience: 'all' }, new Set(), 'a'), true);
  assert.equal(isInAudience({ audience: 'selected' }, new Set(['b']), 'a'), false);
  assert.equal(nextTasmiaQuarter(okDelay, 12), 13);
  assert.equal(nextTasmiaQuarter({ ...okDelay, allCompletedUpToToday: false, requiredQuarter: 4 }, 12), 4);
});

test('candidate: Men partial range, full range requirement, passes and audience', () => {
  const base = { completedQuarters: quarters(1, 2, 3), passedAttempts: [], delay: okDelay, inAudience: true };
  const partial = evaluateCandidate({ ...base, test: test8 });
  assert.equal(partial.is_eligible, true);
  assert.equal(partial.effective_range_end, 3);
  assert.equal(partial.covers_full_range, false);

  const full = evaluateCandidate({ ...base, test: { ...test8, require_all_quarters_completed: true } });
  assert.equal(full.is_eligible, false);
  assert.equal(full.missing_quarters, 5);
  assert.match(full.reasons[0], /جميع أرباع النطاق/);

  assert.equal(evaluateCandidate({ ...base, completedQuarters: quarters(), test: test8 }).is_eligible, false);
  assert.match(evaluateCandidate({ ...base, inAudience: false, test: test8 }).reasons.join(), /المشمولين/);

  // A partial pass blocks a retest until more quarters are recited; a full pass blocks for good.
  const partialPass = [{ covers_full_range: false, effective_range_end: 3 }];
  assert.equal(evaluateCandidate({ ...base, passedAttempts: partialPass, test: test8 }).is_eligible, false);
  assert.equal(evaluateCandidate({ ...base, completedQuarters: quarters(1, 2, 3, 4), passedAttempts: partialPass, test: test8 }).is_eligible, true);
  const fullPass = evaluateCandidate({ ...base, passedAttempts: [{ covers_full_range: null, effective_range_end: null }], test: test8 });
  assert.equal(fullPass.has_passed, true);
  assert.equal(fullPass.is_eligible, false);
});

test('candidate: «مؤهل للإقصاء» blocks the candidate (Sisters rule) with a masculine reason; revision prerequisite', () => {
  const eliminable = { ...okDelay, missedQuartersCount: 4, isSeverelyBehindRecitation: true, isSeverelyBehind: true, severeReasons: ['recitation' as const] };
  assert.equal(eliminationReason(eliminable), 'مؤهل للإقصاء بسبب تأخر التسميع (4 أرباع فائتة)');
  const r = evaluateCandidate({ test: test8, completedQuarters: quarters(1, 2), passedAttempts: [], delay: eliminable, inAudience: true });
  assert.equal(r.is_eligible, false);
  assert.equal(r.is_eliminable, true);

  const rev = { ...test8, require_revision_completed: true };
  const base = { test: rev, completedQuarters: quarters(1), passedAttempts: [], delay: okDelay, inAudience: true };
  assert.equal(evaluateCandidate({ ...base, revision: { missedRevisionDaysCount: 0, hasReviewedToday: true } }).is_eligible, true);
  assert.equal(evaluateCandidate({ ...base, revision: { missedRevisionDaysCount: 1, hasReviewedToday: true } }).is_eligible, false);
  assert.equal(evaluateCandidate({ ...base, revision: { missedRevisionDaysCount: 0, hasReviewedToday: false } }).is_eligible, false);
});

test('question generation stays inside the (effective) range with Mushaf geometry', () => {
  const qs = generateTestQuestions(1, 3, 2, 5, 'any');
  assert.equal(qs.length, 2);
  assert.ok(qs.every((q) => q.actual_lines > 0 && q.start_page > 0 && q.end_line > 0 && q.start_text && q.difficulty_level));
  assert.ok(estimateRangeLines(1, 8) > estimateRangeLines(1, 3));
});

test('personal test setup and generation return the resolved range for saving', () => {
  const setup = parsePersonalSetup({ range_type: 'juz', start_juz: 30, end_juz: 30, questions_count: 3, lines_per_question: 2, difficulty: 'any' });
  const r = generatePersonalQuestions(setup);
  assert.equal(r.questions.length, 3);
  assert.equal(r.setup.start_quarter, 233);
  assert.equal(r.setup.end_quarter, 240);
  assert.match(r.setup.range_label, /الجزء 30/);
  assert.throws(() => parsePersonalSetup({ range_type: 'surah', start_surah: 5, end_surah: 2, questions_count: 1, lines_per_question: 1 }), RuleError);
});

// ---------------------------------------------------------------------------------------------
// Rest days / pauses and review obligations (regression: duplicated range, false overdue)
// ---------------------------------------------------------------------------------------------
import { calculateCycleInfo, getActiveCycleDates, calculateMemberRevisionStatus } from '../supabase/functions/_shared/logic/calculations.ts';
import type { GroupSettings, RestDay, RevisionLog } from '../supabase/functions/_shared/logic/programTypes.ts';

const START = '2026-10-01';
const program = (restDates: string[] = [], extra: Partial<GroupSettings> = {}) => {
  const settings: GroupSettings = {
    id: 'x', start_date: START, total_quarters: 240, review_window: 8, current_cycle_number: 1,
    is_paused: false, paused_at: null, total_paused_days: 0, ...extra,
  };
  const restDays: RestDay[] = restDates.map((d, i) => ({ id: `r${i}`, date: d, note: '', added_by_admin_id: '', created_at: '' }));
  return { settings, restDays };
};
// A review stored the way the database guard stores it: by date, range = program day of that date.
const review = (p: ReturnType<typeof program>, date: string): RevisionLog => {
  const day = calculateCycleInfo(p.settings, p.restDays, date).cycle_day;
  return { id: date, member_id: 'm', member_name: 'm', date, cycle_number: 1, review_start_quarter: Math.max(1, day - 7), review_end_quarter: day, created_at: '' };
};
const status = (p: ReturnType<typeof program>, logs: RevisionLog[], today: string) =>
  calculateMemberRevisionStatus('m', getActiveCycleDates(START, today, p.restDays, p.settings), logs, today);
const days = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `2026-10-${String(from + i).padStart(2, '0')}`);

test('retroactive rest day: completed reviews stay completed, the schedule shifts by one day', () => {
  const before = program();
  const logs = days(1, 9).map((d) => review(before, d)); // every day 1..9 reviewed when it happened
  assert.deepEqual(status(before, logs, '2026-10-10').pastMissedDates, []);
  assert.equal(calculateCycleInfo(before.settings, before.restDays, '2026-10-10').cycle_day, 10);

  for (const rest of [['2026-10-04'], ['2026-10-04', '2026-10-05'], ['2026-10-02', '2026-10-07'], ['2026-10-09']]) {
    const after = program(rest);
    const s = status(after, logs, '2026-10-10');
    assert.deepEqual(s.pastMissedDates, [], `rest ${rest}`); // no false overdue
    assert.equal(calculateCycleInfo(after.settings, after.restDays, '2026-10-10').cycle_day, 10 - rest.length, `rest ${rest}`);
  }
  assert.equal(logs.length, 9, 'history untouched');
});

test('rest day today: no new obligation, and the last active day is not repeated', () => {
  const p = program(['2026-10-10']);
  const logs = days(1, 9).map((d) => review(p, d));
  const s = status(p, logs, '2026-10-10');
  assert.equal(s.isTodayProgramDay, false); // the dashboard shows no "today" card → no duplicated range
  assert.deepEqual(s.pastMissedDates, []);
  // The frozen range today is exactly the last active day's range (what used to be duplicated).
  assert.equal(calculateCycleInfo(p.settings, p.restDays, '2026-10-10').review_end, calculateCycleInfo(p.settings, p.restDays, '2026-10-09').review_end);
});

test('a review recorded on a rest/pause date satisfies the last active day (the range it holds)', () => {
  // Day 9 was not confirmed on 10-09; the member confirmed it on the rest day 10-10.
  const p = program(['2026-10-10']);
  const logs = [...days(1, 8).map((d) => review(p, d)), review(p, '2026-10-10')];
  assert.equal(logs[8].review_end_quarter, calculateCycleInfo(p.settings, p.restDays, '2026-10-09').cycle_day);
  assert.deepEqual(status(p, logs, '2026-10-11').pastMissedDates, []);
  // Same with a pause: paused from 10-10 (open), review stored on 10-11.
  const paused = program([], { is_paused: true, paused_at: '2026-10-10' });
  const pLogs = [...days(1, 8).map((d) => review(paused, d)), review(paused, '2026-10-11')];
  const ps = status(paused, pLogs, '2026-10-12');
  assert.equal(ps.isTodayProgramDay, false);
  assert.deepEqual(ps.pastMissedDates, []);
  // Closed past pause period 10-04..10-05 with reviews on every calendar day.
  const closed = program([], { pause_periods: [{ from: '2026-10-04', to: '2026-10-05' }] });
  assert.deepEqual(status(closed, days(1, 9).map((d) => review(closed, d)), '2026-10-10').pastMissedDates, []);
});

test('genuinely missing reviews stay overdue; different days are never merged', () => {
  const p = program(['2026-10-05']);
  // Day of 10-03 missing; 10-06 missing (10-05 is a rest day, reviews on 10-04 and 10-07).
  const logs = ['2026-10-01', '2026-10-02', '2026-10-04', '2026-10-07', '2026-10-08'].map((d) => review(p, d));
  assert.deepEqual(status(p, logs, '2026-10-09').pastMissedDates, ['2026-10-03', '2026-10-06']);
  // One review never satisfies an EARLIER missed day, only the latest active day on or before it.
  assert.deepEqual(status(p, [review(p, '2026-10-02')], '2026-10-04').pastMissedDates, ['2026-10-01', '2026-10-03']);
  // A missed day followed by a rest-day review still counts the earlier missed days.
  const r = program(['2026-10-04']);
  assert.deepEqual(status(r, [review(r, '2026-10-01'), review(r, '2026-10-04')], '2026-10-05').pastMissedDates, ['2026-10-02']);
  // A future-dated review credits nothing.
  assert.deepEqual(status(p, [review(p, '2026-10-01'), { ...review(p, '2026-10-02'), date: '2026-10-03' }], '2026-10-02').pastMissedDates, []);
  assert.equal(status(p, [review(p, '2026-10-01'), { ...review(p, '2026-10-02'), date: '2026-10-03' }], '2026-10-02').hasReviewedToday, false);
});

test('overdue cards are unique dates with distinct ranges', () => {
  const p = program(['2026-10-04', '2026-10-05']);
  const s = status(p, [review(p, '2026-10-01')], '2026-10-09');
  assert.equal(new Set(s.pastMissedDates).size, s.pastMissedDates.length);
  const ends = s.pastMissedDates.map((d) => calculateCycleInfo(p.settings, p.restDays, d).review_end);
  assert.equal(new Set(ends).size, ends.length);
  // Today (active) has its own, later range.
  assert.ok(calculateCycleInfo(p.settings, p.restDays, '2026-10-09').review_end > Math.max(...ends));
});
