-- Mutqin for Men: an admin may turn TODAY into a «المراجعة البعيدة» day.
--
-- A date added beforehand is simply a non-program day. Added on the day itself, members may already
-- have submitted that day's NORMAL work while the day still counted as program day N+1: Tasmi'a
-- quarter N+1 and the review of that date. Once the day leaves the calendar the next active day
-- becomes N+1, and those rows would satisfy it (a review row credits the day in its end_quarter, and
-- the day of its date: it could also clear a review missed yesterday). They must stop counting.
--
--   * voided_daily_records: such rows are MOVED here. Every existing reader of tasmia_submissions and
--     review_confirmations (dashboards, statistics, peer tests) therefore stops counting them, and
--     the historical fact is kept (shown in the member's history).
--   * distant_review_assignments.cancelled_program_day: the program day this conversion cancelled.
--     Null for every day scheduled beforehand or falling on a rest or paused date.
--   * public.men_distant_review_create_today: creates the day and moves the rows in one transaction.
--     public.men_distant_review_save is NOT changed: future dates behave as before, and an existing
--     future day cannot be edited onto today.
--   * men_same_day_distant_review_guard: an app opened before the conversion cannot submit the
--     cancelled day's quarter or a review of that date.
--   * public.men_backfill_revisions skips converted dates (it writes a review for every date).
--
-- Men identities: a review is identified by its DATE (program_day is always null), and legacy paused
-- days shift program days, so the cancelled day comes from app_private.men_cycle_day (the calendar
-- the guards already use), computed under the lock. Catch-up work done today is not touched: reviews
-- of earlier days carry their own date, and earlier quarters have another number. A quarter recited
-- on an earlier date is not today's work either, so it stays too.
--
-- As with every day that has arrived, the normal app can neither edit nor delete today's day
-- afterwards.
--
-- peer_tests.require_revision_completed no longer affects eligibility (overdue self-revision never
-- blocks a candidate). The column and its stored values stay for history.
--
-- No existing row changes when this migration runs.

alter table public.distant_review_assignments
  add column cancelled_program_day smallint
    check (cancelled_program_day is null or cancelled_program_day between 1 and 240);

comment on column public.distant_review_assignments.cancelled_program_day is
  'The program day cancelled when this day was added on the date itself; null when it replaced no program day.';

comment on column public.peer_tests.require_revision_completed is
  'Deprecated: no longer affects candidate eligibility; kept so old tests keep their stored settings.';

create table public.voided_daily_records (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid references public.distant_review_assignments(id) on delete set null,
  cycle_id uuid not null references public.cycles(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('tasmia', 'review')),
  original_id uuid not null,
  -- The cancelled program day (for Tasmi'a, also its quarter number).
  program_day smallint not null check (program_day between 1 and 240),
  -- The date that was converted.
  program_date date not null,
  -- Review range (kind = 'review').
  start_quarter smallint,
  end_quarter smallint,
  -- Tasmi'a details (kind = 'tasmia').
  listener_id uuid references public.profiles(id) on delete set null,
  listener_name_snapshot text,
  listener_changed_at timestamptz,
  notes text,
  member_name_snapshot text,
  -- The original row's own date and migration identity.
  legacy_date date,
  legacy_occurrence integer not null default 0,
  firestore_id text,
  -- When the member originally recorded it.
  recorded_at timestamptz not null,
  voided_at timestamptz not null default now(),
  voided_by uuid references public.profiles(id) on delete set null,
  constraint voided_daily_records_original_key unique (kind, original_id)
);

create index voided_daily_records_cycle_idx on public.voided_daily_records (cycle_id);
create index voided_daily_records_user_idx on public.voided_daily_records (user_id);

comment on table public.voided_daily_records is
  'Normal Tasmi''a / review rows of a program day that was cancelled the same day by a «المراجعة البعيدة» day. They do not count.';

alter table public.voided_daily_records enable row level security;

-- A member reads his own; an admin those of his managed batches. Nobody writes directly.
create policy voided_daily_records_select_accessible on public.voided_daily_records
  for select to authenticated
  using ((user_id = (select auth.uid() as uid))
         or (cycle_id in (select app_private.managed_cycle_ids() as managed_cycle_ids)));

-- The cycle's lock: submissions take it shared, a conversion exclusively, so a submission can neither
-- slip past the move nor be accepted after it.
create function app_private.men_same_day_distant_review_lock_key(p_cycle_id uuid) returns bigint
    language sql immutable
    set search_path to ''
    as $$ select hashtextextended('same-day-distant:' || p_cycle_id::text, 0) $$;

-- Fires before tasmia_batch_guard and review_batch_guard (triggers run in name order), so the lock is
-- held before they read the calendar; new.legacy_date is therefore not normalized yet.
create function app_private.men_same_day_distant_review_guard() returns trigger
    language plpgsql security definer
    set search_path to ''
    as $$
begin
  perform pg_advisory_xact_lock_shared(app_private.men_same_day_distant_review_lock_key(new.cycle_id));

  if tg_table_name = 'tasmia_submissions' then
    if exists (
      select 1 from public.distant_review_assignments d
      where d.cycle_id = new.cycle_id
        and d.review_date = app_private.men_today()
        and d.cancelled_program_day is not null
        and new.quarter_number >= d.cancelled_program_day
    ) then
      raise exception 'تحوّل اليوم إلى يوم مراجعة بعيدة، ولا يوجد ورد يومي جديد اليوم. يرجى تحديث الصفحة.'
        using errcode = 'check_violation';
    end if;
  elsif exists (
    select 1 from public.distant_review_assignments d
    where d.cycle_id = new.cycle_id
      and d.review_date = coalesce(new.legacy_date, app_private.men_today())
      and d.cancelled_program_day is not null
  ) then
    raise exception 'تحوّل اليوم إلى يوم مراجعة بعيدة، ولا يوجد ورد يومي جديد اليوم. يرجى تحديث الصفحة.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger men_same_day_distant_review_guard before insert on public.tasmia_submissions
  for each row execute function app_private.men_same_day_distant_review_guard();
create trigger men_same_day_distant_review_guard before insert on public.review_confirmations
  for each row execute function app_private.men_same_day_distant_review_guard();

-- Service role (admin-actions checks the batch first).
create function public.men_distant_review_create_today(
  p_batch_id uuid, p_review_date date, p_start_quarter integer, p_end_quarter integer,
  p_note text, p_actor uuid) returns jsonb
    language plpgsql security definer
    set search_path to ''
    as $$
declare
  v_cycle  record;
  v_today  date := app_private.men_today();
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
  v_day    integer;
  v_row    public.distant_review_assignments;
  v_tasmia integer := 0;
  v_review integer := 0;
begin
  select c.id, c.starts_on into v_cycle
  from public.cycles c where c.batch_id = p_batch_id and c.status = 'active';
  if v_cycle.id is null then
    raise exception 'لا توجد دورة نشطة لهذه الدفعة' using errcode = 'check_violation';
  end if;
  if p_review_date is distinct from v_today then
    raise exception 'تغيّر يوم البرنامج. يرجى تحديث الصفحة وإعادة المحاولة.' using errcode = 'check_violation';
  end if;
  if p_review_date < v_cycle.starts_on then
    raise exception 'تاريخ المراجعة البعيدة يسبق بداية الدورة الحالية.' using errcode = 'check_violation';
  end if;
  if p_start_quarter is null or p_end_quarter is null
     or p_start_quarter < 1 or p_end_quarter > 240 or p_start_quarter >= p_end_quarter then
    raise exception 'نطاق الأرباع غير صالح: «إلى الربع» هو موضع التوقف (بداية ذلك الربع)، فيجب أن يكون بعد «من الربع» وضمن 1–240.' using errcode = 'check_violation';
  end if;
  if v_note is not null and char_length(v_note) > 300 then
    raise exception 'الملاحظة طويلة جدًا (300 حرف كحد أقصى).' using errcode = 'check_violation';
  end if;

  -- Waits for submissions in progress; new ones wait for this transaction, then see the day.
  perform pg_advisory_xact_lock(app_private.men_same_day_distant_review_lock_key(v_cycle.id));

  if exists (select 1 from public.distant_review_assignments d where d.cycle_id = v_cycle.id and d.review_date = p_review_date) then
    raise exception 'يوجد يوم مراجعة بعيدة مجدول في هذا التاريخ بالفعل.' using errcode = 'unique_violation';
  end if;

  -- The program day today cancels: only a date that advances the calendar has one. A rest or paused
  -- date, the clamped first days and the days past the last quarter add no day, so nothing is cancelled.
  v_day := app_private.men_cycle_day(v_cycle.id, v_today);
  if v_day <= app_private.men_cycle_day(v_cycle.id, v_today - 1) then
    v_day := null;
  end if;

  insert into public.distant_review_assignments
    (cycle_id, batch_id, review_date, start_quarter, end_quarter, note, created_by, created_by_name_snapshot, cancelled_program_day)
  values (v_cycle.id, p_batch_id, p_review_date, p_start_quarter, p_end_quarter, v_note, p_actor,
          (select btrim(p.full_name) from public.profiles p where p.id = p_actor), v_day)
  returning * into v_row;

  if v_day is not null then
    with moved as (
      delete from public.tasmia_submissions t
      where t.cycle_id = v_cycle.id and t.quarter_number = v_day
        and (t.legacy_date = v_today or app_private.men_program_date(t.submitted_at) = v_today)
      returning t.*
    ), archived as (
      insert into public.voided_daily_records
        (assignment_id, cycle_id, user_id, kind, original_id, program_day, program_date,
         listener_id, listener_name_snapshot, listener_changed_at, notes, member_name_snapshot,
         legacy_date, legacy_occurrence, firestore_id, recorded_at, voided_by)
      select v_row.id, m.cycle_id, m.user_id, 'tasmia', m.id, m.quarter_number, p_review_date,
             m.listener_id, m.listener_name_snapshot, m.listener_changed_at, m.notes, m.member_name_snapshot,
             m.legacy_date, m.legacy_occurrence, m.firestore_id, m.submitted_at, p_actor
      from moved m
      returning 1
    )
    select count(*) into v_tasmia from archived;

    with moved as (
      delete from public.review_confirmations r
      where r.cycle_id = v_cycle.id and r.legacy_date = v_today
      returning r.*
    ), archived as (
      insert into public.voided_daily_records
        (assignment_id, cycle_id, user_id, kind, original_id, program_day, program_date,
         start_quarter, end_quarter, notes, member_name_snapshot,
         legacy_date, legacy_occurrence, firestore_id, recorded_at, voided_by)
      select v_row.id, m.cycle_id, m.user_id, 'review', m.id, v_day, p_review_date,
             m.start_quarter, m.end_quarter, m.notes, m.member_name_snapshot,
             m.legacy_date, m.legacy_occurrence, m.firestore_id, m.confirmed_at, p_actor
      from moved m
      returning 1
    )
    select count(*) into v_review from archived;
  end if;

  return jsonb_build_object('assignment', to_jsonb(v_row), 'voided_tasmia', v_tasmia, 'voided_reviews', v_review);
end;
$$;

-- Admin (browser): add the missing daily reviews of every active member up to p_until (inclusive).
-- Identical to 20261027000100 except that converted dates are skipped: their reviews were voided and
-- a new one would count again. Only inserts; never edits or deletes. Idempotent.
CREATE OR REPLACE FUNCTION public.men_backfill_revisions(p_cycle_id uuid, p_until date) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_start date;
  v_count integer;
begin
  if p_cycle_id not in (select app_private.managed_cycle_ids()) then
    raise exception 'هذا الإجراء مخصص للمشرف فقط' using errcode = 'insufficient_privilege';
  end if;
  select starts_on into v_start from public.cycles where id = p_cycle_id and status = 'active';
  if v_start is null then
    raise exception 'لا توجد دورة نشطة' using errcode = 'check_violation';
  end if;
  if p_until is null or p_until > app_private.men_today() + 1 then
    raise exception 'تاريخ النهاية غير صالح.' using errcode = 'check_violation';
  end if;
  if p_until < v_start then
    raise exception 'تاريخ النهاية يسبق بداية البرنامج.' using errcode = 'check_violation';
  end if;

  insert into public.review_confirmations (cycle_id, user_id, legacy_date, notes)
  select p_cycle_id, m.user_id, d::date, 'تسجيل إداري: تعذّر حفظ المراجعة بسبب خلل تقني'
  from generate_series(v_start, p_until, interval '1 day') d
  cross join public.batch_memberships m
  join public.profiles p on p.id = m.user_id
  join public.cycles c on c.id = p_cycle_id and c.batch_id = m.batch_id
  where m.membership_role = 'member' and p.role = 'member' and p.active
    and not exists (select 1 from public.review_confirmations r
                    where r.cycle_id = p_cycle_id and r.user_id = m.user_id and r.legacy_date = d::date)
    and not exists (select 1 from public.distant_review_assignments a
                    where a.cycle_id = p_cycle_id and a.review_date = d::date and a.cancelled_program_day is not null)
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

do $$
declare
  f text;
  r text;
begin
  foreach f in array array[
    'app_private.men_same_day_distant_review_lock_key(uuid)',
    'app_private.men_same_day_distant_review_guard()',
    'public.men_distant_review_create_today(uuid, date, integer, integer, text, uuid)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', f, r);
      end if;
    end loop;
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table public.voided_daily_records from %I', r);
    end if;
  end loop;
end;
$$;
revoke all on table public.voided_daily_records from public;

grant select on table public.voided_daily_records to authenticated;
grant select, insert, update, delete on table public.voided_daily_records to service_role;
grant execute on function public.men_distant_review_create_today(uuid, date, integer, integer, text, uuid) to service_role;
