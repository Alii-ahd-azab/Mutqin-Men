-- Authoritative foundation: Sisters live schema-only dump, PostgreSQL 17.6.
-- Source SHA-256: 041bccfc29ebdd1d2015058a143da5e0bd0c5a33cb3141e0a7ce091b75312db8
-- Phase 1: fresh destination only; Auth/runtime access deferred explicitly.
DO $$ begin if exists(select 1 from pg_tables where schemaname='public') then raise exception 'Target public schema must be empty'; end if; end $$;
CREATE TABLE public.batch_membership_transfers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    from_batch_id uuid NOT NULL,
    to_batch_id uuid NOT NULL,
    moved_by uuid,
    moved_at timestamp with time zone DEFAULT now() NOT NULL
);


--

CREATE TABLE public.batch_memberships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    batch_id uuid NOT NULL,
    user_id uuid NOT NULL,
    membership_role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT batch_memberships_role_check CHECK ((membership_role = ANY (ARRAY['member'::text, 'admin'::text])))
);


--

CREATE TABLE public.batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    archived_at timestamp with time zone,
    CONSTRAINT batches_name_not_blank CHECK ((length(btrim(name)) > 0))
);


--

CREATE TABLE public.cycles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cycle_number integer NOT NULL,
    name text,
    starts_on date NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    ended_on date,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    batch_id uuid NOT NULL,
    CONSTRAINT cycles_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))
);


--

CREATE TABLE public.daily_thoughts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    content_html text NOT NULL,
    published_by uuid,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    is_published boolean DEFAULT true NOT NULL,
    batch_id uuid NOT NULL
);


--

CREATE TABLE public.group_rest_days (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cycle_id uuid NOT NULL,
    rest_date date NOT NULL,
    reason text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--

CREATE TABLE public.peer_test_attempt_questions (
    attempt_id uuid NOT NULL,
    question_number smallint NOT NULL,
    start_surah smallint NOT NULL,
    start_surah_name text NOT NULL,
    start_ayah smallint NOT NULL,
    end_surah smallint NOT NULL,
    end_surah_name text NOT NULL,
    end_ayah smallint NOT NULL,
    start_page smallint NOT NULL,
    start_line smallint NOT NULL,
    end_page smallint NOT NULL,
    end_line smallint NOT NULL,
    actual_lines smallint NOT NULL,
    difficulty_level text,
    errors_count smallint,
    notes text,
    CONSTRAINT peer_test_attempt_questions_errors_check CHECK (((errors_count IS NULL) OR ((errors_count >= 0) AND (errors_count <= 99)))),
    CONSTRAINT peer_test_attempt_questions_level_check CHECK (((difficulty_level IS NULL) OR (difficulty_level = ANY (ARRAY['easy'::text, 'medium'::text, 'hard'::text])))),
    CONSTRAINT peer_test_attempt_questions_notes_check CHECK (((notes IS NULL) OR (length(notes) <= 300)))
);


--

CREATE TABLE public.peer_test_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    test_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    candidate_name_snapshot text NOT NULL,
    examiner_id uuid,
    examiner_name_snapshot text NOT NULL,
    status text DEFAULT 'in_progress'::text NOT NULL,
    total_errors smallint,
    max_errors_snapshot smallint,
    notes text,
    attempt_date date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT peer_test_attempts_notes_check CHECK (((notes IS NULL) OR (length(notes) <= 300))),
    CONSTRAINT peer_test_attempts_status_check CHECK ((status = ANY (ARRAY['in_progress'::text, 'passed'::text, 'failed'::text, 'cancelled'::text])))
);


--

CREATE TABLE public.peer_tests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cycle_id uuid NOT NULL,
    title text NOT NULL,
    range_start smallint NOT NULL,
    range_end smallint NOT NULL,
    questions_count smallint NOT NULL,
    lines_per_question smallint NOT NULL,
    max_errors smallint,
    test_type text DEFAULT 'mandatory'::text NOT NULL,
    difficulty text DEFAULT 'any'::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    visible_from timestamp with time zone,
    visible_until timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT peer_tests_difficulty_check CHECK ((difficulty = ANY (ARRAY['any'::text, 'easy'::text, 'medium'::text, 'hard'::text, 'mixed'::text]))),
    CONSTRAINT peer_tests_lines_check CHECK (((lines_per_question >= 1) AND (lines_per_question <= 60))),
    CONSTRAINT peer_tests_max_errors_check CHECK (((max_errors IS NULL) OR ((max_errors >= 0) AND (max_errors <= 100)))),
    CONSTRAINT peer_tests_questions_check CHECK (((questions_count >= 1) AND (questions_count <= 50))),
    CONSTRAINT peer_tests_range_check CHECK ((((range_start >= 1) AND (range_start <= 240)) AND ((range_end >= 1) AND (range_end <= 240)) AND (range_start <= range_end))),
    CONSTRAINT peer_tests_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'hidden'::text, 'finished'::text]))),
    CONSTRAINT peer_tests_title_check CHECK (((length(btrim(title)) >= 1) AND (length(btrim(title)) <= 120))),
    CONSTRAINT peer_tests_type_check CHECK ((test_type = ANY (ARRAY['mandatory'::text, 'recommended'::text]))),
    CONSTRAINT peer_tests_window_check CHECK (((visible_from IS NULL) OR (visible_until IS NULL) OR (visible_from < visible_until)))
);


