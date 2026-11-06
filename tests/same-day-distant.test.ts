// Turning TODAY into a «المراجعة البعيدة» day, on the shared calendar (pure; no network). The database
// move itself is covered by tests/db.test.ts; `convert` below applies the same rule to in-memory rows:
// today's normal rows leave the live data. Rows are shaped like Men's: a review carries its date and
// the end quarter the database computed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateCycleInfo,
  calculateMemberDistantReviewStatus,
  calculateMemberRequiredQuarter,
  calculateMemberRevisionStatus,
  getActiveCycleDates,
  programDayOfDate,
} from '../supabase/functions/_shared/logic/calculations.ts';
import { computeMemberDelayStatus, SEVERE_DELAY_THRESHOLD } from '../supabase/functions/_shared/logic/memberDelayStatus.ts';
import { buildSettings, mapVoidedRecords, type CycleRow } from '../supabase/functions/_shared/men/menRows.ts';
import { addDays } from '../supabase/functions/_shared/logic/programDate.ts';
import type { DistantReviewAssignment, RestDay } from '../supabase/functions/_shared/logic/programTypes.ts';

const START = '2026-10-19';
const TODAY = '2026-11-06'; // program day 19 when nothing is off
const TOMORROW = addDays(TODAY, 1);
const YESTERDAY = addDays(TODAY, -1);
const cycle: CycleRow = { id: 'c', batch_id: 'b', cycle_number: 1, starts_on: START, status: 'active', total_quarters: 240, review_window: 8, legacy_paused_days: 0, created_at: '2026-10-01T00:00:00Z' };

const restOf = (dates: string[]): RestDay[] => dates.map((date) => ({ id: date, date, note: '', added_by_admin_id: '', created_at: '' }));
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

interface World {
  distant?: string[];
  rest?: string[];
  pauses?: { paused_on: string; resumed_on: string | null }[];
  legacyPaused?: number;
  start?: string;
}
const calendar = (w: World = {}) => ({
  settings: buildSettings({ ...cycle, starts_on: w.start ?? START, legacy_paused_days: w.legacyPaused ?? 0 }, w.pauses ?? [], null, w.distant ?? []),
  restDays: restOf(w.rest ?? []),
});

type Review = { date: string; end: number };
type Member = { tasmia: number[]; reviews: Review[]; joinedOn?: string; startQuarter?: number };
/** The review rows of days 1..n, each confirmed on its own date (no day off before today). */
const reviewsUpTo = (n: number): Review[] => range(n).map((d) => ({ date: addDays(START, d - 1), end: d }));

/** A member's status on a date, exactly as the dashboards and the Edge Functions read it. */
function statusOn(date: string, member: Member, w: World = {}) {
  const { settings, restDays } = calendar(w);
  const info = calculateCycleInfo(settings, restDays, date);
  const active = getActiveCycleDates(settings.start_date, date, restDays, settings);
  const revisions = member.reviews.map((r) => ({ member_id: 'm', date: r.date, review_end_quarter: r.end }));
  const recitations = member.tasmia.map((q) => ({ member_id: 'm', quarter_number: q }));
  return {
    info,
    active,
    quarter: calculateMemberRequiredQuarter('m', info.quarter_of_day, recitations, member.startQuarter),
    revision: calculateMemberRevisionStatus('m', active, revisions, date, member.joinedOn, settings),
    delay: computeMemberDelayStatus({
      memberId: 'm', quarterOfDay: info.quarter_of_day, activeCycleDates: active, recitations, revisions, todayDate: date,
      joinedOnDate: member.joinedOn, startQuarter: member.startQuarter, calendar: settings,
    }),
  };
}

/** What the conversion does to one member's rows (the database moves them to voided_daily_records). */
const convert = (m: Member, cancelledDay: number): Member => ({
  ...m,
  tasmia: m.tasmia.filter((q) => q !== cancelledDay),
  reviews: m.reviews.filter((r) => r.date !== TODAY),
});

const CONVERTED: World = { distant: [TODAY] };
const memberA: Member = { tasmia: range(19), reviews: reviewsUpTo(19) }; // submitted today's normal work
const memberB: Member = { tasmia: range(18), reviews: reviewsUpTo(18) }; // did nothing today

test('A. a future distant-review day is unchanged: today and the days before it keep their numbers', () => {
  const w: World = { distant: [addDays(TODAY, 3)] };
  const { settings, restDays } = calendar(w);
  assert.equal(calculateCycleInfo(settings, restDays, TODAY).cycle_day, 19);
  assert.equal(calculateCycleInfo(settings, restDays, addDays(TODAY, 2)).cycle_day, 21);
  assert.equal(calculateCycleInfo(settings, restDays, addDays(TODAY, 3)).cycle_day, 21);
  assert.equal(calculateCycleInfo(settings, restDays, addDays(TODAY, 4)).cycle_day, 22);
  assert.equal(programDayOfDate(settings, restDays, addDays(TODAY, 3)), null);
  assert.deepEqual(statusOn(TODAY, memberA, w).delay, statusOn(TODAY, memberA).delay);
});

