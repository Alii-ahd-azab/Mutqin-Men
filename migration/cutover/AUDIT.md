# Phase A — Mutqin for Men application audit (pre-cutover)

Date: 2026-10-26. Read-only audit of the Men repository at commit `0acad94` plus the staged Phase 1 migration package. No functional changes were made before this report.

## Architecture summary

```
Browser SPA (React/Vite)  ──fetch /api/* (Bearer st1 token)──►  Express server.ts (Node, port 3000)
   src/api/client.ts                                             │  in-memory `db` cache + data/database.json fallback
   src/context/AuthContext.tsx                                   │  src/server/firestoreService.ts (Firebase *client* SDK, server-side)
   src/lib/firebase.ts (boot probe only)                         ▼
                                                                Firestore mutqin-7f0bb (default)
```

* The browser **never reads or writes Firestore data**. Its only Firebase code is a connection probe (`src/lib/firebase.ts` → `getDocFromServer(test/connection)`), imported from `src/main.tsx`.
* Every business rule, validation and permission check lives in `server.ts` (Express).
* The server keeps a whole-database in-memory copy (`db`), refreshed by `syncFromFirestore()` (full collection scans) on bootstrap, revision reads and some writes, and mirrored to `data/database.json`. Writes go to Firestore first, then memory/file.
* There are **no realtime listeners, transactions, or batched writes** anywhere. "Atomic" flows are sequences of independent `setDoc`/`updateDoc`/`deleteDoc` calls.
* No Firebase Storage, Functions, Admin SDK (runtime), Analytics or Messaging use. `firebase-admin` is a dependency but only the migration tooling uses it.

## Firebase dependency map

| File | Firebase usage | Supabase replacement |
|---|---|---|
| `package.json` | `firebase` (client SDK, used server-side), `firebase-admin` (unused at runtime) | `@supabase/supabase-js` (Auth, browser + server), `pg` (server data access) |
| `firebase-applet-config.json` | Project/web config; imported by server for project ID and as a **session-secret fallback input** | `SUPABASE_*` env vars; explicit `SESSION_SECRET` no longer needed |
| `firebase-blueprint.json` | AI Studio entity blueprint (documentation only) | Obsolete documentation; superseded by SQL schema |
| `firestore.rules` | Firestore rules; real enforcement is the server account (`herotero13@…`) | Postgres RLS + grants (Phase D) |
| `src/lib/firebase.ts` | Client app/Auth/Firestore init, `handleFirestoreError`, boot probe | `src/lib/supabase.ts` browser client (Auth only) |
| `src/lib/suppressFirestoreWarnings.ts` | Silences Firestore BloomFilter logs (imported by server, main, service) | Obsolete |
| `src/main.tsx` | Imports `firebase.ts` and warning suppression | Remove imports |
| `src/server/firestoreService.ts` | Server Firebase Auth sign-in (`FIREBASE_SERVER_AUTH_EMAIL/PASSWORD`), all collection reads (full scans), `setDoc`/`updateDoc`/`deleteDoc`, seed-if-empty, factory-reset clears | `src/server/repository.ts` (Postgres, transactional) |
| `src/server/personalTestsFirestore.ts` | `personal_tests` collection + `data/personal_tests.json` primary/fallback store | Postgres `personal_tests` + `personal_test_questions` store |
| `server.ts` | Imports firestoreService, firebaseConfig; startup probe + **seed-if-empty** + sync; `/api/firestore/status`; all handlers write Firestore first | Same routes over repository; status endpoint → Supabase health |
| `data/database.json` (tracked!) | Local fallback DB, rewritten on every sync; **contains member phones and bcrypt hashes and is committed to Git** | Obsolete; stop tracking (history rewrite needs separate approval) |
| `.env.example` | `FIREBASE_SERVER_AUTH_EMAIL/PASSWORD`, `GEMINI_API_KEY`, `APP_URL` | Add Supabase names; keep Firebase names until Phase K |
| `public/sw.js` | Comment only; no caching | none |
| `migration/*` | Read-only Firestore export via `firebase-admin` (service-account key outside repo) | Retained for reconciliation/rollback |

