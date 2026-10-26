# Phase 2 — Mutqin for Men ↔ Mutqin for Sisters functional parity

Branch `phase2-sisters-parity`. Men project `uaublandjewfzmhnbflc` only; Sisters was read, never modified.

| Area | Sisters | Men now | Men-specific rule kept |
|---|---|---|---|
| Architecture | Vite SPA + supabase-js + RLS/RPC + 3 Edge Functions | Same; shared code in `supabase/functions/_shared/{logic,peer-tests,data,men}` used by browser and Deno | Mushaf data only in Edge Functions |
| Multi-batch | Batch selector, create batch, per-batch bootstrap | Same (`create_batch_with_cycle`, `BatchSelector`, `CreateBatchModal`) | — |
| Admin model | Master admins + batch admins, batch assignments | Same (`AdminAccountsManager`, `BatchAdminActions`, `set_admin_batches`, guards) | Member ↔ admin role switch (`men_set_account_role`, edit modal) |
| Accounts | Create / edit / exclude / reactivate / delete | Same; batch admins deletable, masters never | Delete also removes attempts as examiner, selections, personal tests |
| Member transfer | Move member between batches | Same (`move_member_batch`, `MoveMemberModal`, transfer log) | — |
| Listener correction | Once, within 12 h | Same (`correct_tasmia_listener`) | — |
| History names | `history_member_names` | Same | Migrated name snapshots preferred |
| Delay / elimination | Shared `memberDelayStatus`, threshold 3 | Same module | Threshold 4 (more than 3) |
| Peer tests | Draft/now/schedule/hidden, show windows, one live test, start → submit sessions, SQL pass/fail, versioning | Same (`peer_test_save/set_status/start_attempt/submit_attempt`, `AdminPeerTestsTab`, `PeerTestCard`) | Selected audience, prerequisite flags, partial range (`effective_range_end`/`covers_full_range`), legacy geometry |
| Candidate rule | Eliminable candidates refused; examiners unaffected | Same | Audience + revision prerequisite |
| Calendar / reviews | Program-day reviews | Men calendar unchanged (SQL = JS verified) | Date-based reviews (allowed on pause/rest days), undated paused days, past pause periods, backfill |
| Recitation | DB guards | Same guards | Sequential quarters enforced in DB |
| Personal tests | — | Kept | Generation in Edge Function, owner RPC save |
| Theme / wording | Pink, feminine | Emerald/amber (rose for warnings), masculine | Men branding |

## Verification
- Local: `npm test` 34/34 (DB on real snapshot via PGlite + shared rules + access), `tsc` clean, `deno check` clean, build OK.
- Production: migration `20261028000100_men_sisters_parity.sql` applied once (recorded), 3 Edge Functions deployed.
- Production smoke (temporary accounts + temporary batch, all cleaned, counts restored): 92/92.
- Browser E2E (`vite preview` against Men Supabase): 20/20.

Remaining: deploy `main` to Vercel and run the deployed-site smoke test.
