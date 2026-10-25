# Phase 1 migration review — approved and executed

Status update, 25 October 2026: the user approved this review and the existing Men RLS-helper adjustment. Production schema installation, import of the final unchanged 926-document Firestore export, and post-commit validation passed for `uaublandjewfzmhnbflc`. See **PRODUCTION_REPORT.md** for actual row counts and execution evidence. The preparation-time statements below are retained as the historical approval record; they no longer describe execution status. The approved helper baseline is recorded in `reference/men-approved-rls-helper.json`.

Prepared 25 October 2026. No Firebase writes, production Supabase writes, frontend changes, Auth migration, Storage migration, or Sisters changes have been made. This is a tested preparation package, **not a completed production migration**. Following approval, the next step is actual import into Men and validation against the final Firestore export.

Confirmed projects:

- Firebase Men: `mutqin-7f0bb`, database `(default)`.
- Supabase reference Sisters: `cuexuketulmyskmdvosp`.
- Supabase destination Men: `uaublandjewfzmhnbflc`.

## Authoritative live reference and comparison

The user-supplied live schema-only dump is now authoritative:
`C:\Users\Omar\Desktop\متقن نساء\Mutqin-app-for-sisters-\sisters-live-schema.sql`.
SHA-256: `041bccfc29ebdd1d2015058a143da5e0bd0c5a33cb3141e0a7ce091b75312db8`.
It was produced from PostgreSQL 17.6 using pg_dump 18.6. All 526 dump object blocks were inspected and classified. No production-data blocks are present. The Sisters source file and repository were not modified.

**The previous reconstruction was a close core-model match, but not a complete match.** All 13 application tables and their 116 columns match, including types, defaults and nullability. All PKs, 28 FKs, unique constraints and 42 indexes match. The one check-expression difference is AND-parenthesis grouping in peer_tests_range_check, with no behavior change. All 30 previously reconstructed functions, five row triggers and 21 policies match.

Live evidence adds the `profile_batch_overview` invoker-security view (eight derived columns), definitions of the three previously unresolved `private.*` helpers, and the active `ensure_rls` event trigger. Its `rls_auto_enable()` function already appeared unchanged in the old backup but was omitted from the executed reconstruction. The live application catalog contains 34 functions, five row triggers, one application event trigger and one view. No application enums/custom types are defined. Supabase-managed schemas/types/functions are fully inventoried but will not be cloned into Men.

The dump contains **no ACL/default-ACL/GRANT/REVOKE statements or owner assignments**. Live privileges therefore remain unknown; default privileges from a local restore must not be mistaken for live permissions. This does not block the explicitly owner-only Phase 1 proposal. A future ACL-inclusive dump or catalog query is required before reproducing Sisters runtime permissions. No additional credentials are requested for this review.

The Men foundation SQL is now generated directly from the live dump. The new view and automatic-RLS function/event trigger are included; all existing Men preservation extensions remain. Previous proposals/reconstruction artifacts are retained under reference/pre-live-* and reference/previous-reconstruction-catalog.json. Auth dependency stubs used only for disposable local comparison are not deployed.

- [Complete comparison, including every category and limitation](LIVE_COMPARISON.md)
- [Every object in the entire dump](reference/LIVE_DUMP_INVENTORY.md)
- [Final live Sisters application structure](reference/LIVE_SCHEMA.md) and [exact catalog definitions](reference/live-catalog.json)
- [Updated Men target structure](PROPOSED_SCHEMA.md) and [live-to-Men column differences](schema-diff.json)

## Men repository inspection

