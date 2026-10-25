// Read-only verification of the Men app-access migration on production.
// Catalog checks plus role behavior inside a transaction that is always rolled back.
//   node migration/cutover/verify-access.mjs --project uaublandjewfzmhnbflc
import { connectOwner, requireProjectArg } from "./production.mjs";

const project = requireProjectArg(process.argv.slice(2));
const db = await connectOwner(project);
const out = {};
const one = async (sql, p) => (await db.query(sql, p)).rows[0];
const all = async (sql, p) => (await db.query(sql, p)).rows;
// Expected failures run inside savepoints so the outer transaction stays usable.
const outcome = async (sql, p = []) => {
  await db.query("savepoint probe");
  try {
    const r = await db.query(sql, p);
    await db.query("release savepoint probe");
    return { ok: true, rows: r.rows };
  } catch (e) {
    await db.query("rollback to savepoint probe");
    return { ok: false, code: e.code };
  }
};
const as = async (role, sub) => {
  await db.query("reset role");
  await db.query("select set_config('request.jwt.claims', $1, true)", [sub ? JSON.stringify({ sub, role }) : ""]);
  await db.query(`set local role ${role}`);
};

try {
  await db.query("begin");
  out.recorded = await one("select name, applied_at is not null as applied from migration_private.cutover_migrations");
  out.serverRole = await one(`select rolname, rolcanlogin, rolsuper, rolbypassrls, rolinherit, rolcreaterole, rolcreatedb
                                from pg_roles where rolname = 'mutqin_app_server'`);
  out.constraints = await one(`select
      exists(select 1 from pg_constraint where conname='reviews_day_or_date') as reviews_day_or_date,
      exists(select 1 from pg_constraint where conname='reviews_legacy_unknown_day') as old_constraint_present`);
  out.policies = await all(`select roles::text, count(*)::int n from pg_policies where schemaname='public' group by roles order by 1`);
  out.functions = await all(`select p.proname, p.prosecdef as security_definer,
        has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
        has_function_privilege('anon', p.oid, 'execute') as anon,
        has_function_privilege('service_role', p.oid, 'execute') as service_role,
        has_function_privilege('mutqin_app_server', p.oid, 'execute') as server
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app_private' order by 1`);
  out.tableAccess = await all(`select c.relname, c.relrowsecurity as rls,
        has_table_privilege('anon', c.oid, 'select') as anon_select,
        has_table_privilege('authenticated', c.oid, 'select') as auth_select,
        has_table_privilege('authenticated', c.oid, 'insert,update,delete') as auth_write,
        has_table_privilege('service_role', c.oid, 'select') as service_select,
        has_table_privilege('mutqin_app_server', c.oid, 'select') as server_select
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public','migration_private') and c.relkind = 'r' order by n.nspname, c.relname`);
  out.counts = await one(`select (select count(*)::int from public.profiles) profiles,
      (select count(*)::int from public.tasmia_submissions) tasmia, (select count(*)::int from public.review_confirmations) reviews`);

  const member = (await one(`select p.id from public.profiles p where p.role='member' and p.active
      and exists(select 1 from public.tasmia_submissions t where t.user_id=p.id) order by p.firestore_id limit 1`)).id;
  const inactive = (await one("select id from public.profiles where role='member' and not active order by firestore_id limit 1")).id;
  const admin = (await one("select id from public.profiles where role='admin' and active order by firestore_id limit 1")).id;

  const behavior = {};
  await as("anon");
  behavior.anon_profiles = await outcome("select 1 from public.profiles limit 1");
  await as("authenticated", member);
  behavior.member = {
    profiles: (await outcome("select count(*)::int n from public.profiles")).rows[0].n,
    foreignTasmia: (await outcome("select count(*)::int n from public.tasmia_submissions where user_id<>$1 and listener_id is distinct from $1", [member])).rows[0].n,
    foreignReviews: (await outcome("select count(*)::int n from public.review_confirmations where user_id<>$1", [member])).rows[0].n,
    insertTasmia: (await outcome("insert into public.tasmia_submissions(cycle_id,user_id,quarter_number,listener_name_snapshot) select id,$1,240,'x' from public.cycles limit 1", [member])).code,
    credentials: (await outcome("select 1 from migration_private.user_credentials limit 1")).code,
  };
  await as("authenticated", inactive);
  behavior.inactive_profiles = (await outcome("select count(*)::int n from public.profiles")).rows[0].n;
  await as("authenticated", admin);
  behavior.admin_tasmia = (await outcome("select count(*)::int n from public.tasmia_submissions")).rows[0].n;
  await db.query("reset role");
  // The owner may lack SET on the server role (PostgreSQL 16+ default); its grants are checked in the catalog above.
  if ((await one("select pg_has_role(current_user, 'mutqin_app_server', 'SET') as can")).can) {
    await as("mutqin_app_server");
    behavior.server = {
      profiles: (await outcome("select count(*)::int n from public.profiles")).rows[0]?.n,
      authUsers: (await outcome("select 1 from auth.users limit 1")).code,
      provenance: (await outcome("select 1 from migration_private.source_documents limit 1")).code,
      deleteProfileDirect: (await outcome("delete from public.profiles where id=$1", [member])).code,
    };
  } else {
    behavior.server = "skipped: owner cannot SET ROLE mutqin_app_server (see catalog privileges)";
  }
  out.behavior = behavior;
} finally {
  await db.query("rollback").catch(() => {});
  await db.end();
}
console.log(JSON.stringify(out, null, 1));
