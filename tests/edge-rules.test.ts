// Rules shared by the web app and the Edge Functions (pure; no network): the Men program mapping,
// the Sisters delay / elimination status with the Men threshold, peer-test eligibility with the Men
// rules and question generation. Imports the very files that are deployed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCandidate,
  eliminationReason,
  isInAudience,
  isPeerTestLive,
  nextTasmiaQuarter,
} from '../supabase/functions/_shared/peer-tests/eligibility.ts';
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

// ---------------------------------------------------------------------------------------------
// Review identity = program day (regression: completed ranges on other dates shown overdue)
// ---------------------------------------------------------------------------------------------
// Status with the calendar facts, as the app calls it.
const statusCal = (p: ReturnType<typeof program>, logs: RevisionLog[], today: string, joined?: string) =>
  calculateMemberRevisionStatus('m', getActiveCycleDates(START, today, p.restDays, p.settings), logs, today, joined, p.settings);
const rangeOn = (p: ReturnType<typeof program>, d: string) => {
  const c = calculateCycleInfo(p.settings, p.restDays, d);
  return `${c.review_start}→${c.review_end}`;
};
// A row stored at confirmation time for obligation date `forDate`, confirmed on `onDate`.
const confirmed = (p: ReturnType<typeof program>, forDate: string, onDate: string): RevisionLog => ({ ...review(p, forDate), id: `${forDate}@${onDate}`, date: onDate });

test('day A 8→15 and day B 9→16 confirmed later (X, Y) are not overdue; history keeps X and Y', () => {
  const p = program();
  const A = '2026-10-15';
  const B = '2026-10-16';
  assert.equal(rangeOn(p, A), '8→15');
  assert.equal(rangeOn(p, B), '9→16');
  const others = days(1, 14).map((d) => review(p, d));
  const X = confirmed(p, A, '2026-10-18');
  const Y = confirmed(p, B, '2026-10-19');
  const logs = [...others, X, Y, review(p, '2026-10-17'), review(p, '2026-10-18'), review(p, '2026-10-19')].filter(
    (r, i, all) => all.findIndex((o) => o.date === r.date) === i || r === X || r === Y
  );
  const s = statusCal(p, logs, '2026-10-20');
  assert.ok(!s.pastMissedDates.includes(A) && !s.pastMissedDates.includes(B), JSON.stringify(s.pastMissedDates));
  assert.equal(X.date, '2026-10-18');
  assert.equal(Y.date, '2026-10-19');
  assert.equal(new Set(s.pastMissedDates).size, s.pastMissedDates.length, 'no duplicated card');
});

test('same day, several days late, on a rest day and during a pause: all count once', () => {
  const p = program(['2026-10-12'], { pause_periods: [{ from: '2026-10-14', to: '2026-10-15' }] });
  const active = getActiveCycleDates(START, '2026-10-17', p.restDays, p.settings);
  const logs = [
    ...active.filter((d) => !['2026-10-05', '2026-10-09', '2026-10-11', '2026-10-13'].includes(d)).map((d) => review(p, d)),
    confirmed(p, '2026-10-05', '2026-10-08'), // several days late (10-08 also has its own review)
    confirmed(p, '2026-10-11', '2026-10-12'), // on a rest day
    confirmed(p, '2026-10-13', '2026-10-15'), // during a pause
  ].filter((r, i, all) => all.findIndex((o) => o.id === r.id) === i);
  const s = statusCal(p, logs, '2026-10-17');
  assert.deepEqual(s.pastMissedDates, ['2026-10-09']); // only the genuinely missing day
});

