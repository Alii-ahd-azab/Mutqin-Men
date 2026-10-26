// READ-ONLY audit of review obligations for every member of every active Men batch.
// Loads the program exactly like the app (shared Men loader + shared calculations) and classifies the
// overdue review obligations the app currently shows.
//
//   npx tsx --env-file=.env.local migration/cutover/review-audit.ts --project uaublandjewfzmhnbflc [--json]
import { loadBatchIds, loadProgram } from '../../supabase/functions/_shared/men/menData.ts';
import {
  calculateCycleInfo,
  calculateMemberRevisionStatus,
  getActiveCycleDates,
  joinedOnDateFromTimestamp,
  isPausedDate,
} from '../../supabase/functions/_shared/logic/calculations.ts';
// @ts-ignore - shared ESM tooling
import { authAdmin, requireProjectArg } from './production.mjs';

const project = requireProjectArg(process.argv.slice(2));
const service = authAdmin(project); // selects only
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const totals = {
  members: 0,
  obligations: 0,
  overdue_shown: 0,
  false_overdue_same_range_exists: 0,
  genuinely_missing: 0,
  uncredited_review_rows: 0,
  review_rows: 0,
  rows_on_rest_days: 0,
  rows_on_pause_days: 0,
  rows_later_than_their_obligation: 0,
  duplicate_range_rows: 0,
  identity_day_mismatches: 0,
};
const examples: Record<string, unknown>[] = [];

for (const batchId of await loadBatchIds(service)) {
  const p = await loadProgram(service, batchId);
  const active = getActiveCycleDates(p.settings.start_date, today, p.restDays, p.settings);
  const restSet = new Set(p.restDays.map((r) => r.date));
  const rangeOf = (d: string) => {
    const c = calculateCycleInfo(p.settings, p.restDays, d);
    return `${c.review_start}-${c.review_end}`;
  };
  // Earliest active date whose current range is r (the obligation a row with range r belongs to).
  const obligationDateOfRange = new Map<string, string>();
  for (const d of active) if (!obligationDateOfRange.has(rangeOf(d))) obligationDateOfRange.set(rangeOf(d), d);

  // The identity's program day of each active date must equal the app/SQL cycle day.
  active.forEach((d, i) => {
    const day = Math.min(p.settings.total_quarters, Math.max(1, i + 1 - (p.settings.total_paused_days || 0)));
    if (day !== calculateCycleInfo(p.settings, p.restDays, d).cycle_day) totals.identity_day_mismatches++;
  });

  for (const m of p.users.filter((u) => u.role === 'member' && u.is_active)) {
    totals.members++;
    const rows = p.revisionLogs.filter((r) => r.member_id === m.id && r.date <= today);
    totals.review_rows += rows.length;
    const ranges = new Map<string, number>();
    for (const r of rows) {
      const key = `${r.review_start_quarter}-${r.review_end_quarter}`;
      ranges.set(key, (ranges.get(key) || 0) + 1);
      if (restSet.has(r.date)) totals.rows_on_rest_days++;
      else if (isPausedDate(p.settings, r.date)) totals.rows_on_pause_days++;
      const origin = obligationDateOfRange.get(key);
      if (origin && r.date > origin) totals.rows_later_than_their_obligation++;
    }
    for (const n of ranges.values()) if (n > 1) totals.duplicate_range_rows += n - 1;

    const joined = joinedOnDateFromTimestamp(m.batch_joined_at);
    const owed = active.filter((d) => d < today && (!joined || d >= joined));
    totals.obligations += owed.length;
    const status = calculateMemberRevisionStatus(m.id, active, p.revisionLogs, today, joined, process.argv.includes('--date-only') ? undefined : p.settings);
    totals.uncredited_review_rows += status.uncreditedReviews.length;
    for (const d of status.pastMissedDates) {
      totals.overdue_shown++;
      const r = rangeOf(d);
      // False overdue: a row that credits no day holds this day's range or was confirmed on its date.
      const day = calculateCycleInfo(p.settings, p.restDays, d).review_end;
      const match = status.uncreditedReviews.find((x) => x.review_end_quarter === day || x.date === d);
      if (match) {
        totals.false_overdue_same_range_exists++;
        if (examples.length < 15) examples.push({ member: m.name, obligation_date: d, range: r, completed_on: match.date, stored_end: match.review_end_quarter });
      } else {
        totals.genuinely_missing++;
      }
    }
  }
}

console.log(JSON.stringify({ project, today, totals, examples }, null, 1));