test('programDayOfDate: the day a date adds to the calendar, null when it adds none', () => {
  const { settings, restDays } = calendar();
  assert.equal(programDayOfDate(settings, restDays, TODAY), 19);
  assert.equal(programDayOfDate(settings, restDays, START), 1);
  assert.equal(programDayOfDate(settings, restDays, addDays(START, -1)), null);
  const rest = calendar({ rest: [TODAY] });
  assert.equal(programDayOfDate(rest.settings, rest.restDays, TODAY), null);
  const open = calendar({ pauses: [{ paused_on: YESTERDAY, resumed_on: null }] });
  assert.equal(programDayOfDate(open.settings, open.restDays, TODAY), null);
  const closed = calendar({ pauses: [{ paused_on: TODAY, resumed_on: TOMORROW }] });
  assert.equal(programDayOfDate(closed.settings, closed.restDays, TODAY), null);
  assert.equal(programDayOfDate(closed.settings, closed.restDays, TOMORROW), 19, 'the day after a pause adds the next day');
  const already = calendar(CONVERTED);
  assert.equal(programDayOfDate(already.settings, already.restDays, TODAY), null);
});

test('programDayOfDate follows the Men calendar: undated paused days, the clamped start, the last quarter', () => {
  // 6 legacy paused days: the 19th active date is program day 13, not 19.
  const legacy = calendar({ legacyPaused: 6 });
  assert.equal(calculateCycleInfo(legacy.settings, legacy.restDays, TODAY).cycle_day, 13);
  assert.equal(programDayOfDate(legacy.settings, legacy.restDays, TODAY), 13);
  // Active dates still inside the undated paused days share day 1: they add no day...
  assert.equal(programDayOfDate(legacy.settings, legacy.restDays, addDays(START, 5)), null);
  // ...the first date past them does.
  assert.equal(programDayOfDate(legacy.settings, legacy.restDays, addDays(START, 7)), 2);
  // The last quarter: day 240 is cancellable; the days after it add nothing.
  const late = calendar({ start: addDays(TODAY, -239) });
  assert.equal(programDayOfDate(late.settings, late.restDays, TODAY), 240);
  assert.equal(programDayOfDate(late.settings, late.restDays, TOMORROW), null);
});

test('C. today N+1 becomes N after the conversion', () => {
  assert.equal(statusOn(TODAY, memberA).info.cycle_day, 19);
  const after = statusOn(TODAY, convert(memberA, 19), CONVERTED);
  assert.equal(after.info.cycle_day, 18);
  assert.equal(after.info.quarter_of_day, 18);
  assert.equal(after.info.review_end, 18);
  assert.equal(after.info.is_distant_review_day, true);
  assert.equal(after.active.includes(TODAY), false);
});

test('D. the next active day is exactly N+1', () => {
  const next = statusOn(TOMORROW, convert(memberA, 19), CONVERTED);
  assert.equal(next.info.cycle_day, 19);
  assert.equal(next.info.review_end, 19);
  assert.equal(next.active.length, 19);
});

test('E. a Tasmi\'a submitted today stops counting; the same quarter is due on the next active day', () => {
  const a = convert(memberA, 19);
  assert.equal(statusOn(TODAY, a, CONVERTED).quarter.allCompletedUpToToday, true);
  const next = statusOn(TOMORROW, a, CONVERTED);
  assert.equal(next.quarter.requiredQuarter, 19);
  assert.equal(next.quarter.hasCompletedToday, false);
  assert.equal(next.quarter.pastMissedQuartersCount, 0);
});

test('F. a review confirmed today stops counting; the next active day\'s review is due', () => {
  const next = statusOn(TOMORROW, convert(memberA, 19), CONVERTED);
  assert.equal(next.revision.hasReviewedToday, false);
  assert.deepEqual(next.revision.missedDates, [TOMORROW]);
  assert.deepEqual(next.revision.pastMissedDates, []);
});