`GEMINI_API_KEY` / `@google/genai` are unrelated to Firebase and are not used by any runtime code.

## Authentication map (actual implementation)

Men does **not** use Firebase Auth for users. It is application-managed phone/password authentication:

1. **Identifier**: phone number, `String(phone).trim()`, exact string match against `users.phone`. Phones are unique by application check (no DB constraint in Firestore); 30/30 unique. One phone contains an internal space; two are 3–4 digit test-style numbers.
2. **Hashes**: `users.password_hash` field in Firestore, bcryptjs cost 10 (`$2b$10$…` for all 30 users). Plain-text legacy values were accepted and upgraded on login; none remain.
3. **Sessions**: stateless HMAC-SHA256 token `st1.<base64url {u:userId, e:exp, f:sha256(hash)[:12]}>.<sig>`, 90-day TTL, stored in `localStorage['motqin_auth_token']`, sent as `Authorization: Bearer`. Secret = `SESSION_SECRET` env, else derived from `FIREBASE_SERVER_AUTH_PASSWORD`, else derived from the **public** Firebase web API key (weak fallback). Password change invalidates tokens through the fingerprint.
4. **Logout**: client discards token; server deletes from an unused legacy map (stateless tokens are never revoked).
5. **Admin identification**: `users.role === 'admin'`. No master-admin concept; all four admins are global. `requireAdmin` middleware.
6. **Inactive users** (`is_active=false`, 8 users) may log in and view; recitation/revision/test/personal-test writes are rejected.
7. **Firebase Auth**: used only by the server itself — one shared email/password account signs in with the client SDK so Firestore rules admit the server (`isServerOrAdmin`). It is an internal backend credential, not user-facing.
8. **Change password**: verifies current bcrypt hash, min length 4, writes new hash to Firestore.

**Unauthenticated exposure found**: `GET /api/bootstrap`, `GET /api/recitations`, `GET /api/revisions` require no session; bootstrap returns all users' names and phone numbers to anyone. The SPA only calls them after login.

## API inventory (all in `server.ts` unless noted) and data flows

`UI → client.ts → route → in-memory/Firestore → target Supabase`

