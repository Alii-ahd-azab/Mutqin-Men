-- Mutqin for Men — "fresh start" members.
--
-- An admin may create a member who joins at the batch's CURRENT position: no Tasmi'a debt for the
-- quarters before it and no review debt before the day he joined (review debt already starts at
-- batch_memberships.joined_at). The baseline is stored on the membership and bound to the cycle it
-- was set in, so it never leaks into a later cycle or another batch (a moved membership keeps the
-- old cycle id, which no longer matches). Existing memberships are untouched (both columns NULL =
-- previous behaviour: quarters start at 1).

alter table public.batch_memberships
  add column start_cycle_id uuid references public.cycles(id) on delete set null,
  add column start_quarter smallint check (start_quarter between 1 and 240),
  add constraint batch_memberships_start_pair check ((start_cycle_id is null) = (start_quarter is null));

comment on column public.batch_memberships.start_quarter is
  'Fresh start: first Tasmi''a quarter owed in start_cycle_id (quarters before it are not owed).';

-- Service role (admin-users Edge Function): set the baseline of a member just created in a batch.
-- The quarter is the batch's quarter of today (men_cycle_day), never chosen by the client.
create function public.men_set_fresh_start(p_user_id uuid, p_batch_id uuid) returns jsonb
    language plpgsql security definer
    set search_path to ''
    as $$
declare
  v_cycle   uuid;
  v_day     integer;
  v_updated integer;
begin
  select c.id into v_cycle from public.cycles c where c.batch_id = p_batch_id and c.status = 'active';
  if v_cycle is null then
    raise exception 'لا توجد دورة نشطة لهذه الدفعة' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.tasmia_submissions t where t.cycle_id = v_cycle and t.user_id = p_user_id)
     or exists (select 1 from public.review_confirmations r where r.cycle_id = v_cycle and r.user_id = p_user_id) then
    raise exception 'لا يمكن تعيين بداية جديدة لعضو لديه سجلات في الدورة الحالية' using errcode = 'check_violation';
  end if;

  v_day := app_private.men_cycle_day(v_cycle, app_private.men_today());
  -- Before the program starts there is nothing to skip.
  if v_day <= 1 then
    return jsonb_build_object('start_quarter', 1, 'cycle_id', v_cycle);
  end if;

  update public.batch_memberships
  set start_cycle_id = v_cycle, start_quarter = v_day, joined_at = now()
  where user_id = p_user_id and batch_id = p_batch_id and membership_role = 'member';
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'العضو غير مرتبط بهذه الدفعة' using errcode = 'P0002';
  end if;
  return jsonb_build_object('start_quarter', v_day, 'cycle_id', v_cycle);
end;
$$;

revoke all on function public.men_set_fresh_start(uuid, uuid) from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function public.men_set_fresh_start(uuid, uuid) from %I', r);
    end if;
  end loop;
end $$;
grant execute on function public.men_set_fresh_start(uuid, uuid) to service_role;

-- Tasmi'a guard: identical to 20261027000100 except that the ordered sequence starts at the
-- membership's fresh-start quarter (1 otherwise). Sequential enforcement is unchanged from there on.
CREATE OR REPLACE FUNCTION app_private.tasmia_batch_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_batch_id      uuid;
  v_status        text;
  v_member_name   text;
  v_listener_name text;
  v_day           integer;
  v_start         integer;
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

  select p.full_name, case when m.start_cycle_id = new.cycle_id then m.start_quarter else 1 end
  into v_member_name, v_start
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

  -- Men rule: quarters are recited in order (from the member's starting quarter), never ahead of
  -- the group's quarter of the day.
  select min(q) into v_required
  from generate_series(coalesce(v_start, 1), v_day) q
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
    -- A fresh-start member never owed quarters before his start: tests of those quarters do not apply.
    and t.range_start >= coalesce(v_start, 1)
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
