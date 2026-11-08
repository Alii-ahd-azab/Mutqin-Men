// Mandatory-test checkpoint vs candidate eligibility (pure; no network). Regression for the production
// deadlock: a member who finished a mandatory test's range was blocked from reciting the quarters after
// it, those blocked quarters were then counted as his overdue Tasmi'a, and at 4 the candidate rule made
// him «مؤهل للإقصاء» — so he could neither continue nor take the test. The range check itself was right.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  evaluateCandidate,
  isBlockedByMandatoryTest,
  nextTasmiaQuarter,
  type PassedAttempt,
} from '../supabase/functions/_shared/peer-tests/eligibility.ts';
import { computeMemberDelayStatus } from '../supabase/functions/_shared/logic/memberDelayStatus.ts';
import {
  generateTestQuestions,
  getQuarterEndIndex,
  getQuarterStartIndex,
  getVerseIndexBySurahAyah,
} from '../supabase/functions/_shared/peer-tests/testGenerator.ts';

const source = (f: string) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);

// «إختبار سورة آل عمران» as stored in production: quarters 20..30, mandatory, whole range required.
const AL_IMRAN: {
  range_start: number; range_end: number; require_all_quarters_completed: boolean;
  test_type: 'mandatory' | 'recommended'; status: 'draft' | 'published' | 'hidden' | 'finished';
  visible_from: string | null; visible_until: string | null;
} = {
  range_start: 20, range_end: 30, require_all_quarters_completed: true,
  test_type: 'mandatory', status: 'published', visible_from: null, visible_until: null,
};

/** A member on program day `day` (one quarter a day, no revision debt) who recited `done`. */
function member(done: number[], day: number, startQuarter = 1) {
  const dates = range(1, day).map((d) => new Date(Date.UTC(2026, 8, 16 + d)).toISOString().slice(0, 10));
  const delay = computeMemberDelayStatus({
    memberId: 'm', quarterOfDay: day, activeCycleDates: dates, startQuarter,
    recitations: done.map((q) => ({ member_id: 'm', quarter_number: q })),
    revisions: dates.map((date) => ({ member_id: 'm', date })), todayDate: dates[day - 1],
  });
  return { delay, completedQuarters: new Set(done), day, startQuarter };
}
type M = ReturnType<typeof member>;
const evaluate = (m: M, over: Partial<typeof AL_IMRAN> = {}, passedAttempts: PassedAttempt[] = [], gate = true) =>
  evaluateCandidate({
    test: { ...AL_IMRAN, ...over }, completedQuarters: m.completedQuarters, passedAttempts, delay: m.delay, inAudience: true,
    ...(gate ? { gate: { quarterOfDay: m.day, startQuarter: m.startQuarter } } : {}),
  });
const blocked = (m: M, over: Partial<typeof AL_IMRAN> = {}, passedAttempts: PassedAttempt[] = []) =>
  isBlockedByMandatoryTest({
    test: { ...AL_IMRAN, ...over }, inAudience: true, hasPassedFull: passedAttempts.some((a) => a.covers_full_range !== false),
    nextQuarter: nextTasmiaQuarter(m.delay, m.day), startQuarter: m.startQuarter,
  });

test('A. exactly completed range (next quarter is the first after it): eligible, and the checkpoint applies', () => {
  for (const day of [30, 31]) {
    const m = member(range(1, 30), day);
    const e = evaluate(m);
    assert.equal(e.is_eligible, true, `day ${day}: ${e.reasons}`);
    assert.equal(e.missing_quarters, 0);
    assert.equal(blocked(m), true);
  }
});