test('calendar edited after the reviews (undated paused days, past pause period): no false overdue either way', () => {
  // Stored under an older calendar, evaluated under the edited one.
  const old = program();
  const logs = days(1, 19).map((d) => review(old, d));
  // Edit 1: 3 undated paused days recognised later — stored ranges are now HIGHER than the dates' days.
  assert.deepEqual(statusCal(program([], { total_paused_days: 3 }), logs, '2026-10-20').pastMissedDates, []);
  // Edit 2: undated paused days removed (e.g. turned into a dated past period) — ranges now LOWER.
  const was = program([], { total_paused_days: 3 });
  const logs2 = days(1, 19).map((d) => review(was, d));
  const now = program([], { total_paused_days: 1 });
  assert.deepEqual(statusCal(now, logs2, '2026-10-20').pastMissedDates, []);
  // Retroactive and multiple rest days after the reviews.
  assert.deepEqual(statusCal(program(['2026-10-04', '2026-10-05', '2026-10-11']), logs, '2026-10-20').pastMissedDates, []);
});

test('distinct ranges stay distinct and genuine gaps stay overdue on the unconfirmed date', () => {
  const p = program();
  // Only 9→16 (day 16) was reviewed, on its own date: day 15 (8→15) stays overdue.
  const s = statusCal(p, [...days(1, 14).map((d) => review(p, d)), review(p, '2026-10-16')], '2026-10-17');
  assert.deepEqual(s.pastMissedDates, ['2026-10-15']);
  // One row cannot serve two days: a late 8→15 confirmed on 10-17 covers day 15 OR its own date,
  // never both; the open day is the date the member never confirmed.
  const late = statusCal(p, [...days(1, 14).map((d) => review(p, d)), confirmed(p, '2026-10-15', '2026-10-17')], '2026-10-18');
  assert.equal(late.pastMissedDates.length, 2); // days 16 and 17 have no row of their own
  assert.ok(!late.pastMissedDates.includes('2026-10-15'));
  assert.equal(late.uncreditedReviews.length, 0);
  // A duplicate confirmation of the same range credits one day only.
  const dup = statusCal(p, [...days(1, 14).map((d) => review(p, d)), review(p, '2026-10-15'), confirmed(p, '2026-10-15', '2026-10-16')], '2026-10-17');
  assert.deepEqual(dup.pastMissedDates, []); // 10-16 row sits on its own date: credits day 16
  const dup2 = statusCal(p, [...days(1, 14).map((d) => review(p, d)), review(p, '2026-10-15'), confirmed(p, '2026-10-15', '2026-10-15')], '2026-10-17');
  assert.equal(dup2.pastMissedDates.length, 1);
});

// ---------------------------------------------------------------------------------------------
// «المراجعة البعيدة» (distant-review days): calendar, obligations, peer-test prerequisite
// ---------------------------------------------------------------------------------------------
import {
  calculateMemberDistantReviewStatus,
  calculateMemberRequiredQuarter,
} from '../supabase/functions/_shared/logic/calculations.ts';
import type { DistantReviewAssignment, DistantReviewCompletion } from '../supabase/functions/_shared/logic/programTypes.ts';

const withDistant = (dates: string[], restDates: string[] = [], extra: Partial<GroupSettings> = {}) =>
  program(restDates, { distant_review_dates: dates, ...extra });
const assignment = (date: string, start = 1, end = 12, id = `a-${date}`): DistantReviewAssignment => ({
  id, batch_id: 'b', cycle_id: 'c', review_date: date, start_quarter: start, end_quarter: end, created_at: '', updated_at: '',
});
const done = (a: DistantReviewAssignment, on: string, member = 'm'): DistantReviewCompletion => ({
  id: `${a.id}-${member}`, assignment_id: a.id, member_id: member, completed_at: `${on}T10:00:00Z`, completed_on: on,
});
const dayOf = (p: ReturnType<typeof program>, d: string) => calculateCycleInfo(p.settings, p.restDays, d).cycle_day;