| Feature | Route | Firestore operation | Target |
|---|---|---|---|
| Health | GET /api/health | – | – |
| Status probe | GET /api/firestore/status | getDoc users/probe_conn | Supabase connectivity check |
| Login | POST /api/auth/login (`LoginView`→`AuthContext.login`) | memory lookup; fallback full `users` scan; plain-text upgrade `updateDoc` | Supabase Auth `signInWithPassword` (browser) |
| Session | GET /api/auth/me (`AuthContext.initAuth`) | memory | JWT verification + `profiles` |
| Logout | POST /api/auth/logout | – | Supabase Auth `signOut` |
| Change password | POST /api/auth/change-password (`Header`) | updateDoc users | Auth admin password update |
| Bootstrap | GET /api/bootstrap (`App.loadAppData`) | full sync of 7 collections | profiles, cycles, program_pauses, daily_thoughts, group_rest_days, tasmia, reviews, peer tests/attempts |
| Recitations list | GET /api/recitations | memory | tasmia_submissions |
| Record recitation | POST /api/recitations (`MemberDashboard`) | setDoc recitations | tasmia_submissions insert |
| Revisions list | GET /api/revisions | full sync | review_confirmations |
| Record revision | POST /api/revisions | sync + setDoc revisions (`rev_<member>_<date>`, idempotent) | review_confirmations insert, unique per user/date |
| Add member | POST /api/admin/members | sync + setDoc users | Auth createUser + profiles + batch_memberships |
| Update member | PATCH /api/admin/members/:id | updateDoc users | profiles/memberships (+ Auth email/password) |
| Delete member | DELETE /api/admin/members/:id/completely | 4 independent deletes (user, recitations, revisions, attempts) | one transaction + Auth deleteUser |
| Rest days | POST/DELETE /api/admin/rest-days | setDoc/deleteDoc rest_days | group_rest_days |
| Pause/resume | POST /api/admin/pause, /resume | setDoc settings/group_settings (whole doc) | program_pauses open/close |
| Past pause period | POST /api/admin/pause-periods | setDoc settings | program_pauses closed row + cycles.legacy_paused_days, one transaction |
| Backfill revisions | POST /api/admin/backfill-revisions | chunks of 25 setDoc | review_confirmations bulk insert, `ON CONFLICT DO NOTHING` |
| Start date | PUT /api/admin/settings | setDoc settings | cycles.starts_on |
| Daily thought | PUT/DELETE /api/admin/daily-thought | setDoc settings | daily_thoughts publish/unpublish |
| Factory reset | POST /api/admin/factory-reset | setDoc settings + 4 collection clears | one transaction |
| Admin stats | GET /api/admin/stats | memory | derived from tasmia/reviews/profiles |
| Tests list | GET /api/tests | memory | peer_tests (+ selected members) |
| Preview/impact | GET /api/admin/tests/:id/preview-questions, /impact | memory | read-only |
| Save test | POST /api/admin/tests | N× updateDoc others + setDoc (non-atomic) | one transaction |
| Toggle/finish test | PATCH …/status, POST …/finish | N× updateDoc (non-atomic) | one transaction |
| Eligible candidates | GET /api/tests/:id/eligible-candidates | memory | read |
| Generate questions | GET /api/tests/:id/generate-questions | memory | read (pure generator) |
| Record attempt | POST /api/tests/attempts | setDoc test_attempts (embedded questions array) | peer_test_attempts + peer_test_attempt_questions, one transaction |
| Attempts list | GET /api/tests/attempts | memory | read with privacy filter |
| Personal tests | /api/personal-tests* (`src/server/personalTests.ts`) | local JSON first, best-effort Firestore | personal_tests + personal_test_questions |

Persisted types: `src/types.ts` (User, GroupSettings, RestDay, RecitationLog, RevisionLog, TestDefinition, TestAttempt, PersonalTestRecord), `DatabaseSchema` (server.ts), `UserWithPassword` (firestoreService), `PersonalTestRecord` (personalTests.ts).

Seed/reset/dev code: `getInitialData()` sample users (password `password123`) written to `data/database.json` if absent and **seeded into Firestore if `users` is empty**; `seedFirestoreIfEmpty`; factory reset.

## Mapping source

Phase 1 mapping (`migration/transform.mjs`, `REVIEW.md`) is authoritative: deterministic UUIDs `uuid('users/<id>')` etc., original IDs in `firestore_id`, `date → legacy_date`, recitation `created_at → submitted_at`, revisions `program_day` null, settings → cycle + open pause + daily thought, tests `is_active/is_finished → status`, selected members join table, attempt questions child table.

New behavior not covered by Phase 1 data (no source rows existed): `GroupSettings.pause_periods` (closed pause periods written by resume/pause-periods endpoints) → `program_pauses` rows with `resumed_on`.

## Risk classification

| Area | Risk | Reason |
|---|---|---|
| Read-only lists, stats, tests list, preview/impact, generate questions, personal-test reads | simple | pure reads; mapping already validated by roundtrip |
| Rest days, start date, daily thought, add recitation, add revision, personal-test write/delete | moderate | new-row semantics (UUID ids, `legacy_date`, schema checks on `program_day`) |
| Pause/resume/pause-periods | moderate | settings document becomes rows; semantics of closed periods must be identical |
| Test save/toggle/finish, attempt submit, member delete, backfill, factory reset | high-risk | multi-document invariants today protected only by sequencing; need transactions; destructive |
| Authentication/session migration | high-risk | identity model change (string IDs → profile UUIDs → `auth.users`), session format change, password import |
| Final Firestore reconciliation | high-risk | production writes continue until cutover; delta needs explicit mapping |

No fundamental blocker found. Constraints discovered: (1) no Men Supabase credentials are available in this environment; (2) no Docker/PostgREST locally, so database work is verified in PGlite with Supabase role/Auth stubs.
