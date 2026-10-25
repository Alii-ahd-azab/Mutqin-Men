import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { parseDump, isApp, sha } from "./dump-utils.mjs";
import { catalog, normalize } from "./catalog.mjs";
const source = process.argv[2];
if (!source) throw Error("Supply schema-only dump path");
const raw = fs.readFileSync(source, "utf8"),
  objects = parseDump(raw);
fs.writeFileSync(
  new URL("reference/sisters-live-schema.sql", import.meta.url),
  raw,
);
const inventory = objects.map(({ sql, ...o }) => ({
  ...o,
  sha256: sha(sql),
  application: isApp({ ...o, sql }),
}));
fs.writeFileSync(
  new URL("reference/live-dump-inventory.json", import.meta.url),
  JSON.stringify(
    {
      source,
      sha256: sha(raw),
      bytes: Buffer.byteLength(raw),
      grantStatements: objects.filter((o) => /ACL/.test(o.type)).length,
      objects: inventory,
    },
    null,
    2,
  ),
);
const old = new PGlite(),
  live = new PGlite();
const read = (f) =>
  fs.readFileSync(new URL("reference/" + f, import.meta.url), "utf8");
try {
  const bootstrap =
    "create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql as $$select null::uuid$$;";
  await old.exec(bootstrap);
  await live.exec(bootstrap + "set check_function_bodies=false;");
  const base = read("sisters-public-schema.sql");
  let sql = [
    ...base.matchAll(/^CREATE TABLE public\.[\s\S]*?^\);/gm),
    ...base.matchAll(/^ALTER TABLE ONLY public\.[\s\S]*?;/gm),
    ...base.matchAll(/^CREATE INDEX .*;/gm),
  ]
    .map((x) => x[0])
    .join("\n");
  sql +=
    "\n" +
    base.match(
      /^CREATE FUNCTION public.sync_deactivated_at\(\)[\s\S]*?^\$\$;/m,
    )[0] +
    "\n" +
    base.match(/^CREATE TRIGGER .*;/m)[0];
  await old.exec(sql);
  for (const file of fs
    .readdirSync(new URL("reference/", import.meta.url))
    .filter((x) => /^2026.*\.sql$/.test(x))
    .sort())
    await old.exec(read(file));
  for (const o of objects.filter(isApp)) {
    if (o.type === "SCHEMA" && o.name === "public") continue;
    try {
      await live.exec(o.sql);
    } catch (e) {
      throw Error(
        `Live object ${o.type} ${o.schema}.${o.name}: ${e.code} ${e.message}`,
      );
    }
  }
  const a = await catalog(old),
    b = await catalog(live);
  fs.writeFileSync(
    new URL("reference/previous-reconstruction-catalog.json", import.meta.url),
    JSON.stringify(a, null, 2),
  );
  b.evidence = {sourceSha256:sha(raw), sourceType:"user-supplied live schema-only dump", grants:"Unavailable in dump; proacl, relacl and grants below describe local restore defaults only", authDependency:"Local empty auth.users and null auth.uid stub, never deployed"};
  fs.writeFileSync(
    new URL("reference/live-catalog.json", import.meta.url),
    JSON.stringify(b, null, 2),
  );
  const key = {
    schemas: (r) => r.nspname,
    tables: (r) => r.schemaname + "." + r.tablename,
    columns: (r) => r.table_schema + "." + r.table_name + "." + r.column_name,
    constraints: (r) => r.schema + "." + r.table_name + "." + r.conname,
    indexes: (r) => r.schemaname + "." + r.indexname,
    functions: (r) => r.schema + "." + r.proname + "(" + r.arguments + ")",
    triggers: (r) => r.schema + "." + r.table_name + "." + r.tgname,
    event_triggers: (r) => r.evtname,
    policies: (r) => r.schemaname + "." + r.tablename + "." + r.policyname,
    views: (r) => r.schemaname + "." + r.viewname,
    types: (r) => r.schema + "." + r.typname,
    enums: (r) => r.schema + "." + r.typname + "." + r.enumlabel,
    access: (r) => r.schema + "." + r.relname,
  };
  const diff = {
    grantComparison:
      "Unknown: live dump contains no ACL/GRANT/REVOKE/default privilege objects; do not treat restore defaults as live grants.",
    categories: {},
  };
  for (const [category, k] of Object.entries(key)) {
    const am = new Map(a[category].map((r) => [k(r), r])),
      bm = new Map(b[category].map((r) => [k(r), r]));
    const added = [...bm.keys()].filter((k) => !am.has(k)),
      removed = [...am.keys()].filter((k) => !bm.has(k)),
      changed = [],
      textOnly = [];
    for (const [id, bv] of bm) {
      if (!am.has(id)) continue;
      const av = am.get(id);
      const fields = Object.keys(bv).filter(
        (f) =>
          !["proacl", "relacl"].includes(f) &&
          JSON.stringify(av[f]) !== JSON.stringify(bv[f]),
      );
      if (!fields.length) continue;
      const semantic = fields.filter(
        (f) =>
          !["definition", "prosrc", "indexdef", "qual", "with_check"].includes(
            f,
          ) || normalize(av[f] || "") !== normalize(bv[f] || ""),
      );
      (semantic.length ? changed : textOnly).push({
        id,
        fields,
        semanticFields: semantic,
        before: Object.fromEntries(fields.map((f) => [f, av[f]])),
        after: Object.fromEntries(fields.map((f) => [f, bv[f]])),
      });
    }
    diff.categories[category] = { added, removed, changed, textOnly };
  }
  const rangeChange = diff.categories.constraints.changed.find(
    (x) => x.id === "public.peer_tests.peer_tests_range_check",
  );
  if (
    rangeChange &&
    normalize(rangeChange.before.definition).replace(/[()\s]/g, "") ===
      normalize(rangeChange.after.definition).replace(/[()\s]/g, "")
  ) {
    rangeChange.behaviorEquivalent = true;
    rangeChange.reason =
      "Only grouping of associative AND predicates differs; same range predicates and SQL NULL behavior.";
  }
  fs.writeFileSync(
    new URL("reference/live-comparison.json", import.meta.url),
    JSON.stringify(diff, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        objectCounts: objects.reduce(
          (a, o) => ((a[o.type] = (a[o.type] || 0) + 1), a),
          {},
        ),
        comparison: Object.fromEntries(
          Object.entries(diff.categories).map(([k, v]) => [
            k,
            {
              added: v.added,
              removed: v.removed,
              changed: v.changed.map((x) => ({
                id: x.id,
                fields: x.semanticFields,
              })),
              textOnly: v.textOnly.map((x) => x.id),
            },
          ]),
        ),
      },
      null,
      2,
    ),
  );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await old.close();
  await live.close();
}
