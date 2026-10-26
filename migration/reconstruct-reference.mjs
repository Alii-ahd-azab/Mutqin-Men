import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const db = new PGlite();
const dir = new URL("reference/", import.meta.url);
try {
  await db.exec(
    "create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql as $$select null::uuid$$;",
  );
  const base = fs.readFileSync(
    new URL("sisters-public-schema.sql", dir),
    "utf8",
  );
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
    )[0];
  sql += "\n" + base.match(/^CREATE TRIGGER .*;/m)[0];
  await db.exec(sql);
  for (const file of fs
    .readdirSync(dir)
    .filter((x) => /^2026.*\.sql$/.test(x))
    .sort())
    await db.exec(fs.readFileSync(new URL(file, dir), "utf8"));
  const query = fs.readFileSync(
    new URL("inspect-reference.sql", import.meta.url),
    "utf8",
  );
  const result = (await db.query(query)).rows[0].schema_catalog;
  fs.writeFileSync(
    new URL("reference/reconstructed-catalog.json", import.meta.url),
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify({
      reconstructed: true,
      tables: [
        ...new Set(
          result.columns
            .filter((x) => x.table_schema === "public")
            .map((x) => x.table_name),
        ),
      ],
      functions: result.functions.length,
      policies: result.policies.length,
      triggers: result.triggers.length,
      views: result.views.length,
      enums: result.enums.length,
    }),
  );
} catch (e) {
  console.error(JSON.stringify({ code: e.code, message: e.message }));
  process.exitCode = 1;
} finally {
  await db.close();
}
