import fs from "node:fs";
import { catalog, normalize } from "./catalog.mjs";

const expected = JSON.parse(fs.readFileSync(new URL("proposed-schema-catalog.json", import.meta.url), "utf8"));
const baseline = JSON.parse(fs.readFileSync(new URL("reference/men-approved-rls-helper.json", import.meta.url), "utf8"));
const functionFields = ["schema", "proname", "arguments", "definition", "provolatile", "prosecdef", "proisstrict", "proleakproof", "proparallel", "proconfig", "result"];
const categories = {
  tables: ["schemaname", "tablename", "rowsecurity"],
  columns: ["table_schema", "table_name", "column_name", "ordinal_position", "data_type", "udt_schema", "udt_name", "is_nullable", "column_default", "is_identity", "is_generated", "collation_name"],
  constraints: ["schema", "table_name", "conname", "contype", "definition", "convalidated", "condeferrable", "condeferred"],
  indexes: ["schemaname", "tablename", "indexname", "indexdef"],
  triggers: ["schema", "table_name", "tgname", "tgenabled", "definition"],
  views: ["schemaname", "viewname", "definition", "reloptions"],
  policies: ["schemaname", "tablename", "policyname", "permissive", "roles", "cmd", "qual", "with_check"],
};
const sqlFields = new Set(["definition", "indexdef", "column_default", "qual", "with_check"]);
function serialize(row, fields) {
  return JSON.stringify(fields.map(k => typeof row[k] === "string" && sqlFields.has(k) ? normalize(row[k]) : row[k]));
}
export async function validateSchema(db) {
  const actual = await catalog(db);
  const differences = [];
  for (const [category, fields] of Object.entries(categories)) {
    const want = new Set(expected[category].map(r => serialize(r, fields)));
    const got = new Set(actual[category].map(r => serialize(r, fields)));
    for (const row of want) if (!got.has(row)) differences.push({ category, missingOrChanged: JSON.parse(row) });
    for (const row of got) if (!want.has(row)) differences.push({ category, unexpectedOrChanged: JSON.parse(row) });
  }
  // Platform extensions may provide other functions/events. Require every approved one exactly.
  for (const category of ["functions", "event_triggers"]) {
    const fields = category === "functions"
      ? ["schema", "proname", "arguments", "definition", "provolatile", "prosecdef", "proisstrict", "proleakproof", "proparallel", "proconfig", "result"]
      : ["evtname", "evtevent", "evtenabled", "evttags", "function"];
    const got = new Set(actual[category].map(r => serialize(r, fields)));
    for (const r of expected[category]) if (!got.has(serialize(r, fields))) differences.push({category, missingOrChanged: JSON.parse(serialize(r, fields))});
  }
  const access = await db.query(`select n.nspname as schema,c.relname,r.rolname,p.privilege
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    cross join pg_roles r cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(privilege)
    where n.nspname in ('public','migration_private') and c.relkind in ('r','p','v','m')
    and r.rolname in ('anon','authenticated','service_role') and has_table_privilege(r.oid,c.oid,p.privilege)`);
  for (const r of access.rows) differences.push({category: "effectiveClientPrivilege", ...r});
  const publicAccess = await db.query(`select n.nspname as schema,c.relname,a.privilege_type from pg_class c
    join pg_namespace n on n.oid=c.relnamespace cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    where n.nspname in ('public','migration_private') and c.relkind in ('r','p','v','m') and a.grantee=0`);
  for (const r of publicAccess.rows) differences.push({category: "publicPrivilege", ...r});
  const functionAccess = await db.query(`select p.proname,r.rolname from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join pg_roles r
    where n.nspname='public' and p.proname in ('rls_auto_enable','sync_deactivated_at')
    and r.rolname in ('anon','authenticated','service_role') and has_function_privilege(r.oid,p.oid,'EXECUTE')`);
  for (const r of functionAccess.rows) differences.push({category: "helperExecutePrivilege", ...r});
  const publicFunctions = await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where n.nspname='public' and p.proname in ('rls_auto_enable','sync_deactivated_at') and a.grantee=0`);
  for (const r of publicFunctions.rows) differences.push({category: "publicHelperPrivilege", ...r});
  if (differences.length) {
    const error = Error("Approved schema or owner-only access validation failed");
    error.code = "SCHEMA_VALIDATION_FAILED";
    error.differences = differences;
    throw error;
  }
  return { passed: true, categories: Object.fromEntries(Object.keys(categories).map(k => [k, actual[k].length])), ownerOnly: true };
}

export async function inspectEmptyDestination(db) {
  const state = await catalog(db);
  const conflicts = Object.fromEntries(["tables", "views", "functions", "types", "policies"].map(k => [k, state[k]]).filter(([,v]) => v.length));
  if (conflicts.functions) {
    conflicts.functions = conflicts.functions.filter(r => serialize(r,functionFields) !== serialize(baseline.function,functionFields));
    if (!conflicts.functions.length) delete conflicts.functions;
  }
  const eventFields = ["evtname", "evtevent", "evtenabled", "evttags", "function"];
  const eventConflicts = state.event_triggers.filter(r => r.evtname === 'ensure_rls' && serialize(r,eventFields) !== serialize(baseline.event,eventFields));
  if (eventConflicts.length) conflicts.event_triggers = eventConflicts;
  return { compatible: !Object.keys(conflicts).length, conflicts, catalog: state };
}