test('B. progressed past the range while blocked (أحمد عاشور: 1..30 done, program day 36, next quarter 31): eligible', () => {
  const m = member(range(1, 30), 36);
  assert.equal(nextTasmiaQuarter(m.delay, 36), 31);
  assert.equal(m.delay.missedQuartersCount, 5); // 31..35: the quarters the checkpoint forbids him to recite
  assert.equal(m.delay.isSeverelyBehindRecitation, true);
  assert.equal(blocked(m), true);
  // The old rule (no checkpoint context) reproduces the production deadlock …
  const before = evaluate(m, {}, [], false);
  assert.equal(before.is_eligible, false);
  assert.deepEqual(before.reasons, ['مؤهل للإقصاء بسبب تأخر التسميع (5 أرباع فائتة)']);
  // … the checkpoint-aware rule does not.
  const after = evaluate(m);
  assert.equal(after.is_eligible, true, String(after.reasons));
  assert.deepEqual(after.reasons, []);
  assert.equal(after.missing_quarters, 0);
  assert.equal(after.covers_full_range, true);
  assert.equal(after.effective_range_end, 30);
  // His real timeline: from 2026-11-01 (day 30) to long after, he stays eligible every day.
  for (let day = 30; day <= 60; day++) assert.equal(evaluate(member(range(1, 30), day)).is_eligible, true, `day ${day}`);
});

test('C. one genuinely missing quarter inside the range: ineligible with the range reason, not blocked', () => {
  const m = member(range(1, 30).filter((q) => q !== 25), 31);
  const e = evaluate(m);
  assert.equal(e.is_eligible, false);
  assert.equal(e.missing_quarters, 1);
  assert.deepEqual(e.reasons, ['لم يُتمّ تسميع جميع أرباع النطاق بعد (متبقٍ 1 من الأرباع 20 إلى 30)']);
  assert.equal(nextTasmiaQuarter(m.delay, 31), 25);
  assert.equal(blocked(m), false); // he may still recite quarter 25: no impossible state
  // A real delay is never forgiven: same hole, day 36 → 25 and 31..35 overdue (6).
  const late = evaluate(member(range(1, 30).filter((q) => q !== 25), 36));
  assert.equal(late.is_eligible, false);
  assert.ok(late.reasons.some((r) => /متبقٍ 1/.test(r)));
  assert.ok(late.reasons.includes('مؤهل للإقصاء بسبب تأخر التسميع (6 أرباع فائتة)'));
});

test('D. several missing quarters: exact count in the reason', () => {
  const e = evaluate(member(range(1, 30).filter((q) => ![22, 23, 27].includes(q)), 31));
  assert.equal(e.is_eligible, false);
  assert.equal(e.missing_quarters, 3);
  assert.match(e.reasons[0], /متبقٍ 3 من الأرباع 20 إلى 30/);
});

test('E. range boundaries are inclusive (20 and 30 are both part of «20 → 30») everywhere', () => {
  // eligibility: quarter 30 is required, quarter 19 is not part of the range
  assert.equal(evaluate(member(range(1, 29), 30)).missing_quarters, 1);
  assert.equal(evaluate(member(range(1, 30).filter((q) => q !== 20), 31)).missing_quarters, 1);
  assert.equal(evaluate(member(range(1, 30).filter((q) => q !== 19), 31)).missing_quarters, 0);
  // checkpoint: reciting quarter 30 is allowed, quarter 31 is the first one stopped
  assert.equal(blocked(member(range(1, 29), 30)), false);
  assert.equal(blocked(member(range(1, 30), 31)), true);
  // questions: from the first ayah of quarter 20 to the ayah before quarter 31 (the end of quarter 30)
  assert.equal(getQuarterEndIndex(30), getQuarterStartIndex(31) - 1);
  const lo = getQuarterStartIndex(20), hi = getQuarterEndIndex(30);
  for (let i = 0; i < 20; i++) {
    for (const q of generateTestQuestions(20, 30, 8, 12)) {
      assert.ok(getVerseIndexBySurahAyah(q.start_surah, q.start_ayah)! >= lo);
      assert.ok(getVerseIndexBySurahAyah(q.end_surah, q.end_ayah)! <= hi);
    }
  }
  // the database guard and the UI use the same inclusive semantics
  const guard = source('supabase/migrations/20261029000100_men_fresh_start_members.sql');
  assert.match(guard, /and new\.quarter_number > t\.range_end/);
  assert.match(guard, /and t\.range_start >= coalesce\(v_start, 1\)/);
  assert.match(guard, /coalesce\(a\.covers_full_range, true\)/);
  assert.match(source('src/components/TestConditionsCard.tsx'), /من الربع \{test\.range_start\} إلى الربع \{test\.range_end\}/);
});

