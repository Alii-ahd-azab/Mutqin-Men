// The 05:00 Africa/Cairo program date and the derived notifications (pure; no network). Every date
// below goes through programDate(), and every status through the same shared calculations the
// dashboards use; the notifications only read those results.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  membershipDate,
  nextProgramDayStart,
  programDate,
  programDayStart,
  PROGRAM_TIME_ZONE,
} from '../supabase/functions/_shared/logic/programDate.ts';
import {
  calculateCycleInfo,
  calculateMemberDistantReviewStatus,
  calculateMemberRequiredQuarter,
  calculateMemberRevisionStatus,
  getActiveCycleDates,
  isPausedDate,
  joinedOnDateFromTimestamp,
} from '../supabase/functions/_shared/logic/calculations.ts';
import { computeMemberDelayStatus } from '../supabase/functions/_shared/logic/memberDelayStatus.ts';
import {
  buildBatchAdminAlerts,
  buildMemberNotifications,
  debtLevel,
  SERIOUS_DEBT_THRESHOLD,
} from '../supabase/functions/_shared/logic/notifications.ts';
import { computeBatchDelays } from '../supabase/functions/_shared/men/batchDelays.ts';
import type {
  DistantReviewAssignment,
  DistantReviewCompletion,
  GroupSettings,
  RecitationLog,
  RestDay,
  RevisionLog,
  User,
} from '../supabase/functions/_shared/logic/programTypes.ts';

// ---------------------------------------------------------------------------------------------
// Program date: 05:00 Africa/Cairo
// ---------------------------------------------------------------------------------------------

/** The instant of a Cairo wall-clock time, given Cairo's UTC offset on that day (+3 summer, +2 winter). */
const cairo = (date: string, time: string, offsetHours: 2 | 3) =>
  new Date(Date.parse(`${date}T${time}Z`) - offsetHours * 3600_000);

const BOUNDARY_CASES: [string, string][] = [
  ['00:00:00', 'previous'],
  ['02:00:00', 'previous'],
  ['04:30:00', 'previous'],
  ['04:59:59', 'previous'],
  ['05:00:00', 'new'],
  ['05:00:01', 'new'],
  ['12:00:00', 'new'],
  ['23:59:59', 'new'],
];

for (const [label, date, offset] of [
  ['summer (UTC+3, DST)', '2026-07-15', 3],
  ['winter (UTC+2)', '2026-01-15', 2],
  ['the example date 2026-10-28 (UTC+3)', '2026-10-28', 3],
  ['after DST ends, 2026-11-02 (UTC+2)', '2026-11-02', 2],
] as const) {
  test(`program date: the day changes at exactly 05:00 Cairo — ${label}`, () => {
    for (const [time, expected] of BOUNDARY_CASES) {
      const got = programDate(cairo(date, time, offset));
      assert.equal(got, expected === 'new' ? date : addDays(date, -1), `${date} ${time} Cairo`);
    }
  });
}

test('program date uses the Africa/Cairo rules, not a fixed UTC offset', () => {
  assert.equal(PROGRAM_TIME_ZONE, 'Africa/Cairo');
  // The same UTC time of day falls on different sides of 05:00 Cairo in summer and in winter.
  assert.equal(programDate(new Date('2026-07-15T02:30:00Z')), '2026-07-15'); // 05:30 Cairo (UTC+3)
  assert.equal(programDate(new Date('2026-01-15T02:30:00Z')), '2026-01-14'); // 04:30 Cairo (UTC+2)
  // Either fixed offset gets one of them wrong.
  const fixed = (iso: string, h: number) => new Date(Date.parse(iso) + (h - 5) * 3600_000).toISOString().slice(0, 10);
  assert.notEqual(fixed('2026-01-15T02:30:00Z', 3), programDate(new Date('2026-01-15T02:30:00Z')));
  assert.notEqual(fixed('2026-07-15T02:30:00Z', 2), programDate(new Date('2026-07-15T02:30:00Z')));
  // Start of a program day, in both offsets; the next start from any instant.
  assert.equal(programDayStart('2026-10-28').toISOString(), '2026-10-28T02:00:00.000Z');
  assert.equal(programDayStart('2026-01-15').toISOString(), '2026-01-15T03:00:00.000Z');
  assert.equal(nextProgramDayStart(cairo('2026-10-28', '04:59:59', 3)).toISOString(), '2026-10-28T02:00:00.000Z');
  assert.equal(nextProgramDayStart(cairo('2026-10-28', '05:00:00', 3)).toISOString(), '2026-10-29T02:00:00.000Z');
  // Across the end of DST (night of 29→30 October 2026) the next start is 05:00 standard time.
  assert.equal(nextProgramDayStart(new Date('2026-10-29T12:00:00Z')).toISOString(), '2026-10-30T03:00:00.000Z');
});

