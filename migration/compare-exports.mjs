import fs from "node:fs";
import { readBackup } from "./analyze.mjs";
const [a, b] = process.argv.slice(2);
if (!a || !b)
  throw Error("Usage: node migration/compare-exports.mjs OLD_DIR NEW_DIR");
const first = readBackup(a),
  second = readBackup(b);
if (
  first.manifest.project !== second.manifest.project ||
  first.manifest.database !== second.manifest.database
)
  throw Error("Different Firestore source");
const old = new Map(first.docs.map((d) => [d.path, JSON.stringify(d)])),
  current = new Map(second.docs.map((d) => [d.path, JSON.stringify(d)]));
const result = {
  added: [...current.keys()].filter((k) => !old.has(k)),
  removed: [...old.keys()].filter((k) => !current.has(k)),
  changed: [...current.keys()].filter(
    (k) => old.has(k) && old.get(k) !== current.get(k),
  ),
  collectionsMatch:
    JSON.stringify(
      first.manifest.collections
        .slice()
        .sort((a, b) => a.path.localeCompare(b.path)),
    ) ===
    JSON.stringify(
      second.manifest.collections
        .slice()
        .sort((a, b) => a.path.localeCompare(b.path)),
    ),
};
fs.writeFileSync(b + "/source-drift.json", JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({
    added: result.added.length,
    removed: result.removed.length,
    changed: result.changed.length,
    collectionsMatch: result.collectionsMatch,
  }),
);
if (
  result.added.length ||
  result.removed.length ||
  result.changed.length ||
  !result.collectionsMatch
)
  process.exitCode = 1;