- `firebase-applet-config.json`: Firebase project and default database configuration; Storage bucket configured but no Storage SDK use found.
- `src/lib/firebase.ts`: client Firestore/Auth initialization and connection probe. `src/main.tsx` imports it.
- `src/server/firestoreService.ts`: client SDK used server-side, backend email/password sign-in, all database reads/writes, seeding and reset/delete operations.
- `server.ts`: Express API, Firestore synchronization, local `data/database.json` fallback, application-managed phone/password login, signed session handling and password hashes. **Application was not started**, since startup can seed Firestore.
- `src/server/personalTestsFirestore.ts`: personal-test collection with local JSON fallback; its file is absent locally and collection absent in Firestore.
- Models: `src/types.ts`, `src/server/personalTests.ts`, `DatabaseSchema` in `server.ts`, and `UserWithPassword` in the Firestore service. UI/API callers and all tracked source/config paths were searched for Firebase/backend usage.
- No Firebase Functions deployments/calls or Firebase Storage reads/writes found. `firebase-admin` is already a dependency but the application service uses the Firebase client SDK.
- No Men Supabase credentials/configuration found in repository or relevant environment variable names. Sisters has local Supabase configuration, but it is not a Men destination credential. The authenticated CLI account listed a different project; it is never substituted for Men.

## Firestore inventory and backup

| Collection | Documents | Proposed mapping |
|---|---:|---|
| `users` | 30 | profiles + private credentials + derived memberships |
| `recitations` | 388 | tasmia_submissions |
| `revisions` | 486 | review_confirmations |
| `rest_days` | 1 | group_rest_days |
| `tests` | 3 | peer_tests + selected-member join rows |
| `test_attempts` | 15 | peer_test_attempts + 89 question rows |
| `settings` | 2 | typed settings preservation; active cycle/thought/pause; empty far-revisions marker |
| `groupSettings` | 1 | typed historical settings preservation |
| **Total** | **926** | all source documents registered in provenance |

No nested subcollections or missing-parent documents were found. Discovery used `listCollections` and `listDocuments` recursively, including non-existent parent references. `personal_tests` and the frontend probe collection `test` contain no discovered documents. Empty collections do not persist in Firestore.

Backups, ignored by Git:

- `migration/backups/2026-10-25-initial/`
- `migration/backups/2026-10-25-verification/`

Each contains typed `firestore.ndjson` and a manifest with completeness, collection counts, acquisition times and SHA-256. The two full exports contain identical paths, values and update times: 0 added, removed or changed documents. A recursive export is not an atomic Firestore snapshot; a quiet/frozen write window and fresh final export are still needed before final production reconciliation. Normal Firestore reads may count toward quotas; no paid managed export/import service was used.

[firestore-inventory.json](firestore-inventory.json) contains all observed field types, counts, optionality and schema shapes, without user values. The private backup contains exact representative records. All business timestamps are strings (ISO instants or calendar dates), not Firestore Timestamp fields. Native document creation/update timestamps are preserved separately as seconds plus nanoseconds. Business fields use strings, integers, booleans, null, arrays and maps; no document-reference, bytes, geographic, vector or floating-point fields were observed. IDs in string fields supply relationships; all referenced users/tests currently resolve.

## Sisters tables retained and expected Men rows

All 13 live Sisters tables remain, plus the exact live profile_batch_overview view and ensure_rls event trigger. UUID PKs follow Sisters; original Firestore document IDs remain in unique `firestore_id` alternate keys and the provenance registry. UUIDs are deterministic namespace-separated SHA-256-derived UUIDv8 values; references use the same mapping. The mapping is stable across reruns and does not force non-UUID IDs into UUID columns.

