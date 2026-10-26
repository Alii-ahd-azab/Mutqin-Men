-- Sisters-derived Phase 1 schema. Requires an EMPTY public schema.
DO $$ begin if exists(select 1 from pg_tables where schemaname='public') then raise exception 'Target public schema must be empty'; end if; end $$;
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

CREATE TABLE public.daily_thoughts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    content_html text NOT NULL,
    published_by uuid,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    is_published boolean DEFAULT true NOT NULL
);

CREATE TABLE public.group_rest_days (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cycle_id uuid NOT NULL,
    rest_date date NOT NULL,
    reason text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

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
ALTER TABLE ONLY public.cycles
    ADD CONSTRAINT cycles_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.daily_thoughts
    ADD CONSTRAINT daily_thoughts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.group_rest_days
    ADD CONSTRAINT group_rest_days_cycle_id_rest_date_key UNIQUE (cycle_id, rest_date);
ALTER TABLE ONLY public.group_rest_days
    ADD CONSTRAINT group_rest_days_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_phone_key UNIQUE (phone);
ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.program_pauses
    ADD CONSTRAINT program_pauses_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.review_confirmations
    ADD CONSTRAINT review_confirmations_cycle_id_user_id_program_day_key UNIQUE (cycle_id, user_id, program_day);
ALTER TABLE ONLY public.review_confirmations
    ADD CONSTRAINT review_confirmations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.tasmia_submissions
    ADD CONSTRAINT tasmia_submissions_cycle_id_user_id_quarter_number_key UNIQUE (cycle_id, user_id, quarter_number);
ALTER TABLE ONLY public.tasmia_submissions
    ADD CONSTRAINT tasmia_submissions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.cycles
    ADD CONSTRAINT cycles_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.daily_thoughts
    ADD CONSTRAINT daily_thoughts_published_by_fkey FOREIGN KEY (published_by) REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.group_rest_days
    ADD CONSTRAINT group_rest_days_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.group_rest_days
    ADD CONSTRAINT group_rest_days_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.cycles(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.program_pauses
    ADD CONSTRAINT program_pauses_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.program_pauses
    ADD CONSTRAINT program_pauses_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.cycles(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.review_confirmations
    ADD CONSTRAINT review_confirmations_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.cycles(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.review_confirmations
    ADD CONSTRAINT review_confirmations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.tasmia_submissions
    ADD CONSTRAINT tasmia_submissions_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.cycles(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.tasmia_submissions
    ADD CONSTRAINT tasmia_submissions_listener_id_fkey FOREIGN KEY (listener_id) REFERENCES public.profiles(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.tasmia_submissions
    ADD CONSTRAINT tasmia_submissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
CREATE INDEX daily_thoughts_published_idx ON public.daily_thoughts USING btree (published_at DESC);
CREATE INDEX program_pauses_cycle_idx ON public.program_pauses USING btree (cycle_id);
CREATE INDEX rest_days_cycle_date_idx ON public.group_rest_days USING btree (cycle_id, rest_date);
CREATE INDEX reviews_cycle_idx ON public.review_confirmations USING btree (cycle_id);
CREATE INDEX reviews_user_idx ON public.review_confirmations USING btree (user_id);
CREATE INDEX tasmia_cycle_idx ON public.tasmia_submissions USING btree (cycle_id);
CREATE INDEX tasmia_listener_idx ON public.tasmia_submissions USING btree (listener_id);
CREATE INDEX tasmia_user_idx ON public.tasmia_submissions USING btree (user_id);
create table public.batches (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now(),
  created_by  uuid,
  archived_at timestamptz,
  constraint batches_name_not_blank check (length(btrim(name)) > 0),
  constraint batches_created_by_fkey
    foreign key (created_by) references public.profiles (id) on delete set null
);
create table public.batch_memberships (
  id              uuid primary key default gen_random_uuid(),
  batch_id        uuid not null,
  user_id         uuid not null,
  membership_role text not null,
  created_at      timestamptz not null default now(),
  created_by      uuid,
  constraint batch_memberships_batch_id_fkey
    foreign key (batch_id) references public.batches (id) on delete cascade,
  -- Deleting a user (auth.users -> profiles cascade) removes memberships.
  constraint batch_memberships_user_id_fkey
    foreign key (user_id) references public.profiles (id) on delete cascade,
  constraint batch_memberships_created_by_fkey
    foreign key (created_by) references public.profiles (id) on delete set null,
  constraint batch_memberships_role_check
    check (membership_role in ('member', 'admin')),
  constraint batch_memberships_batch_user_key
    unique (batch_id, user_id)
);
create table public.batch_membership_transfers (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  from_batch_id uuid not null,
  to_batch_id   uuid not null,
  moved_by      uuid,
  moved_at      timestamptz not null default now(),
  constraint batch_membership_transfers_user_id_fkey
    foreign key (user_id) references public.profiles (id) on delete cascade,
  constraint batch_membership_transfers_from_batch_id_fkey
    foreign key (from_batch_id) references public.batches (id) on delete restrict,
  constraint batch_membership_transfers_to_batch_id_fkey
    foreign key (to_batch_id) references public.batches (id) on delete restrict,
  constraint batch_membership_transfers_moved_by_fkey
    foreign key (moved_by) references public.profiles (id) on delete set null
);
create table public.peer_tests (
  id                 uuid primary key default gen_random_uuid(),
  cycle_id           uuid not null,
  title              text not null,
  range_start        smallint not null,
  range_end          smallint not null,
  questions_count    smallint not null,
  lines_per_question smallint not null,
  max_errors         smallint,                -- null = no limit
  test_type          text not null default 'mandatory',
  difficulty         text not null default 'any',
  status             text not null default 'draft',
  visible_from       timestamptz,             -- null = immediately
  visible_until      timestamptz,             -- null = no end
  created_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  finished_at        timestamptz,
  constraint peer_tests_cycle_id_fkey
    foreign key (cycle_id) references public.cycles (id) on delete restrict,
  constraint peer_tests_created_by_fkey
    foreign key (created_by) references public.profiles (id) on delete set null,
  constraint peer_tests_title_check check (length(btrim(title)) between 1 and 120),
  constraint peer_tests_range_check
    check (range_start between 1 and 240 and range_end between 1 and 240 and range_start <= range_end),
  constraint peer_tests_questions_check check (questions_count between 1 and 50),
  constraint peer_tests_lines_check check (lines_per_question between 1 and 60),
  constraint peer_tests_max_errors_check check (max_errors is null or max_errors between 0 and 100),
  constraint peer_tests_type_check check (test_type in ('mandatory', 'recommended')),
  constraint peer_tests_difficulty_check check (difficulty in ('any', 'easy', 'medium', 'hard', 'mixed')),
  constraint peer_tests_status_check check (status in ('draft', 'published', 'hidden', 'finished')),
  constraint peer_tests_window_check
    check (visible_from is null or visible_until is null or visible_from < visible_until)
);
create table public.peer_test_attempts (
  id                     uuid primary key default gen_random_uuid(),
  test_id                uuid not null,
  candidate_id           uuid not null,
  candidate_name_snapshot text not null,
  examiner_id            uuid,
  examiner_name_snapshot text not null,
  status                 text not null default 'in_progress',
  total_errors           smallint,
  max_errors_snapshot    smallint,
  notes                  text,
  attempt_date           date not null,
  created_at             timestamptz not null default now(),
  completed_at           timestamptz,
  constraint peer_test_attempts_test_id_fkey
    foreign key (test_id) references public.peer_tests (id) on delete restrict,
  -- Deleting a member deletes her own attempts (as with her recitations).
  constraint peer_test_attempts_candidate_id_fkey
    foreign key (candidate_id) references public.profiles (id) on delete cascade,
  -- Deleting an examiner keeps the result (and its pass) with her name.
  constraint peer_test_attempts_examiner_id_fkey
    foreign key (examiner_id) references public.profiles (id) on delete set null,
  constraint peer_test_attempts_status_check
    check (status in ('in_progress', 'passed', 'failed', 'cancelled')),
  constraint peer_test_attempts_notes_check check (notes is null or length(notes) <= 300)
);
create table public.peer_test_attempt_questions (
  attempt_id       uuid not null,
  question_number  smallint not null,
  start_surah      smallint not null,
  start_surah_name text not null,
  start_ayah       smallint not null,
  end_surah        smallint not null,
  end_surah_name   text not null,
  end_ayah         smallint not null,
  start_page       smallint not null,
  start_line       smallint not null,
  end_page         smallint not null,
  end_line         smallint not null,
  actual_lines     smallint not null,
  difficulty_level text,
  errors_count     smallint,
  notes            text,
  constraint peer_test_attempt_questions_pkey primary key (attempt_id, question_number),
  constraint peer_test_attempt_questions_attempt_id_fkey
    foreign key (attempt_id) references public.peer_test_attempts (id) on delete cascade,
  constraint peer_test_attempt_questions_errors_check
    check (errors_count is null or errors_count between 0 and 99),
  constraint peer_test_attempt_questions_level_check
    check (difficulty_level is null or difficulty_level in ('easy', 'medium', 'hard')),
  constraint peer_test_attempt_questions_notes_check check (notes is null or length(notes) <= 300)
);
alter table public.profiles add column is_master_admin boolean not null default false,
 add constraint profiles_master_admin_requires_admin_role check(not is_master_admin or role='admin');
alter table public.cycles add column batch_id uuid not null references public.batches(id) on delete restrict;
alter table public.daily_thoughts add column batch_id uuid not null references public.batches(id) on delete restrict;
alter table public.batch_memberships add column joined_at timestamptz not null default now();
alter table public.tasmia_submissions add column listener_name_snapshot text not null,
 add column listener_changed_at timestamptz, alter column listener_id drop not null,
 drop constraint tasmia_submissions_listener_id_fkey,
 add constraint tasmia_submissions_listener_id_fkey foreign key(listener_id) references public.profiles(id) on delete set null,
 add constraint tasmia_listener_present check(listener_id is not null or listener_name_snapshot is not null);

create unique index batches_name_unique_idx
  on public.batches (lower(btrim(name)));
create unique index batch_memberships_one_batch_per_member_idx
  on public.batch_memberships (user_id)
  where membership_role = 'member';
create index batch_memberships_user_id_idx
  on public.batch_memberships (user_id);
create index batch_memberships_batch_role_idx
  on public.batch_memberships (batch_id, membership_role);
create unique index cycles_batch_cycle_number_key
  on public.cycles (batch_id, cycle_number);
create unique index cycles_one_active_per_batch_idx
  on public.cycles (batch_id)
  where status = 'active';
create index cycles_batch_status_idx
  on public.cycles (batch_id, status);
create index daily_thoughts_batch_published_idx
  on public.daily_thoughts (batch_id, is_published, published_at desc);
create index tasmia_submissions_cycle_submitted_idx
  on public.tasmia_submissions (cycle_id, submitted_at);
create index review_confirmations_cycle_day_idx
  on public.review_confirmations (cycle_id, program_day);
create index batch_membership_transfers_user_idx
  on public.batch_membership_transfers (user_id, moved_at desc);
create index peer_tests_cycle_status_idx
  on public.peer_tests (cycle_id, status);
create unique index peer_test_attempts_one_open_idx
  on public.peer_test_attempts (test_id, candidate_id)
  where status = 'in_progress';
create index peer_test_attempts_test_candidate_idx
  on public.peer_test_attempts (test_id, candidate_id, status);
create index peer_test_attempts_candidate_idx
  on public.peer_test_attempts (candidate_id);
create index peer_test_attempts_examiner_idx
  on public.peer_test_attempts (examiner_id);
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
CREATE TRIGGER trg_sync_deactivated_at BEFORE UPDATE OF active ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.sync_deactivated_at();

DO $$ declare r record; role_name text; begin
for r in select tablename from pg_tables where schemaname='public' loop
 execute format('alter table public.%I enable row level security',r.tablename);
 execute format('revoke all on table public.%I from public',r.tablename);
 foreach role_name in array array['anon','authenticated','service_role'] loop
 if exists(select 1 from pg_roles where rolname=role_name) then execute format('revoke all on table public.%I from %I',r.tablename,role_name);end if;end loop;
end loop;end $$;
revoke all on function public.sync_deactivated_at() from public;
