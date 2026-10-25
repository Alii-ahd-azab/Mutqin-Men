--
-- PostgreSQL database dump
--

\restrict gs0Fy5hUWwz1yofFL2mgydCsND1n2WdMXLcfcE57vHIleZsuSFILsi8PXW1PEwQ

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: rls_auto_enable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


--
-- Name: sync_deactivated_at(); Type: FUNCTION; Schema: public; Owner: -
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


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: cycles; Type: TABLE; Schema: public; Owner: -
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
    CONSTRAINT cycles_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))
);


--
-- Name: daily_thoughts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_thoughts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    content_html text NOT NULL,
    published_by uuid,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    is_published boolean DEFAULT true NOT NULL
);


--
-- Name: group_rest_days; Type: TABLE; Schema: public; Owner: -
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
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    full_name text NOT NULL,
    phone text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deactivated_at timestamp with time zone,
    CONSTRAINT profiles_role_check CHECK ((role = ANY (ARRAY['member'::text, 'admin'::text])))
);


--
-- Name: program_pauses; Type: TABLE; Schema: public; Owner: -
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
-- Name: review_confirmations; Type: TABLE; Schema: public; Owner: -
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
-- Name: tasmia_submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasmia_submissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cycle_id uuid NOT NULL,
    user_id uuid NOT NULL,
    listener_id uuid NOT NULL,
    quarter_number integer NOT NULL,
    notes text,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tasmia_submissions_quarter_number_check CHECK (((quarter_number >= 1) AND (quarter_number <= 240)))
);


--
-- Data for Name: cycles; Type: TABLE DATA; Schema: public; Owner: -
--

-- Production COPY data omitted.


--
-- Data for Name: daily_thoughts; Type: TABLE DATA; Schema: public; Owner: -
--

-- Production COPY data omitted.


--
-- Data for Name: group_rest_days; Type: TABLE DATA; Schema: public; Owner: -
--

-- Production COPY data omitted.


--
-- Data for Name: profiles; Type: TABLE DATA; Schema: public; Owner: -
--

-- Production COPY data omitted.


--
-- Data for Name: program_pauses; Type: TABLE DATA; Schema: public; Owner: -
--

-- Production COPY data omitted.


--
-- Data for Name: review_confirmations; Type: TABLE DATA; Schema: public; Owner: -
--

-- Production COPY data omitted.


--
-- Data for Name: tasmia_submissions; Type: TABLE DATA; Schema: public; Owner: -
--

-- Production COPY data omitted.


--
-- Name: cycles cycles_cycle_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycles
    ADD CONSTRAINT cycles_cycle_number_key UNIQUE (cycle_number);


--
-- Name: cycles cycles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycles
    ADD CONSTRAINT cycles_pkey PRIMARY KEY (id);


--
-- Name: daily_thoughts daily_thoughts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_thoughts
    ADD CONSTRAINT daily_thoughts_pkey PRIMARY KEY (id);


--
-- Name: group_rest_days group_rest_days_cycle_id_rest_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_rest_days
    ADD CONSTRAINT group_rest_days_cycle_id_rest_date_key UNIQUE (cycle_id, rest_date);


--
-- Name: group_rest_days group_rest_days_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_rest_days
    ADD CONSTRAINT group_rest_days_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_phone_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_phone_key UNIQUE (phone);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: program_pauses program_pauses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.program_pauses
    ADD CONSTRAINT program_pauses_pkey PRIMARY KEY (id);


--
-- Name: review_confirmations review_confirmations_cycle_id_user_id_program_day_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_confirmations
    ADD CONSTRAINT review_confirmations_cycle_id_user_id_program_day_key UNIQUE (cycle_id, user_id, program_day);


--
-- Name: review_confirmations review_confirmations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_confirmations
    ADD CONSTRAINT review_confirmations_pkey PRIMARY KEY (id);


--
-- Name: tasmia_submissions tasmia_submissions_cycle_id_user_id_quarter_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasmia_submissions
    ADD CONSTRAINT tasmia_submissions_cycle_id_user_id_quarter_number_key UNIQUE (cycle_id, user_id, quarter_number);


--
-- Name: tasmia_submissions tasmia_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasmia_submissions
    ADD CONSTRAINT tasmia_submissions_pkey PRIMARY KEY (id);


--
-- Name: daily_thoughts_published_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_thoughts_published_idx ON public.daily_thoughts USING btree (published_at DESC);


