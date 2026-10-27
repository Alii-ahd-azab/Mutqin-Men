-- Mutqin for Men: the program day starts at 05:00 Africa/Cairo, and «اختبر نفسك» is retired.
--
-- 1. Program date. app_private.men_today() was the Makkah calendar date (it changed at midnight
--    Asia/Riyadh). Every rule that needs "today" goes through it: Tasmi'a / review dating and the
--    client-date window, distant-review scheduling and completion, revision backfill, fresh-start
--    baselines, peer-test attempts. It now returns the program date: the Cairo wall-clock time minus
--    five hours, as a date. "at time zone 'Africa/Cairo'" uses the IANA rules of the server, so the
--    daylight-saving offset of the day is applied (no fixed UTC offset); the subtraction is done on
--    the local wall-clock time, so 04:59:59 Cairo is still the previous date and 05:00:00 starts the
--    new one in summer and in winter. Same rule as programDate() in
--    supabase/functions/_shared/logic/programDate.ts.
--
--    Stored dates are not touched: no row is rewritten and membership join dates keep their Makkah
--    calendar date (men_complete_distant_review and joinedOnDateFromTimestamp).
--
-- 2. «اختبر نفسك» (personal self-tests) is no longer part of the app. Its history stays in
--    personal_tests / personal_test_questions (readable by its owner); only the write paths that the
--    removed screen used are closed: the save RPC and direct deletes by members.

create function app_private.men_program_date(p_at timestamptz) returns date
    language sql stable
    set search_path to ''
    as $$ select ((p_at at time zone 'Africa/Cairo') - interval '5 hours')::date $$;

comment on function app_private.men_program_date(timestamptz) is
  'Mutqin program date at an instant: Africa/Cairo local date with the day starting at 05:00.';

create or replace function app_private.men_today() returns date
    language sql stable
    set search_path to ''
    as $$ select app_private.men_program_date(now()) $$;

comment on function app_private.men_today() is
  'The program date now (05:00 Africa/Cairo day boundary).';

do $$
declare
  r text;
begin
  revoke all on function app_private.men_program_date(timestamptz) from public;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function app_private.men_program_date(timestamptz) from %I', r);
    end if;
  end loop;
end;
$$;

-- «اختبر نفسك» retired: history is kept, the removed screen's write paths are closed.
revoke execute on function public.men_save_personal_test(jsonb) from authenticated;
revoke delete on public.personal_tests from authenticated;
drop policy personal_tests_delete_own on public.personal_tests;