test('why the rows must move: left in place they would satisfy day N+1 (and could clear a real debt)', () => {
  // The row keeps end_quarter 19, so it credits the next active day.
  assert.equal(statusOn(TOMORROW, { ...memberA, tasmia: memberA.tasmia }, CONVERTED).revision.hasReviewedToday, true);
  assert.equal(statusOn(TOMORROW, memberA, CONVERTED).quarter.hasCompletedToday, true);
  // Missed yesterday's review, confirmed today's: on the converted day the row credits yesterday's
  // day by its date, and on the next day it satisfies day N+1 by its range.
  const missedYesterday: Member = { tasmia: range(19), reviews: [...reviewsUpTo(17), { date: TODAY, end: 19 }] };
  assert.deepEqual(statusOn(TODAY, missedYesterday, CONVERTED).revision.pastMissedDates, [], 'without moving it the debt disappears');
  assert.equal(statusOn(TOMORROW, missedYesterday, CONVERTED).revision.hasReviewedToday, true);
  const moved = convert(missedYesterday, 19);
  assert.deepEqual(statusOn(TODAY, moved, CONVERTED).revision.pastMissedDates, [YESTERDAY], 'moved: the real debt stays');
  assert.deepEqual(statusOn(TOMORROW, moved, CONVERTED).revision.pastMissedDates, [YESTERDAY]);
  assert.equal(statusOn(TOMORROW, moved, CONVERTED).revision.hasReviewedToday, false);
});

test('G. a member who did nothing today gets no debt, today or on the next active day', () => {
  const today = statusOn(TODAY, memberB, CONVERTED);
  assert.equal(today.delay.missedQuartersCount, 0);
  assert.equal(today.delay.missedRevisionDaysCount, 0);
  assert.equal(today.quarter.allCompletedUpToToday, true);
  const next = statusOn(TOMORROW, memberB, CONVERTED);
  assert.equal(next.quarter.requiredQuarter, 19);
  assert.equal(next.delay.missedQuartersCount, 0);
  assert.equal(next.delay.missedRevisionDaysCount, 0);
});

test('both members end up in the same state, today and on the next active day', () => {
  const a = convert(memberA, 19);
  assert.deepEqual(statusOn(TODAY, a, CONVERTED).delay, statusOn(TODAY, memberB, CONVERTED).delay);
  assert.deepEqual(statusOn(TOMORROW, a, CONVERTED).delay, statusOn(TOMORROW, memberB, CONVERTED).delay);
});

test('H. catch-up Tasmi\'a of an earlier quarter recited today stays valid', () => {
  // Quarter 15 was recited today as catch-up, then quarters 16-19. Only 19 is the cancelled day's.
  const m: Member = { tasmia: range(19), reviews: reviewsUpTo(18) };
  const after = convert(m, 19);
  assert.deepEqual(after.tasmia, range(18));
  assert.equal(statusOn(TODAY, after, CONVERTED).delay.missedQuartersCount, 0);
  // A member still behind keeps the rest of his debt and no more.
  const behind: Member = { tasmia: [...range(14), 15], reviews: reviewsUpTo(18) };
  assert.equal(statusOn(TODAY, convert(behind, 19), CONVERTED).delay.missedQuartersCount, 2);
});

test('I. catch-up review of an earlier program day confirmed today stays valid', () => {
  // The row of day 15 keeps its own date; only the row dated today is cancelled.
  const m: Member = { tasmia: range(19), reviews: [...reviewsUpTo(19)] };
  const after = convert(m, 19);
  assert.deepEqual(after.reviews.map((r) => r.end), range(18));
  assert.deepEqual(statusOn(TOMORROW, after, CONVERTED).revision.pastMissedDates, []);
});

test('J. no fake missed day appears anywhere after the conversion', () => {
  for (const m of [convert(memberA, 19), memberB]) {
    for (const date of [TODAY, TOMORROW]) {
      const s = statusOn(date, m, CONVERTED);
      assert.deepEqual(s.revision.pastMissedDates, []);
      assert.deepEqual(s.quarter.pastMissedQuarters, []);
    }
  }
  assert.ok(!statusOn(TOMORROW, memberB, CONVERTED).revision.missedDates.includes(TODAY));
});

test('K. severe-delay counts do not increase because today was converted', () => {
  assert.equal(SEVERE_DELAY_THRESHOLD, 4);
  // Three overdue of each before the conversion: still three, on both days.
  const behind: Member = {
    tasmia: range(19).filter((q) => ![15, 16, 17].includes(q)),
    reviews: reviewsUpTo(19).filter((r) => ![15, 16, 17].includes(r.end)),
  };
  const before = statusOn(TODAY, behind).delay;
  assert.deepEqual([before.missedQuartersCount, before.missedRevisionDaysCount, before.isSeverelyBehind], [3, 3, false]);
  for (const date of [TODAY, TOMORROW]) {
    const d = statusOn(date, convert(behind, 19), CONVERTED).delay;
    assert.deepEqual([d.missedQuartersCount, d.missedRevisionDaysCount, d.isSeverelyBehind], [3, 3, false], date);
  }
});

