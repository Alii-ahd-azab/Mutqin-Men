import { validateSourceRoundtrip } from "./roundtrip.mjs";
import fs from "node:fs";
import pg from "pg";
import { transform } from "./transform.mjs";
import { applySchema, load, validate } from "./database.mjs";
import { inspectEmptyDestination, validateSchema } from "./validate-schema.mjs";
const args = process.argv.slice(2),
  mode = args[0],
  backup = args[1];
if (!["import", "validate", "preflight"].includes(mode) || (mode !== "preflight" && !backup))
  throw Error(
    "Usage: node migration/target.mjs import|validate BACKUP_DIR [--apply-schema] --project REF; or preflight --project REF",
  );
const url = process.env.MEN_MIGRATION_DATABASE_URL;
if (!url)
  throw Error(
    "MEN_MIGRATION_DATABASE_URL is required; never pass credentials on command line.",
  );
let parsed;
try {
  parsed = new URL(url);
} catch {
  throw Error("Invalid database URL; value suppressed.");
}
const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
const projectArg = args.indexOf("--project"),
  project = projectArg >= 0 ? args[projectArg + 1] : null;
const sisters = "cuexuketulmyskmdvosp";
if (url.includes(sisters)) throw Error("Sisters destination is forbidden.");
if (!local) {
  if (project !== "uaublandjewfzmhnbflc")
    throw Error("Explicit approved Men project reference required.");
  if (
    parsed.hostname !== `db.${project}.supabase.co` &&
    !(
      parsed.hostname.endsWith(".pooler.supabase.com") &&
      decodeURIComponent(parsed.username) === `postgres.${project}`
    )
  )
    throw Error("Destination identity does not match approved project.");
  if (
    mode === "import" &&
    process.env.MEN_MIGRATION_APPROVED_PROJECT !== project
  )
    throw Error(
      "After human review approval, set MEN_MIGRATION_APPROVED_PROJECT to the exact destination reference.",
    );
}
for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
  parsed.searchParams.delete(key);
const rows = mode === "preflight" ? null : transform(backup).rows;
const client = new pg.Client({
  connectionString: parsed.toString(),
  ssl: local ? false : { rejectUnauthorized: true },
  application_name: "mutqin_men_phase1_migration",
  connectionTimeoutMillis: 15000,
});
const db = {
  query: (q, p) => client.query(q, p),
  exec: (q) => client.query(q),
};
try {
  await client.connect();
  if (mode === "preflight") {
    await db.exec("begin transaction isolation level repeatable read read only");
    const inspection = await inspectEmptyDestination(db);
    const identity = (await db.query("select current_database() as database, current_user as role")).rows[0];
    await db.exec("commit");
    fs.mkdirSync(new URL("private/", import.meta.url), { recursive: true });
    fs.writeFileSync(new URL("private/destination-preflight.json", import.meta.url), JSON.stringify({project, identity, ...inspection}, null, 2));
    console.log(JSON.stringify({project, compatible: inspection.compatible, conflictCategories: Object.keys(inspection.conflicts)}));
    if (!inspection.compatible) process.exitCode = 1;
  } else if (mode === "validate") {
    await db.exec(
      "begin transaction isolation level repeatable read read only",
    );
    const result = await validate(db, rows);
    result.sourceRoundtrip = await validateSourceRoundtrip(db, backup);
    await db.exec("commit");
    fs.writeFileSync(
      backup + "/target-validation.json",
      JSON.stringify(result, null, 2),
    );
    console.log("Read-only target validation passed.");
  } else {
    await db.query("select pg_advisory_lock(hashtext('mutqin-men-phase1'))");
    if (args.includes("--apply-schema")) {
      await db.exec("begin");
      try {
        const inspection = await inspectEmptyDestination(db);
        if (!inspection.compatible) {
          const error = Error("Unexpected existing destination schema; no schema applied");
          error.code = "DESTINATION_SCHEMA_CONFLICT";
          throw error;
        }
        await applySchema(db);
        await validateSchema(db);
        await db.exec("commit");
      } catch (e) {
        await db.exec("rollback");
        throw e;
      }
    }
    const result = await load(db, rows, backup);
    fs.writeFileSync(
      backup + "/target-import-validation.json",
      JSON.stringify(result, null, 2),
    );
    console.log("Import committed; every expected row validated.");
  }
} catch (e) {
  if (e.differences && mode !== "preflight") fs.writeFileSync(backup + "/schema-validation-failure.json", JSON.stringify(e.differences, null, 2));
  console.error(
    JSON.stringify({
      failed: true,
      code: e.code || "MIGRATION_ERROR",
      table: e.table || null,
      constraint: e.constraint || null,
      hint: "No row values logged. Import transaction rolls back on failure. Schema may remain if separately applied.",
    }),
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
