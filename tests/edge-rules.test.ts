// Men rules used by the peer-tests Edge Function and the shared row mapping (pure; no network).
// Imports the generated Edge copies, i.e. exactly what is deployed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RuleError,
  computeCandidateStatus,
  validateTestInput,
  verifyAttemptQuestions,
  parsePersonalSetup,
  generatePersonalQuestions,
} from '../supabase/functions/_shared/men/peerRules.ts';
import { generateTestQuestions } from '../supabase/functions/_shared/men/testGenerator.ts';
import { buildSettings, mapTests } from '../supabase/functions/_shared/men/menRows.ts';
import type { ProgramState } from '../supabase/functions/_shared/men/menData.ts';
import type { TestDefinition, User } from '../supabase/functions/_shared/men/types.ts';

const cycle = { id: 'c', batch_id: 'b', cycle_number: 1, starts_on: '2026-09-17', status: 'active', total_quarters: 240, review_window: 8, legacy_paused_days: 6, created_at: '2026-09-01T00:00:00Z' };
const member = (id: string, active = true): User => ({ id, name: id, phone: id, role: 'member', is_active: active, created_at: '2026-09-01T00:00:00.000Z' });
const baseTest: TestDefinition = {
  id: 't', title: 'x', range_start: 1, range_end: 8, questions_count: 2, lines_per_question: 5,
  prerequisites: { require_all_quarters_completed: false, require_revision_completed: false },
  has_max_errors: true, max_errors_allowed: 3, test_type: 'recommended', is_active: true, audience: 'all',
  selected_member_ids: [], difficulty: 'any', created_at: '2026-10-01T00:00:00.000Z',
};
function state(recitedQuarters: number[], attempts: ProgramState['testAttempts'] = []): ProgramState {
  return {
    batchId: 'b',
    cycle,
    users: [member('a'), member('b')],
    settings: buildSettings(cycle, [], null),
    restDays: [],
    recitationLogs: recitedQuarters.map((q) => ({ id: `r${q}`, member_id: 'a', member_name: 'a', quarter_number: q, cycle_number: 1, date: '2026-09-20', created_at: '' })),
    revisionLogs: [],
    tests: [baseTest],
    testAttempts: attempts,
  };
}

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

test('test mapping keeps selected-member order and derives active/finished flags', () => {
  const [t] = mapTests(
    [{ ...baseTest, firestore_id: null, max_errors: null, status: 'finished', created_by: null, updated_at: '2026-10-01T00:00:00Z', finished_at: '2026-10-02T00:00:00Z', require_all_quarters_completed: true, require_revision_completed: false } as any],
    [{ test_id: 't', user_id: 'z', position: 1 }, { test_id: 't', user_id: 'y', position: 0 }]
  );
  assert.deepEqual(t.selected_member_ids, ['y', 'z']);
  assert.equal(t.is_active, false);
  assert.equal(t.is_finished, true);
  assert.equal(t.has_max_errors, false);
});

test('candidate eligibility: partial range, full pass, inactive and audience rules', () => {
  const s = state([1, 2, 3]);
  const partial = computeCandidateStatus(s, baseTest, member('a'), '2026-10-26');
  assert.equal(partial.is_eligible, true);
  assert.equal(partial.effective_range_end, 3);
  assert.equal(partial.covers_full_range, false);
  assert.equal(computeCandidateStatus(state([]), baseTest, member('a'), '2026-10-26').is_eligible, false);
  assert.equal(computeCandidateStatus(s, baseTest, member('a', false), '2026-10-26').is_eligible, false);
  assert.equal(computeCandidateStatus(s, { ...baseTest, audience: 'selected', selected_member_ids: ['b'] }, member('a'), '2026-10-26').is_eligible, false);
  const passed = state([1, 2, 3], [{ id: 'x', test_id: 't', candidate_id: 'a', candidate_name: 'a', examiner_id: 'b', examiner_name: 'b', total_errors: 0, passed: true, status: 'passed', date: '2026-10-20', questions_results: [], created_at: '' }]);
  const st = computeCandidateStatus(passed, baseTest, member('a'), '2026-10-26');
  assert.equal(st.has_passed, true);
  assert.equal(st.is_eligible, false);
});

test('test definition validation (former API rules)', () => {
  const ok = validateTestInput({ range_start: 1, range_end: 8, questions_count: 2, lines_per_question: 5, audience: 'all', title: '  ' }, new Set());
  assert.equal(ok.title, 'اختبار الأرباع (1 - 8)');
  assert.equal(ok.max_errors, null);
  assert.throws(() => validateTestInput({ range_start: 9, range_end: 8, questions_count: 1, lines_per_question: 1 }, new Set()), RuleError);
  assert.throws(() => validateTestInput({ range_start: 1, range_end: 1, questions_count: 50, lines_per_question: 60 }, new Set()), /لا يتسع/);
  assert.throws(() => validateTestInput({ range_start: 1, range_end: 8, questions_count: 1, lines_per_question: 1, audience: 'selected', selected_member_ids: ['ghost'] }, new Set()), /غير موجود/);
});

test('attempt answers are re-validated against the Mushaf with full geometry', () => {
  const qs = generateTestQuestions(1, 8, 2, 5, 'any');
  const answers = qs.map((q, i) => ({ start_surah: q.start_surah, start_ayah: q.start_ayah, end_surah: q.end_surah, end_ayah: q.end_ayah, errors_count: i }));
  const verified = verifyAttemptQuestions(baseTest, 8, answers);
  assert.equal(verified.length, 2);
  assert.ok(verified.every((v) => v.actual_lines > 0 && v.start_page > 0 && v.end_line > 0));
  assert.throws(() => verifyAttemptQuestions(baseTest, 8, answers.slice(0, 1)), /عدد الأسئلة/);
  assert.throws(() => verifyAttemptQuestions(baseTest, 8, [answers[1], answers[0]]), /تداخل|تسبق/);
  assert.throws(() => verifyAttemptQuestions(baseTest, 8, [{ ...answers[0], start_surah: 114, start_ayah: 1, end_surah: 114, end_ayah: 6 }, answers[1]]), /خارج نطاق|تداخل/);
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
