# Mutqin for Men — application cutover to Supabase

Branch `supabase-cutover` (from `main` at `0acad94`). Prepared 26 October 2026. Phase A details: [AUDIT.md](AUDIT.md).

## Status at a glance

| | |
|---|---|
| Code cutover (Phases A–G, K) | **Done and verified locally.** The application contains no Firebase runtime code. |
| Database access model and auth link (C, D) | **Written and tested locally, not applied to production.** |
| Final reconciliation (H) | **Delta measured against live Firebase (read-only): 7 new documents.** Production import is pending. |
| Production go-live (I, J) | **Not executed.** No Men Supabase credentials were available in this environment. |
| Does Mutqin for Men run on Supabase in production today? | **No.** Production still runs `main` on Firebase. The branch is ready to deploy using the runbook below. |

No production Supabase operation was run, nothing was written to Firebase, and nothing was written to Mutqin for Sisters (its repository was only read).

## 1. Files changed

| Area | Files |
|---|---|
| Server | `server.ts` (now wiring only), `src/server/app.ts` (all routes, new), `src/server/store.ts` (Supabase repository, new), `src/server/auth.ts` (Auth service, new), `src/server/config.ts` (env and project guards, new), `src/server/personalTests.ts` (async auth, UUID ids) |
| Browser | `src/lib/supabase.ts` (new), `src/lib/authIdentity.ts` (new, shared), `src/api/client.ts`, `src/context/AuthContext.tsx`, `src/main.tsx`, `src/types.ts` |
| Database | `supabase/migrations/20261026000100_men_app_access.sql`, `supabase/migrations/20261026000200_men_auth_link.sql` |
| Tooling | `migration/cutover/*` (audit, harness, RLS tests, link-auth, apply-migration, parity, reconcile, read-only rules), `migration/database.mjs` (Phase 1 `applySchema` pinned to Phase 1 files) |
| Tests | `tests/app.test.ts`, `tests/parity.test.ts`, `tests/reconcile.test.ts`, `tests/config.test.ts`, `tests/support.ts` |
| Config | `.env.example`, `.gitignore` (`data/`), `package.json`, `package-lock.json`, `certs/supabase-prod-ca-2021.crt` (public Supabase root CA) |
| Removed/archived | see sections 3 and 4 |

Commits, each one a reviewable step: `3cad82e` Phase 1 package · `51de925` audit · `76ad91c` dependencies · `9eb5edb` access model and RLS tests · `6d5f7b2` clients/config · `90b6544` data layer and auth · `4210e2b` reconciliation · `bf24cb3` Firebase retirement · `e6feca9` session-revocation hardening.

## 2. Dependencies

* Added: `@supabase/supabase-js` ^2.118, `pg` ^8.23; dev: `@types/pg`, `@electric-sql/pglite` 0.3.14 (local tests only).
* Removed: `firebase`, `firebase-admin` (application), `bcryptjs`, `@types/bcryptjs` (Supabase Auth now verifies passwords).
* `migration/package.json` keeps its own `firebase-admin` for read-only exports.
* Installed with npm (`package-lock.json`). **`bun.lock` was not updated** because bun isn't available here. Regenerate it, or delete it if npm is the real installer.

## 3. Firebase code removed

`src/server/firestoreService.ts` (server Firebase sign-in, all reads and writes, seed-if-empty, reset clears), `src/server/personalTestsFirestore.ts` (Firestore plus local JSON store), `src/lib/firebase.ts` (browser init and probe), `src/lib/suppressFirestoreWarnings.ts`, the startup Firestore probe/seed/sync, the in-memory cache and `data/database.json` fallback, `/api/firestore/status`, HMAC session tokens, and the session secret derived from Firebase config.

## 4. Firebase material intentionally retained

* `migration/` export, compare, transform and validation tooling, for reconciliation and rollback reference.
* `migration/archive/firebase/`: the original `firestore.rules`, the Firebase web config (its API key is public by design) and the AI Studio blueprint.
* `migration/cutover/firestore.readonly.rules`: rules for the go-live write freeze.
* `firestore_id` provenance columns and `migration_private.*` tables (owner-only).
* Firebase **Storage**: never used, so there is nothing to migrate.
* The Firebase project and all its data: untouched.