test("program date ignores the device's time zone", () => {
  const saved = process.env.TZ;
  const instant = cairo('2026-10-28', '04:59:59', 3);
  const results = new Set<string>();
  try {
    for (const tz of ['Africa/Cairo', 'Asia/Riyadh', 'Europe/London', 'America/Los_Angeles', 'Pacific/Kiritimati', 'UTC']) {
      process.env.TZ = tz;
      results.add(programDate(instant));
      results.add(programDate(new Date(instant.getTime() + 1000)));
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
  assert.deepEqual([...results].sort(), ['2026-10-27', '2026-10-28']);
});

test('stored membership dates keep their Makkah calendar date (no join date moves)', () => {
  // Real join timestamps whose Cairo-05:00 date would be one day earlier.
  assert.equal(membershipDate('2026-09-19T21:02:47.654+00:00'), '2026-09-20');
  assert.equal(membershipDate('2026-09-18T23:23:15.158+00:00'), '2026-09-19');
  assert.equal(joinedOnDateFromTimestamp('2026-09-17T21:05:25.606+00:00'), '2026-09-18');
});

// ---------------------------------------------------------------------------------------------
// A small program: started 2026-10-20, every date-sensitive status read at a Cairo instant
// ---------------------------------------------------------------------------------------------

const START = '2026-10-20';
const settingsOf = (extra: Partial<GroupSettings> = {}): GroupSettings => ({
  id: 'c',
  start_date: START,
  total_quarters: 240,
  review_window: 8,
  current_cycle_number: 1,
  is_paused: false,
  paused_at: null,
  total_paused_days: 0,
  ...extra,
});
const rest = (date: string, note = ''): RestDay => ({ id: `r-${date}`, date, note, added_by_admin_id: 'a', created_at: '' });
const tasmia = (member: string, quarters: number[]): RecitationLog[] =>
  quarters.map((q) => ({ id: `t-${member}-${q}`, member_id: member, member_name: member, quarter_number: q, cycle_number: 1, date: START, created_at: '' }));
const reviews = (member: string, dates: string[]): RevisionLog[] =>
  dates.map((d) => ({ id: `v-${member}-${d}`, member_id: member, member_name: member, date: d, cycle_number: 1, review_start_quarter: 0, review_end_quarter: undefined as unknown as number, created_at: '' }));
const assignment = (date: string, start: number, end: number, note?: string): DistantReviewAssignment => ({
  id: `d-${date}`,
  batch_id: 'b',
  cycle_id: 'c',
  review_date: date,
  start_quarter: start,
  end_quarter: end,
  note,
  created_at: '',
  updated_at: '',
});
const JOINED = '2026-10-19T12:00:00Z';

interface World {
  settings?: GroupSettings;
  restDays?: RestDay[];
  recitations?: RecitationLog[];
  revisions?: RevisionLog[];
  distant?: DistantReviewAssignment[];
  completions?: DistantReviewCompletion[];
  joinedAt?: string;
  startQuarter?: number;
  isActive?: boolean;
}

/** The member dashboard's pipeline (MemberDashboard.tsx) at an instant, for member "m". */
function memberAt(instant: Date, w: World) {
  const settings = w.settings ?? settingsOf({ distant_review_dates: (w.distant ?? []).map((a) => a.review_date) });
  const restDays = w.restDays ?? [];
  const today = programDate(instant);
  const cycleInfo = calculateCycleInfo(settings, restDays, today);
  const activeDates = getActiveCycleDates(cycleInfo.start_date, today, restDays, settings);
  const joined = joinedOnDateFromTimestamp(w.joinedAt ?? JOINED);
  const quarter = calculateMemberRequiredQuarter('m', cycleInfo.quarter_of_day, w.recitations ?? [], w.startQuarter ?? 1);
  const revision = calculateMemberRevisionStatus('m', activeDates, w.revisions ?? [], today, joined, settings);
  const distant = calculateMemberDistantReviewStatus('m', cycleInfo.has_started ? w.distant ?? [] : [], w.completions ?? [], settings, restDays, today, joined);
  const notifications = buildMemberNotifications({
    today,
    isActive: w.isActive ?? true,
    hasStarted: cycleInfo.has_started,
    isCompleted: cycleInfo.is_completed,
    isRestDay: cycleInfo.is_rest_day,
    restDayNote: cycleInfo.rest_day_note,
    tasmia: { pastMissedCount: quarter.pastMissedQuartersCount, requiredQuarter: quarter.requiredQuarter },
    revision: { pastMissedDates: revision.pastMissedDates },
    distant: { overdue: distant.overdue, todayAssignment: distant.todayAssignment, hasCompletedToday: distant.hasCompletedToday },
  });
  return { today, cycleInfo, activeDates, quarter, revision, distant, notifications };
}
const kinds = (r: ReturnType<typeof memberAt>) => r.notifications.map((n) => `${n.kind}:${n.tone}${n.count ? ':' + n.count : ''}`);

const BEFORE = cairo('2026-10-28', '04:59:59', 3);
const AT = cairo('2026-10-28', '05:00:00', 3);
const datesUpTo = (last: string) => {
  const out: string[] = [];
  for (let d = START; d <= last; d = addDays(d, 1)) out.push(d);
  return out;
};

test('05:00 Cairo: new Tasmi\'a quarter and new review range appear at 05:00, not at midnight', () => {
  const at0000 = memberAt(cairo('2026-10-28', '00:00:00', 3), {});
  const before = memberAt(BEFORE, {});
  const at = memberAt(AT, {});
  assert.equal(at0000.today, '2026-10-27');
  assert.equal(before.cycleInfo.quarter_of_day, 8); // 20..27 October = days 1..8
  assert.equal(at0000.cycleInfo.quarter_of_day, 8);
  assert.equal(at.cycleInfo.quarter_of_day, 9);
  assert.deepEqual([before.cycleInfo.review_start, before.cycleInfo.review_end], [1, 8]);
  assert.deepEqual([at.cycleInfo.review_start, at.cycleInfo.review_end], [2, 9]);
});

test('05:00 Cairo: an unfinished day becomes overdue at 05:00 (Tasmi\'a, review, distant review, notifications)', () => {
  const w: World = {
    recitations: tasmia('m', [1, 2, 3, 4, 5, 6, 7]), // quarter 8 (27 Oct) not recited
    revisions: reviews('m', datesUpTo('2026-10-26')), // 27 Oct not reviewed
    distant: [],
  };
  const before = memberAt(BEFORE, w);
  assert.equal(before.quarter.pastMissedQuartersCount, 0, 'quarter 8 is still today at 04:59:59');
  assert.equal(before.revision.pastMissedRevisionDaysCount, 0);
  assert.deepEqual(kinds(before), []);
  const at = memberAt(AT, w);
  assert.equal(at.quarter.pastMissedQuartersCount, 1);
  assert.deepEqual(at.revision.pastMissedDates, ['2026-10-27']);
  assert.deepEqual(kinds(at), ['tasmia-overdue:light:1', 'revision-overdue:light:1']);
});

test('05:00 Cairo: a rest day scheduled for 28 Oct becomes today at 05:00 (and its notification)', () => {
  const w: World = { restDays: [rest('2026-10-28', 'يوم استدراك')], recitations: tasmia('m', [1, 2, 3, 4, 5, 6, 7, 8]), revisions: reviews('m', datesUpTo('2026-10-27')) };
  for (const instant of [cairo('2026-10-28', '00:01:00', 3), BEFORE]) {
    const r = memberAt(instant, w);
    assert.equal(r.cycleInfo.is_rest_day, false);
    assert.deepEqual(kinds(r), []);
  }
  const at = memberAt(AT, w);
  assert.equal(at.cycleInfo.is_rest_day, true);
  assert.equal(at.cycleInfo.quarter_of_day, 8, 'no new quarter on the rest day');
  assert.equal(at.revision.isTodayProgramDay, false, 'no new review obligation on the rest day');
  assert.deepEqual(kinds(at), ['rest-day:info']);
  assert.equal(at.notifications[0].note, 'يوم استدراك');
  assert.deepEqual(at.notifications[0].target, { kind: 'rest-day' });
});

test('05:00 Cairo: a distant-review day becomes today at 05:00; its notification shows the range and note', () => {
  const a = assignment('2026-10-28', 1, 9, 'راجع جيدًا');
  const w: World = { distant: [a], recitations: tasmia('m', [1, 2, 3, 4, 5, 6, 7, 8]), revisions: reviews('m', datesUpTo('2026-10-27')) };
  const before = memberAt(BEFORE, w);
  assert.equal(before.cycleInfo.is_distant_review_day, false);
  assert.equal(before.distant.todayAssignment, null);
  assert.deepEqual(kinds(before), []);
  const at = memberAt(AT, w);
  assert.equal(at.cycleInfo.is_distant_review_day, true);
  assert.equal(at.cycleInfo.quarter_of_day, 8, 'normal progression paused');
  assert.equal(at.revision.isTodayProgramDay, false);
  assert.deepEqual(kinds(at), ['distant-day:distant']);
  const n = at.notifications[0];
  assert.match(n.title, /اليوم مراجعة بعيدة/);
  assert.match(n.body, /المطلوب: من بداية الربع 1 حتى بداية الربع 9/);
  assert.equal(n.note, 'راجع جيدًا');
  assert.deepEqual(n.target, { kind: 'distant', assignmentId: a.id });
  // Not completed by the next 05:00: its own overdue notification, separate from the normal review.
  const next = memberAt(cairo('2026-10-29', '05:00:00', 3), { ...w, revisions: reviews('m', datesUpTo('2026-10-28')), recitations: tasmia('m', [1, 2, 3, 4, 5, 6, 7, 8, 9]) });
  assert.deepEqual(kinds(next), ['distant-overdue:light:1']);
  assert.deepEqual(next.notifications[0].target, { kind: 'distant', assignmentId: a.id });
  assert.equal(next.revision.pastMissedRevisionDaysCount, 0, 'distant debt is not counted as normal review debt');
  const stillBefore = memberAt(cairo('2026-10-29', '04:59:59', 3), { ...w, revisions: reviews('m', datesUpTo('2026-10-27')) });
  assert.deepEqual(kinds(stillBefore), ['distant-day:distant'], 'not overdue before 05:00');
});

test('05:00 Cairo: pause dates follow the program date', () => {
  const settings = settingsOf({ is_paused: true, paused_at: '2026-10-28' });
  assert.equal(isPausedDate(settings, programDate(BEFORE)), false);
  assert.equal(isPausedDate(settings, programDate(AT)), true);
  const at = memberAt(AT, { settings, recitations: tasmia('m', [1, 2, 3, 4, 5, 6, 7, 8]), revisions: reviews('m', datesUpTo('2026-10-27')) });
  assert.equal(at.cycleInfo.quarter_of_day, 8, 'the paused day adds no quarter');
  assert.deepEqual(kinds(at), [], 'no false overdue on a paused day');
});

// ---------------------------------------------------------------------------------------------
// Member notification levels (per category, never merged)
// ---------------------------------------------------------------------------------------------

const NOON = cairo('2026-10-28', '12:00:00', 3); // program day 9 (quarters 1..9, 20..28 October)
const allQuarters = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const allDates = datesUpTo('2026-10-28');
const without = <T,>(list: T[], ...drop: T[]) => list.filter((x) => !drop.includes(x));

test('member: 0 overdue → no warning; 1 → light (yellow); 2 → stronger (orange); 3 → serious (red) — Tasmi\'a', () => {
  assert.deepEqual(kinds(memberAt(NOON, { recitations: tasmia('m', allQuarters), revisions: reviews('m', allDates) })), []);
  const one = memberAt(NOON, { recitations: tasmia('m', without(allQuarters, 5)), revisions: reviews('m', allDates) });
  assert.deepEqual(kinds(one), ['tasmia-overdue:light:1']);
  assert.equal(one.notifications[0].title, 'لديك يوم تسميع متأخر');
  assert.deepEqual(one.notifications[0].target, { kind: 'tasmia', quarter: 5 });
  const two = memberAt(NOON, { recitations: tasmia('m', without(allQuarters, 5, 6)), revisions: reviews('m', allDates) });
  assert.deepEqual(kinds(two), ['tasmia-overdue:strong:2']);
  assert.equal(two.notifications[0].title, 'لديك يومان متأخران في التسميع');
  const three = memberAt(NOON, { recitations: tasmia('m', without(allQuarters, 5, 6, 7)), revisions: reviews('m', allDates) });
  assert.deepEqual(kinds(three), ['tasmia-overdue:serious:3']);
  assert.equal(three.notifications[0].title, 'تنبيه شديد: لديك 3 أيام متأخرة في التسميع');
  assert.match(three.notifications[0].body, /الاستبعاد/);
  // Today's own quarter (9) is not overdue during the day.
  assert.deepEqual(kinds(memberAt(NOON, { recitations: tasmia('m', without(allQuarters, 9)), revisions: reviews('m', allDates) })), []);
});

test('member: the same three levels for the normal review, with the oldest missed day as target', () => {
  const at = (missing: string[]) => memberAt(NOON, { recitations: tasmia('m', allQuarters), revisions: reviews('m', without(allDates, ...missing)) });
  assert.deepEqual(kinds(at([])), []);
  const one = at(['2026-10-24']);
  assert.deepEqual(kinds(one), ['revision-overdue:light:1']);
  assert.equal(one.notifications[0].title, 'لديك يوم مراجعة متأخر');
  assert.deepEqual(one.notifications[0].target, { kind: 'revision', date: '2026-10-24' });
  assert.deepEqual(kinds(at(['2026-10-24', '2026-10-21'])), ['revision-overdue:strong:2']);
  const three = at(['2026-10-24', '2026-10-21', '2026-10-26']);
  assert.deepEqual(kinds(three), ['revision-overdue:serious:3']);
  assert.equal(three.notifications[0].title, 'تنبيه شديد: لديك 3 أيام متأخرة في المراجعة');
  assert.deepEqual(three.notifications[0].target, { kind: 'revision', date: '2026-10-21' });
});

test('member: Tasmi\'a and review are separate (1 + 2 → two notifications, never "3")', () => {
  const r = memberAt(NOON, { recitations: tasmia('m', without(allQuarters, 3)), revisions: reviews('m', without(allDates, '2026-10-22', '2026-10-25')) });
  assert.deepEqual(kinds(r), ['revision-overdue:strong:2', 'tasmia-overdue:light:1']);
  assert.ok(r.notifications.every((n) => n.tone !== 'serious'));
});

test('member: catching up lowers the level, completing everything removes the warning', () => {
  const missing = ['2026-10-21', '2026-10-24', '2026-10-26'];
  const levels = [3, 2, 1, 0].map((n) => {
    const r = memberAt(NOON, { recitations: tasmia('m', allQuarters), revisions: reviews('m', without(allDates, ...missing.slice(0, n))) });
    return kinds(r).join(',');
  });
  assert.deepEqual(levels, ['revision-overdue:serious:3', 'revision-overdue:strong:2', 'revision-overdue:light:1', '']);
  // The signature changes with the content, so a "read" warning shows as new after it changes.
  const a = memberAt(NOON, { recitations: tasmia('m', allQuarters), revisions: reviews('m', without(allDates, ...missing)) });
  const b = memberAt(NOON, { recitations: tasmia('m', allQuarters), revisions: reviews('m', without(allDates, ...missing.slice(0, 2))) });
  assert.equal(a.notifications[0].id, b.notifications[0].id);
  assert.notEqual(a.notifications[0].signature, b.notifications[0].signature);
});

test('member: fresh start and join date — nothing before the baseline is notified', () => {
  // Fresh start at quarter 7 on 26 October: quarters 1..6 and days before joining are never owed.
  const fresh = memberAt(NOON, {
    startQuarter: 7,
    joinedAt: '2026-10-26T08:00:00Z',
    recitations: tasmia('m', [7, 8]),
    revisions: reviews('m', ['2026-10-26', '2026-10-27']),
  });
  assert.deepEqual(kinds(fresh), []);
  // The same member missing his first owed quarter gets exactly one day of Tasmi'a debt.
  const missed = memberAt(NOON, { startQuarter: 7, joinedAt: '2026-10-26T08:00:00Z', recitations: tasmia('m', [8]), revisions: reviews('m', ['2026-10-26', '2026-10-27']) });
  assert.deepEqual(kinds(missed), ['tasmia-overdue:light:1']);
});

test('member: rest, pause and distant-review dates create no false normal overdue', () => {
  const restDays = [rest('2026-10-22'), rest('2026-10-25')];
  const settings = settingsOf({ pause_periods: [{ from: '2026-10-23', to: '2026-10-23' }], distant_review_dates: ['2026-10-26'] });
  const r = memberAt(NOON, {
    settings,
    restDays,
    distant: [assignment('2026-10-26', 1, 5)],
    completions: [{ id: 'x', assignment_id: 'd-2026-10-26', member_id: 'm', completed_at: '', completed_on: '2026-10-26' }],
    // 20,21,24,27,28 are the active days: program days 1..5
    recitations: tasmia('m', [1, 2, 3, 4, 5]),
    revisions: reviews('m', ['2026-10-20', '2026-10-21', '2026-10-24', '2026-10-27', '2026-10-28']),
  });
  assert.equal(r.cycleInfo.quarter_of_day, 5);
  assert.deepEqual(kinds(r), []);
});

test('member: an inactive (excluded) member gets no overdue warnings; schedule information remains', () => {
  const r = memberAt(AT, { isActive: false, restDays: [rest('2026-10-28')], recitations: [], revisions: [] });
  assert.deepEqual(kinds(r), ['rest-day:info']);
});

test('member: several missed distant reviews are one separate notification with a count', () => {
  const w: World = {
    distant: [assignment('2026-10-22', 1, 4), assignment('2026-10-24', 5, 9)],
    recitations: tasmia('m', [1, 2, 3, 4, 5, 6, 7]),
    revisions: reviews('m', allDates),
  };
  const r = memberAt(NOON, w);
  assert.deepEqual(kinds(r), ['distant-overdue:strong:2']);
  assert.equal(r.notifications[0].title, 'لديك مراجعتان بعيدتان متأخرتان');
  assert.deepEqual(r.notifications[0].target, { kind: 'distant', assignmentId: 'd-2026-10-22' });
});

test('debt levels: thresholds', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 12].map(debtLevel), [null, 'light', 'strong', 'serious', 'serious', 'serious']);
  assert.equal(SERIOUS_DEBT_THRESHOLD, 3);
});

