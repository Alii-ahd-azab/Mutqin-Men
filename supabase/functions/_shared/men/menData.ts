import type { User, GroupSettings, RestDay, RecitationLog, RevisionLog } from '../logic/programTypes.ts';
import {
  PROFILE_COLUMNS,
  CYCLE_COLUMNS,
  TASMIA_COLUMNS,
  REVIEW_COLUMNS,
  REST_DAY_COLUMNS,
  legacyOrder,
  mapUser,
  buildSettings,
  mapRestDays,
  mapRecitations,
  mapRevisions,
  type ProfileRow,
  type CycleRow,
  type TasmiaRow,
  type ReviewRow,
  type RestDayRow,
} from './menRows.ts';

/**
 * Loads one batch's program state through a Supabase client. In the browser RLS decides which rows
 * come back (members: their own; admins: the batch); Edge Functions pass the service-role client.
 */

// Structural type so the same code runs with supabase-js in the browser and in Deno.
export type SupabaseLike = { from: (table: string) => any; rpc?: (fn: string, args: Record<string, unknown>) => any };

export interface ProgramState {
  batchId: string;
  cycle: CycleRow;
  users: User[];
  settings: GroupSettings;
  restDays: RestDay[];
  recitationLogs: RecitationLog[];
  revisionLogs: RevisionLog[];
}

const PAGE = 1000;

function check<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

// PostgREST returns at most 1000 rows per request: read in pages until a short page.
async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const data = check(await page(from, from + PAGE - 1)) || [];
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}


/** Batches the caller may open, oldest first (RLS decides). */
export async function loadBatchIds(db: SupabaseLike): Promise<string[]> {
  const rows = check<{ id: string }[]>(
    await db.from('batches').select('id').is('archived_at', null).order('created_at', { ascending: true })
  );
  return (rows || []).map((r) => r.id);
}

export async function loadActiveCycle(db: SupabaseLike, batchId: string): Promise<CycleRow> {
  const cycle = check<CycleRow | null>(
    await db
      .from('cycles')
      .select(CYCLE_COLUMNS)
      .eq('batch_id', batchId)
      .eq('status', 'active')
      .order('cycle_number', { ascending: false })
      .limit(1)
      .maybeSingle()
  );
  if (!cycle) throw new Error('لا توجد دورة نشطة حالياً');
  return cycle;
}

/** Members of the batch (any status), its admins, and master admins. */
export async function loadBatchUsers(db: SupabaseLike, batchId: string, activeCycleId?: string): Promise<User[]> {
  const [memberships, masters] = await Promise.all([
    db
      .from('batch_memberships')
      .select(`membership_role, joined_at, start_cycle_id, start_quarter, profile:profiles!batch_memberships_user_id_fkey(${PROFILE_COLUMNS})`)
      .eq('batch_id', batchId),
    db.from('profiles').select(PROFILE_COLUMNS).eq('role', 'admin').eq('is_master_admin', true),
  ]);
  const byId = new Map<string, ProfileRow>();
  // When each MEMBER joined this batch (revision debt starts there).
  const joinedAt = new Map<string, string>();
  // Fresh-start baseline, only for the batch's active cycle.
  const startQuarter = new Map<string, number>();
  type MembershipRow = {
    membership_role: string;
    joined_at: string;
    start_cycle_id: string | null;
    start_quarter: number | null;
    profile: ProfileRow | null;
  };
  for (const row of check<MembershipRow[]>(memberships) || []) {
    if (!row.profile) continue;
    byId.set(row.profile.id, row.profile);
    if (row.membership_role === 'member') joinedAt.set(row.profile.id, row.joined_at);
    if (row.start_quarter && activeCycleId && row.start_cycle_id === activeCycleId) startQuarter.set(row.profile.id, row.start_quarter);
  }
  for (const row of check<ProfileRow[]>(masters) || []) byId.set(row.id, row);
  return legacyOrder([...byId.values()], (r) => r.created_at).map((row) => {
    const user = mapUser(row);
    const joined = joinedAt.get(row.id);
    const start = startQuarter.get(row.id);
    return {
      ...user,
      ...(joined ? { batch_joined_at: joined } : {}),
      ...(start ? { batch_start_quarter: start } : {}),
    };
  });
}

export async function loadProgram(db: SupabaseLike, batchId: string): Promise<ProgramState> {
  const cycle = await loadActiveCycle(db, batchId);
  const [users, pauses, thought, restRows, tasmiaRows, reviewRows] = await Promise.all([
    loadBatchUsers(db, batchId, cycle.id),
    db.from('program_pauses').select('paused_on, resumed_on').eq('cycle_id', cycle.id).then(check),
    db
      .from('daily_thoughts')
      .select('content_html, published_at, published_by_name_snapshot')
      .eq('batch_id', batchId)
      .eq('is_published', true)
      .order('published_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(check),
    db.from('group_rest_days').select(REST_DAY_COLUMNS).eq('cycle_id', cycle.id).then(check),
    fetchAll<TasmiaRow>((f, t) => db.from('tasmia_submissions').select(TASMIA_COLUMNS).eq('cycle_id', cycle.id).order('id').range(f, t)),
    fetchAll<ReviewRow>((f, t) => db.from('review_confirmations').select(REVIEW_COLUMNS).eq('cycle_id', cycle.id).order('id').range(f, t)),
  ]);
  const names = new Map(users.map((u) => [u.id, u.name]));
  // People who have since left this batch keep their name in its history (Sisters history_member_names).
  const missing = [...tasmiaRows, ...reviewRows].some((r) => !names.has(r.user_id) && !r.member_name_snapshot);
  if (missing && db.rpc) {
    const { data, error } = await db.rpc('history_member_names', { p_cycle_id: cycle.id });
    // Names are cosmetic: never fail the dashboard over them.
    if (!error) for (const row of (data || []) as { id: string; full_name: string }[]) if (!names.has(row.id)) names.set(row.id, row.full_name.trim());
  }
  return {
    batchId,
    cycle,
    users,
    settings: buildSettings(cycle, pauses || [], thought || null),
    restDays: mapRestDays((restRows || []) as RestDayRow[]),
    recitationLogs: mapRecitations(tasmiaRows, cycle.cycle_number, names),
    revisionLogs: mapRevisions(reviewRows, cycle.cycle_number, names),
  };
}
