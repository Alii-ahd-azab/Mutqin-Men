-- Mutqin for Men — Sisters runtime architecture.
--
-- The application now follows Mutqin for Sisters: React → supabase-js (Auth + RLS reads/writes + RPCs)
-- and service-role Edge Functions (admin-users, admin-actions, peer-tests). There is no custom server.
--
-- This migration:
--   1. removes the superseded Express-era server role (mutqin_app_server), its policies and functions;
--   2. adds the live Sisters write policies (browser writes under RLS) with column-limited grants;
--   3. grants service_role the table access the Edge Functions use (as in a standard Supabase project);
--   4. installs Sisters-style insert guards carrying the Men rules (sequential quarters, mandatory
--      peer test with audience, date-based reviews) so they are enforced by the database;
--   5. adds the Sisters functions start_next_cycle / create_profile_with_membership (verbatim) and the
--      Men-only multi-step operations as RPCs.
-- Imported rows, provenance (migration_private) and the read policies from 20261026000100 are kept.

-- ---------------------------------------------------------------------------------------------
-- 1. Remove the Express-era server role
-- ---------------------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['profiles','batches','batch_memberships','cycles','daily_thoughts','group_rest_days',
    'program_pauses','tasmia_submissions','review_confirmations','peer_tests','peer_test_selected_members',
    'peer_test_attempts','peer_test_attempt_questions','personal_tests','personal_test_questions'] loop
    execute format('drop policy if exists server_all on public.%I', t);
  end loop;
end $$;

drop function app_private.delete_member_completely(uuid);
drop function app_private.revoke_user_sessions(uuid);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'mutqin_app_server') then
    revoke all on all tables in schema public from mutqin_app_server;
    revoke all on all functions in schema app_private from mutqin_app_server;
    revoke all on schema public from mutqin_app_server;
    revoke all on schema app_private from mutqin_app_server;
    drop role mutqin_app_server;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 2. Men calendar (exact SQL port of calculateCycleInfo in src/lib/calculations.ts)
-- ---------------------------------------------------------------------------------------------

-- Program day for a date: 0 before the start, else elapsed days minus rest days (outside pauses),
-- paused days (dated periods + the legacy undated counter), clamped to 1..total_quarters.
create function app_private.men_cycle_day(p_cycle_id uuid, p_date date) returns integer
    language plpgsql stable security definer
    set search_path to ''
    as $$
declare
  c record;
  v_paused integer;
  v_rest integer;
begin
  select cy.starts_on, cy.total_quarters, cy.legacy_paused_days into c
  from public.cycles cy where cy.id = p_cycle_id;
  if not found then
    return null;
  end if;
  if p_date < c.starts_on then
    return 0;
  end if;

  -- Closed pause: paused_on .. resumed_on - 1; open pause: paused_on .. the target date.
  select coalesce(sum(greatest(0,
           least(coalesce(p.resumed_on - 1, greatest(p_date, p.paused_on)), p_date)
           - greatest(p.paused_on, c.starts_on) + 1)), 0)
  into v_paused
  from public.program_pauses p
  where p.cycle_id = p_cycle_id;

  select count(*) into v_rest
  from public.group_rest_days r
  where r.cycle_id = p_cycle_id
    and r.rest_date between c.starts_on and p_date
    and not exists (
      select 1 from public.program_pauses p
      where p.cycle_id = p_cycle_id
        and r.rest_date >= p.paused_on
        and (p.resumed_on is null or r.rest_date < p.resumed_on));

  return least(c.total_quarters, greatest(1, (p_date - c.starts_on + 1) - v_rest - v_paused - c.legacy_paused_days));
end;
$$;

-- The calendar date the program uses for "today" (the halaqah runs on Makkah time).
create function app_private.men_today() returns date
    language sql stable
    set search_path to ''
    as $$ select (now() at time zone 'Asia/Riyadh')::date $$;

-- A browser may send its local date; accept it only within one day of the program date.
create function app_private.men_client_date(p_date date) returns date
    language plpgsql stable
    set search_path to ''
    as $$
declare
  v_today date := app_private.men_today();
begin
  if p_date is null then
    return v_today;
  end if;
  if p_date not between v_today - 1 and v_today + 1 then
    raise exception 'التاريخ المحدد غير صالح' using errcode = 'check_violation';
  end if;
  return p_date;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Insert guards (Sisters tasmia_batch_guard / review_batch_guard + Men rules)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION app_private.tasmia_batch_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_batch_id      uuid;
  v_status        text;
  v_member_name   text;
  v_listener_name text;
  v_day           integer;
  v_required      integer;
  v_block_start   smallint;
  v_block_end     smallint;
