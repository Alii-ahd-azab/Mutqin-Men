-- Mutqin for Men — Phase 2: functional parity with Mutqin for Sisters.
--
-- Adds the live Sisters multi-batch layer (membership/profile guards, member transfer, admin batch
-- assignments, batch creation, history names), the listener correction, and the Sisters peer-test model
-- (stored sessions: start → submit, show windows, overlap guard) extended with the Men rules: selected
-- audience, prerequisite flags, partial-range eligibility (effective_range_end / covers_full_range).
-- Sisters function bodies are kept as close to verbatim as the Men schema allows; user-facing wording is
-- masculine. No existing rows are changed.

-- ---------------------------------------------------------------------------------------------
-- 1. Batch membership / profile guards (Sisters). Men additionally supports switching an account
--    between member and admin through public.men_set_account_role (transaction flag app.role_change).
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION app_private.batch_memberships_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_role   text;
  v_master boolean;
begin
  if tg_op = 'UPDATE' and old.membership_role = 'member' then
    -- A membership never changes owner or type.
    if new.user_id is distinct from old.user_id
       or new.membership_role is distinct from old.membership_role then
      raise exception 'لا يمكن تعديل عضوية الدفعة بهذه الطريقة'
        using errcode = 'check_violation';
    end if;

    -- Changing the batch is a transfer: only public.move_member_batch
    -- sets this transaction-local flag.
    if new.batch_id is distinct from old.batch_id
       and coalesce(current_setting('app.member_transfer', true), '') <> 'on' then
      raise exception 'نقل العضو بين الدفعات يتم فقط من خلال إجراء النقل الآمن'
        using errcode = 'check_violation';
    end if;
  end if;

  select p.role::text, p.is_master_admin
  into v_role, v_master
  from public.profiles p
  where p.id = new.user_id;

  if v_role is null then
    raise exception 'الحساب غير موجود'
      using errcode = 'foreign_key_violation';
  end if;

  if new.membership_role = 'member' and v_role <> 'member' then
    raise exception 'عضوية الدفعة كعضو متاحة لحسابات الأعضاء فقط'
      using errcode = 'check_violation';
  end if;

  if new.membership_role = 'admin' and (v_role <> 'admin' or v_master) then
    raise exception 'تعيين الدفعات متاح لمشرفي الدفعات فقط'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

CREATE FUNCTION app_private.profiles_batch_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if new.role::text is distinct from old.role::text
     and coalesce(current_setting('app.role_change', true), '') <> 'on'
     and exists (select 1 from public.batch_memberships m where m.user_id = new.id) then
    raise exception 'لا يمكن تغيير نوع حساب مرتبط بدفعة'
      using errcode = 'check_violation';
  end if;

  -- A master admin manages every batch; explicit assignments are redundant.
  if new.is_master_admin and not old.is_master_admin then
    delete from public.batch_memberships m
    where m.user_id = new.id
      and m.membership_role = 'admin';
  end if;

  return new;
end;
$$;

CREATE TRIGGER batch_memberships_guard BEFORE INSERT OR UPDATE OF batch_id, user_id, membership_role ON public.batch_memberships FOR EACH ROW EXECUTE FUNCTION app_private.batch_memberships_guard();
CREATE TRIGGER profiles_batch_guard BEFORE UPDATE OF role, is_master_admin ON public.profiles FOR EACH ROW EXECUTE FUNCTION app_private.profiles_batch_guard();