test('distant review: Oct 5 does not consume a program day (Oct 1–4, then Oct 6 = day 5)', () => {
  const p = withDistant(['2026-10-05']);
  assert.deepEqual(getActiveCycleDates(START, '2026-10-06', p.restDays, p.settings), [...days(1, 4), '2026-10-06']);
  assert.deepEqual(days(1, 6).map((d) => dayOf(p, d)), [1, 2, 3, 4, 4, 5]);
  const info = calculateCycleInfo(p.settings, p.restDays, '2026-10-05');
  assert.equal(info.is_distant_review_day, true);
  assert.equal(info.is_rest_day, false);
  assert.equal(info.distant_review_days_count, 1);
  // Monday q30 → Tuesday distant (still 30, no new quarter) → Wednesday q31
  const q = withDistant(['2026-10-31']);
  assert.deepEqual(['2026-10-30', '2026-10-31', '2026-11-01'].map((d) => dayOf(q, d)), [30, 30, 31]);
});

test('distant review: several manual days, consecutive and separated, each skipped once', () => {
  const p = withDistant(['2026-10-05', '2026-10-06', '2026-10-12']);
  assert.deepEqual(getActiveCycleDates(START, '2026-10-13', p.restDays, p.settings), [...days(1, 4), ...days(7, 11), '2026-10-13']);
  assert.equal(dayOf(p, '2026-10-13'), 10);
  assert.equal(calculateCycleInfo(p.settings, p.restDays, '2026-10-13').distant_review_days_count, 3);
});

test('distant review: a date that is also a rest day or paused is never counted twice', () => {
  // (the database forbids rest day + distant review on one date; the calendar stays safe anyway)
  const both = withDistant(['2026-10-05'], ['2026-10-05']);
  assert.equal(dayOf(both, '2026-10-06'), 5);
  const paused = withDistant(['2026-10-05'], [], { pause_periods: [{ from: '2026-10-04', to: '2026-10-06' }] });
  assert.equal(dayOf(paused, '2026-10-07'), 4);
  assert.equal(calculateCycleInfo(paused.settings, paused.restDays, '2026-10-05').is_distant_review_day, false);
  assert.equal(calculateCycleInfo(paused.settings, paused.restDays, '2026-10-07').distant_review_days_count, 0);
});

test('distant review: deleting a future day restores it; adding one never changes past days', () => {
  const plain = program();
  const scheduled = withDistant(['2026-10-20']);
  for (const d of days(1, 19)) assert.equal(dayOf(scheduled, d), dayOf(plain, d), d);
  assert.equal(dayOf(scheduled, '2026-10-21'), dayOf(plain, '2026-10-21') - 1);
  const deleted = withDistant([]);
  assert.equal(dayOf(deleted, '2026-10-21'), dayOf(plain, '2026-10-21'));
  assert.deepEqual(getActiveCycleDates(START, '2026-10-21', deleted.restDays, deleted.settings), days(1, 21));
});

test("distant review today: no new normal Tasmi'a or daily review, the assignment is due", () => {
  const p = withDistant(['2026-10-05']);
  const a = assignment('2026-10-05');
  const logs = days(1, 4).map((d) => review(p, d));
  const rev = status(p, logs, '2026-10-05');
  assert.equal(rev.isTodayProgramDay, false);
  assert.equal(rev.pastMissedRevisionDaysCount, 0);
  assert.deepEqual(rev.missedDates, []);
  // Tasmi'a: the group quarter stays at 4, a member who recited 1..4 owes nothing new.
  const recs = [1, 2, 3, 4].map((q) => ({ member_id: 'm', quarter_number: q }));
  const tasmia = calculateMemberRequiredQuarter('m', dayOf(p, '2026-10-05'), recs);
  assert.equal(tasmia.allCompletedUpToToday, true);
  assert.equal(tasmia.pastMissedQuartersCount, 0);
  const s = calculateMemberDistantReviewStatus('m', [a], [], p.settings, p.restDays, '2026-10-05');
  assert.equal(s.todayAssignment?.id, a.id);
  assert.equal(s.overdueCount, 0);
  assert.deepEqual(s.outstanding.map((x) => x.id), [a.id]);
});