| Target table | Rows | PK | Principal FKs / purpose |
|---|---:|---|---|
| profiles | 30 | id UUID | Auth FK deferred; no auth.users inserted |
| batches | 1 | id UUID | created_by → profiles; one derived Men batch |
| batch_memberships | 30 | id UUID | batch_id → batches; user_id/created_by → profiles |
| batch_membership_transfers | 0 | id UUID | user/actor → profiles; from/to → batches; retained shared architecture |
| cycles | 1 | id UUID | batch_id → batches; created_by → profiles |
| daily_thoughts | 1 | id UUID | batch_id → batches; published_by → profiles, unknown author ID stays null |
| group_rest_days | 1 | id UUID | cycle_id → cycles; created_by → profiles |
| program_pauses | 1 | id UUID | cycle_id → cycles; created_by → profiles; known open pause only |
| tasmia_submissions | 388 | id UUID | cycle/user/listener → cycles/profiles |
| review_confirmations | 486 | id UUID | cycle/user → cycles/profiles |
| peer_tests | 3 | id UUID | cycle/creator → cycles/profiles |
| peer_test_attempts | 15 | id UUID | test/candidate/examiner → peer_tests/profiles |
| peer_test_attempt_questions | 89 | attempt_id + question_number | attempt → peer_test_attempts |

New Men preservation tables:

| Table | Rows | Reason |
|---|---:|---|
| peer_test_selected_members | 2 | Normalize selected_member_ids; PK test/user; unique test/position preserves array order |
| personal_tests | 0 | Men-only model, explicit typed schema for future/fresh-export data |
| personal_test_questions | 0 | Normalize personal question arrays; PK test/question |
| migration_private.source_settings | 2 | Both conflicting settings documents retained as typed columns; source_path PK |
| migration_private.user_credentials | 30 | Existing application password_hash and optional firebase_uid; profile PK/FK; no Supabase Auth migration |
| migration_private.source_documents | 926 | source_path PK; original collection/id, target mapping, field-type/presence metadata and exact native source timestamps |
| migration_private.empty_legacy_arrays | 1 | Preserve settings/far_revisions.logs as explicitly empty; composite source/field PK |

The view produces 30 derived rows from the imported Men profiles; it receives no imported records.

Indexes retain Sisters' profile phone uniqueness; batch name uniqueness; batch/user membership uniqueness; one member batch; one active cycle per batch; cycle numbers unique per batch; rest date uniqueness per cycle; tasmia/review user/cycle/listener access; batch/status and thought publication access; transfer history; peer-test cycle/status; attempts candidate/examiner/test/status; and one open attempt per test/candidate. Additional indexes support selected-member lookup and personal member/date lookup. Exact definitions appear in PROPOSED_SCHEMA.md.

## Field mapping

Every source document also maps its path, ID, field presence/types, createTime and updateTime into the private provenance registry. Unknown source collections, subcollections or fields fail the transformation rather than disappear. Embedded IDs must match document IDs except the explicitly preserved settings exception.

| Source | Source fields → target columns |
|---|---|
| users | id/doc ID → profiles.firestore_id and deterministic profiles.id; name → full_name; phone → phone (text, leading zeros preserved); role → role; is_active → active; created_at → created_at; password_hash → private credentials.password_hash; firebase_uid if present → private credentials.firebase_uid |
| recitations | member_id → user_id; member_name → member_name_snapshot; listener_id → listener_id; listener_name → listener_name_snapshot; quarter_number unchanged; cycle_number → cycle_id; date → legacy_date; notes unchanged; created_at → submitted_at; reciter_id/name are checked equal to member_id/name, then represented by those same normalized values with original field presence recorded |
| revisions | member_id → user_id; member_name → member_name_snapshot; cycle_number → cycle_id; date → legacy_date; review_start_quarter/end_quarter → start_quarter/end_quarter; created_at → confirmed_at; optional notes retained; program_day remains unknown/null |
| rest_days | date → rest_date; note → reason; added_by_admin_id → created_by; added_by_name → created_by_name_snapshot; created_at unchanged; cycle_id inferred as current cycle |
| tests | title/range_start/range_end/questions_count/lines_per_question/test_type/difficulty/created_at/updated_at/finished_at retained; created_by_admin_id → created_by; prerequisites flags → two named boolean columns; has_max_errors/max_errors_allowed → max_errors or null plus original legacy flag/value; is_finished/is_active → finished/published/hidden status plus original nullable legacy flags; audience retained; selected_member_ids → join table preserving ordinal position; cycle_id inferred |
| test_attempts | test_id/candidate_id/examiner_id → mapped FKs; candidate_name/examiner_name → snapshots; total_errors/status/notes/created_at unchanged; date → attempt_date; passed → legacy_passed, checked against status; effective_range_end/covers_full_range retained; questions_results → child table; completed_at/max_errors_snapshot left null because no source values exist |
| questions_results[] | question_number/start_surah/start_surah_name/start_ayah/end_surah/end_surah_name/end_ayah/errors_count/notes retained as typed columns; missing page/line/actual_lines → null with legacy_incomplete=true |
| settings/group_settings | id → embedded_id='group_main', document ID separately preserved; start_date → cycles.starts_on; current_cycle_number → cycle_number; total_quarters/review_window retained on cycle; total_paused_days → legacy_paused_days; is_paused/paused_at → open program_pauses row; daily_thought → content_html; daily_thought_updated_at → published_at; daily_thought_updated_by → author-name snapshot; all source values also retained in typed source_settings |
| groupSettings/group_main | Every field retained in source_settings; not allowed to override current settings |
| settings/far_revisions | Empty logs array → empty-array marker; nonempty future logs block migration pending mapping |
| personal_tests (currently absent) | All fields from PersonalTestRecord retained in the named typed columns; member_id mapped; questions normalized into personal_test_questions |