-- ---------------------------------------------------------------------------------------------
-- 2. Sisters batch functions (service role, via Edge Functions) and browser RPCs
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public.create_batch_with_cycle(p_name text, p_start_date date, p_actor uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_batch public.batches;
begin
  if p_name is null or length(btrim(p_name)) = 0 then
    raise exception 'اسم الدفعة مطلوب' using errcode = 'check_violation';
  end if;

  if p_start_date is null then
    raise exception 'تاريخ البداية مطلوب' using errcode = 'check_violation';
  end if;

  insert into public.batches (name, created_by)
  values (btrim(p_name), p_actor)
  returning * into v_batch;

  insert into public.cycles (batch_id, cycle_number, name, starts_on, status, created_by)
  values (v_batch.id, 1, 'الدورة 1', p_start_date, 'active', p_actor);

  return jsonb_build_object(
    'id', v_batch.id,
    'name', v_batch.name,
    'created_at', v_batch.created_at,
    'archived_at', v_batch.archived_at
  );
end;
$$;

CREATE FUNCTION public.set_admin_batches(p_user_id uuid, p_batch_ids uuid[], p_actor uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if coalesce(array_length(p_batch_ids, 1), 0) = 0 then
    raise exception 'يرجى اختيار دفعة واحدة على الأقل'
      using errcode = 'check_violation';
  end if;

  delete from public.batch_memberships m
  where m.user_id = p_user_id
    and m.membership_role = 'admin'
    and not (m.batch_id = any (p_batch_ids));

  insert into public.batch_memberships (batch_id, user_id, membership_role, created_by)
  select distinct b.batch_id, p_user_id, 'admin', p_actor
  from unnest(p_batch_ids) as b(batch_id)
  on conflict (batch_id, user_id) do nothing;
end;
$$;

CREATE FUNCTION public.move_member_batch(p_user_id uuid, p_destination_batch_id uuid, p_expected_source_batch_id uuid, p_actor uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_role         text;
  v_count        integer;
  v_membership   public.batch_memberships;
  v_dest         public.batches;
begin
  select p.role::text into v_role
  from public.profiles p
  where p.id = p_user_id;

  if v_role is null then
    raise exception 'العضو غير موجود' using errcode = 'no_data_found';
  end if;

  if v_role <> 'member' then
    raise exception 'يمكن نقل حسابات الأعضاء فقط' using errcode = 'check_violation';
  end if;

  -- Lock the member's current membership row(s) first, then inspect.
  perform 1
  from public.batch_memberships m
  where m.user_id = p_user_id
    and m.membership_role = 'member'
  for update;

  select count(*) into v_count
  from public.batch_memberships m
  where m.user_id = p_user_id
    and m.membership_role = 'member';

  if v_count = 0 then
    raise exception 'العضو غير مرتبط بأي دفعة' using errcode = 'no_data_found';
  end if;

  if v_count > 1 then
    raise exception 'خطأ في البيانات: العضو مرتبط بأكثر من دفعة' using errcode = 'check_violation';
  end if;

  select m.* into v_membership
  from public.batch_memberships m
  where m.user_id = p_user_id
    and m.membership_role = 'member';

  if p_expected_source_batch_id is not null
     and v_membership.batch_id <> p_expected_source_batch_id then
    raise exception 'تغيّرت دفعة العضو، يرجى تحديث الصفحة والمحاولة مرة أخرى'
      using errcode = 'check_violation';
  end if;

  if v_membership.batch_id = p_destination_batch_id then
    raise exception 'العضو موجود بالفعل في هذه الدفعة' using errcode = 'check_violation';
  end if;

  select b.* into v_dest
  from public.batches b
  where b.id = p_destination_batch_id
  for share;

  if v_dest.id is null or v_dest.archived_at is not null then
    raise exception 'الدفعة المختارة غير موجودة' using errcode = 'no_data_found';
  end if;

  if not exists (
    select 1 from public.cycles c
    where c.batch_id = p_destination_batch_id
      and c.status = 'active'
  ) then
    raise exception 'لا توجد دورة نشطة في الدفعة المختارة' using errcode = 'check_violation';
  end if;

  perform set_config('app.member_transfer', 'on', true);

  update public.batch_memberships
  set batch_id = p_destination_batch_id,
      joined_at = now()
  where id = v_membership.id;

  perform set_config('app.member_transfer', 'off', true);

  insert into public.batch_membership_transfers (user_id, from_batch_id, to_batch_id, moved_by)
  values (p_user_id, v_membership.batch_id, p_destination_batch_id, p_actor);

  return jsonb_build_object(
    'from_batch_id', v_membership.batch_id,
    'to_batch_id', p_destination_batch_id
  );
end;
$$;

CREATE FUNCTION public.history_member_names(p_cycle_id uuid) RETURNS TABLE(id uuid, full_name text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  with people as (
    select t.user_id as uid
    from public.tasmia_submissions t
    where t.cycle_id = p_cycle_id
      and p_cycle_id in (select app_private.managed_cycle_ids())
    union
    select t.listener_id
    from public.tasmia_submissions t
    where t.cycle_id = p_cycle_id
      and t.listener_id is not null
      and p_cycle_id in (select app_private.managed_cycle_ids())
    union
    select r.user_id
    from public.review_confirmations r
    where r.cycle_id = p_cycle_id
      and p_cycle_id in (select app_private.managed_cycle_ids())
    union
    select t.user_id
    from public.tasmia_submissions t
    where t.cycle_id = p_cycle_id
      and p_cycle_id = app_private.member_active_cycle_id()
      and t.listener_id = auth.uid()
  )
  select p.id, p.full_name
  from public.profiles p
  join people on people.uid = p.id;
$$;

-- The member's one listener correction (within 12 hours of submitting).
CREATE FUNCTION public.correct_tasmia_listener(p_submission_id uuid, p_new_listener_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_uid           uuid := auth.uid();
  v_row           public.tasmia_submissions;
  v_batch_id      uuid;
  v_listener_name text;
  v_saved         public.tasmia_submissions;
begin
  select t.* into v_row
  from public.tasmia_submissions t
  where t.id = p_submission_id
  for update;

  -- Missing and not-his look the same, so existence is not revealed.
  -- The member_active_cycle_id() check also requires an active member
  -- whose batch's active cycle this row belongs to.
  if v_uid is null
     or v_row.id is null
     or v_row.user_id <> v_uid
     or v_row.cycle_id is distinct from app_private.member_active_cycle_id() then
    raise exception 'لا يمكن تعديل هذا التسميع'
      using errcode = 'check_violation';
  end if;

  if v_row.listener_changed_at is not null then
    raise exception 'تم تعديل المستمع مسبقًا'
      using errcode = 'check_violation';
  end if;

  if now() > v_row.submitted_at + interval '12 hours' then
    raise exception 'انتهت مهلة التعديل'
      using errcode = 'check_violation';
  end if;

  if p_new_listener_id is null then
    raise exception 'يجب اختيار الزميل المستمع'
      using errcode = 'check_violation';
  end if;

  if p_new_listener_id is not distinct from v_row.listener_id then
    raise exception 'هذا هو المستمع المسجل حاليًا'
      using errcode = 'check_violation';
  end if;

  if p_new_listener_id = v_uid then
    raise exception 'لا يمكن اختيار نفسك كمستمع'
      using errcode = 'check_violation';
  end if;

  select c.batch_id into v_batch_id
  from public.cycles c
  where c.id = v_row.cycle_id;

  v_listener_name := app_private.tasmia_listener_name(v_batch_id, v_row.user_id, p_new_listener_id);

  if v_listener_name is null then
    raise exception 'المستمع يجب أن يكون عضوًا نشطًا من نفس الدفعة'
      using errcode = 'check_violation';
  end if;

  -- The corrected listener replaces the wrong one everywhere, including
  -- the name snapshot kept for after an account deletion.
  update public.tasmia_submissions
  set listener_id = p_new_listener_id,
      listener_name_snapshot = v_listener_name,
      listener_changed_at = now()
  where id = v_row.id
  returning * into v_saved;

  return jsonb_build_object(
    'id', v_saved.id,
    'listener_id', v_saved.listener_id,
    'listener_name_snapshot', v_saved.listener_name_snapshot,
    'listener_changed_at', v_saved.listener_changed_at
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Men account functions, updated for the guards and Sisters' batch-admin model
-- ---------------------------------------------------------------------------------------------

-- Switch an account between member and admin (Men feature). Admins become master admins unless
-- batch assignments are given; members get a membership in p_batch_id.
CREATE OR REPLACE FUNCTION public.men_set_account_role(p_user_id uuid, p_role text, p_batch_id uuid, p_actor uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if p_role not in ('member', 'admin') then
    raise exception 'الدور غير صالح' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'العضو غير موجود' using errcode = 'P0002';
  end if;
  if p_role = 'member' and p_batch_id is null then
    raise exception 'يرجى اختيار دفعة العضو' using errcode = 'check_violation';
  end if;

  perform set_config('app.role_change', 'on', true);
  delete from public.batch_memberships where user_id = p_user_id;
  update public.profiles set role = p_role, is_master_admin = (p_role = 'admin') where id = p_user_id;
  perform set_config('app.role_change', 'off', true);

  if p_role = 'member' then
    insert into public.batch_memberships (batch_id, user_id, membership_role, created_by)
    values (p_batch_id, p_user_id, 'member', p_actor);
  end if;
end;
$$;

-- Permanent deletion of a member or batch admin (Sisters: master admins are never deleted).
-- Removes the rows that would block the Auth-user cascade (Men: attempts as candidate or examiner,
-- audience selections, personal tests, preserved legacy credential).
CREATE OR REPLACE FUNCTION public.men_delete_member_completely(p_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_role text;
  v_master boolean;
  v_recitations integer;
  v_revisions integer;
  v_attempts integer;
begin
  select p.role, p.is_master_admin into v_role, v_master from public.profiles p where p.id = p_user_id for update;
  if not found then
    raise exception 'العضو غير موجود' using errcode = 'P0002';
  end if;
  if v_role = 'admin' and v_master then
    raise exception 'لا يمكن حذف حساب مشرف عام' using errcode = 'P0001';
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

-- ---------------------------------------------------------------------------------------------
-- 4. Peer tests: Sisters model + Men audience, prerequisites and partial ranges
-- ---------------------------------------------------------------------------------------------
drop function public.men_peer_test_save(uuid, uuid, jsonb, uuid[], uuid);
drop function public.men_peer_test_set_status(uuid, text);
drop function public.men_peer_test_record_attempt(jsonb, jsonb);

CREATE FUNCTION app_private.peer_test_future_window(p_visible_from timestamp with time zone, p_visible_until timestamp with time zone) RETURNS tstzrange
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select case
    when coalesce(p_visible_until, 'infinity'::timestamptz)
         <= greatest(coalesce(p_visible_from, '-infinity'::timestamptz), now())
      then 'empty'::tstzrange
    else tstzrange(
      greatest(coalesce(p_visible_from, '-infinity'::timestamptz), now()),
      coalesce(p_visible_until, 'infinity'::timestamptz),
      '[)'
    )
  end;
$$;

CREATE FUNCTION app_private.assert_no_overlapping_peer_test(p_cycle_id uuid, p_exclude_ids uuid[], p_visible_from timestamp with time zone, p_visible_until timestamp with time zone) RETURNS void
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if exists (
    select 1
    from public.peer_tests t
    where t.cycle_id = p_cycle_id
      and t.status = 'published'
      and not (t.id = any (coalesce(p_exclude_ids, '{}'::uuid[])))
      and app_private.peer_test_future_window(t.visible_from, t.visible_until)
          && app_private.peer_test_future_window(p_visible_from, p_visible_until)
  ) then
    raise exception 'يوجد اختبار آخر ظاهر في نفس الفترة لهذه الدفعة. أخفِه أو عدّل فترة العرض أولاً'
      using errcode = 'check_violation';
  end if;
end;
$$;

-- Sisters peer_test_save + Men audience / selected members / prerequisites.
CREATE FUNCTION public.peer_test_save(p_test_id uuid, p_cycle_id uuid, p_title text, p_range_start integer, p_range_end integer, p_questions_count integer, p_lines_per_question integer, p_max_errors integer, p_test_type text, p_difficulty text, p_status text, p_visible_from timestamp with time zone, p_visible_until timestamp with time zone, p_actor uuid, p_audience text, p_selected_member_ids uuid[], p_require_all_quarters_completed boolean, p_require_revision_completed boolean) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_cycle     public.cycles;
  v_existing  public.peer_tests;
  v_saved     public.peer_tests;
  v_versioned boolean := false;
  v_exclude   uuid[] := '{}';
  v_selected  uuid[] := coalesce(p_selected_member_ids, '{}');
begin
  if p_status not in ('draft', 'published', 'hidden') then
    raise exception 'حالة العرض غير صالحة' using errcode = 'check_violation';
  end if;
  if p_audience not in ('all', 'selected') then
    raise exception 'الجمهور المستهدف غير صالح' using errcode = 'check_violation';
  end if;
  if p_audience = 'selected' and coalesce(array_length(v_selected, 1), 0) = 0 then
    raise exception 'يرجى تحديد عضو واحد على الأقل في قائمة الأعضاء المختارين، أو اختيار (كل الأعضاء)'
      using errcode = 'check_violation';
  end if;

  -- Serialize changes per cycle (keeps the one-live-test rule race-safe).
  select c.* into v_cycle from public.cycles c where c.id = p_cycle_id for update;
  if v_cycle.id is null or v_cycle.status <> 'active' then
    raise exception 'لا توجد دورة نشطة لهذه الدفعة' using errcode = 'check_violation';
  end if;

  -- Selected members must be members of this batch.
  if exists (
    select 1 from unnest(v_selected) s(uid)
    where not exists (
      select 1 from public.batch_memberships m
      where m.user_id = s.uid and m.batch_id = v_cycle.batch_id and m.membership_role = 'member')
  ) then
    raise exception 'قائمة الأعضاء المختارين تحتوي على عضو غير موجود في هذه الدفعة' using errcode = 'check_violation';
  end if;

  if p_status = 'published' and p_visible_until is not null and p_visible_until <= now() then
    raise exception 'وقت انتهاء العرض يجب أن يكون في المستقبل' using errcode = 'check_violation';
  end if;

  if p_test_id is not null then
    select t.* into v_existing from public.peer_tests t where t.id = p_test_id for update;
    if v_existing.id is null or v_existing.cycle_id <> p_cycle_id then
      raise exception 'الاختبار غير موجود' using errcode = 'no_data_found';
    end if;
    if v_existing.status = 'finished' then
      raise exception 'هذا الاختبار منتهٍ نهائيًا ولا يمكن تعديله، أنشئ اختبارًا جديدًا'
        using errcode = 'check_violation';
    end if;

    v_exclude := array[v_existing.id];

    v_versioned := (
      v_existing.range_start <> p_range_start
      or v_existing.range_end <> p_range_end
      or v_existing.questions_count <> p_questions_count
      or v_existing.lines_per_question <> p_lines_per_question
      or v_existing.difficulty <> p_difficulty
    ) and exists (
      select 1 from public.peer_test_attempts a
      where a.test_id = v_existing.id and a.status <> 'cancelled'
    );
  end if;

  if p_status = 'published' then
    perform app_private.assert_no_overlapping_peer_test(p_cycle_id, v_exclude, p_visible_from, p_visible_until);
  end if;

  if p_test_id is not null and not v_versioned then
    update public.peer_tests
    set title = btrim(p_title),
        range_start = p_range_start,
        range_end = p_range_end,
        questions_count = p_questions_count,
        lines_per_question = p_lines_per_question,
        max_errors = p_max_errors,
        test_type = p_test_type,
        difficulty = p_difficulty,
        status = p_status,
        visible_from = p_visible_from,
        visible_until = p_visible_until,
        audience = p_audience,
        require_all_quarters_completed = coalesce(p_require_all_quarters_completed, false),
        require_revision_completed = coalesce(p_require_revision_completed, false),
        updated_at = now()
    where id = p_test_id
    returning * into v_saved;
  else
    if v_versioned then
      update public.peer_tests
      set status = 'finished', finished_at = now(), updated_at = now()
      where id = v_existing.id;

      update public.peer_test_attempts
      set status = 'cancelled'
      where test_id = v_existing.id and status = 'in_progress';
    end if;

    insert into public.peer_tests (
      cycle_id, title, range_start, range_end, questions_count, lines_per_question,
      max_errors, test_type, difficulty, status, visible_from, visible_until, created_by,
      audience, require_all_quarters_completed, require_revision_completed
    )
    values (
      p_cycle_id, btrim(p_title), p_range_start, p_range_end, p_questions_count, p_lines_per_question,
      p_max_errors, p_test_type, p_difficulty, p_status, p_visible_from, p_visible_until, p_actor,
      p_audience, coalesce(p_require_all_quarters_completed, false), coalesce(p_require_revision_completed, false)
    )
    returning * into v_saved;
  end if;

  delete from public.peer_test_selected_members where test_id = v_saved.id;
  if p_audience = 'selected' then
    insert into public.peer_test_selected_members (test_id, user_id, position)
    select v_saved.id, s.uid, s.ord - 1
    from unnest(v_selected) with ordinality as s(uid, ord);
  end if;

  return jsonb_build_object('test', to_jsonb(v_saved), 'versioned', v_versioned);
end;
$$;

CREATE FUNCTION public.peer_test_set_status(p_test_id uuid, p_action text, p_actor uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_test  public.peer_tests;
  v_saved public.peer_tests;
  v_until timestamptz;
begin
  select t.* into v_test from public.peer_tests t where t.id = p_test_id;
  if v_test.id is null then
    raise exception 'الاختبار غير موجود' using errcode = 'no_data_found';
  end if;

  perform 1 from public.cycles c where c.id = v_test.cycle_id for update;
  select t.* into v_test from public.peer_tests t where t.id = p_test_id for update;

  if v_test.status = 'finished' then
    raise exception 'هذا الاختبار منتهٍ نهائيًا' using errcode = 'check_violation';
  end if;

  if p_action = 'show' then
    -- Men: a selected-audience test needs at least one selected member.
    if v_test.audience = 'selected'
       and not exists (select 1 from public.peer_test_selected_members s where s.test_id = p_test_id) then
      raise exception 'لا يمكن إظهار اختبار مخصص لأعضاء مختارين دون تحديد أي عضو في قائمته'
        using errcode = 'check_violation';
    end if;
    v_until := case when v_test.visible_until is not null and v_test.visible_until <= now()
                    then null else v_test.visible_until end;
    perform app_private.assert_no_overlapping_peer_test(v_test.cycle_id, array[v_test.id], null, v_until);
    update public.peer_tests
    set status = 'published', visible_from = null, visible_until = v_until, updated_at = now()
    where id = p_test_id
    returning * into v_saved;
  elsif p_action = 'hide' then
    update public.peer_tests
    set status = 'hidden', updated_at = now()
    where id = p_test_id
    returning * into v_saved;
  elsif p_action = 'finish' then
    update public.peer_tests
    set status = 'finished', finished_at = now(), updated_at = now()
    where id = p_test_id
    returning * into v_saved;

    update public.peer_test_attempts
    set status = 'cancelled'
    where test_id = p_test_id and status = 'in_progress';
  else
    raise exception 'إجراء غير معروف' using errcode = 'check_violation';
  end if;

  return jsonb_build_object('test', to_jsonb(v_saved));
end;
$$;

-- Sisters peer_test_start_attempt + Men audience and partial range:
-- p_effective_range_end is the last quarter the questions cover (the full range unless the test
-- allows a partially recited range); the database re-checks it against the recitations.
CREATE FUNCTION public.peer_test_start_attempt(p_test_id uuid, p_candidate_id uuid, p_examiner_id uuid, p_questions jsonb, p_effective_range_end integer) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_test       public.peer_tests;
  v_batch_id   uuid;
  v_cycle_open boolean;
  v_cand_name  text;
  v_exam_name  text;
  v_done       integer;
  v_end        integer := coalesce(p_effective_range_end, 0);
  v_attempt_id uuid;
begin
  select t.* into v_test from public.peer_tests t where t.id = p_test_id for share;
  if v_test.id is null
     or not app_private.peer_test_is_live(v_test.status, v_test.visible_from, v_test.visible_until) then
    raise exception 'الاختبار غير متاح حاليًا' using errcode = 'check_violation';
  end if;

  select c.batch_id, c.status = 'active' into v_batch_id, v_cycle_open
  from public.cycles c where c.id = v_test.cycle_id;
  if not coalesce(v_cycle_open, false) then
    raise exception 'دورة هذا الاختبار غير نشطة' using errcode = 'check_violation';
  end if;

  if p_candidate_id = p_examiner_id then
    raise exception 'لا يمكن للعضو اختبار نفسه' using errcode = 'check_violation';
  end if;

  select p.full_name into v_exam_name
  from public.profiles p
  join public.batch_memberships m on m.user_id = p.id and m.membership_role = 'member'
  where p.id = p_examiner_id and p.role = 'member' and p.active and m.batch_id = v_batch_id;
  if v_exam_name is null then
    raise exception 'المُختبِر يجب أن يكون عضوًا نشطًا في هذه الدفعة' using errcode = 'check_violation';
  end if;

  select p.full_name into v_cand_name
  from public.profiles p
  join public.batch_memberships m on m.user_id = p.id and m.membership_role = 'member'
  where p.id = p_candidate_id and p.role = 'member' and p.active and m.batch_id = v_batch_id;
  if v_cand_name is null then
    raise exception 'العضو المُختبَر يجب أن يكون عضوًا نشطًا في هذه الدفعة' using errcode = 'check_violation';
  end if;

  -- Men: both people must be in the test's audience.
  if v_test.audience = 'selected' and (
       not exists (select 1 from public.peer_test_selected_members s where s.test_id = v_test.id and s.user_id = p_examiner_id)
    or not exists (select 1 from public.peer_test_selected_members s where s.test_id = v_test.id and s.user_id = p_candidate_id)) then
    raise exception 'المُختبِر والمُختبَر يجب أن يكونا ضمن الأعضاء المشمولين بهذا الاختبار' using errcode = 'check_violation';
  end if;

  -- Men: the questions cover range_start..effective end; the whole range unless partial ranges are allowed.
  if v_end < v_test.range_start or v_end > v_test.range_end
     or (v_test.require_all_quarters_completed and v_end <> v_test.range_end) then
    raise exception 'نطاق أسئلة الاختبار غير صالح' using errcode = 'check_violation';
  end if;

  -- Every quarter of the covered range must already be recited in this cycle.
  select count(distinct s.quarter_number) into v_done
  from public.tasmia_submissions s
  where s.cycle_id = v_test.cycle_id
    and s.user_id = p_candidate_id
    and s.quarter_number between v_test.range_start and v_end;
  if v_done < (v_end - v_test.range_start + 1) then
    raise exception 'لم يُتمّ العضو تسميع جميع أرباع نطاق الاختبار بعد' using errcode = 'check_violation';
  end if;

  -- Already passed for the whole range, or for at least this partial range.
  if exists (
    select 1 from public.peer_test_attempts a
    where a.test_id = p_test_id and a.candidate_id = p_candidate_id and a.status = 'passed'
      and (coalesce(a.covers_full_range, true) or a.effective_range_end >= v_end)
  ) then
    raise exception 'اجتاز العضو هذا الاختبار من قبل' using errcode = 'check_violation';
  end if;

  if jsonb_typeof(p_questions) <> 'array' or jsonb_array_length(p_questions) <> v_test.questions_count then
    raise exception 'عدد الأسئلة لا يطابق إعدادات الاختبار' using errcode = 'check_violation';
  end if;

  -- A new session replaces any unfinished one for this candidate.
  update public.peer_test_attempts
  set status = 'cancelled'
  where test_id = p_test_id and candidate_id = p_candidate_id and status = 'in_progress';

  insert into public.peer_test_attempts (
    test_id, candidate_id, candidate_name_snapshot, examiner_id, examiner_name_snapshot,
    status, max_errors_snapshot, attempt_date, effective_range_end, covers_full_range
  )
  values (
    p_test_id, p_candidate_id, v_cand_name, p_examiner_id, v_exam_name,
    'in_progress', v_test.max_errors, app_private.men_today(), v_end, v_end = v_test.range_end
  )
  returning id into v_attempt_id;

  insert into public.peer_test_attempt_questions (
    attempt_id, question_number, start_surah, start_surah_name, start_ayah,
    end_surah, end_surah_name, end_ayah,
    start_page, start_line, end_page, end_line, actual_lines, difficulty_level
  )
  select v_attempt_id, q.question_number, q.start_surah, q.start_surah_name, q.start_ayah,
         q.end_surah, q.end_surah_name, q.end_ayah,
         q.start_page, q.start_line, q.end_page, q.end_line, q.actual_lines, q.difficulty_level
  from jsonb_to_recordset(p_questions) as q(
    question_number smallint, start_surah smallint, start_surah_name text, start_ayah smallint,
    end_surah smallint, end_surah_name text, end_ayah smallint, start_page smallint, start_line smallint,
    end_page smallint, end_line smallint, actual_lines smallint, difficulty_level text
  );

  return v_attempt_id;
end;
$$;

CREATE FUNCTION public.peer_test_submit_attempt(p_attempt_id uuid, p_examiner_id uuid, p_errors integer[], p_question_notes text[], p_notes text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_attempt public.peer_test_attempts;
  v_test    public.peer_tests;
  v_count   integer;
  v_total   integer;
  v_passed  boolean;
  v_saved   public.peer_test_attempts;
begin
  select a.* into v_attempt from public.peer_test_attempts a where a.id = p_attempt_id for update;
  if v_attempt.id is null or v_attempt.status <> 'in_progress' then
    raise exception 'جلسة الاختبار غير موجودة أو انتهت' using errcode = 'check_violation';
  end if;
  if v_attempt.examiner_id is distinct from p_examiner_id then
    raise exception 'لا يمكن اعتماد نتيجة اختبار أجراه زميل آخر' using errcode = 'check_violation';
  end if;

  select t.* into v_test from public.peer_tests t where t.id = v_attempt.test_id;
  if not app_private.peer_test_is_live(v_test.status, v_test.visible_from, v_test.visible_until)
     or not exists (select 1 from public.cycles c where c.id = v_test.cycle_id and c.status = 'active') then
    raise exception 'الاختبار غير متاح حاليًا' using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from public.peer_test_attempts a
    where a.test_id = v_attempt.test_id and a.candidate_id = v_attempt.candidate_id and a.status = 'passed'
      and (coalesce(a.covers_full_range, true) or a.effective_range_end >= v_attempt.effective_range_end)
  ) then
    raise exception 'اجتاز العضو هذا الاختبار من قبل' using errcode = 'check_violation';
  end if;

  select count(*) into v_count from public.peer_test_attempt_questions q where q.attempt_id = p_attempt_id;
  if coalesce(array_length(p_errors, 1), 0) <> v_count then
    raise exception 'يجب تسجيل أخطاء جميع الأسئلة' using errcode = 'check_violation';
  end if;
  if exists (select 1 from unnest(p_errors) e where e is null or e < 0 or e > 99) then
    raise exception 'عدد الأخطاء لكل سؤال يجب أن يكون بين 0 و 99' using errcode = 'check_violation';
  end if;

  update public.peer_test_attempt_questions q
  set errors_count = p_errors[q.question_number],
      notes = nullif(left(btrim(coalesce(p_question_notes[q.question_number], '')), 300), '')
  where q.attempt_id = p_attempt_id;

  select coalesce(sum(e), 0) into v_total from unnest(p_errors) e;
  v_passed := v_attempt.max_errors_snapshot is null or v_total <= v_attempt.max_errors_snapshot;

  update public.peer_test_attempts
  set status = case when v_passed then 'passed' else 'failed' end,
      total_errors = v_total,
      notes = nullif(left(btrim(coalesce(p_notes, '')), 300), ''),
      completed_at = now()
  where id = p_attempt_id
  returning * into v_saved;

  return jsonb_build_object('attempt', to_jsonb(v_saved));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. Privileges
-- ---------------------------------------------------------------------------------------------
do $$
declare
  f text;
  r text;
begin
  foreach f in array array[
    'app_private.batch_memberships_guard()', 'app_private.profiles_batch_guard()',
    'app_private.peer_test_future_window(timestamp with time zone, timestamp with time zone)',
    'app_private.assert_no_overlapping_peer_test(uuid, uuid[], timestamp with time zone, timestamp with time zone)',
    'public.create_batch_with_cycle(text, date, uuid)', 'public.set_admin_batches(uuid, uuid[], uuid)',
    'public.move_member_batch(uuid, uuid, uuid, uuid)', 'public.history_member_names(uuid)',
    'public.correct_tasmia_listener(uuid, uuid)', 'public.men_set_account_role(uuid, text, uuid, uuid)',
    'public.men_delete_member_completely(uuid)',
    'public.peer_test_save(uuid, uuid, text, integer, integer, integer, integer, integer, text, text, text, timestamp with time zone, timestamp with time zone, uuid, text, uuid[], boolean, boolean)',
    'public.peer_test_set_status(uuid, text, uuid)',
    'public.peer_test_start_attempt(uuid, uuid, uuid, jsonb, integer)',
    'public.peer_test_submit_attempt(uuid, uuid, integer[], text[], text)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', f, r);
      end if;
    end loop;
  end loop;
end $$;

-- Browser RPCs (each checks the caller itself).
grant execute on function public.history_member_names(uuid), public.correct_tasmia_listener(uuid, uuid) to authenticated;
-- Edge Functions only.
grant execute on function
  public.create_batch_with_cycle(text, date, uuid), public.set_admin_batches(uuid, uuid[], uuid),
  public.move_member_batch(uuid, uuid, uuid, uuid), public.men_set_account_role(uuid, text, uuid, uuid),
  public.men_delete_member_completely(uuid),
  public.peer_test_save(uuid, uuid, text, integer, integer, integer, integer, integer, text, text, text, timestamp with time zone, timestamp with time zone, uuid, text, uuid[], boolean, boolean),
  public.peer_test_set_status(uuid, text, uuid), public.peer_test_start_attempt(uuid, uuid, uuid, jsonb, integer),
  public.peer_test_submit_attempt(uuid, uuid, integer[], text[], text)
  to service_role;