test('distant review: completed today → no debt tomorrow; missed → overdue tomorrow; late completion clears it', () => {
  const p = withDistant(['2026-10-05']);
  const a = assignment('2026-10-05');
  const onTime = calculateMemberDistantReviewStatus('m', [a], [done(a, '2026-10-05')], p.settings, p.restDays, '2026-10-06');
  assert.equal(onTime.overdueCount, 0);
  const missed = calculateMemberDistantReviewStatus('m', [a], [], p.settings, p.restDays, '2026-10-06');
  assert.deepEqual(missed.overdue.map((x) => x.id), [a.id]);
  // Still owed days later, the program having moved on.
  assert.equal(calculateMemberDistantReviewStatus('m', [a], [], p.settings, p.restDays, '2026-10-20').overdueCount, 1);
  const late = done(a, '2026-10-07');
  const after = calculateMemberDistantReviewStatus('m', [a], [late], p.settings, p.restDays, '2026-10-08');
  assert.equal(after.overdueCount, 0);
  assert.equal(after.completionByAssignment.get(a.id)?.completed_on, '2026-10-07');
  // Another member's completion never settles his.
  assert.equal(calculateMemberDistantReviewStatus('m', [a], [done(a, '2026-10-05', 'x')], p.settings, p.restDays, '2026-10-06').overdueCount, 1);
});

test('distant review: several missed days stay separately owed, even with overlapping ranges', () => {
  const p = withDistant(['2026-10-06', '2026-10-13']);
  const a1 = assignment('2026-10-06', 1, 12);
  const a2 = assignment('2026-10-13', 5, 12);
  const s = calculateMemberDistantReviewStatus('m', [a2, a1], [], p.settings, p.restDays, '2026-10-14');
  assert.deepEqual(s.overdue.map((x) => x.id), [a1.id, a2.id]);
  const one = calculateMemberDistantReviewStatus('m', [a1, a2], [done(a2, '2026-10-14')], p.settings, p.restDays, '2026-10-14');
  assert.deepEqual(one.overdue.map((x) => x.id), [a1.id]);
});

test('distant review: not owed before joining, before the date, or on a paused date', () => {
  const p = withDistant(['2026-10-05', '2026-10-09'], [], { pause_periods: [{ from: '2026-10-08', to: '2026-10-10' }] });
  const a = assignment('2026-10-05');
  const pausedA = assignment('2026-10-09');
  assert.equal(calculateMemberDistantReviewStatus('m', [a], [], p.settings, p.restDays, '2026-10-20', '2026-10-06').overdueCount, 0);
  assert.equal(calculateMemberDistantReviewStatus('m', [a], [], p.settings, p.restDays, '2026-10-04').outstanding.length, 0);
  assert.equal(calculateMemberDistantReviewStatus('m', [pausedA], [], p.settings, p.restDays, '2026-10-20').overdueCount, 0);
  // Open (global) pause covering the date: no obligation either.
  const open = withDistant(['2026-10-05'], [], { is_paused: true, paused_at: '2026-10-04' });
  assert.equal(calculateMemberDistantReviewStatus('m', [a], [], open.settings, open.restDays, '2026-10-05').todayAssignment, null);
});

test('distant review: normal historical overdue reviews are unaffected', () => {
  const p = withDistant(['2026-10-05']);
  const logs = ['2026-10-01', '2026-10-02', '2026-10-04', '2026-10-06'].map((d) => review(p, d)); // Oct 3 missed
  const s = status(p, logs, '2026-10-07');
  assert.deepEqual(s.pastMissedDates, ['2026-10-03']);
});

