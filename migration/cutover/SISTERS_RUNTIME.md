# Mutqin for Men — Sisters runtime architecture (26 Oct 2026)

Supersedes the Express/direct-Postgres design in CUTOVER_REPORT.md. Data migration, final reconciliation and the Firebase freeze from that report remain valid.

## Status (26 Oct 2026)

| | |
|---|---|
| Supabase backend, Auth, RLS, Edge Functions | **Production-ready** on `uaublandjewfzmhnbflc` |
| Code | **Merged to `main` and pushed** to the Mutqin-Men GitHub repository (`supabase-cutover` kept until go-live) |
| Firebase `mutqin-7f0bb` | **Frozen read-only**, kept as historical fallback/reference; unchanged since the final snapshot |
| Website | **Not live yet**: Vercel deployment of `main` is the only remaining go-live step |
| Deployed-site smoke test | **Pending** (runs after the Vercel deployment) |

## Architecture (matches Mutqin for Sisters)

```
React SPA (Men UI/theme) ── supabase-js (URL + publishable key)
   ├─ Supabase Auth: phone → <phone>@members.mutqin.local, session persisted in the browser
   ├─ PostgREST reads under RLS (live Sisters policies + Men audience / personal-test rules)
   ├─ direct writes under RLS (live Sisters write policies), checked by insert guards
   ├─ RPCs: men_add_past_pause_period, men_backfill_revisions, men_save_personal_test
   └─ Edge Functions (service role, verify the caller themselves):
        admin-users   create / update (incl. member↔admin) / delete accounts
        admin-actions factory reset = Sisters start_next_cycle; create batch
        peer-tests    candidates, questions, submit, admin save/status/preview/impact, personal-test generation
```

There is no Express server, no Node backend, no direct Postgres connection and no custom server role, as in Sisters.

| Concern | Sisters | Men now |
|---|---|---|
| Client | `src/lib/supabase.ts`, VITE_ URL + publishable key | same (also reads SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY from .env.local; Vite exposes only these two values) |
| Auth | signInWithPassword, phone → email, profile load, inactive signed out | same |
| Reads | RLS, paged 1000 rows | same (`src/lib/menData.ts`, rows mapped by `src/lib/menRows.ts`) |
| Simple writes | direct insert/update + RLS + guards | same; Men guards add sequential-quarter, audience-aware mandatory test, date-based reviews |
| Privileged | 3 Edge Functions + service-role SQL functions | 3 Edge Functions (same names, shared auth) + Men service-role functions |
| Factory reset | start_next_cycle (archives, history kept) | same (was destructive deletion) |

Men-specific database extensions are kept: Firestore alternate IDs, legacy occurrences, name snapshots, selected test members, legacy question geometry, personal tests, `migration_private` provenance. Application code never reads `migration_private`.

## Production state (uaublandjewfzmhnbflc)

* Auth: 30/30 profiles linked (`auth.users.id = profiles.id`), all 30 bcrypt hashes preserved (no password resets), FK `profiles.id → auth.users` applied. Public sign-ups disabled.
* Migrations applied: `20261026000100_men_app_access`, `20261026000200_men_auth_link`, `20261027000100_men_sisters_runtime`.
* Catalog: `mutqin_app_server` removed; 15 read + 10 write policies; 2 guards; 8 Men RPCs; RLS on every table; anon has no grants; no API role reaches `migration_private`.
* Read parity of the new browser data layer against the frozen Firebase export: 30 users, 1 rest day, 391 recitations, 490 revisions, 3 tests, 15 attempts — 0 differences, 0 ordering differences.
* Firebase `mutqin-7f0bb`: frozen read-only; a post-change export is identical to the final cutover export (0/0/0).

## Verification

* `npm test`: 17 (database: RLS reads/writes per role, guards, SQL calendar = JS calendar on every date, RPCs, Edge-only RPCs; Edge rule unit tests) + 9 RLS role tests. Phase 1 suite: 6/6. `npm run lint`, `npm run build`, Deno type-check of all three functions: pass.
* Production API smoke test (`migration/cutover/smoke.ts`, temporary accounts created and fully removed): **62/62 pass**, including every action of the deployed admin-users, admin-actions and peer-tests functions (account lifecycle, factory-reset guard, peer-test administration on a hidden test, end-to-end peer test with mandatory-test checkpoint, personal tests), login with an imported bcrypt hash, session persistence, logout, inactive and unauthenticated restrictions, cross-member and privilege denials.
* Browser end-to-end test of the production build against Men Supabase (`migration/cutover/browser-e2e.cjs`, served locally by `vite preview`): **15/15 pass** — login and wrong-password message, member and admin dashboards, review and personal test written from the UI, Edge Function from the browser origin, logout, no cross-account data, only Men Supabase requests, no console errors.
* Edge Functions deployed and ACTIVE (`verify_jwt = false`, callers validated in-function as in Sisters); unauthenticated and forged-token calls get 401.

## Intentional behavior changes (Sisters behavior adopted)

* Inactive members cannot sign in (previously they could view).
* Logout ends the account's sessions on all devices; password changes do not end other sessions.
* Factory reset archives the cycle and starts the next one (history kept; cycle number increases; tests finished).
* Admins cannot reset another (master) admin's password from the admin panel; Men admins are master admins.
* New/changed passwords need 6+ characters; new phones are stored without spaces.
* Recitation dates are accepted only within one day of the Makkah date.

## Remaining before go-live

Deploy the `main` branch of the Mutqin-Men GitHub repository to Vercel (as Sisters is hosted: zero-config Vite, build `npm run build`, output `dist/`) with `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` set to the Men values, then run the final deployed-site smoke test (`browser-e2e.cjs` against the deployed URL). No other runtime variables are needed.

Later cleanup (before Phase 2): the Mushaf data still ships in the browser bundle through `TestConditionsCard` (Sisters keeps it server-side); `data/database.json` remains in Git history.