## 5. Supabase clients and configuration

| Where | Credential | Used for |
|---|---|---|
| Browser | `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY`, served by `/api/public-config` (or `VITE_*` at build time) | Sign-in, token refresh, sign-out only. No table queries. |
| Server | `SUPABASE_SECRET_KEY` (or legacy service_role) | Supabase Auth only: verify access tokens, create/update/delete users, check the current password |
| Server | `SUPABASE_DB_URL` as role `mutqin_app_server` (pooler, TLS verified against the bundled public CA) | All application data, in transactions |

At startup the server refuses to run if the URL, database host/user or project ref is not `uaublandjewfzmhnbflc`, rejects the Sisters ref `cuexuketulmyskmdvosp` anywhere, and rejects swapped keys. The secret key never reaches the browser (verified in the built bundle).

**Why the server uses a Postgres connection rather than PostgREST:** Men's write rules (sequential quarters, mandatory tests, eligibility, one active test) live in server code. They need the whole program state plus real transactions and row locks. A direct connection gives atomicity without rewriting that logic in SQL, and it let the real routes be tested against the real data locally. `mutqin_app_server` holds only explicit grants on application tables: no `BYPASSRLS`, and no access to Auth, Storage or provenance tables.

## 6. Authentication

* **Before:** application-managed phone + bcrypt (cost 10, 30/30 `$2b$`) hashes in Firestore `users.password_hash`, plus HMAC tokens valid for 90 days. Firebase Auth was only the server's own internal account.
* **After:** Supabase Auth, Sisters convention: email = `<phone without spaces>@members.mutqin.local`. The browser signs in with supabase-js. The server verifies every request's access token with Supabase Auth (`getUser`, cached for 30 s), so revoked sessions and deleted users are rejected.
* **Account conversion** (`migration/cutover/link-auth.mjs`), with no password resets:

  `legacy users/<id>` → `profiles.id = uuid('users/<id>')` (Phase 1, unchanged) → `auth.users.id = profiles.id`, existing bcrypt hash imported as-is through `admin.createUser({ id, password_hash })`, email confirmed.

  It is idempotent, refuses phone collisions, non-bcrypt hashes or foreign identities, and verifies that 30/30 hashes match afterwards. Only then can `20261026000200_men_auth_link.sql` add `profiles.id → auth.users(id)`, and that migration itself refuses to run while any profile is unlinked.
* Admins: `profiles.role='admin'` with `is_master_admin` (all four existing admins, as Phase 1 approved). Inactive members can still sign in and view, as before.
* Password change (self) and reset (admin) end that user's sessions, as fingerprint invalidation did before. Logout ends only the current device's session, as before.

## 7. RLS and access model

* **Browser roles** (publishable key, direct PostgREST): `anon` has nothing. `authenticated` gets **read-only** policies: the live Sisters policies, verbatim, built on the live Sisters `app_private` helpers. Men adds two rules: selected-audience tests are hidden from non-selected members, and personal tests are owner-only. Sisters' client insert policies were deliberately **not** installed, because they would let a member bypass Men's server rules. Every write goes through the server.
* **Server role** `mutqin_app_server`: explicit grants and `USING (true)` policies on application tables only. Deleting profiles goes only through `app_private.delete_member_completely` (atomic, refuses admins). Session revocation goes through `app_private.revoke_user_sessions`.
* **Verified locally** on the real snapshot (`migration/cutover/access.test.mjs`, 10 tests):

| Role | Result |
|---|---|
| anon | denied on every table and helper |
| unknown JWT | sees nothing |
| active member | sees active batch profiles; tasmia only as reciter or listener; own reviews; attempts only as candidate or examiner; live tests in their audience; cannot write anything, read credentials or touch `auth.users` |
| inactive member | own profile only |
| master admin | everything in the batch, read-only |
| admin without a batch membership | nothing |
| server role | its tables only; no Auth or provenance access; cannot delete profiles directly |

* Also fixed: `/api/bootstrap`, `/api/recitations` and `/api/revisions` previously returned all members' names and phones **without login**. They now require a session.

## 8. Firestore → Supabase operation mapping