test("peer test with require_revision_completed: distant-review debt blocks, today's distant review replaces the daily one", () => {
  const t = { ...test8, require_revision_completed: true };
  const base = { test: t, completedQuarters: quarters(1, 2, 3, 4, 5, 6, 7, 8), passedAttempts: [], delay: okDelay, inAudience: true };
  assert.equal(evaluateCandidate({ ...base, revision: { missedRevisionDaysCount: 0, hasReviewedToday: true } }).is_eligible, true);
  const overdue = evaluateCandidate({ ...base, revision: { missedRevisionDaysCount: 0, hasReviewedToday: true, distantOverdueCount: 2 } });
  assert.equal(overdue.is_eligible, false);
  assert.match(overdue.reasons.join(' '), /مراجعات بعيدة متأخرة \(2\)/);
  const todayPending = evaluateCandidate({ ...base, revision: { missedRevisionDaysCount: 0, hasReviewedToday: true, distantTodayPending: true } });
  assert.match(todayPending.reasons.join(' '), /المراجعة البعيدة لليوم/);
  // Without the prerequisite, distant debt does not matter.
  assert.equal(evaluateCandidate({ ...base, test: test8, revision: undefined }).is_eligible, true);
});

test("settings mapping carries this cycle's distant-review dates (sorted), absent when none", () => {
  assert.equal('distant_review_dates' in buildSettings(cycle, [], null), false);
  assert.deepEqual(buildSettings(cycle, [], null, ['2026-11-13', '2026-11-06']).distant_review_dates, ['2026-11-06', '2026-11-13']);
});

// «المراجعة البعيدة» range boundary and quarter metadata (the TO quarter is where the review stops).
import { ALL_QUARTERS, getDistantReviewBounds, distantReviewQuarterCount, getRangeBounds } from '../src/data/quranData.ts';
import mushafLines from '../supabase/functions/_shared/data/mushafLines.json' with { type: 'json' };

test('distant review FROM 1 / TO 9: starts at the beginning of quarter 1 and stops at the BEGINNING of quarter 9', () => {
  const b = getDistantReviewBounds(1, 9);
  assert.deepEqual([b.start.surahNumber, b.start.ayahNumber], [2, 1]);
  assert.deepEqual([b.stop.surahNumber, b.stop.ayahNumber], [2, 142]); // سيقول السفهاء من الناس
  assert.match(b.stop.ayahText, /سَيَقُولُ/);
  assert.notEqual(b.stop.ayahNumber, ALL_QUARTERS[9].ayahStart); // never the beginning of quarter 10 (2:158)
  assert.doesNotMatch(b.stop.ayahText, /ٱلصَّفَا/);
  assert.equal(distantReviewQuarterCount(1, 9), 8);
  // Last possible boundary: stop at the beginning of quarter 240.
  assert.equal(getDistantReviewBounds(239, 240).stop.ayahNumber, ALL_QUARTERS[239].ayahStart);
  // The normal daily review keeps its own semantics (end quarter included → stops at quarter 10).
  assert.equal(getRangeBounds(1, 9).stop.ayahNumber, 158);
});

test('quarter metadata: juz, hizb, Mushaf page (from mushafLines.json) and ayah for all 240 quarters', () => {
  const pageOf = new Map((mushafLines as { surah: number; ayah: number; page: number }[]).map((a) => [`${a.surah}:${a.ayah}`, a.page]));
  assert.equal(ALL_QUARTERS.length, 240);
  for (const q of ALL_QUARTERS) {
    assert.ok(q.juz >= 1 && q.hizb >= 1 && q.ayahStart >= 1, `quarter ${q.number}`);
    assert.equal(q.page, pageOf.get(`${q.surahNumber}:${q.ayahStart}`), `page of quarter ${q.number}`);
  }
  assert.deepEqual([ALL_QUARTERS[8].juz, ALL_QUARTERS[8].hizb, ALL_QUARTERS[8].page, ALL_QUARTERS[8].ayahStart], [2, 3, 22, 142]);
  for (let i = 1; i < 240; i++) assert.ok(ALL_QUARTERS[i].page >= ALL_QUARTERS[i - 1].page);
});