// ---------------------------------------------------------------------------------------------
// Batch admin alerts: only at 3 or more, per category, per batch
// ---------------------------------------------------------------------------------------------

const member = (id: string, name: string, phone: string, extra: Partial<User> = {}): User => ({
  id,
  name,
  phone,
  role: 'member',
  is_active: true,
  created_at: '',
  batch_joined_at: JOINED,
  ...extra,
});

function batchAlertsAt(instant: Date, users: User[], recitations: RecitationLog[], revisions: RevisionLog[], batch = { id: 'A', name: 'الدفعة أ' }) {
  const { members, delayById } = computeBatchDelays({ users, settings: settingsOf(), restDays: [], recitationLogs: recitations, revisionLogs: revisions }, programDate(instant));
  return buildBatchAdminAlerts(batch, members, delayById);
}

test('batch admin: no alert at 1 or 2 missed days; one alert per category at 3+ with name and phone', () => {
  const users = [
    member('one', 'عضو يوم', '01000000001'),
    member('two', 'عضو يومين', '01000000002'),
    member('t3', 'محمد أحمد', '01012345678'),
    member('r3', 'خالد محمود', '01087654321'),
    member('both', 'عمر علي', '01011112222'),
    member('out', 'مقصى', '01099999999', { is_active: false }),
    { ...member('adm', 'مشرف', '01000000000'), role: 'admin' as const },
  ];
  const recitations = [
    ...tasmia('one', without(allQuarters, 2)),
    ...tasmia('two', without(allQuarters, 2, 3)),
    ...tasmia('t3', without(allQuarters, 2, 3, 4)),
    ...tasmia('r3', allQuarters),
    ...tasmia('both', without(allQuarters, 1, 2, 3, 4)),
  ];
  const revisions = [
    ...reviews('one', allDates),
    ...reviews('two', without(allDates, '2026-10-21', '2026-10-22')),
    ...reviews('t3', allDates),
    ...reviews('r3', without(allDates, '2026-10-21', '2026-10-22', '2026-10-23')),
    ...reviews('both', without(allDates, '2026-10-21', '2026-10-22', '2026-10-23')),
  ];
  const alerts = batchAlertsAt(NOON, users, recitations, revisions);
  assert.deepEqual(
    alerts.map((a) => `${a.memberName}|${a.phone}|${a.category}|${a.count}|${a.eligibleForExclusion}`).sort(),
    [
      'خالد محمود|01087654321|revision|3|false',
      'عمر علي|01011112222|revision|3|false',
      'عمر علي|01011112222|tasmia|4|true',
      'محمد أحمد|01012345678|tasmia|3|false',
    ]
  );
  assert.ok(alerts.every((a) => a.batchId === 'A' && a.batchName === 'الدفعة أ'));
  // The same rule as the dashboards' «مؤهل للإقصاء» (unchanged, 4+).
  const d = computeMemberDelayStatus({ memberId: 'both', quarterOfDay: 9, activeCycleDates: allDates, recitations, revisions, todayDate: '2026-10-28', joinedOnDate: '2026-10-19' });
  assert.equal(d.isSeverelyBehindRecitation, true);
});