--
-- Name: program_pauses_cycle_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX program_pauses_cycle_idx ON public.program_pauses USING btree (cycle_id);


--
-- Name: rest_days_cycle_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rest_days_cycle_date_idx ON public.group_rest_days USING btree (cycle_id, rest_date);


--
-- Name: reviews_cycle_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reviews_cycle_idx ON public.review_confirmations USING btree (cycle_id);


--
-- Name: reviews_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reviews_user_idx ON public.review_confirmations USING btree (user_id);


--
-- Name: tasmia_cycle_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasmia_cycle_idx ON public.tasmia_submissions USING btree (cycle_id);


--
-- Name: tasmia_listener_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasmia_listener_idx ON public.tasmia_submissions USING btree (listener_id);


--
-- Name: tasmia_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasmia_user_idx ON public.tasmia_submissions USING btree (user_id);


--
-- Name: profiles trg_sync_deactivated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_deactivated_at BEFORE UPDATE OF active ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.sync_deactivated_at();


--
-- Name: cycles cycles_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycles
    ADD CONSTRAINT cycles_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: daily_thoughts daily_thoughts_published_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_thoughts
    ADD CONSTRAINT daily_thoughts_published_by_fkey FOREIGN KEY (published_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: group_rest_days group_rest_days_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_rest_days
    ADD CONSTRAINT group_rest_days_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: group_rest_days group_rest_days_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_rest_days
    ADD CONSTRAINT group_rest_days_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.cycles(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: program_pauses program_pauses_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.program_pauses
    ADD CONSTRAINT program_pauses_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: program_pauses program_pauses_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.program_pauses
    ADD CONSTRAINT program_pauses_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.cycles(id) ON DELETE CASCADE;


--
-- Name: review_confirmations review_confirmations_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_confirmations
    ADD CONSTRAINT review_confirmations_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.cycles(id) ON DELETE CASCADE;


--
-- Name: review_confirmations review_confirmations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_confirmations
    ADD CONSTRAINT review_confirmations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: tasmia_submissions tasmia_submissions_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasmia_submissions
    ADD CONSTRAINT tasmia_submissions_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.cycles(id) ON DELETE CASCADE;


--
-- Name: tasmia_submissions tasmia_submissions_listener_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasmia_submissions
    ADD CONSTRAINT tasmia_submissions_listener_id_fkey FOREIGN KEY (listener_id) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: tasmia_submissions tasmia_submissions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasmia_submissions
    ADD CONSTRAINT tasmia_submissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: group_rest_days Admins delete rest days; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins delete rest days" ON public.group_rest_days FOR DELETE TO authenticated USING (( SELECT private.is_admin() AS is_admin));


--
-- Name: daily_thoughts Admins delete thoughts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins delete thoughts" ON public.daily_thoughts FOR DELETE TO authenticated USING (( SELECT private.is_admin() AS is_admin));


--
-- Name: cycles Admins insert cycles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins insert cycles" ON public.cycles FOR INSERT TO authenticated WITH CHECK (( SELECT private.is_admin() AS is_admin));


--
-- Name: program_pauses Admins insert pauses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins insert pauses" ON public.program_pauses FOR INSERT TO authenticated WITH CHECK (( SELECT private.is_admin() AS is_admin));


--
-- Name: group_rest_days Admins insert rest days; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins insert rest days" ON public.group_rest_days FOR INSERT TO authenticated WITH CHECK (( SELECT private.is_admin() AS is_admin));


--
-- Name: daily_thoughts Admins insert thoughts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins insert thoughts" ON public.daily_thoughts FOR INSERT TO authenticated WITH CHECK (( SELECT private.is_admin() AS is_admin));


--
-- Name: cycles Admins update cycles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins update cycles" ON public.cycles FOR UPDATE TO authenticated USING (( SELECT private.is_admin() AS is_admin)) WITH CHECK (( SELECT private.is_admin() AS is_admin));


--
-- Name: program_pauses Admins update pauses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins update pauses" ON public.program_pauses FOR UPDATE TO authenticated USING (( SELECT private.is_admin() AS is_admin)) WITH CHECK (( SELECT private.is_admin() AS is_admin));


--
-- Name: profiles Admins update profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins update profiles" ON public.profiles FOR UPDATE TO authenticated USING (( SELECT private.is_admin() AS is_admin)) WITH CHECK (( SELECT private.is_admin() AS is_admin));


--
-- Name: group_rest_days Admins update rest days; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins update rest days" ON public.group_rest_days FOR UPDATE TO authenticated USING (( SELECT private.is_admin() AS is_admin)) WITH CHECK (( SELECT private.is_admin() AS is_admin));


--
-- Name: daily_thoughts Admins update thoughts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins update thoughts" ON public.daily_thoughts FOR UPDATE TO authenticated USING (( SELECT private.is_admin() AS is_admin)) WITH CHECK (( SELECT private.is_admin() AS is_admin));


--
-- Name: review_confirmations Members confirm own reviews; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members confirm own reviews" ON public.review_confirmations FOR INSERT TO authenticated WITH CHECK ((( SELECT private.is_active_user() AS is_active_user) AND (user_id = ( SELECT auth.uid() AS uid)) AND ( SELECT private.is_active_cycle(review_confirmations.cycle_id) AS is_active_cycle)));


--
-- Name: tasmia_submissions Members submit own tasmia; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members submit own tasmia" ON public.tasmia_submissions FOR INSERT TO authenticated WITH CHECK ((( SELECT private.is_active_user() AS is_active_user) AND (user_id = ( SELECT auth.uid() AS uid)) AND ( SELECT private.is_active_cycle(tasmia_submissions.cycle_id) AS is_active_cycle)));


--
-- Name: profiles Read appropriate profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Read appropriate profiles" ON public.profiles FOR SELECT TO authenticated USING (((( SELECT private.is_active_user() AS is_active_user) AND (active = true)) OR ( SELECT private.is_admin() AS is_admin) OR (id = ( SELECT auth.uid() AS uid))));


--
-- Name: cycles Read cycles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Read cycles" ON public.cycles FOR SELECT TO authenticated USING (((( SELECT private.is_active_user() AS is_active_user) AND (status = 'active'::text)) OR ( SELECT private.is_admin() AS is_admin)));


--
-- Name: daily_thoughts Read daily thoughts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Read daily thoughts" ON public.daily_thoughts FOR SELECT TO authenticated USING (((( SELECT private.is_active_user() AS is_active_user) AND (is_published = true)) OR ( SELECT private.is_admin() AS is_admin)));


--
-- Name: group_rest_days Read group rest days; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Read group rest days" ON public.group_rest_days FOR SELECT TO authenticated USING ((( SELECT private.is_admin() AS is_admin) OR (( SELECT private.is_active_user() AS is_active_user) AND ( SELECT private.is_active_cycle(group_rest_days.cycle_id) AS is_active_cycle))));


--
-- Name: program_pauses Read program pauses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Read program pauses" ON public.program_pauses FOR SELECT TO authenticated USING ((( SELECT private.is_admin() AS is_admin) OR (( SELECT private.is_active_user() AS is_active_user) AND ( SELECT private.is_active_cycle(program_pauses.cycle_id) AS is_active_cycle))));


--
-- Name: review_confirmations Read review confirmations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Read review confirmations" ON public.review_confirmations FOR SELECT TO authenticated USING ((( SELECT private.is_admin() AS is_admin) OR (( SELECT private.is_active_user() AS is_active_user) AND ( SELECT private.is_active_cycle(review_confirmations.cycle_id) AS is_active_cycle) AND (user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: tasmia_submissions Read tasmia activity; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Read tasmia activity" ON public.tasmia_submissions FOR SELECT TO authenticated USING ((( SELECT private.is_admin() AS is_admin) OR (( SELECT private.is_active_user() AS is_active_user) AND ( SELECT private.is_active_cycle(tasmia_submissions.cycle_id) AS is_active_cycle) AND ((user_id = ( SELECT auth.uid() AS uid)) OR (listener_id = ( SELECT auth.uid() AS uid))))));


--
-- Name: cycles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cycles ENABLE ROW LEVEL SECURITY;

--
-- Name: daily_thoughts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.daily_thoughts ENABLE ROW LEVEL SECURITY;

--
-- Name: group_rest_days; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.group_rest_days ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: program_pauses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.program_pauses ENABLE ROW LEVEL SECURITY;

--
-- Name: review_confirmations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.review_confirmations ENABLE ROW LEVEL SECURITY;

--
-- Name: tasmia_submissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tasmia_submissions ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict gs0Fy5hUWwz1yofFL2mgydCsND1n2WdMXLcfcE57vHIleZsuSFILsi8PXW1PEwQ
