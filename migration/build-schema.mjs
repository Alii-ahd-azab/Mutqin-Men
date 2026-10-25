import fs from "node:fs";
import { parseDump, sha } from "./dump-utils.mjs";
const source = fs.readFileSync(
  new URL("reference/sisters-live-schema.sql", import.meta.url),
  "utf8",
);
const objects = parseDump(source);
const baseline = JSON.parse(fs.readFileSync(new URL("reference/men-approved-rls-helper.json", import.meta.url), "utf8"));
const literal = s => "'" + s.replaceAll("'", "''") + "'";
const take = (type, predicate = () => true) =>
  objects
    .filter((o) => o.type === type && o.schema === "public" && predicate(o))
    .map((o) => o.sql)
    .join("\n\n");
let sql = `-- Authoritative foundation: Sisters live schema-only dump, PostgreSQL 17.6.\n-- Source SHA-256: ${sha(source)}\n-- Phase 1: fresh destination only; Auth/runtime access deferred explicitly.\nDO $$ begin if exists(select 1 from pg_tables where schemaname='public') then raise exception 'Target public schema must be empty'; end if; end $$;\n`;
sql +=
  take("TABLE") +
  "\n" +
  take("CONSTRAINT") +
  "\n" +
  take("FK CONSTRAINT", (o) => !o.sql.includes("REFERENCES auth.users")) +
  "\n" +
  take("CHECK CONSTRAINT") +
  "\n" +
  take("INDEX");
sql +=
  "\n" +
  take("FUNCTION", (o) =>
    ["sync_deactivated_at()"].includes(o.name),
  );
sql += `\nDO $install$ BEGIN
IF to_regprocedure('public.rls_auto_enable()') IS NULL THEN
 EXECUTE ${literal(baseline.function.definition.replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION'))};
ELSIF (SELECT prosrc FROM pg_proc WHERE oid='public.rls_auto_enable()'::regprocedure) IS DISTINCT FROM ${literal(baseline.function.prosrc)} THEN
 RAISE EXCEPTION 'Unapproved existing RLS helper';
END IF;
END $install$;\n`;
sql +=
  "\n" + take("TRIGGER", (o) => o.name.endsWith("trg_sync_deactivated_at"));
sql += "\n" + take("VIEW");
sql +=
  "\n" +
  objects
    .filter((o) => o.type === "EVENT TRIGGER" && o.name === "ensure_rls")
    .map((o) => `DO $install$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtname='ensure_rls') THEN EXECUTE ${literal(o.sql)}; END IF; END $install$;`)
    .join("\n");
sql += `\nDO $$ declare r record; role_name text; begin
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
`;
fs.writeFileSync(
  new URL(
    "../supabase/migrations/20261025000100_sisters_foundation.sql",
    import.meta.url,
  ),
  sql.trim() + "\n",
);