test('batch admin: the alert appears at 05:00 Cairo and disappears when the member catches up below 3', () => {
  const users = [member('m3', 'محمد أحمد', '01012345678')];
  const revisions = reviews('m3', allDates);
  // Quarters 6 and 7 missed; quarter 8 (27 Oct) still open at 04:59:59 on 28 Oct.
  const recs = tasmia('m3', [1, 2, 3, 4, 5]);
  assert.deepEqual(batchAlertsAt(BEFORE, users, recs, revisions), []);
  assert.deepEqual(batchAlertsAt(AT, users, recs, revisions).map((a) => `${a.category}:${a.count}`), ['tasmia:3']);
  assert.deepEqual(batchAlertsAt(AT, users, tasmia('m3', [1, 2, 3, 4, 5, 6]), revisions), [], 'below 3 again → no alert');
});

test('batch admin: alerts are computed per batch from that batch\'s own members', () => {
  const a = batchAlertsAt(NOON, [member('x', 'عضو أ', '010')], tasmia('x', [1, 2, 3, 4, 5]), reviews('x', allDates), { id: 'A', name: 'أ' });
  const b = batchAlertsAt(NOON, [member('y', 'عضو ب', '011')], tasmia('y', allQuarters), reviews('y', allDates), { id: 'B', name: 'ب' });
  assert.deepEqual(a.map((x) => x.memberId), ['x']);
  assert.deepEqual(b, []);
});
