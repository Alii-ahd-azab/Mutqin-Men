-- Mutqin for Men — application cutover: access model (Phase C/D).
--
-- Applied AFTER the Phase 1 foundation/preservation migrations on the populated Men database.
-- It never changes or deletes imported rows.
--
-- Access model:
--   * Browser clients (anon/authenticated via the publishable key) get READ-ONLY access through
--     Sisters-style RLS (live Sisters helper functions, copied verbatim) plus Men audience/personal rules.
--     No client write policies: every Men write goes through the Express server, which enforces the
--     sequential-quarter, eligibility and admin rules that RLS cannot express.
--   * The Express server connects as the dedicated role mutqin_app_server (no BYPASSRLS, no auth/storage
--     access) with explicit per-table grants and explicit server policies.
--   * anon and service_role receive no table access.

-- ---------------------------------------------------------------------------------------------
-- Men date-based reviews: one review per member per calendar date. Rest/paused days share a
-- program day with the preceding active day, so new rows store the date and leave program_day null,
-- exactly like the approved Phase 1 mapping of historical revisions.
-- ---------------------------------------------------------------------------------------------
alter table public.review_confirmations drop constraint reviews_legacy_unknown_day;
alter table public.review_confirmations
  add constraint reviews_day_or_date check ((program_day is not null) or (legacy_date is not null));

-- ---------------------------------------------------------------------------------------------
-- Helper schemas (definitions below are the live Sisters app_private helpers, unchanged).
-- ---------------------------------------------------------------------------------------------
create schema if not exists app_private;
revoke all on schema app_private from public;

CREATE FUNCTION app_private.is_master_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
      and p.is_master_admin
      and p.active
  );
$$;

CREATE FUNCTION app_private.managed_batch_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select b.id
  from public.batches b
  where app_private.is_master_admin()
  union
  select m.batch_id
  from public.batch_memberships m
  join public.profiles p on p.id = m.user_id
  where m.user_id = auth.uid()
    and m.membership_role = 'admin'
    and p.role = 'admin'
    and p.active;
$$;

CREATE FUNCTION app_private.managed_cycle_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select c.id
  from public.cycles c
  where c.batch_id in (select app_private.managed_batch_ids());
$$;

CREATE FUNCTION app_private.managed_peer_test_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select t.id
  from public.peer_tests t
  where t.cycle_id in (select app_private.managed_cycle_ids());
$$;

CREATE FUNCTION app_private.member_batch_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select m.batch_id
  from public.batch_memberships m
  join public.profiles p on p.id = m.user_id
  where m.user_id = auth.uid()
    and m.membership_role = 'member'
    and p.role = 'member'
    and p.active
  limit 1;
$$;

CREATE FUNCTION app_private.member_active_cycle_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select c.id
  from public.cycles c
  where c.batch_id = app_private.member_batch_id()
    and c.status = 'active'
  limit 1;
$$;

CREATE FUNCTION app_private.viewable_batch_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select app_private.managed_batch_ids()
  union
  select app_private.member_batch_id()
  where app_private.member_batch_id() is not null;
$$;

CREATE FUNCTION app_private.viewable_profile_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select p.id
  from public.profiles p
  where app_private.is_master_admin()
  union
  select m.user_id
  from public.batch_memberships m
  where m.batch_id in (select app_private.managed_batch_ids())
  union
  select m.user_id
  from public.batch_memberships m
  join public.profiles p on p.id = m.user_id
  where m.batch_id = app_private.member_batch_id()
    and p.active
  union
  select p.id
  from public.profiles p
  where p.role = 'admin'
    and p.is_master_admin
    and p.active
    and exists (select 1 from app_private.viewable_batch_ids());
$$;

CREATE FUNCTION app_private.visible_peer_attempt_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select a.id
  from public.peer_test_attempts a
  where a.test_id in (select app_private.managed_peer_test_ids())
     or a.candidate_id = auth.uid()
     or a.examiner_id = auth.uid();
$$;

