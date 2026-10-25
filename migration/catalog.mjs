export async function catalog(db) {
  const queries = {
    schemas:
      "select nspname from pg_namespace where nspname in ('public','private','app_private','migration_private') order by 1",
    tables:
      "select schemaname,tablename,rowsecurity from pg_tables where schemaname in ('public','private','app_private','migration_private') order by 1,2",
    columns:
      "select table_schema,table_name,column_name,ordinal_position,data_type,udt_schema,udt_name,is_nullable,column_default,is_identity,is_generated,collation_name from information_schema.columns where table_schema in ('public','private','app_private','migration_private') order by 1,2,ordinal_position",
    constraints:
      "select n.nspname as schema,t.relname as table_name,c.conname,c.contype,pg_get_constraintdef(c.oid) as definition,c.convalidated,c.condeferrable,c.condeferred from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace where n.nspname in ('public','private','app_private','migration_private') order by 1,2,3",
    indexes:
      "select schemaname,tablename,indexname,indexdef from pg_indexes where schemaname in ('public','private','app_private','migration_private') order by 1,2,3",
    functions:
      "select n.nspname as schema,p.proname,pg_get_function_identity_arguments(p.oid) as arguments,pg_get_functiondef(p.oid) as definition,p.prosrc,p.provolatile,p.prosecdef,p.proisstrict,p.proleakproof,p.proparallel,p.proconfig,pg_get_function_result(p.oid) as result,p.proacl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private','app_private','migration_private') and p.prokind='f' order by 1,2,3",
    triggers:
      "select n.nspname as schema,c.relname as table_name,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) as definition from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','app_private','migration_private') and not t.tgisinternal order by 1,2,3",
    event_triggers:
      "select evtname,evtevent,evtenabled,evttags,evtfoid::regprocedure::text as function from pg_event_trigger order by 1",
    policies:
      "select * from pg_policies where schemaname in ('public','private','app_private','migration_private') order by schemaname,tablename,policyname",
    views:
      "select v.schemaname,v.viewname,v.definition,c.reloptions from pg_views v join pg_namespace n on n.nspname=v.schemaname join pg_class c on c.relnamespace=n.oid and c.relname=v.viewname where v.schemaname in ('public','private','app_private','migration_private') order by 1,2",
    types:
      "select n.nspname as schema,t.typname,t.typtype,format_type(t.oid,null) as type from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname in ('public','private','app_private','migration_private') and t.typrelid=0 and t.typelem=0 order by 1,2",
    enums:
      "select n.nspname as schema,t.typname,e.enumlabel,e.enumsortorder from pg_type t join pg_namespace n on n.oid=t.typnamespace join pg_enum e on e.enumtypid=t.oid where n.nspname in ('public','private','app_private','migration_private') order by 1,2,4",
    access:
      "select n.nspname as schema,c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relacl from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','app_private','migration_private') and c.relkind in ('r','v','m','p') order by 1,2",
    grants:
      "select table_schema,table_name,grantee,privilege_type,is_grantable from information_schema.table_privileges where table_schema in ('public','private','app_private','migration_private') order by 1,2,3,4",
  };
  const out = {};
  for (const [k, q] of Object.entries(queries))
    out[k] = (await db.query(q)).rows;
  return out;
}
// Strip comments and normalize unquoted tokens, preserving literal and quoted-identifier content.
export function normalize(sql) {
  const tokens =
    sql.match(
      /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z_0-9$]*|\d+(?:\.\d+)?|[^\s]/g,
    ) || [];
  return tokens
    .filter((t) => !t.startsWith("--") && !t.startsWith("/*"))
    .map((t) => (t.startsWith("'") || t.startsWith('"') ? t : t.toLowerCase()))
    .join(" ");
}
