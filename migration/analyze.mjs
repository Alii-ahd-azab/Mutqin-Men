import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
export function readBackup(dir) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json")));
  const raw = fs.readFileSync(path.join(dir, "firestore.ndjson"));
  if (
    !m.complete ||
    crypto.createHash("sha256").update(raw).digest("hex") !== m.sha256
  )
    throw Error("Incomplete or corrupt backup");
  return {
    manifest: m,
    docs: raw.toString().trim().split("\n").filter(Boolean).map(JSON.parse),
  };
}
export function decode(x) {
  switch (x.t) {
    case "null":
      return null;
    case "map":
      return Object.fromEntries(
        Object.entries(x.v).map(([k, v]) => [k, decode(v)]),
      );
    case "array":
      return x.v.map(decode);
    case "integer": {
      const n = Number(x.v);
      if (!Number.isSafeInteger(n)) throw Error("Unsafe integer");
      return n;
    }
    case "double":
      return Number(x.v);
    case "timestamp":
      return new Date(Number(x.seconds) * 1000)
        .toISOString()
        .replace(".000Z", "." + String(x.nanoseconds).padStart(9, "0") + "Z");
    case "string":
    case "boolean":
      return x.v;
    default:
      throw Error("Unmapped Firestore type: " + x.t);
  }
}
if (process.argv[1]?.endsWith("analyze.mjs")) {
  const dir = process.argv[2];
  const { manifest, docs } = readBackup(dir);
  const inventory = {
    collections: manifest.collections,
    missingParents: manifest.missingParents,
    schemas: {},
  };
  for (const d of docs) {
    const col = d.path.split("/").slice(0, -1).join("/");
    const s = (inventory.schemas[col] ??= { count: 0, fields: {}, shapes: {} });
    s.count++;
    const shape = Object.keys(d.data.v).sort().join(",");
    s.shapes[shape] = (s.shapes[shape] || 0) + 1;
    function walk(x, p) {
      const f = (s.fields[p] ??= { present: 0, types: {} });
      f.present++;
      f.types[x.t] = (f.types[x.t] || 0) + 1;
      if (x.t === "map")
        for (const [k, v] of Object.entries(x.v)) walk(v, p ? `${p}.${k}` : k);
      if (x.t === "array") for (const v of x.v) walk(v, p + "[]");
    }
    for (const [k, v] of Object.entries(d.data.v)) walk(v, k);
  }
  fs.writeFileSync(
    path.join(dir, "inventory.json"),
    JSON.stringify(inventory, null, 2),
  );
  console.log(JSON.stringify(inventory, null, 2));
}
