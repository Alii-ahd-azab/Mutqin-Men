// Phase C: create one Supabase Auth identity per migrated profile, keeping the existing password.
//
//   legacy Firestore user (users/<id>) → profiles.id = uuid('users/<id>') (Phase 1, unchanged)
//                                      → auth.users.id = profiles.id
//                                      → email = <phone without spaces>@members.mutqin.local (Sisters convention)
//                                      → encrypted_password = existing bcrypt hash (no reset, no plain text)
//
// Usage (MEN_MIGRATION_DATABASE_URL, SUPABASE_URL, SUPABASE_SECRET_KEY in the environment):
//   node migration/cutover/link-auth.mjs plan   --project uaublandjewfzmhnbflc   # read-only
//   node migration/cutover/link-auth.mjs apply  --project uaublandjewfzmhnbflc   # needs MEN_CUTOVER_APPROVED_PROJECT
//   node migration/cutover/link-auth.mjs verify --project uaublandjewfzmhnbflc   # read-only
// Idempotent: existing identities with the expected id/email are skipped; any mismatch stops the run.
import fs from "node:fs";
import { phoneToAuthEmail } from "../../supabase/functions/_shared/men/authIdentity.ts";
import { authAdmin, connectOwner, requireApproval, requireProjectArg } from "./production.mjs";

const args = process.argv.slice(2);
const mode = args[0];
if (!["plan", "apply", "verify"].includes(mode)) throw Error("Usage: link-auth.mjs plan|apply|verify --project REF");
const project = requireProjectArg(args);
if (mode === "apply") requireApproval(project);

const BCRYPT = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

async function readState(db) {
  const { rows } = await db.query(`
    select p.id, p.firestore_id, p.phone, p.full_name, p.role, p.active,
           c.password_hash,
           u.id is not null as has_auth, u.email as auth_email,
           u.encrypted_password = c.password_hash as hash_matches
    from public.profiles p
    left join migration_private.user_credentials c on c.profile_id = p.id
    left join auth.users u on u.id = p.id
    order by p.created_at, p.id`);
  const emails = new Map();
  const problems = [];
  for (const r of rows) {
    r.email = phoneToAuthEmail(r.phone);
    if (emails.has(r.email)) problems.push({ profile: r.id, problem: "duplicate login identity after phone normalization" });
    emails.set(r.email, r.id);
    if (!r.password_hash) problems.push({ profile: r.id, problem: "no preserved credential" });
    else if (!BCRYPT.test(r.password_hash)) problems.push({ profile: r.id, problem: "credential is not a bcrypt hash" });
    if (r.has_auth && r.auth_email !== r.email) problems.push({ profile: r.id, problem: "existing auth identity has a different email" });
  }
  const { rows: clash } = await db.query(
    "select u.id, u.email from auth.users u where u.email = any($1::text[]) and not exists (select 1 from public.profiles p where p.id = u.id)",
    [[...emails.keys()]],
  );
  for (const c of clash) problems.push({ auth_user: c.id, problem: "email already used by an unrelated auth user" });
  return { rows, problems };
}

function summary(rows, problems) {
  return {
    project,
    profiles: rows.length,
    linked: rows.filter((r) => r.has_auth).length,
    hashPreserved: rows.filter((r) => r.hash_matches).length,
    admins: rows.filter((r) => r.role === "admin").length,
    inactive: rows.filter((r) => !r.active).length,
    problems,
  };
}

const db = await connectOwner(project);
try {
  let { rows, problems } = await readState(db);
  fs.mkdirSync("migration/private", { recursive: true });
  fs.writeFileSync(
    `migration/private/auth-link-${mode}.json`,
    JSON.stringify(
      rows.map((r) => ({ legacy_user: r.firestore_id, profile_id: r.id, auth_user_id: r.id, email: r.email, role: r.role, active: r.active, linked: r.has_auth })),
      null,
      2,
    ),
  );
  if (problems.length) {
    console.error(JSON.stringify(summary(rows, problems), null, 2));
    throw Error("Resolve the listed problems before linking. No Auth users were created.");
  }
  if (mode === "apply") {
    const admin = authAdmin(project);
    for (const r of rows.filter((x) => !x.has_auth)) {
      const { error } = await admin.auth.admin.createUser({
        id: r.id,
        email: r.email,
        password_hash: r.password_hash,
        email_confirm: true,
        user_metadata: { full_name: r.full_name },
      });
      if (error) throw Error(`createUser failed for profile ${r.id}: ${error.message}`);
    }
    ({ rows, problems } = await readState(db));
  }
  const result = summary(rows, problems);
  console.log(JSON.stringify(result, null, 2));
  if (mode !== "plan" && (result.linked !== result.profiles || result.hashPreserved !== result.profiles))
    throw Error("Verification failed: every profile must have an auth identity with its preserved hash.");
  if (mode !== "plan")
    console.log("All profiles linked. Next: apply supabase/migrations/20261026000200_men_auth_link.sql");
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