| Old Firestore operation | Now |
|---|---|
| full scans of 7 collections on every bootstrap | `store.loadState`: one read-only repeatable-read snapshot, mapped back to the legacy API shapes |
| `setDoc recitations` | insert `tasmia_submissions` (`legacy_date` = day, snapshots of names) |
| `setDoc revisions rev_<member>_<date>` | insert `review_confirmations` `ON CONFLICT DO NOTHING` (one per member/date; `program_day` null) |
| `setDoc/updateDoc/deleteDoc users` | Auth admin API + `profiles`/`batch_memberships`; delete via `delete_member_completely` |
| `setDoc settings/group_settings` (pause/resume/periods/start/thought) | `program_pauses` (open row / `resumed_on` = first active day), `cycles.starts_on`/`legacy_paused_days`, `daily_thoughts` publish/unpublish |
| rest days | `group_rest_days` |
| tests: N×`updateDoc` + `setDoc` | one transaction: hide other published tests, upsert `peer_tests`, replace `peer_test_selected_members` |
| attempt with embedded questions | `peer_test_attempts` + `peer_test_attempt_questions` with full Mushaf geometry (`legacy_incomplete=false`) |
| factory reset (4 independent clears) | one transaction |
| personal tests (JSON file + best-effort Firestore) | `personal_tests` + `personal_test_questions` |
| backfill (chunks of 25) | one transaction, idempotent |

Realtime: none existed and none was added. Every mutation locks the active cycle row, which serializes writers. The old read-validate-write races disappear, and unique keys enforce one quarter per member and one review per date.

## 9. API changes

All routes and response shapes are unchanged except:

