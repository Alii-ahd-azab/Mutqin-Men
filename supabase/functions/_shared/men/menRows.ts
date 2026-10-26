import type { User, GroupSettings, RestDay, RecitationLog, RevisionLog } from '../logic/programTypes.ts';

/**
 * Supabase rows → the Men application shapes (the inverse of the approved Firestore → Supabase
 * mapping). Shared by the browser data layer and the Edge Functions so both read data identically.
 */

export const PROFILE_COLUMNS = 'id, full_name, phone, role, active, created_at, is_master_admin, firestore_id';
export const CYCLE_COLUMNS = 'id, batch_id, cycle_number, starts_on, status, total_quarters, review_window, legacy_paused_days, created_at';
export const TASMIA_COLUMNS =
  'id, firestore_id, cycle_id, user_id, listener_id, listener_name_snapshot, listener_changed_at, member_name_snapshot, quarter_number, notes, submitted_at, legacy_date';
export const REVIEW_COLUMNS =
  'id, firestore_id, cycle_id, user_id, start_quarter, end_quarter, confirmed_at, legacy_date, member_name_snapshot, notes';
export const REST_DAY_COLUMNS = 'id, firestore_id, cycle_id, rest_date, reason, created_by, created_by_name_snapshot, created_at';
export type ProfileRow = {
  id: string;
  full_name: string;
  phone: string;
  role: 'member' | 'admin';
  active: boolean;
  created_at: string;
  is_master_admin: boolean;
  firestore_id: string | null;
};
export type CycleRow = {
  id: string;
  batch_id: string;
  cycle_number: number;
  starts_on: string;
  status: string;
  total_quarters: number;
  review_window: number;
  legacy_paused_days: number;
  created_at: string;
};
export type PauseRow = { paused_on: string; resumed_on: string | null };
export type ThoughtRow = { content_html: string; published_at: string; published_by_name_snapshot: string | null } | null;
export type TasmiaRow = {
  id: string;
  firestore_id: string | null;
  user_id: string;
  listener_id: string | null;
  listener_name_snapshot: string | null;
  listener_changed_at: string | null;
  member_name_snapshot: string | null;
  quarter_number: number;
  notes: string | null;
  submitted_at: string;
  legacy_date: string | null;
};
export type ReviewRow = {
  id: string;
  firestore_id: string | null;
  user_id: string;
  start_quarter: number;
  end_quarter: number;
  confirmed_at: string;
  legacy_date: string | null;
  member_name_snapshot: string | null;
  notes: string | null;
};
export type RestDayRow = {
  id: string;
  firestore_id: string | null;
  rest_date: string;
  reason: string | null;
  created_by: string | null;
  created_by_name_snapshot: string | null;
  created_at: string;
};
/** Timestamps exactly like JavaScript toISOString() (what the legacy data stored). */
export function iso(value: string | null | undefined): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

function riyadhDate(timestamp: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(timestamp)
  );
}

function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Drop keys whose value is null/undefined (legacy documents omitted absent optional fields). */
function compact<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== null && v !== undefined) out[k] = v;
  return out as T;
}

/** Firestore listed documents by ID: migrated rows keep that order, newer rows follow by time. */
export function legacyOrder<T extends { firestore_id: string | null; id: string }>(rows: T[], time: (r: T) => string): T[] {
  return [...rows].sort((a, b) => {
    if (a.firestore_id !== null && b.firestore_id !== null) return a.firestore_id < b.firestore_id ? -1 : a.firestore_id > b.firestore_id ? 1 : 0;
    if (a.firestore_id !== null) return -1;
    if (b.firestore_id !== null) return 1;
    const t = new Date(time(a)).getTime() - new Date(time(b)).getTime();
    return t || (a.id < b.id ? -1 : 1);
  });
}

// Names/phones are trimmed exactly as the legacy server normalized users.
export function mapUser(row: ProfileRow): User {
  return {
    id: row.id,
    name: row.full_name.trim(),
    phone: row.phone.trim(),
    role: row.role,
    is_active: row.active,
    created_at: iso(row.created_at) as string,
    auth_uid: row.id,
    is_master_admin: !!row.is_master_admin,
  };
}

export function buildSettings(cycle: CycleRow, pauses: PauseRow[], thought: ThoughtRow): GroupSettings {
  const ordered = [...pauses].sort((a, b) => a.paused_on.localeCompare(b.paused_on));
  const open = ordered.find((p) => p.resumed_on === null) || null;
  // Men periods are inclusive {from, to}; resumed_on is the first active day. A same-day resume is no period.
  const closed = ordered
    .filter((p) => p.resumed_on !== null && p.resumed_on > p.paused_on)
    .map((p) => ({ from: p.paused_on, to: addDays(p.resumed_on as string, -1) }));
  return {
    id: 'group_main',
    start_date: cycle.starts_on,
    total_quarters: cycle.total_quarters,
    review_window: cycle.review_window,
    current_cycle_number: cycle.cycle_number,
    is_paused: !!open,
    paused_at: open ? open.paused_on : null,
    total_paused_days: cycle.legacy_paused_days,
    ...(closed.length ? { pause_periods: closed } : {}),
    ...(thought
      ? {
          daily_thought: thought.content_html,
          daily_thought_updated_at: iso(thought.published_at),
          ...(thought.published_by_name_snapshot ? { daily_thought_updated_by: thought.published_by_name_snapshot } : {}),
        }
      : { daily_thought: '' }),
  };
}

export function mapRestDays(rows: RestDayRow[]): RestDay[] {
  return legacyOrder(rows, (r) => r.created_at).map(
    (r) =>
      compact({
        id: r.id,
        date: r.rest_date,
        note: r.reason,
        added_by_admin_id: r.created_by,
        added_by_name: r.created_by_name_snapshot,
        created_at: iso(r.created_at),
      }) as RestDay
  );
}

export function mapRecitations(rows: TasmiaRow[], cycleNumber: number, names: Map<string, string>): RecitationLog[] {
  return legacyOrder(rows, (r) => r.submitted_at).map((r) => {
    const memberName = r.member_name_snapshot ?? names.get(r.user_id) ?? 'عضو';
    return compact({
      id: r.id,
      member_id: r.user_id,
      member_name: memberName,
      listener_id: r.listener_id,
      listener_name: r.listener_name_snapshot,
      listener_changed_at: iso(r.listener_changed_at),
      quarter_number: r.quarter_number,
      date: r.legacy_date ?? riyadhDate(r.submitted_at),
      notes: r.notes,
      created_at: iso(r.submitted_at),
      cycle_number: cycleNumber,
      reciter_id: r.user_id,
      reciter_name: memberName,
    }) as RecitationLog;
  });
}

export function mapRevisions(rows: ReviewRow[], cycleNumber: number, names: Map<string, string>): RevisionLog[] {
  return legacyOrder(rows, (r) => r.confirmed_at).map(
    (r) =>
      compact({
        id: r.id,
        member_id: r.user_id,
        member_name: r.member_name_snapshot ?? names.get(r.user_id) ?? 'عضو',
        date: r.legacy_date ?? riyadhDate(r.confirmed_at),
        review_start_quarter: r.start_quarter,
        review_end_quarter: r.end_quarter,
        notes: r.notes,
        created_at: iso(r.confirmed_at),
        cycle_number: cycleNumber,
      }) as RevisionLog
  );
}
