import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { initializeApp, cert } from "firebase-admin/app";
import {
  getFirestore,
  Timestamp,
  GeoPoint,
  DocumentReference,
} from "firebase-admin/firestore";
export function encode(v) {
  if (v === null) return { t: "null" };
  if (v instanceof Timestamp)
    return {
      t: "timestamp",
      seconds: String(v.seconds),
      nanoseconds: v.nanoseconds,
    };
  if (v instanceof DocumentReference)
    return {
      t: "reference",
      path: v.path,
      database: v.firestore.databaseId,
      project: v.firestore.projectId,
    };
  if (v instanceof GeoPoint)
    return { t: "geopoint", latitude: v.latitude, longitude: v.longitude };
  if (Buffer.isBuffer(v)) return { t: "bytes", v: v.toString("base64") };
  if (Array.isArray(v)) return { t: "array", v: v.map(encode) };
  if (typeof v === "bigint") return { t: "integer", v: String(v) };
  if (typeof v === "number")
    return { t: "double", v: Object.is(v, -0) ? "-0" : String(v) };
  if (typeof v === "object") {
    if (v.constructor.name === "VectorValue")
      return { t: "vector", v: v.toArray() };
    return {
      t: "map",
      v: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)])),
    };
  }
  return { t: typeof v, v };
}
const key = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!key)
  throw Error("Set GOOGLE_APPLICATION_CREDENTIALS to existing key file.");
const config = JSON.parse(
  fs.readFileSync(new URL("../firebase-applet-config.json", import.meta.url)),
);
let credential;
try {
  credential = JSON.parse(fs.readFileSync(key));
} catch {
  throw Error("Cannot read/parse credential file; contents suppressed.");
}
if (credential.project_id !== config.projectId)
  throw Error("Credential project mismatch");
let app;
try {
  app = initializeApp({
    credential: cert(credential),
    projectId: config.projectId,
  });
} catch {
  throw Error("Credential initialization failed; details suppressed.");
}
const db = getFirestore(app, config.firestoreDatabaseId || "(default)");
db.settings({ useBigInt: true });
const dir = path.resolve(
  process.argv[2] ||
    `migration/backups/${new Date().toISOString().replaceAll(":", "-")}`,
);
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, "firestore.ndjson");
const fd = fs.openSync(file, "wx");
const manifest = {
  format: 1,
  project: config.projectId,
  database: db.databaseId,
  startedAt: new Date().toISOString(),
  complete: false,
  collections: [],
  missingParents: [],
};
try {
  async function walk(col) {
    const refs = await col.listDocuments();
    let count = 0;
    for (let i = 0; i < refs.length; i += 100) {
      const batch = refs.slice(i, i + 100);
      const docs = await db.getAll(...batch);
      const subs = await Promise.all(docs.map((d) => d.ref.listCollections()));
      for (let j = 0; j < docs.length; j++) {
        const doc = docs[j];
        if (doc.exists) {
          fs.writeSync(
            fd,
            JSON.stringify({
              path: doc.ref.path,
              id: doc.id,
              createTime: encode(doc.createTime),
              updateTime: encode(doc.updateTime),
              data: encode(doc.data()),
            }) + "\n",
          );
          count++;
        } else manifest.missingParents.push(doc.ref.path);
        for (const sub of subs[j]) await walk(sub);
      }
    }
    manifest.collections.push({ path: col.path, count });
    console.log(JSON.stringify({ collection: col.path, count }));
  }
  for (const col of await db.listCollections()) await walk(col);
  manifest.complete = true;
} catch (e) {
  manifest.errorCode = String(e.code || "EXPORT_FAILED");
  process.exitCode = 1;
  console.error(
    "Export failed; see manifest errorCode. No Firebase writes performed.",
  );
} finally {
  fs.closeSync(fd);
  manifest.finishedAt = new Date().toISOString();
  manifest.sha256 = crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  await db.terminate();
}
console.log("Backup directory: " + dir);
