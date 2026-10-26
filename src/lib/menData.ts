import type { User, GroupSettings, RestDay, RecitationLog, RevisionLog, TestDefinition, TestAttempt } from '../types';
import {
  PROFILE_COLUMNS,
  CYCLE_COLUMNS,
  TASMIA_COLUMNS,
  REVIEW_COLUMNS,
  REST_DAY_COLUMNS,
  TEST_COLUMNS,
  ATTEMPT_COLUMNS,
  legacyOrder,
  mapUser,
  buildSettings,
  mapRestDays,
  mapRecitations,
  mapRevisions,
  mapTests,
  mapAttempts,
  type ProfileRow,
  type CycleRow,
  type TasmiaRow,
  type ReviewRow,
  type RestDayRow,
  type TestRow,
  type AttemptRow,
  type QuestionRow,
} from './menRows';

/**
 * Loads one batch's program state through a Supabase client. In the browser RLS decides which rows
 * come back (members: their own; admins: the batch); Edge Functions pass the service-role client.
 */

// Structural type so the same code runs with supabase-js in the browser and in Deno.
export type SupabaseLike = { from: (table: string) => any };

export interface ProgramState {
  batchId: string;
  cycle: CycleRow;
  users: User[];
  settings: GroupSettings;
  restDays: RestDay[];
  recitationLogs: RecitationLog[];
  revisionLogs: RevisionLog[];
  tests: TestDefinition[];
  testAttempts: TestAttempt[];
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

async function inChunks<T>(ids: string[], load: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 100) out.push(...(await load(ids.slice(i, i + 100))));
  return out;
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
export async function loadBatchUsers(db: SupabaseLike, batchId: string): Promise<User[]> {
  const [memberships, masters] = await Promise.all([
    db.from('batch_memberships').select(`profile:profiles!batch_memberships_user_id_fkey(${PROFILE_COLUMNS})`).eq('batch_id', batchId),
    db.from('profiles').select(PROFILE_COLUMNS).eq('role', 'admin').eq('is_master_admin', true),
  ]);
  const byId = new Map<string, ProfileRow>();
  for (const row of (check<{ profile: ProfileRow | null }[]>(memberships) || [])) if (row.profile) byId.set(row.profile.id, row.profile);
  for (const row of check<ProfileRow[]>(masters) || []) byId.set(row.id, row);
  return legacyOrder([...byId.values()], (r) => r.created_at).map(mapUser);
}

export async function loadProgram(db: SupabaseLike, batchId: string): Promise<ProgramState> {
  const cycle = await loadActiveCycle(db, batchId);
  const [users, pauses, thought, restRows, tasmiaRows, reviewRows, testRows] = await Promise.all([
    loadBatchUsers(db, batchId),
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
    db.from('peer_tests').select(TEST_COLUMNS).eq('cycle_id', cycle.id).then(check),
  ]);
  const tests = (testRows || []) as TestRow[];
  const testIds = tests.map((t) => t.id);
  const [selected, attemptRows] = await Promise.all([
    inChunks(testIds, async (ids) =>
      check<{ test_id: string; user_id: string; position: number }[]>(
        await db.from('peer_test_selected_members').select('test_id, user_id, position').in('test_id', ids)
      )
    ),
    inChunks(testIds, (ids) =>
      fetchAll<AttemptRow>((f, t) => db.from('peer_test_attempts').select(ATTEMPT_COLUMNS).in('test_id', ids).order('id').range(f, t))
    ),
  ]);
  const questionRows = await inChunks(
    attemptRows.map((a) => a.id),
    (ids) =>
      fetchAll<QuestionRow>((f, t) =>
        db
          .from('peer_test_attempt_questions')
          .select('attempt_id, question_number, start_surah, start_surah_name, start_ayah, end_surah, end_surah_name, end_ayah, errors_count, notes')
          .in('attempt_id', ids)
          .order('attempt_id')
          .order('question_number')
          .range(f, t)
      )
  );

  const names = new Map(users.map((u) => [u.id, u.name]));
  return {
    batchId,
    cycle,
    users,
    settings: buildSettings(cycle, pauses || [], thought || null),
    restDays: mapRestDays((restRows || []) as RestDayRow[]),
    recitationLogs: mapRecitations(tasmiaRows, cycle.cycle_number, names),
    revisionLogs: mapRevisions(reviewRows, cycle.cycle_number, names),
    tests: mapTests(tests, selected),
    testAttempts: mapAttempts(attemptRows, questionRows),
  };
}