begin
  select c.batch_id, c.status::text into v_batch_id, v_status
  from public.cycles c where c.id = new.cycle_id;

  if v_batch_id is null then
    raise exception 'الدورة غير موجودة' using errcode = 'foreign_key_violation';
  end if;
  if v_status <> 'active' then
    raise exception 'لا يمكن التسجيل في دورة مؤرشفة' using errcode = 'check_violation';
  end if;

  select p.full_name into v_member_name
  from public.batch_memberships m
  join public.profiles p on p.id = m.user_id
  where m.user_id = new.user_id and m.batch_id = v_batch_id and m.membership_role = 'member'
    and p.role = 'member' and p.active;
  if v_member_name is null then
    raise exception 'حسابك مُعلّق (مُقصَى) حاليًا أو لا ينتمي إلى هذه الدفعة، ولا يمكنك تسجيل التسميع.'
      using errcode = 'check_violation';
  end if;

  if new.listener_id is null then
    raise exception 'يرجى اختيار الزميل المستمع من أعضاء المقرأة (لا يُسمح بالتسميع على شخص من الخارج).'
      using errcode = 'check_violation';
  end if;
  v_listener_name := app_private.tasmia_listener_name(v_batch_id, new.user_id, new.listener_id);
  if v_listener_name is null then
    raise exception 'الزميل المستمع المحدد غير صالح. يجب اختيار زميل نشط من أعضاء المقرأة.'
      using errcode = 'check_violation';
  end if;

  -- One member's submissions are evaluated one at a time.
  perform pg_advisory_xact_lock(hashtextextended('tasmia:' || new.user_id::text, 0));

  new.legacy_date := app_private.men_client_date(new.legacy_date);
  v_day := app_private.men_cycle_day(new.cycle_id, new.legacy_date);
  if v_day = 0 then
    raise exception 'برنامج المقرأة لم يبدأ بعد، وسيتاح تسجيل التسميع عند بدء البرنامج.'
      using errcode = 'check_violation';
  end if;

  -- Men rule: quarters are recited in order, never ahead of the group's quarter of the day.
  select min(q) into v_required
  from generate_series(1, v_day) q
  where not exists (
    select 1 from public.tasmia_submissions t
    where t.cycle_id = new.cycle_id and t.user_id = new.user_id and t.quarter_number = q);
  if v_required is null then
    raise exception 'لقد أتممت بالفعل جميع الأرباع حتى ربع اليوم الحالي للمجموعة (الربع %). لا يمكن السبق على الجدول الزمني الجماعي.', v_day
      using errcode = 'check_violation';
  end if;
  if new.quarter_number <> v_required then
    raise exception 'لا يمكن تخطي الربع الفائت! الربع المطلوب منك تسميعه الآن هو الربع رقم (%). يجب تسميع الأرباع السابقة بالترتيب أولاً.', v_required
      using errcode = 'check_violation';
  end if;

  -- Mandatory peer-test checkpoint (Men: audience-aware; partial-range passes do not count).
  select t.range_start, t.range_end into v_block_start, v_block_end
  from public.peer_tests t
  where t.cycle_id = new.cycle_id
    and t.test_type = 'mandatory'
    and app_private.peer_test_is_live(t.status, t.visible_from, t.visible_until)
    and (t.audience = 'all' or exists (
          select 1 from public.peer_test_selected_members s where s.test_id = t.id and s.user_id = new.user_id))
    and new.quarter_number > t.range_end
    and not exists (
      select 1 from public.peer_test_attempts a
      where a.test_id = t.id and a.candidate_id = new.user_id and a.status = 'passed'
        and coalesce(a.covers_full_range, true))
  order by t.range_end
  limit 1;
  if v_block_end is not null then
    raise exception 'يجب اجتياز الاختبار الإلزامي للأرباع (% - %) بنجاح أولاً قبل متابعة تسميع الأرباع التالية.', v_block_start, v_block_end
      using errcode = 'P0001', hint = 'peer_test_required';
  end if;

  -- Set by the database; values sent by the browser are ignored.
  new.member_name_snapshot := v_member_name;
  new.listener_name_snapshot := v_listener_name;
  new.submitted_at := least(coalesce(new.submitted_at, now()), now());
  new.listener_changed_at := null;
  new.legacy_occurrence := 0;
  new.firestore_id := null;
  return new;
end;
$$;