JSONB is used **only** for the varying provenance field-type/presence map. Business documents, arrays and maps are not dumped into JSONB. Nullable SQL values plus source field metadata distinguish missing from explicit null. Dates are SQL date; ISO instants are timestamptz; booleans are boolean; bounded counts use Sisters integer/smallint types; phone and legacy IDs are text. Native Firestore metadata preserves nanoseconds in separate numeric columns, avoiding PostgreSQL timestamp precision loss.

## Incompatibilities and proposed decisions

1. **ID/Auth mismatch:** none of the 30 user IDs is a UUID. Preserve them as alternate keys and use deterministic UUIDs. Do not attach profiles.id to auth.users until a separately approved Auth plan links/creates identities. Existing password hashes remain private, not client-readable. Phase 1 does not provide Supabase sign-in.
2. **Duplicate history:** four recitation records exceed Sisters' unique cycle/user/quarter rule. Preserve all with deterministic legacy_occurrence 0,1,..., extending the unique key. New unmarked rows default to occurrence 0. Fourteen revisions share cycle/member/date; preserve all with date/occurrence uniqueness. No deduplication, merging or record deletion.
3. **Unknown program days:** current settings report six already-paused days but no closed pause ranges. Do not manufacture dates or program_day. Preserve aggregate and original revision dates; allow null program_day only for marked legacy rows. Sisters' unique cycle/user/program_day remains for known/new rows. Phase 2 calculations must account for this explicitly.
4. **Question geometry missing:** all 89 legacy question results lack page, line and actual-line counts. Five Sisters non-null columns become nullable for legacy_incomplete records only; new complete records remain checked. Do not regenerate questions and claim they are original data.
5. **Conflicting settings:** legacy groupSettings starts September 16, unpaused/0 days; active settings starts September 17, paused from October 24/6 days. Code reads settings/group_settings. Both are retained; only current settings drives the cycle. Its embedded id group_main differs from document ID group_settings and is explicitly retained.
6. **Additional Men semantics:** selected audiences, prerequisites, effective range, full-range coverage, dates and historical names survive as typed extensions. Sisters' runtime peer-test rules do not yet consume these fields; enabling them unchanged would alter behavior, so no Phase 2 functionality is deployed.
7. **Derived rows/unknowns:** create one Men batch and current cycle 1; assign tests/rest days to it because source has no cycle FK. Four existing global admins are proposed as master admins; all 30 users receive matching-role memberships. Batch/cycle creation and membership joined_at use earliest/user creation timestamps as documented inferred defaults. Pause created_at uses source-document update time, not a claimed historical pause creation instant. Unknown actor IDs, deactivation times, completion times and error-limit snapshots stay null.
8. **Fallback-only rest days:** local data/database.json has 2 rest-day IDs absent from Firestore. A private local fallback copy and comparison are saved. They may be stale/deleted records; do not restore them automatically. The deployed server's separate personal_tests.json, if any, is outside the Firestore snapshot and was not available locally.
9. **Security/routines:** preserve Sisters routine definitions in reference, but Phase 1 installs the deactivation timestamp trigger and the live automatic-RLS function/event trigger, plus the invoker-security overview view. Other auth-dependent RPCs, membership/activity guards and RLS policies are deferred; they could reject historical records or overwrite snapshots and assume Supabase Auth. All proposed tables have RLS enabled and client/service-role grants revoked. Owner-only SQL import is intentional. There are no allow policies. These are explicit Phase 1 differences, not an assertion of full runtime parity.
10. **Live state:** comparison against the user-supplied live Sisters dump is verified. Live grants/ownership and Men target emptiness are not verified; the dump is authoritative as supplied, not a claim of continuous live synchronization. The schema importer requires an empty public schema and will not overwrite an existing application schema. A nonempty Men target requires a separate reviewed compatibility plan.

