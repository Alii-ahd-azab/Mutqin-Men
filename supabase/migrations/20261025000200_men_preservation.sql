-- Men compatibility extensions. Preserve all history without pretending unknown facts are known.
create schema migration_private;
revoke all on schema migration_private from public;

-- UUID primary keys follow Sisters; exact Firestore IDs remain unique alternate keys.
DO $$ declare t text; begin
 foreach t in array array['profiles','tasmia_submissions','review_confirmations','group_rest_days','peer_tests','peer_test_attempts'] loop
 execute format('alter table public.%I add column firestore_id text unique',t);
 end loop;
end $$;

alter table public.tasmia_submissions
 add column legacy_date date,
 add column member_name_snapshot text,
 add column legacy_occurrence integer not null default 0 check(legacy_occurrence>=0),
 drop constraint tasmia_submissions_cycle_id_user_id_quarter_number_key,
 add constraint tasmia_submissions_history_key unique(cycle_id,user_id,quarter_number,legacy_occurrence),
 add constraint tasmia_legacy_occurrence_source check(legacy_occurrence=0 or firestore_id is not null);
alter table public.review_confirmations
 alter column program_day drop not null,
 add column legacy_date date,
 add column member_name_snapshot text,
 add column notes text,
 add column legacy_occurrence integer not null default 0 check(legacy_occurrence>=0),
 add constraint reviews_legacy_unknown_day check(program_day is not null or (firestore_id is not null and legacy_date is not null)),
 add constraint reviews_legacy_date_key unique(cycle_id,user_id,legacy_date,legacy_occurrence);
-- Keep Sisters unique(cycle_id,user_id,program_day); historical day is unknown, not fabricated.
alter table public.group_rest_days add column created_by_name_snapshot text;
alter table public.daily_thoughts add column published_by_name_snapshot text;
alter table public.cycles
 add column total_quarters integer not null default 240 check(total_quarters=240),
 add column review_window integer not null default 8 check(review_window>0),
 add column legacy_paused_days integer not null default 0 check(legacy_paused_days>=0);
alter table public.peer_tests
 add column require_all_quarters_completed boolean not null default false,
 add column require_revision_completed boolean not null default false,
 add column audience text not null default 'all' check(audience in ('all','selected')),
 add column legacy_is_active boolean,
 add column legacy_is_finished boolean,
 add column legacy_has_max_errors boolean,
 add column legacy_max_errors_allowed integer;
create table public.peer_test_selected_members (
 test_id uuid not null references public.peer_tests(id) on delete cascade,
 user_id uuid not null references public.profiles(id) on delete restrict,
 position integer not null check(position>=0), primary key(test_id,user_id), unique(test_id,position)
);
create index peer_test_selected_members_user_idx on public.peer_test_selected_members(user_id);
alter table public.peer_test_attempts add column effective_range_end integer,
 add column covers_full_range boolean, add column legacy_passed boolean;
alter table public.peer_test_attempt_questions
 alter column start_page drop not null, alter column start_line drop not null,
 alter column end_page drop not null, alter column end_line drop not null,
 alter column actual_lines drop not null,
 add column legacy_incomplete boolean not null default false,
 add constraint question_geometry_required check(legacy_incomplete or
 (start_page is not null and start_line is not null and end_page is not null and end_line is not null and actual_lines is not null));

-- Preserve conflicting legacy settings as typed records; only settings/group_settings drives the active cycle.
create table migration_private.source_settings (
 source_path text primary key, firestore_id text not null, embedded_id text,
 cycle_id uuid references public.cycles(id), start_date date not null,
 total_quarters integer not null, review_window integer not null, current_cycle_number integer not null,
 is_paused boolean not null, paused_at date, total_paused_days integer not null,
 daily_thought text, daily_thought_updated_at timestamptz, daily_thought_updated_by text
);
create table migration_private.user_credentials (
 profile_id uuid primary key references public.profiles(id), password_hash text not null,
 firebase_uid text
);
-- Only field presence/type and source timestamps: never a JSON copy of business records.
create table migration_private.source_documents (
 source_path text primary key, collection_path text not null, firestore_id text not null,
 target_table text not null, target_id text not null,
 field_types jsonb not null,
 create_seconds bigint not null, create_nanos integer not null check(create_nanos between 0 and 999999999),
 update_seconds bigint not null, update_nanos integer not null check(update_nanos between 0 and 999999999),
 unique(collection_path,firestore_id)
);
create table migration_private.empty_legacy_arrays (
 source_path text not null references migration_private.source_documents(source_path),
 field_name text not null, primary key(source_path,field_name)
);
-- Personal tests are used by Men code but absent in this Firestore snapshot.
create table public.personal_tests (
 id uuid primary key, firestore_id text unique, member_id uuid not null references public.profiles(id),
 range_type text check(range_type in ('surah','juz','quarter')), range_label text,
 start_surah integer not null, start_surah_name text not null, end_surah integer not null, end_surah_name text not null,
 start_juz integer, end_juz integer, start_quarter integer, end_quarter integer,
 questions_count integer not null, lines_per_question integer not null, difficulty text not null,
 total_errors integer not null, grade numeric not null, grade_label text not null,
 notes text, date date not null, created_at timestamptz not null
);
create index personal_tests_member_date_idx on public.personal_tests(member_id,date);
create table public.personal_test_questions (
 test_id uuid not null references public.personal_tests(id) on delete cascade,
 question_number integer not null, start_surah integer not null, start_surah_name text not null, start_ayah integer not null,
 end_surah integer not null, end_surah_name text not null, end_ayah integer not null,
 errors_count integer not null, grade numeric not null, difficulty_level text,
 primary key(test_id,question_number)
);

-- Phase 1 is owner-only. No API policies/RPC grants before the separate Auth/application design.
DO $$ declare r record; role_name text; begin
 for r in select schemaname,tablename from pg_tables where schemaname in ('public','migration_private') loop
 execute format('alter table %I.%I enable row level security',r.schemaname,r.tablename);
 execute format('revoke all on table %I.%I from public',r.schemaname,r.tablename);
 foreach role_name in array array['anon','authenticated','service_role'] loop
 if exists(select 1 from pg_roles where rolname=role_name) then
 execute format('revoke all on table %I.%I from %I',r.schemaname,r.tablename,role_name);
 end if;
 end loop;
 end loop;
end $$;
revoke all on function public.sync_deactivated_at() from public;