CREATE FUNCTION app_private.tasmia_listener_name(p_batch_id uuid, p_reciter_id uuid, p_listener_id uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select p.full_name
  from public.batch_memberships m
  join public.profiles p on p.id = m.user_id
  where m.user_id = p_listener_id
    and p_listener_id <> p_reciter_id
    and m.batch_id = p_batch_id
    and m.membership_role = 'member'
    and p.role = 'member'
    and p.active;
$$;

CREATE FUNCTION app_private.review_batch_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_batch_id    uuid;
  v_status      text;
  v_starts_on   date;
  v_window      integer;
  v_member_name text;
  v_day         integer;
begin
  select c.batch_id, c.status::text, c.starts_on, c.review_window
  into v_batch_id, v_status, v_starts_on, v_window
  from public.cycles c where c.id = new.cycle_id;

  if v_batch_id is null then
    raise exception 'الدورة غير موجودة' using errcode = 'foreign_key_violation';
  end if;
  if v_status <> 'active' then
    raise exception 'لا يمكن التسجيل في دورة مؤرشفة' using errcode = 'check_violation';
  end if;

  select p.full_name into v_member_name
  from public.batch_memberships m
  join public.profiles p on p.id = m.user_id
  where m.user_id = new.user_id and m.batch_id = v_batch_id and m.membership_role = 'member'
    and p.role = 'member' and p.active;
  if v_member_name is null then
    raise exception 'حسابك مُعلّق (مُقصَى) حاليًا أو لا ينتمي إلى هذه الدفعة، ولا يمكنك تسجيل المراجعة.'
      using errcode = 'check_violation';
  end if;

  -- Men reviews are one per member per calendar date (rest and paused days may be recorded too).
  new.legacy_date := coalesce(new.legacy_date, app_private.men_today());
  if new.legacy_date > app_private.men_today() + 1 then
    raise exception 'التاريخ المحدد غير صالح: لا يمكن تسجيل مراجعة لتاريخ مستقبلي بعد اليوم الحالي.'
      using errcode = 'check_violation';
  end if;
  if new.legacy_date < v_starts_on then
    raise exception 'التاريخ المحدد غير صالح: لا يمكن تسجيل مراجعة لتاريخ يسبق بداية برنامج المقرأة.'
      using errcode = 'check_violation';
  end if;

  v_day := app_private.men_cycle_day(new.cycle_id, new.legacy_date);
  new.program_day := null;
  new.end_quarter := v_day;
  new.start_quarter := greatest(1, v_day - v_window + 1);
  new.member_name_snapshot := v_member_name;
  new.confirmed_at := least(coalesce(new.confirmed_at, now()), now());
  new.legacy_occurrence := 0;
  new.firestore_id := null;
  return new;
end;
$$;

CREATE TRIGGER tasmia_batch_guard BEFORE INSERT ON public.tasmia_submissions FOR EACH ROW EXECUTE FUNCTION app_private.tasmia_batch_guard();
CREATE TRIGGER review_batch_guard BEFORE INSERT ON public.review_confirmations FOR EACH ROW EXECUTE FUNCTION app_private.review_batch_guard();

-- At most one open pause per cycle.
create unique index program_pauses_one_open_idx on public.program_pauses (cycle_id) where resumed_on is null;

-- ---------------------------------------------------------------------------------------------
-- 4. Browser write policies (live Sisters policies, verbatim) + Men personal-test delete
-- ---------------------------------------------------------------------------------------------
CREATE POLICY tasmia_submissions_insert_own_batch ON public.tasmia_submissions FOR INSERT TO authenticated WITH CHECK (((user_id = ( SELECT auth.uid() AS uid)) AND (cycle_id = ( SELECT app_private.member_active_cycle_id() AS member_active_cycle_id))));
CREATE POLICY review_confirmations_insert_own_batch ON public.review_confirmations FOR INSERT TO authenticated WITH CHECK (((user_id = ( SELECT auth.uid() AS uid)) AND (cycle_id = ( SELECT app_private.member_active_cycle_id() AS member_active_cycle_id))));
CREATE POLICY group_rest_days_insert_managed ON public.group_rest_days FOR INSERT TO authenticated WITH CHECK (((cycle_id IN ( SELECT app_private.managed_cycle_ids() AS managed_cycle_ids)) AND (created_by = ( SELECT auth.uid() AS uid))));
CREATE POLICY group_rest_days_delete_managed ON public.group_rest_days FOR DELETE TO authenticated USING ((cycle_id IN ( SELECT app_private.managed_cycle_ids() AS managed_cycle_ids)));
CREATE POLICY program_pauses_insert_managed ON public.program_pauses FOR INSERT TO authenticated WITH CHECK (((cycle_id IN ( SELECT app_private.managed_cycle_ids() AS managed_cycle_ids)) AND (created_by = ( SELECT auth.uid() AS uid))));
CREATE POLICY program_pauses_update_managed ON public.program_pauses FOR UPDATE TO authenticated USING ((cycle_id IN ( SELECT app_private.managed_cycle_ids() AS managed_cycle_ids))) WITH CHECK ((cycle_id IN ( SELECT app_private.managed_cycle_ids() AS managed_cycle_ids)));
CREATE POLICY cycles_update_managed ON public.cycles FOR UPDATE TO authenticated USING ((batch_id IN ( SELECT app_private.managed_batch_ids() AS managed_batch_ids))) WITH CHECK ((batch_id IN ( SELECT app_private.managed_batch_ids() AS managed_batch_ids)));
CREATE POLICY daily_thoughts_insert_managed ON public.daily_thoughts FOR INSERT TO authenticated WITH CHECK (((batch_id IN ( SELECT app_private.managed_batch_ids() AS managed_batch_ids)) AND (published_by = ( SELECT auth.uid() AS uid))));
CREATE POLICY daily_thoughts_update_managed ON public.daily_thoughts FOR UPDATE TO authenticated USING ((batch_id IN ( SELECT app_private.managed_batch_ids() AS managed_batch_ids))) WITH CHECK ((batch_id IN ( SELECT app_private.managed_batch_ids() AS managed_batch_ids)));
CREATE POLICY personal_tests_delete_own ON public.personal_tests FOR DELETE TO authenticated USING ((member_id = ( SELECT auth.uid() AS uid)));

-- Column-limited: the browser can only supply the fields these features need.
grant insert (cycle_id, user_id, listener_id, quarter_number, notes, legacy_date) on public.tasmia_submissions to authenticated;
grant insert (cycle_id, user_id, notes, legacy_date) on public.review_confirmations to authenticated;
grant insert (cycle_id, rest_date, reason, created_by, created_by_name_snapshot) on public.group_rest_days to authenticated;
grant delete on public.group_rest_days to authenticated;
grant insert (cycle_id, paused_on, reason, created_by) on public.program_pauses to authenticated;
grant update (resumed_on) on public.program_pauses to authenticated;
grant update (starts_on) on public.cycles to authenticated;
grant insert (batch_id, content_html, published_by, published_by_name_snapshot, is_published) on public.daily_thoughts to authenticated;
grant update (is_published) on public.daily_thoughts to authenticated;
grant delete on public.personal_tests to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. Edge Functions (service role) — table access as in a standard Supabase project
-- ---------------------------------------------------------------------------------------------
grant usage on schema public to service_role;
grant select, insert, update, delete on table
  public.profiles, public.batches, public.batch_memberships, public.batch_membership_transfers, public.cycles,
  public.daily_thoughts, public.group_rest_days, public.program_pauses, public.tasmia_submissions,
  public.review_confirmations, public.peer_tests, public.peer_test_selected_members, public.peer_test_attempts,
  public.peer_test_attempt_questions, public.personal_tests, public.personal_test_questions
  to service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. Sisters functions (verbatim)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public.create_profile_with_membership(p_id uuid, p_full_name text, p_phone text, p_role text, p_is_master_admin boolean, p_member_batch_id uuid, p_admin_batch_ids uuid[], p_actor uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  v_is_master boolean := (p_role = 'admin' and coalesce(p_is_master_admin, false));
begin
  if p_role not in ('member', 'admin') then
    raise exception 'الدور غير صالح' using errcode = 'check_violation';
  end if;

  if p_role = 'member' and p_member_batch_id is null then
    raise exception 'يرجى اختيار دفعة العضوة' using errcode = 'check_violation';
  end if;

  if p_role = 'admin'
     and not v_is_master
     and coalesce(array_length(p_admin_batch_ids, 1), 0) = 0 then
    raise exception 'يرجى اختيار دفعة واحدة على الأقل لمشرفة الدفعة'
      using errcode = 'check_violation';
  end if;

  -- The role is inlined as a literal so this works whether
  -- profiles.role is text or an enum.
  execute format(
    'insert into public.profiles (id, full_name, phone, role, active, is_master_admin)
     values ($1, $2, $3, %L, true, $4)',
    p_role
  )
  using p_id, btrim(p_full_name), p_phone, v_is_master;

  if p_role = 'member' then
    insert into public.batch_memberships (batch_id, user_id, membership_role, created_by)
    values (p_member_batch_id, p_id, 'member', p_actor);
  elsif not v_is_master then
    insert into public.batch_memberships (batch_id, user_id, membership_role, created_by)
    select distinct b.batch_id, p_id, 'admin', p_actor
    from unnest(p_admin_batch_ids) as b(batch_id);
  end if;
end;
$_$;

CREATE FUNCTION public.start_next_cycle(p_batch_id uuid, p_today date, p_actor uuid, p_expected_cycle_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_current public.cycles;
  v_new     public.cycles;
  v_next    integer;
begin
  -- Serialize concurrent resets of the same batch.
  perform 1
  from public.batches b
  where b.id = p_batch_id
    and b.archived_at is null
  for update;

  if not found then
    raise exception 'الدفعة غير موجودة' using errcode = 'no_data_found';
  end if;

  select c.* into v_current
  from public.cycles c
  where c.batch_id = p_batch_id
    and c.status = 'active'
  order by c.cycle_number desc
  limit 1
  for update;

  -- The cycle the admin was looking at must belong to THIS batch and
  -- still be its active cycle.
  if p_expected_cycle_id is not null
     and (v_current.id is null or v_current.id <> p_expected_cycle_id) then
    raise exception 'تغيّرت الدورة الحالية لهذه الدفعة. يرجى تحديث الصفحة والمحاولة مرة أخرى'
      using errcode = 'check_violation';
  end if;

  if v_current.id is not null then
    -- 1. Close an open pause so the archived history is complete.
    update public.program_pauses
    set resumed_on = p_today
    where cycle_id = v_current.id
      and resumed_on is null;

    -- 2. Archive the current cycle (its logs stay attached to it).
    update public.cycles
    set status = 'archived',
        ended_on = p_today
    where id = v_current.id;

    -- 3. Unpublish this batch's current daily thought (kept as history).
    update public.daily_thoughts
    set is_published = false
    where batch_id = p_batch_id
      and is_published;

    -- 4. Finish this cycle's peer tests (results stay as history).
    update public.peer_test_attempts
    set status = 'cancelled'
    where status = 'in_progress'
      and test_id in (select t.id from public.peer_tests t where t.cycle_id = v_current.id);

    update public.peer_tests
    set status = 'finished', finished_at = now(), updated_at = now()
    where cycle_id = v_current.id
      and status <> 'finished';
  end if;

  select coalesce(max(c.cycle_number), 0) + 1
  into v_next
  from public.cycles c
  where c.batch_id = p_batch_id;

  -- 5. Create the new active cycle.
  insert into public.cycles (batch_id, cycle_number, name, starts_on, status, created_by)
  values (p_batch_id, v_next, 'الدورة ' || v_next, p_today, 'active', p_actor)
  returning * into v_new;

  return jsonb_build_object(
    'previous_cycle_id', v_current.id,
    'previous_cycle_number', v_current.cycle_number,
    'cycle', to_jsonb(v_new)
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 7. Men RPCs
-- ---------------------------------------------------------------------------------------------

-- Admin (browser): record a past pause whose dates were never stored, moving its days out of the
-- legacy undated counter. One transaction.
CREATE FUNCTION public.men_add_past_pause_period(p_cycle_id uuid, p_from date, p_to date) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if p_cycle_id not in (select app_private.managed_cycle_ids()) then
    raise exception 'هذا الإجراء مخصص للمشرف فقط' using errcode = 'insufficient_privilege';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'تواريخ الإيقاف غير صالحة (من/إلى).' using errcode = 'check_violation';
  end if;
  insert into public.program_pauses (cycle_id, paused_on, resumed_on, created_by)
  values (p_cycle_id, p_from, p_to + 1, auth.uid());
  update public.cycles
  set legacy_paused_days = greatest(0, legacy_paused_days - (p_to - p_from + 1))
  where id = p_cycle_id;
end;
$$;

-- Admin (browser): add the missing daily reviews of every active member up to p_until (inclusive).
-- Only inserts; never edits or deletes. Idempotent.
CREATE FUNCTION public.men_backfill_revisions(p_cycle_id uuid, p_until date) RETURNS integer
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
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Member (browser): save one finished personal self-test. Grades are computed here (never trusted).
CREATE FUNCTION public.men_save_personal_test(p_test jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_id uuid := gen_random_uuid();
  v_count integer;
  v_grade numeric;
begin
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.active) then
    raise exception 'حسابك مُعلّق حاليًا' using errcode = 'insufficient_privilege';
  end if;
  v_count := jsonb_array_length(coalesce(p_test->'questions', '[]'::jsonb));
  if v_count < 1 or v_count > 30 or v_count <> (p_test->>'questions_count')::integer then
    raise exception 'عدد الأسئلة المرسلة لا يطابق عدد أسئلة الاختبار' using errcode = 'check_violation';
  end if;
  if exists (select 1 from jsonb_array_elements(p_test->'questions') q
             where (q->>'errors_count')::integer not between 0 and 99) then
    raise exception 'عدد الأخطاء يجب أن يكون بين 0 و 99' using errcode = 'check_violation';
  end if;

  select round(avg(greatest(0, 100 - 15 * (q->>'errors_count')::integer)))
  into v_grade
  from jsonb_array_elements(p_test->'questions') q;

  insert into public.personal_tests (id, member_id, range_type, range_label, start_surah, start_surah_name,
    end_surah, end_surah_name, start_juz, end_juz, start_quarter, end_quarter, questions_count, lines_per_question,
    difficulty, total_errors, grade, grade_label, notes, date, created_at)
  values (v_id, auth.uid(), p_test->>'range_type', p_test->>'range_label',
    (p_test->>'start_surah')::integer, p_test->>'start_surah_name',
    (p_test->>'end_surah')::integer, p_test->>'end_surah_name',
    (p_test->>'start_juz')::integer, (p_test->>'end_juz')::integer,
    (p_test->>'start_quarter')::integer, (p_test->>'end_quarter')::integer,
    v_count, (p_test->>'lines_per_question')::integer, coalesce(p_test->>'difficulty', 'any'),
    (select sum((q->>'errors_count')::integer) from jsonb_array_elements(p_test->'questions') q),
    v_grade,
    case when v_grade >= 90 then 'ممتاز' when v_grade >= 80 then 'جيد جدًا' when v_grade >= 65 then 'جيد'
         when v_grade >= 50 then 'مقبول' else 'يحتاج مراجعة' end,
    nullif(left(btrim(coalesce(p_test->>'notes', '')), 300), ''),
    app_private.men_client_date((p_test->>'date')::date), now());

  insert into public.personal_test_questions (test_id, question_number, start_surah, start_surah_name, start_ayah,
    end_surah, end_surah_name, end_ayah, errors_count, grade, difficulty_level)
  select v_id, ord::integer, (q->>'start_surah')::integer, q->>'start_surah_name', (q->>'start_ayah')::integer,
         (q->>'end_surah')::integer, q->>'end_surah_name', (q->>'end_ayah')::integer,
         (q->>'errors_count')::integer, greatest(0, 100 - 15 * (q->>'errors_count')::integer),
         case when q->>'difficulty_level' in ('easy', 'medium', 'hard') then q->>'difficulty_level' end
  from jsonb_array_elements(p_test->'questions') with ordinality as x(q, ord);
  return v_id;
end;
$$;

-- Edge Function (admin-users): permanent deletion of a member's records before the Auth user is
-- deleted. Mirrors the legacy behavior (attempts as candidate or examiner are removed too) and
-- clears rows that would block the cascade.
CREATE FUNCTION public.men_delete_member_completely(p_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_role text;
  v_recitations integer;
  v_revisions integer;
  v_attempts integer;
begin
  select p.role into v_role from public.profiles p where p.id = p_user_id for update;
  if not found then
    raise exception 'العضو غير موجود' using errcode = 'P0002';
  end if;
  if v_role = 'admin' then
    raise exception 'لا يمكن حذف حساب المشرف' using errcode = 'P0001';
  end if;
  delete from public.peer_test_attempts a where a.candidate_id = p_user_id or a.examiner_id = p_user_id;
  get diagnostics v_attempts = row_count;
  delete from public.peer_test_selected_members s where s.user_id = p_user_id;
  delete from public.personal_tests t where t.member_id = p_user_id;
  select count(*) into v_recitations from public.tasmia_submissions t where t.user_id = p_user_id;
  select count(*) into v_revisions from public.review_confirmations r where r.user_id = p_user_id;
  delete from migration_private.user_credentials c where c.profile_id = p_user_id;
  delete from public.profiles p where p.id = p_user_id;
  return jsonb_build_object('recitations', v_recitations, 'revisions', v_revisions, 'attempts', v_attempts);
end;
$$;

-- Edge Function (admin-users): switch an account between member and admin (Men supports this).
-- Men admins are master admins (one batch); members get the batch membership back.
CREATE FUNCTION public.men_set_account_role(p_user_id uuid, p_role text, p_batch_id uuid, p_actor uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if p_role not in ('member', 'admin') then
    raise exception 'الدور غير صالح' using errcode = 'check_violation';
  end if;
  update public.profiles set role = p_role, is_master_admin = (p_role = 'admin') where id = p_user_id;
  if not found then
    raise exception 'العضو غير موجود' using errcode = 'P0002';
  end if;
  if p_role = 'admin' then
    delete from public.batch_memberships where user_id = p_user_id and membership_role = 'member';
  else
    delete from public.batch_memberships where user_id = p_user_id and membership_role = 'admin';
    insert into public.batch_memberships (batch_id, user_id, membership_role, created_by)
    values (p_batch_id, p_user_id, 'member', p_actor)
    on conflict (batch_id, user_id) do update set membership_role = 'member';
  end if;
end;
$$;

-- Edge Function (peer-tests): create or update a test. With prior attempts, a material change saves a
-- new version and hides the old one. Activating a test hides every other published test of the cycle.
CREATE FUNCTION public.men_peer_test_save(p_cycle_id uuid, p_test_id uuid, p_test jsonb, p_selected uuid[], p_actor uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_old public.peer_tests;
  v_row public.peer_tests;
  v_versioned boolean := false;
  v_id uuid;
  v_status text := case when (p_test->>'is_active')::boolean then 'published' else 'hidden' end;
begin
  perform 1 from public.cycles c where c.id = p_cycle_id and c.status = 'active' for update;
  if not found then
    raise exception 'لا توجد دورة نشطة' using errcode = 'P0001';
  end if;

  if p_test_id is not null then
    select * into v_old from public.peer_tests t where t.id = p_test_id and t.cycle_id = p_cycle_id for update;
  end if;
  if v_old.id is not null and v_old.status = 'finished' then
    raise exception 'هذا الاختبار منتهٍ نهائيًا ولا يمكن إعادة تفعيله، أنشئ اختبارًا جديدًا' using errcode = 'P0001';
  end if;
  if v_old.id is not null and exists (select 1 from public.peer_test_attempts a where a.test_id = v_old.id)
     and (v_old.range_start, v_old.range_end, v_old.questions_count, v_old.lines_per_question, v_old.difficulty)
         is distinct from ((p_test->>'range_start')::smallint, (p_test->>'range_end')::smallint,
           (p_test->>'questions_count')::smallint, (p_test->>'lines_per_question')::smallint, p_test->>'difficulty') then
    v_versioned := true;
    update public.peer_tests set status = 'hidden', updated_at = now() where id = v_old.id;
  end if;

  v_id := case when v_old.id is null or v_versioned then gen_random_uuid() else v_old.id end;
  if v_status = 'published' then
    update public.peer_tests set status = 'hidden', updated_at = now()
    where cycle_id = p_cycle_id and status = 'published' and id <> v_id;
  end if;

  if v_id = v_old.id then
    update public.peer_tests set
      title = p_test->>'title', range_start = (p_test->>'range_start')::smallint, range_end = (p_test->>'range_end')::smallint,
      questions_count = (p_test->>'questions_count')::smallint, lines_per_question = (p_test->>'lines_per_question')::smallint,
      max_errors = (p_test->>'max_errors')::smallint, test_type = p_test->>'test_type', difficulty = p_test->>'difficulty',
      status = v_status, audience = p_test->>'audience', created_by = p_actor, updated_at = now(),
      require_all_quarters_completed = (p_test->>'require_all_quarters_completed')::boolean,
      require_revision_completed = (p_test->>'require_revision_completed')::boolean
    where id = v_id returning * into v_row;
    delete from public.peer_test_selected_members where test_id = v_id;
  else
    insert into public.peer_tests (id, cycle_id, title, range_start, range_end, questions_count, lines_per_question,
      max_errors, test_type, difficulty, status, created_by, require_all_quarters_completed,
      require_revision_completed, audience)
    values (v_id, p_cycle_id, p_test->>'title', (p_test->>'range_start')::smallint, (p_test->>'range_end')::smallint,
      (p_test->>'questions_count')::smallint, (p_test->>'lines_per_question')::smallint, (p_test->>'max_errors')::smallint,
      p_test->>'test_type', p_test->>'difficulty', v_status, p_actor,
      (p_test->>'require_all_quarters_completed')::boolean, (p_test->>'require_revision_completed')::boolean,
      p_test->>'audience')
    returning * into v_row;
  end if;

  insert into public.peer_test_selected_members (test_id, user_id, position)
  select v_id, s.user_id, s.ord - 1
  from unnest(coalesce(p_selected, '{}'::uuid[])) with ordinality as s(user_id, ord);

  return jsonb_build_object('test', to_jsonb(v_row), 'versioned', v_versioned);
end;
$$;

-- Edge Function (peer-tests): show / hide / finish a test.
CREATE FUNCTION public.men_peer_test_set_status(p_test_id uuid, p_action text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_test public.peer_tests;
begin
  select * into v_test from public.peer_tests where id = p_test_id for update;
  if not found then
    raise exception 'الاختبار غير موجود' using errcode = 'P0002';
  end if;
  if v_test.status = 'finished' then
    raise exception '%', case when p_action = 'finish' then 'هذا الاختبار منتهٍ بالفعل ولا يمكن إنهاؤه مجدداً'
      else 'هذا الاختبار منتهٍ نهائيًا ولا يمكن إعادة تفعيله، أنشئ اختبارًا جديدًا' end using errcode = 'P0001';
  end if;
  if p_action = 'show' then
    if v_test.audience = 'selected'
       and not exists (select 1 from public.peer_test_selected_members s where s.test_id = p_test_id) then
      raise exception 'لا يمكن تفعيل اختبار مخصص لأعضاء مختارين دون تحديد أي عضو في قائمته' using errcode = 'P0001';
    end if;
    update public.peer_tests set status = 'hidden', updated_at = now()
    where cycle_id = v_test.cycle_id and status = 'published' and id <> p_test_id;
    update public.peer_tests set status = 'published', updated_at = now() where id = p_test_id returning * into v_test;
  elsif p_action = 'hide' then
    update public.peer_tests set status = 'hidden', updated_at = now() where id = p_test_id returning * into v_test;
  elsif p_action = 'finish' then
    update public.peer_tests set status = 'finished', finished_at = now(), updated_at = now()
    where id = p_test_id returning * into v_test;
  else
    raise exception 'إجراء غير معروف' using errcode = 'P0001';
  end if;
  return jsonb_build_object('test', to_jsonb(v_test));
end;
$$;

-- Edge Function (peer-tests): store one completed attempt and its questions atomically.
-- Pass/fail is computed here from the stored errors and the test's error limit.
CREATE FUNCTION public.men_peer_test_record_attempt(p_attempt jsonb, p_questions jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_test public.peer_tests;
  v_total integer;
  v_status text;
  v_row public.peer_test_attempts;
begin
  select * into v_test from public.peer_tests where id = (p_attempt->>'test_id')::uuid for update;
  if not found or v_test.status <> 'published' then
    raise exception 'هذا الاختبار غير مفعّل حالياً' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.peer_test_attempts a
             where a.test_id = v_test.id and a.candidate_id = (p_attempt->>'candidate_id')::uuid
               and a.examiner_id = (p_attempt->>'examiner_id')::uuid and a.created_at > now() - interval '60 seconds') then
    raise exception 'تم تسجيل محاولة لنفس العضو من قِبلك للتو! يرجى الانتظار دقيقة واحدة قبل تسجيل محاولة جديدة منعاً للتكرار.'
      using errcode = 'P0001', hint = 'duplicate_attempt';
  end if;

  select sum((q->>'errors_count')::integer) into v_total from jsonb_array_elements(p_questions) q;
  v_status := case when v_test.max_errors is null or v_total <= v_test.max_errors then 'passed' else 'failed' end;

  insert into public.peer_test_attempts (test_id, candidate_id, candidate_name_snapshot, examiner_id, examiner_name_snapshot,
    status, total_errors, max_errors_snapshot, notes, attempt_date, completed_at, effective_range_end, covers_full_range)
  values (v_test.id, (p_attempt->>'candidate_id')::uuid, p_attempt->>'candidate_name', (p_attempt->>'examiner_id')::uuid,
    p_attempt->>'examiner_name', v_status, v_total, v_test.max_errors, nullif(p_attempt->>'notes', ''),
    (p_attempt->>'date')::date, now(), (p_attempt->>'effective_range_end')::integer,
    (p_attempt->>'covers_full_range')::boolean)
  returning * into v_row;

  insert into public.peer_test_attempt_questions (attempt_id, question_number, start_surah, start_surah_name, start_ayah,
    end_surah, end_surah_name, end_ayah, start_page, start_line, end_page, end_line, actual_lines, errors_count, notes,
    legacy_incomplete)
  select v_row.id, (q->>'question_number')::smallint, (q->>'start_surah')::smallint, q->>'start_surah_name',
         (q->>'start_ayah')::smallint, (q->>'end_surah')::smallint, q->>'end_surah_name', (q->>'end_ayah')::smallint,
         (q->>'start_page')::smallint, (q->>'start_line')::smallint, (q->>'end_page')::smallint,
         (q->>'end_line')::smallint, (q->>'actual_lines')::smallint, (q->>'errors_count')::smallint,
         nullif(q->>'notes', ''), false
  from jsonb_array_elements(p_questions) q;

  return jsonb_build_object('attempt', to_jsonb(v_row));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 8. Function privileges
-- ---------------------------------------------------------------------------------------------
do $$
declare
  f text;
  r text;
begin
  foreach f in array array[
    'app_private.men_cycle_day(uuid, date)', 'app_private.men_today()', 'app_private.men_client_date(date)',
    'app_private.tasmia_batch_guard()', 'app_private.tasmia_listener_name(uuid, uuid, uuid)', 'app_private.review_batch_guard()',
    'public.create_profile_with_membership(uuid, text, text, text, boolean, uuid, uuid[], uuid)',
    'public.start_next_cycle(uuid, date, uuid, uuid)', 'public.men_add_past_pause_period(uuid, date, date)',
    'public.men_backfill_revisions(uuid, date)', 'public.men_save_personal_test(jsonb)',
    'public.men_delete_member_completely(uuid)', 'public.men_set_account_role(uuid, text, uuid, uuid)',
    'public.men_peer_test_save(uuid, uuid, jsonb, uuid[], uuid)', 'public.men_peer_test_set_status(uuid, text)',
    'public.men_peer_test_record_attempt(jsonb, jsonb)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', f, r);
      end if;
    end loop;
  end loop;
end $$;

-- Browser RPCs (each checks the caller itself).
grant execute on function public.men_add_past_pause_period(uuid, date, date), public.men_backfill_revisions(uuid, date),
  public.men_save_personal_test(jsonb) to authenticated;
-- Edge Functions only.
grant execute on function public.create_profile_with_membership(uuid, text, text, text, boolean, uuid, uuid[], uuid),
  public.start_next_cycle(uuid, date, uuid, uuid), public.men_delete_member_completely(uuid),
  public.men_set_account_role(uuid, text, uuid, uuid), public.men_peer_test_save(uuid, uuid, jsonb, uuid[], uuid),
  public.men_peer_test_set_status(uuid, text), public.men_peer_test_record_attempt(jsonb, jsonb)
  to service_role;
