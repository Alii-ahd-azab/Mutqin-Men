import pg from 'pg';
import type {
  User,
  GroupSettings,
  RestDay,
  RecitationLog,
  RevisionLog,
  TestDefinition,
  TestAttempt,
  TestAttemptQuestionResult,
} from '../types';
import type { PersonalTestRecord } from './personalTests';

/**
 * Supabase Postgres data layer for the Express server.
 *
 * Reads return exactly the legacy API shapes (the inverse of the approved Phase 1 mapping in
 * migration/transform.mjs), so route handlers and the UI keep their contracts.
 * Mutations run inside transactions; `loadState(tx, { lock: true })` locks the active cycle row,
 * which serializes concurrent writers and makes read-validate-write sequences atomic.
 */

export interface QueryResult<R> {
  rows: R[];
  rowCount?: number | null;
  affectedRows?: number;
}

export interface Queryable {
  query<R = any>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
}

export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function affected(r: QueryResult<unknown>): number {
  return r.rowCount ?? r.affectedRows ?? 0;
}

export function createPgDatabase(connectionString: string, options: { ssl?: pg.PoolConfig['ssl'] } = {}): Database {
  // Every date/time value is formatted to text in SQL; keep the driver from re-interpreting them.
  const types = {
    getTypeParser: (oid: number, format?: any) =>
      [1082, 1114, 1184].includes(oid) ? (v: string) => v : pg.types.getTypeParser(oid, format),
  };
  const pool = new pg.Pool({
    connectionString,
    ssl: options.ssl,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    application_name: 'mutqin_men_server',
    types,
  });
  pool.on('error', (err) => console.error('[Supabase DB] idle client error:', err.message));
  return {
    query: (text, params) => pool.query(text, params as any[]) as any,
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await fn({ query: (text, params) => client.query(text, params as any[]) as any });
        await client.query('commit');
        return result;
      } catch (err) {
        await client.query('rollback').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

// ---------------------------------------------------------------------------------------------
// Formatting helpers (timestamps match JavaScript toISOString(), dates are YYYY-MM-DD).
// ---------------------------------------------------------------------------------------------
const ts = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const day = (col: string) => `to_char(${col}, 'YYYY-MM-DD')`;
// Firestore listed documents by ID; keep that order for migrated rows, then append newer rows.
const legacyOrder = (alias: string, created: string) =>
  `${alias}.firestore_id collate "C" nulls last, ${created}, ${alias}.id`;

function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Drop keys whose value is null/undefined (legacy documents omitted absent optional fields). */
function compact<T extends object>(obj: T): T {
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------------------------
// State (whole-program snapshot used by the existing business logic)
// ---------------------------------------------------------------------------------------------
export interface ProgramContext {
  cycleId: string;
  batchId: string;
  cycleNumber: number;
}

export interface AppState extends ProgramContext {
  users: User[];
  settings: GroupSettings;
  restDays: RestDay[];
  recitationLogs: RecitationLog[];
  revisionLogs: RevisionLog[];
  tests: TestDefinition[];
  testAttempts: TestAttempt[];
}

interface CycleRow {
  id: string;
  batch_id: string;
  cycle_number: number;
  starts_on: string;
  total_quarters: number;
  review_window: number;
  legacy_paused_days: number;
}

async function loadCycle(q: Queryable, lock: boolean): Promise<CycleRow> {
  const { rows } = await q.query<CycleRow>(
    `select c.id, c.batch_id, c.cycle_number, ${day('c.starts_on')} as starts_on,
            c.total_quarters, c.review_window, c.legacy_paused_days
       from public.cycles c
      where c.status = 'active'
      order by c.created_at, c.id
      limit 1${lock ? ' for update' : ''}`
  );
  if (!rows[0]) throw new Error('No active cycle found in Supabase');
  return rows[0];
}

export async function loadContext(q: Queryable, lock = false): Promise<ProgramContext> {
  const c = await loadCycle(q, lock);
  return { cycleId: c.id, batchId: c.batch_id, cycleNumber: c.cycle_number };
}

// Names/phones are trimmed on read exactly as the legacy server normalized users; stored values stay raw.
export async function loadUsers(q: Queryable, batchId: string): Promise<User[]> {
  const { rows } = await q.query<User>(
    `select p.id, btrim(p.full_name) as name, btrim(p.phone) as phone, p.role, p.active as is_active, ${ts('p.created_at')} as created_at
       from public.profiles p
      where p.is_master_admin
         or exists (select 1 from public.batch_memberships m where m.user_id = p.id and m.batch_id = $1)
      order by ${legacyOrder('p', 'p.created_at')}`,
    [batchId]
  );
  return rows;
}

export async function loadUser(q: Queryable, userId: string): Promise<User | null> {
  const { rows } = await q.query<User>(
    `select p.id, btrim(p.full_name) as name, btrim(p.phone) as phone, p.role, p.active as is_active, ${ts('p.created_at')} as created_at
       from public.profiles p where p.id = $1`,
    [userId]
  );
  return rows[0] || null;
}

async function loadSettings(q: Queryable, c: CycleRow): Promise<GroupSettings> {
  const pauses = await q.query<{ paused_on: string; resumed_on: string | null }>(
    `select ${day('paused_on')} as paused_on, ${day('resumed_on')} as resumed_on
       from public.program_pauses where cycle_id = $1 order by paused_on, created_at, id`,
    [c.id]
  );
  const thought = await q.query<{ content_html: string; published_at: string; author: string | null }>(
    `select content_html, ${ts('published_at')} as published_at, published_by_name_snapshot as author
       from public.daily_thoughts
      where batch_id = $1 and is_published
      order by published_at desc, id desc
      limit 1`,
    [c.batch_id]
  );
  const open = pauses.rows.find((p) => p.resumed_on === null) || null;
  // Men closed periods are inclusive {from, to}; program_pauses.resumed_on is the first active day.
  const closed = pauses.rows
    .filter((p) => p.resumed_on !== null)
    .map((p) => ({ from: p.paused_on, to: addDays(p.resumed_on as string, -1) }));
  const t = thought.rows[0];
  return {
    id: 'group_main',
    start_date: c.starts_on,
    total_quarters: c.total_quarters,
    review_window: c.review_window,
    current_cycle_number: c.cycle_number,
    is_paused: !!open,
    paused_at: open ? open.paused_on : null,
    total_paused_days: c.legacy_paused_days,
    ...(closed.length ? { pause_periods: closed } : {}),
    ...(t
      ? { daily_thought: t.content_html, daily_thought_updated_at: t.published_at, ...(t.author ? { daily_thought_updated_by: t.author } : {}) }
      : { daily_thought: '' }),
  };
}

async function loadRestDays(q: Queryable, cycleId: string): Promise<RestDay[]> {
  const { rows } = await q.query(
    `select r.id, ${day('r.rest_date')} as date, r.reason as note, r.created_by as added_by_admin_id,
            r.created_by_name_snapshot as added_by_name, ${ts('r.created_at')} as created_at
       from public.group_rest_days r where r.cycle_id = $1
      order by ${legacyOrder('r', 'r.created_at')}`,
    [cycleId]
  );
  return rows.map((r) => compact(r) as RestDay);
}

async function loadRecitations(q: Queryable, c: CycleRow): Promise<RecitationLog[]> {
  const { rows } = await q.query(
    `select t.id, t.user_id as member_id, coalesce(t.member_name_snapshot, p.full_name) as member_name,
            t.listener_id, t.listener_name_snapshot as listener_name, t.quarter_number,
            coalesce(${day('t.legacy_date')}, to_char(t.submitted_at at time zone 'Asia/Riyadh', 'YYYY-MM-DD')) as date,
            t.notes, ${ts('t.submitted_at')} as created_at
       from public.tasmia_submissions t
       join public.profiles p on p.id = t.user_id
      where t.cycle_id = $1
      order by ${legacyOrder('t', 't.submitted_at')}`,
    [c.id]
  );
  return rows.map(
    (r) =>
      compact({
        ...r,
        cycle_number: c.cycle_number,
        reciter_id: r.member_id,
        reciter_name: r.member_name,
      }) as RecitationLog
  );
}

async function loadRevisions(q: Queryable, c: CycleRow): Promise<RevisionLog[]> {
  const { rows } = await q.query(
    `select r.id, r.user_id as member_id, coalesce(r.member_name_snapshot, p.full_name) as member_name,
            coalesce(${day('r.legacy_date')}, to_char(r.confirmed_at at time zone 'Asia/Riyadh', 'YYYY-MM-DD')) as date,
            r.start_quarter as review_start_quarter, r.end_quarter as review_end_quarter,
            r.notes, ${ts('r.confirmed_at')} as created_at
       from public.review_confirmations r
       join public.profiles p on p.id = r.user_id
      where r.cycle_id = $1
      order by ${legacyOrder('r', 'r.confirmed_at')}`,
    [c.id]
  );
  return rows.map((r) => compact({ ...r, cycle_number: c.cycle_number }) as RevisionLog);
}

async function loadTests(q: Queryable, cycleId: string): Promise<TestDefinition[]> {
  const { rows } = await q.query(
    `select t.id, t.title, t.range_start, t.range_end, t.questions_count, t.lines_per_question,
            t.require_all_quarters_completed, t.require_revision_completed, t.max_errors,
            t.test_type, t.status, t.audience, t.difficulty, t.created_by,
            ${ts('t.created_at')} as created_at, ${ts('t.updated_at')} as updated_at, ${ts('t.finished_at')} as finished_at,
            coalesce((select array_agg(s.user_id::text order by s.position)
                        from public.peer_test_selected_members s where s.test_id = t.id), '{}') as selected_member_ids
       from public.peer_tests t
      where t.cycle_id = $1
      order by ${legacyOrder('t', 't.created_at')}`,
    [cycleId]
  );
  return rows.map(
    (r) =>
      compact({
        id: r.id,
        title: r.title,
        range_start: r.range_start,
        range_end: r.range_end,
        questions_count: r.questions_count,
        lines_per_question: r.lines_per_question,
        prerequisites: {
          require_all_quarters_completed: r.require_all_quarters_completed,
          require_revision_completed: r.require_revision_completed,
        },
        has_max_errors: r.max_errors !== null,
        max_errors_allowed: r.max_errors,
        test_type: r.test_type,
        is_active: r.status === 'published',
        audience: r.audience,
        selected_member_ids: r.selected_member_ids,
        difficulty: r.difficulty,
        created_at: r.created_at,
        created_by_admin_id: r.created_by,
        updated_at: r.updated_at,
        ...(r.status === 'finished' ? { is_finished: true } : {}),
        finished_at: r.finished_at,
      }) as TestDefinition
  );
}

async function loadAttempts(q: Queryable, cycleId: string, where = '', params: unknown[] = []): Promise<TestAttempt[]> {
  const { rows } = await q.query(
    `select a.id, a.test_id, a.candidate_id, a.candidate_name_snapshot as candidate_name,
            a.examiner_id, a.examiner_name_snapshot as examiner_name, a.total_errors, a.status,
            ${day('a.attempt_date')} as date, a.notes, ${ts('a.created_at')} as created_at,
            a.effective_range_end, a.covers_full_range,
            coalesce((select json_agg(json_build_object(
                         'question_number', q.question_number,
                         'start_surah', q.start_surah, 'start_surah_name', q.start_surah_name, 'start_ayah', q.start_ayah,
                         'end_surah', q.end_surah, 'end_surah_name', q.end_surah_name, 'end_ayah', q.end_ayah,
                         'errors_count', q.errors_count, 'notes', q.notes) order by q.question_number)
                        from public.peer_test_attempt_questions q where q.attempt_id = a.id), '[]') as questions_results
       from public.peer_test_attempts a
       join public.peer_tests t on t.id = a.test_id
      where t.cycle_id = $1 ${where}
      order by ${legacyOrder('a', 'a.created_at')}`,
    [cycleId, ...params]
  );
  return rows.map((r) => {
    const questions = (typeof r.questions_results === 'string' ? JSON.parse(r.questions_results) : r.questions_results) as any[];
    return compact({
      ...r,
      passed: r.status === 'passed',
      questions_results: questions.map((x) => compact(x) as TestAttemptQuestionResult),
    }) as TestAttempt;
  });
}

export async function loadState(q: Queryable, opts: { lock?: boolean } = {}): Promise<AppState> {
  const c = await loadCycle(q, !!opts.lock);
  const users = await loadUsers(q, c.batch_id);
  const settings = await loadSettings(q, c);
  const restDays = await loadRestDays(q, c.id);
  const recitationLogs = await loadRecitations(q, c);
  const revisionLogs = await loadRevisions(q, c);
  const tests = await loadTests(q, c.id);
  const testAttempts = await loadAttempts(q, c.id);
  return {
    cycleId: c.id,
    batchId: c.batch_id,
    cycleNumber: c.cycle_number,
    users,
    settings,
    restDays,
    recitationLogs,
    revisionLogs,
    tests,
    testAttempts,
  };
}

// ---------------------------------------------------------------------------------------------
// Mutations (call inside a transaction holding the cycle lock)
// ---------------------------------------------------------------------------------------------

export async function insertRecitation(
  q: Queryable,
  ctx: ProgramContext,
  r: { memberId: string; memberName: string; listenerId: string; listenerName: string; quarter: number; date: string; notes?: string; createdAt: string }
): Promise<RecitationLog> {
  const { rows } = await q.query<{ id: string }>(
    `insert into public.tasmia_submissions
       (cycle_id, user_id, listener_id, quarter_number, notes, submitted_at, listener_name_snapshot, legacy_date, member_name_snapshot)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning id`,
    [ctx.cycleId, r.memberId, r.listenerId, r.quarter, r.notes ?? null, r.createdAt, r.listenerName, r.date, r.memberName]
  );
  return compact({
    id: rows[0].id,
    member_id: r.memberId,
    member_name: r.memberName,
    listener_id: r.listenerId,
    listener_name: r.listenerName,
    quarter_number: r.quarter,
    cycle_number: ctx.cycleNumber,
    date: r.date,
    notes: r.notes,
    created_at: r.createdAt,
    reciter_id: r.memberId,
    reciter_name: r.memberName,
  }) as RecitationLog;
}

/** Inserts one review per member/date; an existing review for that date is left untouched (idempotent). */
export async function insertRevision(
  q: Queryable,
  ctx: ProgramContext,
  r: { memberId: string; memberName: string; date: string; start: number; end: number; notes?: string; createdAt: string }
): Promise<RevisionLog | null> {
  const { rows } = await q.query<{ id: string }>(
    `insert into public.review_confirmations
       (cycle_id, user_id, program_day, start_quarter, end_quarter, confirmed_at, legacy_date, member_name_snapshot, notes)
     values ($1, $2, null, $3, $4, $5, $6, $7, $8)
     on conflict (cycle_id, user_id, legacy_date, legacy_occurrence) do nothing
     returning id`,
    [ctx.cycleId, r.memberId, r.start, r.end, r.createdAt, r.date, r.memberName, r.notes ?? null]
  );
  if (!rows[0]) return null;
  return compact({
    id: rows[0].id,
    member_id: r.memberId,
    member_name: r.memberName,
    date: r.date,
    cycle_number: ctx.cycleNumber,
    review_start_quarter: r.start,
    review_end_quarter: r.end,
    notes: r.notes,
    created_at: r.createdAt,
  }) as RevisionLog;
}

export async function insertProfile(
  q: Queryable,
  ctx: ProgramContext,
  u: { id: string; name: string; phone: string; role: 'member' | 'admin'; createdAt: string; actorId: string }
): Promise<void> {
  await q.query(
    `insert into public.profiles (id, full_name, phone, role, active, created_at, is_master_admin)
     values ($1, $2, $3, $4, true, $5, $6)`,
    [u.id, u.name, u.phone, u.role, u.createdAt, u.role === 'admin']
  );
  await q.query(
    `insert into public.batch_memberships (batch_id, user_id, membership_role, created_at, created_by, joined_at)
     values ($1, $2, $3, $4, $5, $4)`,
    [ctx.batchId, u.id, u.role, u.createdAt, u.actorId]
  );
}

export async function updateProfile(
  q: Queryable,
  ctx: ProgramContext,
  id: string,
  u: { name?: string; phone?: string; role?: 'member' | 'admin'; is_active?: boolean }
): Promise<void> {
  await q.query(
    `update public.profiles set
        full_name = coalesce($2, full_name),
        phone = coalesce($3, phone),
        role = coalesce($4, role),
        is_master_admin = case when $4::text is null then is_master_admin else $4::text = 'admin' end,
        active = coalesce($5, active)
      where id = $1`,
    [id, u.name ?? null, u.phone ?? null, u.role ?? null, u.is_active ?? null]
  );
  if (u.role) {
    await q.query(
      `update public.batch_memberships set membership_role = $3 where batch_id = $1 and user_id = $2`,
      [ctx.batchId, id, u.role]
    );
  }
}

export async function deleteMemberCompletely(q: Queryable, id: string): Promise<{ recitations: number; revisions: number; attempts: number }> {
  const { rows } = await q.query<{ r: any }>('select app_private.delete_member_completely($1) as r', [id]);
  const r = typeof rows[0].r === 'string' ? JSON.parse(rows[0].r) : rows[0].r;
  return r;
}

export async function revokeSessions(q: Queryable, userId: string): Promise<void> {
  await q.query('select app_private.revoke_user_sessions($1)', [userId]);
}

export async function insertRestDay(
  q: Queryable,
  ctx: ProgramContext,
  r: { date: string; note: string; adminId: string; adminName: string; createdAt: string }
): Promise<RestDay> {
  const { rows } = await q.query<{ id: string }>(
    `insert into public.group_rest_days (cycle_id, rest_date, reason, created_by, created_at, created_by_name_snapshot)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [ctx.cycleId, r.date, r.note, r.adminId, r.createdAt, r.adminName]
  );
  return { id: rows[0].id, date: r.date, note: r.note, added_by_admin_id: r.adminId, added_by_name: r.adminName, created_at: r.createdAt };
}

export async function deleteRestDay(q: Queryable, ctx: ProgramContext, id: string): Promise<boolean> {
  return affected(await q.query('delete from public.group_rest_days where cycle_id = $1 and id = $2', [ctx.cycleId, id])) > 0;
}

export async function openPause(q: Queryable, ctx: ProgramContext, pausedOn: string, actorId: string): Promise<void> {
  await q.query(
    `insert into public.program_pauses (cycle_id, paused_on, created_by) values ($1, $2, $3)`,
    [ctx.cycleId, pausedOn, actorId]
  );
}

/** Closes the open pause; the resume day itself is active. A same-day resume records no period. */
export async function closePause(q: Queryable, ctx: ProgramContext, resumeDay: string): Promise<void> {
  await q.query(
    `delete from public.program_pauses where cycle_id = $1 and resumed_on is null and paused_on >= $2`,
    [ctx.cycleId, resumeDay]
  );
  await q.query(
    `update public.program_pauses set resumed_on = $2 where cycle_id = $1 and resumed_on is null`,
    [ctx.cycleId, resumeDay]
  );
}

/** Records a dated past pause (inclusive from..to) and moves its days out of the legacy counter. */
export async function addPastPausePeriod(q: Queryable, ctx: ProgramContext, from: string, to: string, days: number, actorId: string): Promise<void> {
  await q.query(
    `insert into public.program_pauses (cycle_id, paused_on, resumed_on, created_by) values ($1, $2, $3, $4)`,
    [ctx.cycleId, from, addDays(to, 1), actorId]
  );
  await q.query(
    `update public.cycles set legacy_paused_days = greatest(0, legacy_paused_days - $2) where id = $1`,
    [ctx.cycleId, days]
  );
}

export async function updateStartDate(q: Queryable, ctx: ProgramContext, startDate: string): Promise<void> {
  await q.query('update public.cycles set starts_on = $2 where id = $1', [ctx.cycleId, startDate]);
}

export async function publishDailyThought(
  q: Queryable,
  ctx: ProgramContext,
  t: { html: string; adminId: string; adminName: string; publishedAt: string }
): Promise<void> {
  await q.query(
    `insert into public.daily_thoughts (batch_id, content_html, published_by, published_by_name_snapshot, published_at, is_published)
     values ($1, $2, $3, $4, $5, true)`,
    [ctx.batchId, t.html, t.adminId, t.adminName, t.publishedAt]
  );
}

export async function unpublishDailyThoughts(q: Queryable, ctx: ProgramContext): Promise<void> {
  await q.query('update public.daily_thoughts set is_published = false where batch_id = $1 and is_published', [ctx.batchId]);
}

/** Factory reset: clears cycle activity (recitations, reviews, rest days, pauses, attempts); keeps members and tests. */
export async function factoryReset(q: Queryable, ctx: ProgramContext, today: string): Promise<void> {
  await q.query('delete from public.tasmia_submissions where cycle_id = $1', [ctx.cycleId]);
  await q.query('delete from public.review_confirmations where cycle_id = $1', [ctx.cycleId]);
  await q.query('delete from public.group_rest_days where cycle_id = $1', [ctx.cycleId]);
  await q.query('delete from public.program_pauses where cycle_id = $1', [ctx.cycleId]);
  await q.query(
    'delete from public.peer_test_attempts a using public.peer_tests t where t.id = a.test_id and t.cycle_id = $1',
    [ctx.cycleId]
  );
  await q.query(
    'update public.cycles set starts_on = $2, cycle_number = 1, legacy_paused_days = 0 where id = $1',
    [ctx.cycleId, today]
  );
}

export async function saveTest(q: Queryable, ctx: ProgramContext, t: TestDefinition, isNew: boolean): Promise<void> {
  const status = t.is_finished ? 'finished' : t.is_active ? 'published' : 'hidden';
  const values = [
    t.id,
    ctx.cycleId,
    t.title,
    t.range_start,
    t.range_end,
    t.questions_count,
    t.lines_per_question,
    t.has_max_errors && typeof t.max_errors_allowed === 'number' ? t.max_errors_allowed : null,
    t.test_type,
    t.difficulty || 'any',
    status,
    t.created_by_admin_id ?? null,
    t.created_at,
    t.updated_at ?? t.created_at,
    !!t.prerequisites?.require_all_quarters_completed,
    !!t.prerequisites?.require_revision_completed,
    t.audience || 'selected',
  ];
  if (isNew) {
    await q.query(
      `insert into public.peer_tests (id, cycle_id, title, range_start, range_end, questions_count, lines_per_question,
         max_errors, test_type, difficulty, status, created_by, created_at, updated_at,
         require_all_quarters_completed, require_revision_completed, audience)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      values
    );
  } else {
    await q.query(
      `update public.peer_tests set title = $3, range_start = $4, range_end = $5, questions_count = $6,
         lines_per_question = $7, max_errors = $8, test_type = $9, difficulty = $10, status = $11,
         created_by = $12, created_at = $13, updated_at = $14, require_all_quarters_completed = $15,
         require_revision_completed = $16, audience = $17
       where id = $1 and cycle_id = $2`,
      values
    );
    await q.query('delete from public.peer_test_selected_members where test_id = $1', [t.id]);
  }
  const selected = t.selected_member_ids || [];
  if (selected.length) {
    await q.query(
      `insert into public.peer_test_selected_members (test_id, user_id, position)
       select $1, s.user_id::uuid, s.ord - 1 from unnest($2::text[]) with ordinality as s(user_id, ord)`,
      [t.id, selected]
    );
  }
}

export async function setTestStatus(
  q: Queryable,
  ctx: ProgramContext,
  id: string,
  status: 'published' | 'hidden' | 'finished',
  at: string
): Promise<void> {
  await q.query(
    `update public.peer_tests set status = $3, updated_at = $4,
            finished_at = case when $3 = 'finished' then $4::timestamptz else finished_at end
      where cycle_id = $1 and id = $2`,
    [ctx.cycleId, id, status, at]
  );
}

/** Hides every other published test of the cycle (only one test may be active). */
export async function hideOtherPublishedTests(q: Queryable, ctx: ProgramContext, keepId: string, at: string): Promise<void> {
  await q.query(
    `update public.peer_tests set status = 'hidden', updated_at = $3
      where cycle_id = $1 and id <> $2 and status = 'published'`,
    [ctx.cycleId, keepId, at]
  );
}

export interface AttemptQuestionGeometry {
  start_page: number;
  start_line: number;
  end_page: number;
  end_line: number;
  actual_lines: number;
}

export async function insertAttempt(
  q: Queryable,
  a: TestAttempt,
  maxErrors: number | null,
  geometry: AttemptQuestionGeometry[]
): Promise<TestAttempt> {
  const { rows } = await q.query<{ id: string }>(
    `insert into public.peer_test_attempts
       (test_id, candidate_id, candidate_name_snapshot, examiner_id, examiner_name_snapshot, status, total_errors,
        max_errors_snapshot, notes, attempt_date, created_at, completed_at, effective_range_end, covers_full_range)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13)
     returning id`,
    [
      a.test_id,
      a.candidate_id,
      a.candidate_name,
      a.examiner_id,
      a.examiner_name,
      a.status,
      a.total_errors,
      maxErrors,
      a.notes ?? null,
      a.date,
      a.created_at,
      a.effective_range_end ?? null,
      a.covers_full_range ?? null,
    ]
  );
  const id = rows[0].id;
  const qs = a.questions_results;
  await q.query(
    `insert into public.peer_test_attempt_questions
       (attempt_id, question_number, start_surah, start_surah_name, start_ayah, end_surah, end_surah_name, end_ayah,
        start_page, start_line, end_page, end_line, actual_lines, errors_count, notes, legacy_incomplete)
     select $1, x.question_number, x.start_surah, x.start_surah_name, x.start_ayah, x.end_surah, x.end_surah_name,
            x.end_ayah, x.start_page, x.start_line, x.end_page, x.end_line, x.actual_lines, x.errors_count, x.notes, false
       from json_to_recordset($2::json) as x(question_number smallint, start_surah smallint, start_surah_name text,
            start_ayah smallint, end_surah smallint, end_surah_name text, end_ayah smallint, start_page smallint,
            start_line smallint, end_page smallint, end_line smallint, actual_lines smallint, errors_count smallint, notes text)`,
    [id, JSON.stringify(qs.map((x, i) => ({ ...x, ...geometry[i], notes: x.notes ?? null })))]
  );
  return { ...a, id };
}

// ---------------------------------------------------------------------------------------------
// Personal self-tests (each member's own records only)
// ---------------------------------------------------------------------------------------------
export async function listPersonalTests(q: Queryable, memberId: string): Promise<PersonalTestRecord[]> {
  const { rows } = await q.query(
    `select t.id, t.member_id, t.range_type, t.range_label, t.start_juz, t.end_juz, t.start_quarter, t.end_quarter,
            t.start_surah, t.start_surah_name, t.end_surah, t.end_surah_name, t.questions_count, t.lines_per_question,
            t.difficulty, t.total_errors, t.grade::float8 as grade, t.grade_label, t.notes, ${day('t.date')} as date,
            ${ts('t.created_at')} as created_at,
            coalesce((select json_agg(json_build_object(
                         'question_number', x.question_number, 'start_surah', x.start_surah, 'start_surah_name', x.start_surah_name,
                         'start_ayah', x.start_ayah, 'end_surah', x.end_surah, 'end_surah_name', x.end_surah_name,
                         'end_ayah', x.end_ayah, 'errors_count', x.errors_count, 'grade', x.grade::float8,
                         'difficulty_level', x.difficulty_level) order by x.question_number)
                        from public.personal_test_questions x where x.test_id = t.id), '[]') as questions
       from public.personal_tests t
      where t.member_id = $1
      order by t.created_at desc, t.id`,
    [memberId]
  );
  return rows.map((r) => {
    const questions = (typeof r.questions === 'string' ? JSON.parse(r.questions) : r.questions) as any[];
    return compact({ ...r, questions: questions.map((x) => compact(x)) }) as PersonalTestRecord;
  });
}

export async function insertPersonalTest(q: Queryable, r: PersonalTestRecord): Promise<void> {
  await q.query(
    `insert into public.personal_tests (id, member_id, range_type, range_label, start_surah, start_surah_name, end_surah,
       end_surah_name, start_juz, end_juz, start_quarter, end_quarter, questions_count, lines_per_question, difficulty,
       total_errors, grade, grade_label, notes, date, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [
      r.id, r.member_id, r.range_type ?? null, r.range_label ?? null, r.start_surah, r.start_surah_name, r.end_surah,
      r.end_surah_name, r.start_juz ?? null, r.end_juz ?? null, r.start_quarter ?? null, r.end_quarter ?? null,
      r.questions_count, r.lines_per_question, r.difficulty, r.total_errors, r.grade, r.grade_label, r.notes ?? null,
      r.date, r.created_at,
    ]
  );
  await q.query(
    `insert into public.personal_test_questions (test_id, question_number, start_surah, start_surah_name, start_ayah,
       end_surah, end_surah_name, end_ayah, errors_count, grade, difficulty_level)
     select $1, x.question_number, x.start_surah, x.start_surah_name, x.start_ayah, x.end_surah, x.end_surah_name,
            x.end_ayah, x.errors_count, x.grade, x.difficulty_level
       from json_to_recordset($2::json) as x(question_number integer, start_surah integer, start_surah_name text,
            start_ayah integer, end_surah integer, end_surah_name text, end_ayah integer, errors_count integer,
            grade numeric, difficulty_level text)`,
    [r.id, JSON.stringify(r.questions)]
  );
}

export async function deletePersonalTest(q: Queryable, memberId: string, id: string): Promise<boolean> {
  return affected(await q.query('delete from public.personal_tests where id = $1 and member_id = $2', [id, memberId])) > 0;
}