--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    full_name text NOT NULL,
    phone text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deactivated_at timestamp with time zone,
    is_master_admin boolean DEFAULT false NOT NULL,
    CONSTRAINT profiles_master_admin_requires_admin_role CHECK (((NOT is_master_admin) OR (role = 'admin'::text))),
    CONSTRAINT profiles_role_check CHECK ((role = ANY (ARRAY['member'::text, 'admin'::text])))
);


--

CREATE TABLE public.program_pauses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cycle_id uuid NOT NULL,
    paused_on date NOT NULL,
    resumed_on date,
    reason text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT program_pauses_check CHECK (((resumed_on IS NULL) OR (resumed_on >= paused_on)))
);


--

CREATE TABLE public.review_confirmations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cycle_id uuid NOT NULL,
    user_id uuid NOT NULL,
    program_day integer NOT NULL,
    start_quarter integer NOT NULL,
    end_quarter integer NOT NULL,
    confirmed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT review_confirmations_check CHECK ((end_quarter >= start_quarter)),
    CONSTRAINT review_confirmations_end_quarter_check CHECK (((end_quarter >= 1) AND (end_quarter <= 240))),
    CONSTRAINT review_confirmations_program_day_check CHECK (((program_day >= 1) AND (program_day <= 240))),
    CONSTRAINT review_confirmations_start_quarter_check CHECK (((start_quarter >= 1) AND (start_quarter <= 240)))
);


--

CREATE TABLE public.tasmia_submissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cycle_id uuid NOT NULL,
    user_id uuid NOT NULL,
    listener_id uuid,
    quarter_number integer NOT NULL,
    notes text,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    listener_name_snapshot text NOT NULL,
    listener_changed_at timestamp with time zone,
    CONSTRAINT tasmia_listener_present CHECK (((listener_id IS NOT NULL) OR (listener_name_snapshot IS NOT NULL))),
    CONSTRAINT tasmia_submissions_quarter_number_check CHECK (((quarter_number >= 1) AND (quarter_number <= 240)))
);


--
ALTER TABLE ONLY public.batch_membership_transfers
    ADD CONSTRAINT batch_membership_transfers_pkey PRIMARY KEY (id);


--

ALTER TABLE ONLY public.batch_memberships
    ADD CONSTRAINT batch_memberships_batch_user_key UNIQUE (batch_id, user_id);


--

ALTER TABLE ONLY public.batch_memberships
    ADD CONSTRAINT batch_memberships_pkey PRIMARY KEY (id);


--

ALTER TABLE ONLY public.batches
    ADD CONSTRAINT batches_pkey PRIMARY KEY (id);


--

ALTER TABLE ONLY public.cycles
    ADD CONSTRAINT cycles_pkey PRIMARY KEY (id);


--

ALTER TABLE ONLY public.daily_thoughts
    ADD CONSTRAINT daily_thoughts_pkey PRIMARY KEY (id);


--

ALTER TABLE ONLY public.group_rest_days
    ADD CONSTRAINT group_rest_days_cycle_id_rest_date_key UNIQUE (cycle_id, rest_date);


--

ALTER TABLE ONLY public.group_rest_days
    ADD CONSTRAINT group_rest_days_pkey PRIMARY KEY (id);


--

ALTER TABLE ONLY public.peer_test_attempt_questions
    ADD CONSTRAINT peer_test_attempt_questions_pkey PRIMARY KEY (attempt_id, question_number);


--

ALTER TABLE ONLY public.peer_test_attempts
    ADD CONSTRAINT peer_test_attempts_pkey PRIMARY KEY (id);


--