## Import order, reruns and validation

Order: profiles → batches → memberships → cycles → thought/rest days/pauses → tasmia/reviews → peer tests → selected members → attempts → question results → personal tests/questions → transfer table (empty) → typed settings/credentials → provenance → empty-array marker.

Schema SQL is one-time migration DDL. The data importer runs in a transaction with dependency order, parameterized queries and PK-based conflict handling. An identical rerun is safe; existing differing rows or unexpected extra rows cause validation failure and rollback, rather than silent overwrite. It is not a live-sync tool and does not automatically delete or update changed target records. A final fresh snapshot should be imported into the empty approved destination; if source changes after an earlier load, reconcile explicitly.

Validation covers exact table counts, expected IDs, extra/missing records, duplicate IDs, every expected typed field, timestamps, relationships, arrays' child records and ordering, required values, validated FK/check constraints, and provenance coverage. Question error totals and passed/status are checked against source. PostgreSQL PK/unique/FK/check constraints enforce duplicates, orphans and required-value errors. Backups are checksum-verified before transformation.

Local results: updated live-derived schema and view/event-trigger checks pass; two identical Firestore exports; both schema migrations execute; 926/926 source documents represented; 89/89 question results and 2/2 selected-member relationships preserved; import rerun identical. Tests pass for checksum tampering, unknown fields, ID stability, FK rollback, missing rows, mismatched timestamps/fields, idempotence and denied anonymous reads. PGlite uses PostgreSQL in WASM; this is not a full Supabase-hosted integration test. An independent reverse mapping reconstructs source fields from stored SQL rows: 926 documents and 9,364 scalar values match, array order matches, and native source timestamp nanoseconds are exact. That check runs before real import commit and again during read-only target validation. No target production validation has run yet.

Before production writes: approve this mapping and its decisions, establish authenticated access to the confirmed Men project, inspect target schema read-only, agree a final snapshot/write-quiet window, re-export and rerun checks. Then apply the approved schema/import and validate actual Men production rows. The migration is complete only after that production validation; the frontend still remains unchanged in this phase.


## Approval requested for the live-derived proposal

Approve the field mappings and minimal preservation exceptions above, including original-ID alternate keys, duplicate history, unknown program days/question geometry, private credential retention without Auth migration, derived batch/cycle assignments, and owner-only access. The authoritative live view and ensure_rls trigger are now included. No new Men-specific data extensions were needed solely because of the live comparison; expected stored row counts remain unchanged.

After approval, the next work is authenticated read-only Men target inspection, a fresh final Firestore snapshot in an agreed quiet window, actual schema/data import into `uaublandjewfzmhnbflc`, and production validation. No approval is inferred from providing this dump or asking to resume. This review ends before all production writes.