CREATE FUNCTION app_private.peer_test_is_live(p_status text, p_visible_from timestamp with time zone, p_visible_until timestamp with time zone) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select p_status = 'published'
     and (p_visible_from is null or p_visible_from <= now())
     and (p_visible_until is null or p_visible_until > now());
$$;

-- Men-only helper: is the caller in the audience of a peer test ('all' or explicitly selected)?
CREATE FUNCTION app_private.in_peer_test_audience(p_test_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1 from public.peer_tests t
    where t.id = p_test_id
      and (t.audience = 'all'
           or exists (select 1 from public.peer_test_selected_members s
                      where s.test_id = t.id and s.user_id = auth.uid()))
  );
$$;

-- ---------------------------------------------------------------------------------------------
-- Server-only routines.
-- ---------------------------------------------------------------------------------------------

-- Permanent member deletion (admin "delete completely"): one atomic statement set.
-- Mirrors the legacy behavior (user + recitations + revisions + attempts as candidate or examiner)
-- and also removes rows that would otherwise block the delete (audience selection, personal tests,
-- preserved legacy credential hash).
CREATE FUNCTION app_private.delete_member_completely(p_user_id uuid) RETURNS jsonb
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
    raise exception 'profile not found' using errcode = 'P0002';
  end if;
  if v_role = 'admin' then
    raise exception 'admin profiles cannot be deleted' using errcode = '42501';
  end if;

  delete from public.peer_test_attempts a where a.candidate_id = p_user_id or a.examiner_id = p_user_id;
  get diagnostics v_attempts = row_count;
  delete from public.peer_test_selected_members s where s.user_id = p_user_id;
  delete from public.personal_tests t where t.member_id = p_user_id;
  select count(*) into v_recitations from public.tasmia_submissions t where t.user_id = p_user_id;
  select count(*) into v_revisions from public.review_confirmations r where r.user_id = p_user_id;
  delete from migration_private.user_credentials c where c.profile_id = p_user_id;
  -- Cascades: tasmia_submissions, review_confirmations, batch_memberships, batch_membership_transfers.
  delete from public.profiles p where p.id = p_user_id;

  return jsonb_build_object('recitations', v_recitations, 'revisions', v_revisions, 'attempts', v_attempts);
end;
$$;