test('L. the distant review itself works normally on the converted day', () => {
  const { settings, restDays } = calendar(CONVERTED);
  const a = { id: 'a1', batch_id: 'b', cycle_id: 'c', review_date: TODAY, start_quarter: 1, end_quarter: 9, created_at: '', updated_at: '' } as DistantReviewAssignment;
  const owed = calculateMemberDistantReviewStatus('m', [a], [], settings, restDays, TODAY);
  assert.equal(owed.todayAssignment?.id, 'a1');
  assert.equal(owed.hasCompletedToday, false);
  const late = calculateMemberDistantReviewStatus('m', [a], [], settings, restDays, TOMORROW);
  assert.deepEqual(late.overdue.map((x) => x.id), ['a1']);
  const done = calculateMemberDistantReviewStatus('m', [a], [{ id: 'x', assignment_id: 'a1', member_id: 'm', completed_at: '', completed_on: TODAY }], settings, restDays, TODAY);
  assert.equal(done.hasCompletedToday, true);
});

test('M. rest or pause + distant review on today does not cancel an extra program day', () => {
  for (const off of [{ rest: [TODAY] }, { pauses: [{ paused_on: TODAY, resumed_on: TOMORROW }] }, { pauses: [{ paused_on: YESTERDAY, resumed_on: null }] }] as World[]) {
    const w = { ...off, distant: [TODAY] };
    const before = calendar(off);
    const after = calendar(w);
    assert.equal(calculateCycleInfo(after.settings, after.restDays, TODAY).cycle_day, calculateCycleInfo(before.settings, before.restDays, TODAY).cycle_day);
    assert.equal(calculateCycleInfo(after.settings, after.restDays, TOMORROW).cycle_day, calculateCycleInfo(before.settings, before.restDays, TOMORROW).cycle_day);
    assert.equal(programDayOfDate(before.settings, before.restDays, TODAY), null, 'nothing to void');
  }
});

test('undated paused days: the conversion cancels the calendar\'s day, not the active-date index', () => {
  const legacy: World = { legacyPaused: 6 };
  const { settings, restDays } = calendar(legacy);
  const cancelled = programDayOfDate(settings, restDays, TODAY)!;
  assert.equal(cancelled, 13);
  const conv = { ...legacy, distant: [TODAY] };
  const m: Member = { tasmia: range(13), reviews: [...range(12).map((d) => ({ date: addDays(START, d + 5), end: d })), { date: TODAY, end: 13 }] };
  const after = convert(m, cancelled);
  assert.equal(statusOn(TODAY, after, conv).info.cycle_day, 12);
  const next = statusOn(TOMORROW, after, conv);
  assert.equal(next.info.cycle_day, 13);
  assert.equal(next.quarter.requiredQuarter, 13);
  assert.equal(next.revision.hasReviewedToday, false);
  assert.equal(next.delay.missedQuartersCount, 0);
});

test('fresh-start member created today at N+1: no debt today, owes exactly N+1 on the next active day', () => {
  const fresh: Member = { tasmia: [], reviews: [], joinedOn: TODAY, startQuarter: 19 };
  const today = statusOn(TODAY, fresh, CONVERTED);
  assert.equal(today.info.quarter_of_day, 18);
  assert.equal(today.quarter.allCompletedUpToToday, true);
  assert.equal(today.delay.missedQuartersCount, 0);
  assert.equal(today.delay.missedRevisionDaysCount, 0);
  const next = statusOn(TOMORROW, fresh, CONVERTED);
  assert.equal(next.quarter.requiredQuarter, 19);
  assert.equal(next.delay.missedQuartersCount, 0);
  assert.deepEqual(next.revision.missedDates, [TOMORROW]);
  assert.deepEqual(next.revision.pastMissedDates, []);
});

test('voided rows map to the history shape (date = the converted date; absent optional fields omitted)', () => {
  const rows = mapVoidedRecords([
    { id: 'v1', kind: 'tasmia', user_id: 'm', program_day: 19, program_date: TODAY, start_quarter: null, end_quarter: null, listener_name_snapshot: 'س', notes: null, voided_at: '2026-11-06T10:00:00+00:00' },
    { id: 'v2', kind: 'review', user_id: 'm', program_day: 19, program_date: TODAY, start_quarter: 12, end_quarter: 19, listener_name_snapshot: null, notes: 'ن', voided_at: '2026-11-06T10:00:00+00:00' },
  ]);
  assert.deepEqual(rows[0], { id: 'v1', kind: 'tasmia', member_id: 'm', program_day: 19, date: TODAY, listener_name: 'س', voided_at: '2026-11-06T10:00:00.000Z' });
  assert.deepEqual(rows[1], { id: 'v2', kind: 'review', member_id: 'm', program_day: 19, date: TODAY, review_start_quarter: 12, review_end_quarter: 19, notes: 'ن', voided_at: '2026-11-06T10:00:00.000Z' });
});