* `POST /api/auth/login` → 410 (sign-in happens in the browser). New: `GET /api/public-config`, `GET /api/status` (replaces `/api/firestore/status`).
* Data routes require a session (see section 7). IDs are now UUIDs.
* Minimum length for **new** passwords is 6, not 4 (Supabase Auth's floor). Existing shorter passwords keep working.
* A blank test title falls back to the default title. Duplicate or unknown selected members are deduplicated or rejected (the database enforces this).
* Error messages no longer mention "Firestore".

## 10. Final Firebase reconciliation

A fresh read-only recursive export (`migration/backups/2026-10-26-cutover-reconciliation`) compared with the 926-document Phase 1 snapshot:

* **Added 7**: 3 recitations and 4 revisions (two dated 2026-10-26, and retroactive entries for 10-07 and 10-08). **Removed 0. Changed 0.**
* No new fields, collections or subcollections. The approved transform accepts the export (it fails closed otherwise).
* `reconcile.mjs` plan against a Phase 1 copy: **insert 3 tasmia + 4 reviews + 7 provenance rows, 0 conflicts, 0 removed.** After applying, read parity with the new export is exact.
* **Production import is not done.** Firebase is still live, so this must be repeated in the go-live window (runbook steps 1–4) so that no write is lost.

## 11. Tests

| Suite | Result |
|---|---|
| `npm test`: workflows (11), parity (1), reconciliation (2), config guards (4) | 18/18 pass |
| `migration/cutover/access.test.mjs`: RLS per role | 10/10 pass |
| `migration/test.mjs`: Phase 1 regression | 6/6 pass |
| Read parity: Firebase snapshot vs Supabase repository, all 923 records + settings | 0 differences, 0 order differences |

Workflows covered: unauthenticated access, sign-in/session, bootstrap/lists, pause/resume/periods, rest days, start date, daily thought, idempotent revisions and backfill, sequential recitation rules, the full peer-test lifecycle (save, eligibility, questions, attempt, privacy, versioning, finish), member add/update/role/reset/delete including Auth-failure rollback, personal tests, change password, factory reset. All of these run as the restricted server role.

Not run: a browser smoke test against a real Supabase project, and anything else in production (no credentials here).

## 12. Build

`npm run lint` (tsc) passes. `npm run build` passes: the client bundle has no Firebase and no secrets, and the server bundle has no Firebase. The large client chunk (~2.9 MB) predates this work. The built server exits with a clear message naming any missing variable.

## 13. Known limitations

* Everyone must sign in once after go-live, because old tokens are invalid. Accounts and passwords are unchanged.
* The server assumes one batch with one active cycle, as Men has today.
* Session revocation deletes `auth.sessions` rows. If the platform forbids that, it logs a warning and the password change still succeeds.
* A Supabase Auth call and a database commit cannot share one transaction. Deletes remove the Auth user after commit (failures are logged). Creates are compensated if the profile insert fails.
* Old-server `data/personal_tests.json` records, if a deployed instance has any, are outside Firestore and are not migrated. Check before go-live.
* **`data/database.json` (member phones and bcrypt hashes) remains in Git history** and on the GitHub remote. Stopping tracking does not remove it. Rewriting history needs a separate decision.

## 14. Remaining Firebase dependencies

The running application has none. Migration tooling uses `firebase-admin` and the service-account key (kept outside the repo) for read-only exports.

## 15. Before Firebase can eventually be deleted

Go live (runbook), keep Firestore read-only for an agreed rollback period, take and archive a final export, confirm there are no consumers, then revoke the legacy server account (`FIREBASE_SERVER_AUTH_*`) and the service-account key.

## 16. Does Mutqin for Men now run entirely from Supabase?

**The code does**, and that is verified locally end to end. **Production does not yet.** The runbook below has not been executed.

## 17. Before Phase 2

* Sisters' client write policies, RPCs and guard triggers are not installed. Phase 2 must choose between Sisters' client-side writes and Men's server-enforced rules for each feature.
* Men reviews are date-based (`program_day` null). Sisters uses `program_day` uniquely, and rest/pause days break that for Men.
* `service_role` has no table grants (Phase 1 decision). Sisters-style Edge Functions will need explicit grants.
* Legacy unknowns: `cycles.legacy_paused_days` (6 undated days) and the 89 historical questions without geometry.
* Decide whether to rewrite Git history for `data/database.json`.

---

## Go-live runbook (operator)

Every step targets `uaublandjewfzmhnbflc`. Credentials go only in your environment.

1. **Freeze Firebase writes.** Announce a short window and deploy `migration/cutover/firestore.readonly.rules` to `mutqin-7f0bb`. Members can still read; saves fail with an error.
2. **Export:** `node migration/export.mjs migration/backups/<NEW>`, then `node migration/compare-exports.mjs migration/backups/2026-10-25-final-production migration/backups/<NEW>`.
3. **Reconcile** (needs `MEN_MIGRATION_DATABASE_URL`, `NODE_EXTRA_CA_CERTS=certs/supabase-prod-ca-2021.crt`): `node migration/cutover/reconcile.mjs plan migration/backups/<NEW> --project uaublandjewfzmhnbflc`. If there are 0 conflicts and 0 removed, set `MEN_CUTOVER_APPROVED_PROJECT=uaublandjewfzmhnbflc` and run `apply`. If there are conflicts, stop and decide.
4. **Parity:** `npx tsx migration/cutover/parity.ts migration/backups/<NEW> --project uaublandjewfzmhnbflc`. Expect 0 differences.
5. **Access model:** `node migration/cutover/apply-migration.mjs supabase/migrations/20261026000100_men_app_access.sql --project uaublandjewfzmhnbflc`. Then, in the SQL editor: `alter role mutqin_app_server with login password '<strong generated secret>';`.
6. **Auth settings (dashboard):** disable public sign-ups; keep the email provider enabled; minimum password length 6.
7. **Link accounts:** `node migration/cutover/link-auth.mjs plan …`, then `apply`, then `verify` (needs `SUPABASE_URL`, `SUPABASE_SECRET_KEY`). Expect 30/30 linked, 30/30 hashes preserved. Then `apply-migration.mjs supabase/migrations/20261026000200_men_auth_link.sql`.
8. **Deploy** the branch with `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` and `SUPABASE_DB_URL` (transaction pooler, user `mutqin_app_server.uaublandjewfzmhnbflc`). Remove `FIREBASE_SERVER_AUTH_*`.
9. **Smoke test:** sign in as a member and an admin, record one revision, check the admin dashboard. Writes now reach Supabase only.

**Rollback** before step 9 writes anything: redeploy `main` and the archived rules. After go-live, Supabase-only writes would need a manual replay into Firestore; no reverse sync exists.