-- Ends every Supabase Auth session of a user (password change/reset).
-- Returns the number of sessions ended, or -1 if the platform does not allow it (the caller logs it;
-- the password change itself still succeeds, matching Supabase's own behavior).
CREATE FUNCTION app_private.revoke_user_sessions(p_user_id uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_count integer;
begin
  delete from auth.sessions s where s.user_id = p_user_id;
  get diagnostics v_count = row_count;
  return v_count;
exception
  when insufficient_privilege then
    return -1;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Function privileges.
-- ---------------------------------------------------------------------------------------------
revoke all on all functions in schema app_private from public;
do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on all functions in schema app_private from %I', role_name);
    end if;
  end loop;
end $$;

grant usage on schema app_private to authenticated;
grant execute on function
  app_private.is_master_admin(),
  app_private.managed_batch_ids(),
  app_private.managed_cycle_ids(),
  app_private.managed_peer_test_ids(),
  app_private.member_batch_id(),
  app_private.member_active_cycle_id(),
  app_private.viewable_batch_ids(),
  app_private.viewable_profile_ids(),
  app_private.visible_peer_attempt_ids(),
  app_private.peer_test_is_live(text, timestamp with time zone, timestamp with time zone),
  app_private.in_peer_test_audience(uuid)
  to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Browser (authenticated) read policies. Sisters live policies, verbatim, except where noted.
-- ---------------------------------------------------------------------------------------------
CREATE POLICY profiles_select_visible ON public.profiles FOR SELECT TO authenticated USING (((id = ( SELECT auth.uid() AS uid)) OR (id IN ( SELECT app_private.viewable_profile_ids() AS viewable_profile_ids))));
CREATE POLICY batches_select_accessible ON public.batches FOR SELECT TO authenticated USING ((id IN ( SELECT app_private.viewable_batch_ids() AS viewable_batch_ids)));
CREATE POLICY batch_memberships_select_accessible ON public.batch_memberships FOR SELECT TO authenticated USING (((user_id = ( SELECT auth.uid() AS uid)) OR (batch_id IN ( SELECT app_private.viewable_batch_ids() AS viewable_batch_ids))));
CREATE POLICY cycles_select_accessible ON public.cycles FOR SELECT TO authenticated USING (((batch_id IN ( SELECT app_private.managed_batch_ids() AS managed_batch_ids)) OR (id = ( SELECT app_private.member_active_cycle_id() AS member_active_cycle_id))));
CREATE POLICY daily_thoughts_select_accessible ON public.daily_thoughts FOR SELECT TO authenticated USING (((batch_id IN ( SELECT app_private.managed_batch_ids() AS managed_batch_ids)) OR (is_published AND (batch_id IN ( SELECT app_private.viewable_batch_ids() AS viewable_batch_ids)))));
CREATE POLICY group_rest_days_select_accessible ON public.group_rest_days FOR SELECT TO authenticated USING (((cycle_id IN ( SELECT app_private.managed_cycle_ids() AS managed_cycle_ids)) OR (cycle_id = ( SELECT app_private.member_active_cycle_id() AS member_active_cycle_id))));
CREATE POLICY program_pauses_select_accessible ON public.program_pauses FOR SELECT TO authenticated USING (((cycle_id IN ( SELECT app_private.managed_cycle_ids() AS managed_cycle_ids)) OR (cycle_id = ( SELECT app_private.member_active_cycle_id() AS member_active_cycle_id))));
CREATE POLICY review_confirmations_select_accessible ON public.review_confirmations FOR SELECT TO authenticated USING (((cycle_id IN ( SELECT app_private.managed_cycle_ids() AS managed_cycle_ids)) OR ((cycle_id = ( SELECT app_private.member_active_cycle_id() AS member_active_cycle_id)) AND (user_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY tasmia_submissions_select_accessible ON public.tasmia_submissions FOR SELECT TO authenticated USING (((cycle_id IN ( SELECT app_private.managed_cycle_ids() AS managed_cycle_ids)) OR ((cycle_id = ( SELECT app_private.member_active_cycle_id() AS member_active_cycle_id)) AND ((user_id = ( SELECT auth.uid() AS uid)) OR (listener_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY peer_test_attempts_select ON public.peer_test_attempts FOR SELECT TO authenticated USING ((id IN ( SELECT app_private.visible_peer_attempt_ids() AS visible_peer_attempt_ids)));
CREATE POLICY peer_test_attempt_questions_select ON public.peer_test_attempt_questions FOR SELECT TO authenticated USING ((attempt_id IN ( SELECT app_private.visible_peer_attempt_ids() AS visible_peer_attempt_ids)));
-- Sisters peer_tests_select plus the Men audience rule (selected-audience tests stay hidden from non-selected members).
CREATE POLICY peer_tests_select ON public.peer_tests FOR SELECT TO authenticated USING (((cycle_id IN ( SELECT app_private.managed_cycle_ids() AS managed_cycle_ids)) OR ((cycle_id = ( SELECT app_private.member_active_cycle_id() AS member_active_cycle_id)) AND app_private.peer_test_is_live(status, visible_from, visible_until) AND app_private.in_peer_test_audience(id))));
-- Men-only tables.
CREATE POLICY peer_test_selected_members_select ON public.peer_test_selected_members FOR SELECT TO authenticated USING (((test_id IN ( SELECT app_private.managed_peer_test_ids() AS managed_peer_test_ids)) OR (user_id = ( SELECT auth.uid() AS uid))));
CREATE POLICY personal_tests_select_own ON public.personal_tests FOR SELECT TO authenticated USING ((member_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY personal_test_questions_select_own ON public.personal_test_questions FOR SELECT TO authenticated USING ((test_id IN ( SELECT t.id FROM public.personal_tests t WHERE (t.member_id = ( SELECT auth.uid() AS uid)))));

grant select on table
  public.profiles,
  public.batches,
  public.batch_memberships,
  public.cycles,
  public.daily_thoughts,
  public.group_rest_days,
  public.program_pauses,
  public.review_confirmations,
  public.tasmia_submissions,
  public.peer_tests,
  public.peer_test_attempts,
  public.peer_test_attempt_questions,
  public.peer_test_selected_members,
  public.personal_tests,
  public.personal_test_questions
  to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Express server role. Created without LOGIN; the operator enables it with a strong password:
--   alter role mutqin_app_server with login password '<generated secret>';
-- ---------------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mutqin_app_server') then
    create role mutqin_app_server nologin noinherit;
  end if;
end $$;

grant usage on schema public to mutqin_app_server;
grant usage on schema app_private to mutqin_app_server;
grant execute on function app_private.delete_member_completely(uuid), app_private.revoke_user_sessions(uuid) to mutqin_app_server;

grant select, insert, update on table public.profiles to mutqin_app_server;
grant select on table public.batches to mutqin_app_server;
grant select, insert, update on table public.batch_memberships to mutqin_app_server;
grant select, update on table public.cycles to mutqin_app_server;
grant select, insert, update on table public.daily_thoughts to mutqin_app_server;
grant select, insert, delete on table public.group_rest_days to mutqin_app_server;
grant select, insert, update, delete on table public.program_pauses to mutqin_app_server;
grant select, insert, delete on table public.tasmia_submissions to mutqin_app_server;
grant select, insert, delete on table public.review_confirmations to mutqin_app_server;
grant select, insert, update on table public.peer_tests to mutqin_app_server;
grant select, insert, delete on table public.peer_test_selected_members to mutqin_app_server;
grant select, insert, delete on table public.peer_test_attempts to mutqin_app_server;
grant select, insert on table public.peer_test_attempt_questions to mutqin_app_server;
grant select, insert, delete on table public.personal_tests to mutqin_app_server;
grant select, insert on table public.personal_test_questions to mutqin_app_server;

CREATE POLICY server_all ON public.profiles TO mutqin_app_server USING (true) WITH CHECK (true);
CREATE POLICY server_all ON public.batches TO mutqin_app_server USING (true) WITH CHECK (true);
CREATE POLICY server_all ON public.batch_memberships TO mutqin_app_server USING (true) WITH CHECK (true);
CREATE POLICY server_all ON public.cycles TO mutqin_app_server USING (true) WITH CHECK (true);
CREATE POLICY server_all ON public.daily_thoughts TO mutqin_app_server USING (true) WITH CHECK (true);
CREATE POLICY server_all ON public.group_rest_days TO mutqin_app_server USING (true) WITH CHECK (true);
CREATE POLICY server_all ON public.program_pauses TO mutqin_app_server USING (true) WITH CHECK (true);
CREATE POLICY server_all ON public.tasmia_submissions TO mutqin_app_server USING (true) WITH CHECK (true);
CREATE POLICY server_all ON public.review_confirmations TO mutqin_app_server USING (true) WITH CHECK (true);
CREATE POLICY server_all ON public.peer_tests TO mutqin_app_server USING (true) WITH CHECK (true);
CREATE POLICY server_all ON public.peer_test_selected_members TO mutqin_app_server USING (true) WITH CHECK (true);
CREATE POLICY server_all ON public.peer_test_attempts TO mutqin_app_server USING (true) WITH CHECK (true);
CREATE POLICY server_all ON public.peer_test_attempt_questions TO mutqin_app_server USING (true) WITH CHECK (true);
CREATE POLICY server_all ON public.personal_tests TO mutqin_app_server USING (true) WITH CHECK (true);
CREATE POLICY server_all ON public.personal_test_questions TO mutqin_app_server USING (true) WITH CHECK (true);
