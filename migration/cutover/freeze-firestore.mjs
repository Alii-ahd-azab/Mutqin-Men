// Phase J: freeze (or roll back) Firestore writes for the Men Firebase project via security rules.
// Changes rules only — never documents. Saves the live ruleset before replacing it.
//
//   node migration/cutover/freeze-firestore.mjs freeze     # deploys firestore.readonly.rules
//   node migration/cutover/freeze-firestore.mjs restore    # redeploys the saved pre-freeze ruleset
//   node migration/cutover/freeze-firestore.mjs status     # prints whether the live rules are the freeze rules
// Uses GOOGLE_APPLICATION_CREDENTIALS (service-account file outside the repository).
import fs from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getSecurityRules } from "firebase-admin/security-rules";

const PROJECT = "mutqin-7f0bb";
const mode = process.argv[2];
if (!["freeze", "restore", "status"].includes(mode)) throw Error("Usage: freeze-firestore.mjs freeze|restore|status");
const backupFile = "migration/private/firestore-rules-before-freeze.json";
const freezeSource = fs.readFileSync(new URL("firestore.readonly.rules", import.meta.url), "utf8");

const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!keyFile) throw Error("Set GOOGLE_APPLICATION_CREDENTIALS to the service-account file.");
let credential;
try {
  credential = JSON.parse(fs.readFileSync(keyFile, "utf8"));
} catch {
  throw Error("Cannot read/parse credential file; contents suppressed.");
}
if (credential.project_id !== PROJECT) throw Error("Credential does not belong to the Men Firebase project.");
const rules = getSecurityRules(initializeApp({ credential: cert(credential), projectId: PROJECT }));
const live = await rules.getFirestoreRuleset();
const liveSource = live.source[0].content;
const isFrozen = liveSource.trim() === freezeSource.trim();

if (mode === "status") {
  console.log(JSON.stringify({ project: PROJECT, frozen: isFrozen, liveRuleset: live.name, createTime: live.createTime }));
} else if (mode === "freeze") {
  if (isFrozen) {
    console.log(JSON.stringify({ project: PROJECT, frozen: true, note: "already frozen" }));
  } else {
    if (fs.existsSync(backupFile)) throw Error(`${backupFile} exists; refusing to overwrite the saved pre-freeze rules.`);
    fs.mkdirSync("migration/private", { recursive: true });
    fs.writeFileSync(backupFile, JSON.stringify({ name: live.name, createTime: live.createTime, source: liveSource }, null, 2));
    const released = await rules.releaseFirestoreRulesetFromSource(freezeSource);
    const now = await rules.getFirestoreRuleset();
    console.log(JSON.stringify({
      project: PROJECT,
      previousRulesetSaved: backupFile,
      released: released.name,
      frozen: now.source[0].content.trim() === freezeSource.trim(),
    }));
  }
} else {
  const saved = JSON.parse(fs.readFileSync(backupFile, "utf8"));
  const released = await rules.releaseFirestoreRulesetFromSource(saved.source);
  console.log(JSON.stringify({ project: PROJECT, restored: released.name }));
}