test('F. checkpoint never coexists with «not eligible» for a member who recited in order', () => {
  // Every member who recited 1..k in order, on every program day: when the checkpoint stops him, he can take the test.
  for (let k = 0; k <= 45; k++) {
    for (let day = Math.max(1, k); day <= 60; day++) {
      const m = member(range(1, k), day);
      if (blocked(m)) assert.equal(evaluate(m).is_eligible, true, `recited 1..${k}, day ${day}: ${evaluate(m).reasons}`);
    }
  }
  // and the blocking itself is unchanged: a completed range + no pass → Tasmi'a past quarter 30 stopped
  assert.equal(blocked(member(range(1, 30), 33)), true);
});

test('F2. the exception is only for this test\'s own checkpoint (no weakening elsewhere)', () => {
  const m = member(range(1, 30), 36);
  const variants: Partial<typeof AL_IMRAN>[] = [{ test_type: 'recommended' }, { status: 'hidden' }, { visible_until: '2026-01-01T00:00:00Z' }];
  for (const over of variants) {
    const e = evaluate(m, over);
    assert.equal(e.is_eligible, false, JSON.stringify(over));
    assert.ok(e.reasons.includes('مؤهل للإقصاء بسبب تأخر التسميع (5 أرباع فائتة)'));
  }
  // outside the audience, the reason is the audience
  const out = evaluateCandidate({ test: AL_IMRAN, completedQuarters: m.completedQuarters, passedAttempts: [], delay: m.delay, inAudience: false, gate: { quarterOfDay: 36 } });
  assert.equal(out.is_eligible, false);
  assert.ok(out.reasons.some((r) => /المشمولين/.test(r)));
});

test('G. after passing the full range the checkpoint lifts and Tasmi\'a resumes; a partial pass does not lift it', () => {
  const m = member(range(1, 30), 33);
  assert.equal(blocked(m, {}, [{ covers_full_range: true, effective_range_end: 30 }]), false);
  assert.equal(blocked(m, {}, [{ covers_full_range: null, effective_range_end: null }]), false); // legacy pass
  assert.equal(blocked(m, {}, [{ covers_full_range: false, effective_range_end: 25 }]), true); // same as the database
  const again = evaluate(m, {}, [{ covers_full_range: true, effective_range_end: 30 }]);
  assert.equal(again.is_eligible, false);
  assert.equal(again.has_passed, true);
});

test('H. fresh start: tests of quarters before the baseline never block; a baseline inside the checkpoint still leads to the test', () => {
  // start at quarter 25, test 20..30: the checkpoint does not apply (same as the database rule)
  const late = member(range(25, 30), 36, 25);
  assert.equal(nextTasmiaQuarter(late.delay, 36), 31);
  assert.equal(blocked(late), false);
  // start at quarter 15, recited 15..30, day 36: the checkpoint applies and he can take the test
  const early = member(range(15, 30), 36, 15);
  assert.equal(blocked(early), true);
  assert.equal(evaluate(early).is_eligible, true, String(evaluate(early).reasons));
});

test('one checkpoint definition: database guard, Edge Function (candidates/start/impact) and member dashboard', () => {
  const fn = source('supabase/functions/peer-tests/index.ts');
  assert.equal(fn.match(/evaluateCandidate\(\{/g)?.length, 1);
  assert.match(fn, /gate: \{\n\s+quarterOfDay: progress\.quarterOfDay,/);
  assert.match(fn, /isBlockedByMandatoryTest\(\{/);
  const dash = source('src/components/MemberDashboard.tsx');
  assert.match(dash, /isBlockedByMandatoryTest\(\{/);
  assert.doesNotMatch(dash, /nextQuarterToRecite > liveTest\.range_end/);
});