ALTER TABLE ONLY public.peer_tests
    ADD CONSTRAINT peer_tests_pkey PRIMARY KEY (id);


--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_phone_key UNIQUE (phone);


--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--

ALTER TABLE ONLY public.program_pauses
    ADD CONSTRAINT program_pauses_pkey PRIMARY KEY (id);


--

ALTER TABLE ONLY public.review_confirmations
    ADD CONSTRAINT review_confirmations_cycle_id_user_id_program_day_key UNIQUE (cycle_id, user_id, program_day);


--

ALTER TABLE ONLY public.review_confirmations
    ADD CONSTRAINT review_confirmations_pkey PRIMARY KEY (id);


--

ALTER TABLE ONLY public.tasmia_submissions
    ADD CONSTRAINT tasmia_submissions_cycle_id_user_id_quarter_number_key UNIQUE (cycle_id, user_id, quarter_number);


--

ALTER TABLE ONLY public.tasmia_submissions
    ADD CONSTRAINT tasmia_submissions_pkey PRIMARY KEY (id);


--
ALTER TABLE ONLY public.batch_membership_transfers
    ADD CONSTRAINT batch_membership_transfers_from_batch_id_fkey FOREIGN KEY (from_batch_id) REFERENCES public.batches(id) ON DELETE RESTRICT;


--

