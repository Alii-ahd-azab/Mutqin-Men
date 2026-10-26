import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { catalog as inspectCatalog } from "./catalog.mjs";
import { validateSourceRoundtrip } from "./roundtrip.mjs";
import { transform } from "./transform.mjs";
import { applySchema, load, validate } from "./database.mjs";
const dir = process.argv[2];
if (!dir) throw Error("Usage: node migration/rehearse.mjs BACKUP_DIR");
const { rows, warnings } = transform(dir);
const db = new PGlite();
try {
  await applySchema(db);
  const first = await load(db, rows);
  await load(db, rows);
  const final = await validate(db, rows);
  const catalog = await inspectCatalog(db);
  const roundtrip = await validateSourceRoundtrip(db, dir);
  fs.writeFileSync(
    new URL("proposed-schema-catalog.json", import.meta.url),
    JSON.stringify(catalog, null, 2),
  );
  fs.writeFileSync(
    dir + "/rehearsal-report.json",
    JSON.stringify(
      {
        engine: "PGlite PostgreSQL WASM; no remote connection",
        first,
        roundtrip,
        rerun: final,
        warnings,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      {
        passed: true,
        roundtrip,
        counts: Object.fromEntries(
          Object.entries(rows).map(([t, r]) => [t, r.length]),
        ),
        rerun: "identical",
      },
      null,
      2,
    ),
  );
} catch (e) {
  console.error(
    JSON.stringify({
      failed: true,
      code: e.code,
      table: e.table,
      constraint: e.constraint,
      message: e.message,
    }),
  );
  process.exitCode = 1;
} finally {
  await db.close();
}
