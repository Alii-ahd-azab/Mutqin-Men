-- Mutqin for Men — link migrated profiles to Supabase Auth identities.
--
-- Apply ONLY after `migration/cutover/link-auth.mjs` has created one auth.users row per profile with
-- auth.users.id = profiles.id (existing bcrypt hashes imported, no password reset).
-- Refuses to run while any profile is unlinked, so it can never orphan an account.

do $$
declare
  v_missing integer;
begin
  select count(*) into v_missing
  from public.profiles p
  where not exists (select 1 from auth.users u where u.id = p.id);
  if v_missing > 0 then
    raise exception 'auth link incomplete: % profile(s) without a matching auth.users row', v_missing;
  end if;
end $$;

alter table public.profiles
  add constraint profiles_id_fkey foreign key (id) references auth.users(id) on delete cascade;