ALTER TABLE ONLY public.batch_membership_transfers
    ADD CONSTRAINT batch_membership_transfers_moved_by_fkey FOREIGN KEY (moved_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--

ALTER TABLE ONLY public.batch_membership_transfers
    ADD CONSTRAINT batch_membership_transfers_to_batch_id_fkey FOREIGN KEY (to_batch_id) REFERENCES public.batches(id) ON DELETE RESTRICT;


--

ALTER TABLE ONLY public.batch_membership_transfers
    ADD CONSTRAINT batch_membership_transfers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--

ALTER TABLE ONLY public.batch_memberships
    ADD CONSTRAINT batch_memberships_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.batches(id) ON DELETE CASCADE;


--

ALTER TABLE ONLY public.batch_memberships
    ADD CONSTRAINT batch_memberships_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--

ALTER TABLE ONLY public.batch_memberships
    ADD CONSTRAINT batch_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--

ALTER TABLE ONLY public.batches
    ADD CONSTRAINT batches_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--

ALTER TABLE ONLY public.cycles
    ADD CONSTRAINT cycles_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.batches(id) ON DELETE RESTRICT;


--

ALTER TABLE ONLY public.cycles
    ADD CONSTRAINT cycles_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--

ALTER TABLE ONLY public.daily_thoughts
    ADD CONSTRAINT daily_thoughts_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.batches(id) ON DELETE RESTRICT;


--

ALTER TABLE ONLY public.daily_thoughts
    ADD CONSTRAINT daily_thoughts_published_by_fkey FOREIGN KEY (published_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--

ALTER TABLE ONLY public.group_rest_days
    ADD CONSTRAINT group_rest_days_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--

ALTER TABLE ONLY public.group_rest_days
    ADD CONSTRAINT group_rest_days_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.cycles(id) ON DELETE CASCADE;


--

ALTER TABLE ONLY public.peer_test_attempt_questions
    ADD CONSTRAINT peer_test_attempt_questions_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES public.peer_test_attempts(id) ON DELETE CASCADE;


--

ALTER TABLE ONLY public.peer_test_attempts
    ADD CONSTRAINT peer_test_attempts_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--

ALTER TABLE ONLY public.peer_test_attempts
    ADD CONSTRAINT peer_test_attempts_examiner_id_fkey FOREIGN KEY (examiner_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--

ALTER TABLE ONLY public.peer_test_attempts
    ADD CONSTRAINT peer_test_attempts_test_id_fkey FOREIGN KEY (test_id) REFERENCES public.peer_tests(id) ON DELETE RESTRICT;


--

ALTER TABLE ONLY public.peer_tests
    ADD CONSTRAINT peer_tests_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--

ALTER TABLE ONLY public.peer_tests
    ADD CONSTRAINT peer_tests_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.cycles(id) ON DELETE RESTRICT;


--

ALTER TABLE ONLY public.program_pauses
    ADD CONSTRAINT program_pauses_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--

ALTER TABLE ONLY public.program_pauses
    ADD CONSTRAINT program_pauses_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.cycles(id) ON DELETE CASCADE;


--

ALTER TABLE ONLY public.review_confirmations
    ADD CONSTRAINT review_confirmations_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.cycles(id) ON DELETE CASCADE;


--

ALTER TABLE ONLY public.review_confirmations
    ADD CONSTRAINT review_confirmations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--

ALTER TABLE ONLY public.tasmia_submissions
    ADD CONSTRAINT tasmia_submissions_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.cycles(id) ON DELETE CASCADE;


--

ALTER TABLE ONLY public.tasmia_submissions
    ADD CONSTRAINT tasmia_submissions_listener_id_fkey FOREIGN KEY (listener_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--

ALTER TABLE ONLY public.tasmia_submissions
    ADD CONSTRAINT tasmia_submissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--

CREATE INDEX batch_membership_transfers_user_idx ON public.batch_membership_transfers USING btree (user_id, moved_at DESC);


--

CREATE INDEX batch_memberships_batch_role_idx ON public.batch_memberships USING btree (batch_id, membership_role);


--

CREATE UNIQUE INDEX batch_memberships_one_batch_per_member_idx ON public.batch_memberships USING btree (user_id) WHERE (membership_role = 'member'::text);


--

CREATE INDEX batch_memberships_user_id_idx ON public.batch_memberships USING btree (user_id);


--

CREATE UNIQUE INDEX batches_name_unique_idx ON public.batches USING btree (lower(btrim(name)));


--

CREATE UNIQUE INDEX cycles_batch_cycle_number_key ON public.cycles USING btree (batch_id, cycle_number);


--

CREATE INDEX cycles_batch_status_idx ON public.cycles USING btree (batch_id, status);


--

CREATE UNIQUE INDEX cycles_one_active_per_batch_idx ON public.cycles USING btree (batch_id) WHERE (status = 'active'::text);


--

CREATE INDEX daily_thoughts_batch_published_idx ON public.daily_thoughts USING btree (batch_id, is_published, published_at DESC);


--

CREATE INDEX daily_thoughts_published_idx ON public.daily_thoughts USING btree (published_at DESC);


--

CREATE INDEX peer_test_attempts_candidate_idx ON public.peer_test_attempts USING btree (candidate_id);


--

CREATE INDEX peer_test_attempts_examiner_idx ON public.peer_test_attempts USING btree (examiner_id);


--

CREATE UNIQUE INDEX peer_test_attempts_one_open_idx ON public.peer_test_attempts USING btree (test_id, candidate_id) WHERE (status = 'in_progress'::text);


--

CREATE INDEX peer_test_attempts_test_candidate_idx ON public.peer_test_attempts USING btree (test_id, candidate_id, status);


--

CREATE INDEX peer_tests_cycle_status_idx ON public.peer_tests USING btree (cycle_id, status);


--

CREATE INDEX program_pauses_cycle_idx ON public.program_pauses USING btree (cycle_id);


--

CREATE INDEX rest_days_cycle_date_idx ON public.group_rest_days USING btree (cycle_id, rest_date);


--

CREATE INDEX review_confirmations_cycle_day_idx ON public.review_confirmations USING btree (cycle_id, program_day);


--

CREATE INDEX reviews_cycle_idx ON public.review_confirmations USING btree (cycle_id);


--

CREATE INDEX reviews_user_idx ON public.review_confirmations USING btree (user_id);


--

CREATE INDEX tasmia_cycle_idx ON public.tasmia_submissions USING btree (cycle_id);


--

CREATE INDEX tasmia_listener_idx ON public.tasmia_submissions USING btree (listener_id);


--

CREATE INDEX tasmia_submissions_cycle_submitted_idx ON public.tasmia_submissions USING btree (cycle_id, submitted_at);


--

CREATE INDEX tasmia_user_idx ON public.tasmia_submissions USING btree (user_id);


--
CREATE FUNCTION public.sync_deactivated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.active = true then
    new.deactivated_at := null;
  elsif new.active = false and old.active is distinct from false then
    new.deactivated_at := now();
  end if;

  return new;
end;
$$;


--
DO $install$ BEGIN
IF to_regprocedure('public.rls_auto_enable()') IS NULL THEN
 EXECUTE 'CREATE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''pg_catalog''
AS $function$
DECLARE
  cmd record;
  tbl name;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN (''CREATE TABLE'', ''CREATE TABLE AS'', ''SELECT INTO'')
      AND object_type IN (''table'',''partitioned table'')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN (''public'') AND cmd.schema_name NOT IN (''pg_catalog'',''information_schema'') AND cmd.schema_name NOT LIKE ''pg_toast%'' AND cmd.schema_name NOT LIKE ''pg_temp%'' THEN
      BEGIN
        SELECT c.relname INTO tbl FROM pg_catalog.pg_class c WHERE c.oid = cmd.objid;
        EXECUTE format(''alter table if exists %I.%I enable row level security'', cmd.schema_name, tbl);
        RAISE LOG ''rls_auto_enable: enabled RLS on %'', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG ''rls_auto_enable: failed to enable RLS on %'', cmd.object_identity;
      END;
     ELSE
        RAISE LOG ''rls_auto_enable: skip % (either system schema or not in enforced list: %.)'', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$
';
ELSIF (SELECT prosrc FROM pg_proc WHERE oid='public.rls_auto_enable()'::regprocedure) IS DISTINCT FROM '
DECLARE
  cmd record;
  tbl name;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN (''CREATE TABLE'', ''CREATE TABLE AS'', ''SELECT INTO'')
      AND object_type IN (''table'',''partitioned table'')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN (''public'') AND cmd.schema_name NOT IN (''pg_catalog'',''information_schema'') AND cmd.schema_name NOT LIKE ''pg_toast%'' AND cmd.schema_name NOT LIKE ''pg_temp%'' THEN
      BEGIN
        SELECT c.relname INTO tbl FROM pg_catalog.pg_class c WHERE c.oid = cmd.objid;
        EXECUTE format(''alter table if exists %I.%I enable row level security'', cmd.schema_name, tbl);
        RAISE LOG ''rls_auto_enable: enabled RLS on %'', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG ''rls_auto_enable: failed to enable RLS on %'', cmd.object_identity;
      END;
     ELSE
        RAISE LOG ''rls_auto_enable: skip % (either system schema or not in enforced list: %.)'', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
' THEN
 RAISE EXCEPTION 'Unapproved existing RLS helper';
END IF;
END $install$;

CREATE TRIGGER trg_sync_deactivated_at BEFORE UPDATE OF active ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.sync_deactivated_at();


--
CREATE VIEW public.profile_batch_overview WITH (security_invoker='true') AS
 SELECT p.id AS user_id,
    p.full_name,
    p.phone,
    p.role,
    p.active,
    p.deactivated_at,
    p.is_master_admin,
        CASE
            WHEN ((p.role = 'admin'::text) AND (p.is_master_admin = true)) THEN 'Master Admin - All Batches'::text
            WHEN (count(b.id) = 0) THEN 'No batch assigned'::text
            ELSE string_agg(DISTINCT b.name, ', '::text ORDER BY b.name)
        END AS batches
   FROM ((public.profiles p
     LEFT JOIN public.batch_memberships bm ON ((bm.user_id = p.id)))
     LEFT JOIN public.batches b ON ((b.id = bm.batch_id)))
  GROUP BY p.id, p.full_name, p.phone, p.role, p.active, p.deactivated_at, p.is_master_admin;


--
DO $install$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtname='ensure_rls') THEN EXECUTE 'CREATE EVENT TRIGGER ensure_rls ON ddl_command_end
         WHEN TAG IN (''CREATE TABLE'', ''CREATE TABLE AS'', ''SELECT INTO'')
   EXECUTE FUNCTION public.rls_auto_enable();


--'; END IF; END $install$;
DO $$ declare r record; role_name text; begin
for r in select tablename from pg_tables where schemaname='public' loop
 execute format('alter table public.%I enable row level security',r.tablename);
 execute format('revoke all on table public.%I from public',r.tablename);
 foreach role_name in array array['anon','authenticated','service_role'] loop
 if exists(select 1 from pg_roles where rolname=role_name) then execute format('revoke all on table public.%I from %I',r.tablename,role_name);end if;end loop;
end loop;
for r in select viewname from pg_views where schemaname='public' loop
 execute format('revoke all on public.%I from public',r.viewname);
 foreach role_name in array array['anon','authenticated','service_role'] loop
 if exists(select 1 from pg_roles where rolname=role_name) then execute format('revoke all on public.%I from %I',r.viewname,role_name);end if;end loop;
end loop;end $$;
revoke all on function public.sync_deactivated_at() from public;
revoke all on function public.rls_auto_enable() from public;
DO $$ declare role_name text; begin
foreach role_name in array array['anon','authenticated','service_role'] loop
if exists(select 1 from pg_roles where rolname=role_name) then
execute format('revoke all on function public.rls_auto_enable() from %I',role_name);
execute format('revoke all on function public.sync_deactivated_at() from %I',role_name);
end if; end loop; end $$;
