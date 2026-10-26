# Mutqin for Men — completed Phase 1 production migration

Production destination: **uaublandjewfzmhnbflc**. Schema installation, transactional data import, and independent post-commit read-only validation all passed on 25 October 2026. The application has not been switched to Supabase.

## Source snapshot

Read-only Firebase Admin SDK export of Men project mutqin-7f0bb, database (default), using the existing service account. Export interval: 2026-10-25T20:47:09.358Z to 2026-10-25T20:47:20.786Z (UTC).

Final document count: **926**. Eight top-level collections, no nested subcollections or missing parent documents. Compared with the previously validated snapshot: **0 added, 0 removed, 0 changed**, identical collections and SHA-256.

SHA-256: `929b8dbe454ca5695b233d0b253b7f3d3ec215685acf107510449f21fe4503a8`. Local backup: `migration/backups/2026-10-25-final-production` (ignored by Git). Export is a read-only traversal, not a Firestore-wide atomic transaction or an ongoing sync. The result represents that export interval; subsequent application writes remain in Firebase until an explicit cutover/reconciliation.

| Firestore collection | Documents |
|---|---:|
| groupSettings | 1 |
| recitations | 388 |
| rest_days | 1 |
| revisions | 486 |
| settings | 2 |
| test_attempts | 15 |
| tests | 3 |
| users | 30 |

## Rows inserted and independently validated

The destination had no application tables before installation. All listed populated rows were newly inserted. Counts include normalized business rows, derived batch/cycle/membership rows, and private provenance; they are intentionally not equal to the source document total.

| SQL table | Inserted | Production count |
|---|---:|---:|
| public.profiles | 30 | 30 |
| public.batches | 1 | 1 |
| public.batch_memberships | 30 | 30 |
| public.cycles | 1 | 1 |
| public.daily_thoughts | 1 | 1 |
| public.group_rest_days | 1 | 1 |
| public.program_pauses | 1 | 1 |
| public.tasmia_submissions | 388 | 388 |
| public.review_confirmations | 486 | 486 |
| public.peer_tests | 3 | 3 |
| public.peer_test_selected_members | 2 | 2 |
| public.peer_test_attempts | 15 | 15 |
| public.peer_test_attempt_questions | 89 | 89 |
| public.personal_tests | 0 | 0 |
| public.personal_test_questions | 0 | 0 |
| public.batch_membership_transfers | 0 | 0 |
| migration_private.source_settings | 2 | 2 |
| migration_private.user_credentials | 30 | 30 |
| migration_private.source_documents | 926 | 926 |
| migration_private.empty_legacy_arrays | 1 | 1 |

Total stored rows: **2007** across 20 tables. The invoker-security profile_batch_overview view contains no stored/imported rows.

## Validation results

- Import-time checks passed before data commit; independent repeatable-read, read-only validation passed after commit.
- Source-document provenance coverage: **926/926**; original paths and Firestore IDs preserved alongside deterministic SQL UUIDs.
- Reverse mapping from actual stored SQL values matched **9,364/9,364 scalar values** across all source documents. Missing-versus-null distinctions and empty arrays are retained.
- Exact expected IDs and row counts in every table: no missing or extra records. Primary/unique keys prevent duplicate identifiers; the full-row comparison verifies every mapped relationship.
- All expected FK/check constraints are present and validated. Dependency-safe import succeeded without orphan or required-value violations.
- All 89 question rows and 2 selected-member relationships match, including original array ordering.
- SQL scalar/timestamp comparisons passed; native Firestore creation/update timestamps preserve exact seconds and nanoseconds.
- Schema validation passed: **20 tables, 218 columns, 108 constraints, 61 indexes, 1 row trigger, 1 view, 0 allow policies**. Required helper functions and automatic-RLS event trigger match the approved baseline.
- RLS enabled on every imported table. No effective table access for anon, authenticated, or service_role; no PUBLIC table privileges. Helper execution grants revoked from PUBLIC and those API roles.
- Six local regression tests passed, including identical reruns, corruption detection, unknown-field rejection, FK rollback, denied access, and reuse of the existing helper with quoted identifiers. No production rerun was needed.

Evidence: target-import-validation.json and target-validation.json under the private final backup directory, alongside manifest.json, source-drift.json, and rehearsal-report.json.

## Approved differences and legacy exceptions

- Retained the existing Men rls_auto_enable function body and matching ensure_rls event registration. Verified its only change from Sisters is resolving the relation name from its OID and quoting schema/table separately. No replacement or new behavior; client EXECUTE grants explicitly revoked.
- Four repeated recitation keys and fourteen extra revision/date keys remain separate records using legacy_occurrence. No deduplication.
- Historical program_day remains unknown where pause history is missing. Preserved the six-day pause aggregate and known open pause; no fabricated closed pause intervals.
- All 89 legacy questions retain missing page/line geometry as null under the approved legacy exception.
- Both conflicting settings documents and their embedded/document ID difference are retained; current settings drive the active cycle.
- One batch/current cycle and memberships use the approved derived mapping. Tests/rest days without cycle IDs map to that current cycle. Unknown author IDs and other absent historical fields remain null.
- Existing application credential hashes are stored in owner-only private tables; no Supabase Auth users were created and the Auth FK remains deferred.
- Two stale local fallback rest-day IDs absent from Firestore were not resurrected. Any deployed file-only personal-test data remains outside the Firestore scope.
- No new data/schema incompatibilities, dropped records, ignored fields, or failed production validation checks occurred. Initial TLS trust setup and the previously approved helper conflict were resolved before writes.

## Scope and remaining work

Men Supabase is populated and validated for the final Firestore export. **Sisters and Firebase were not modified.** No Firebase Auth/Storage migration, application frontend/backend changes, or Phase 2 functionality cloning occurred. Sisters' dump remains reference-only; no Sisters production records were copied. Secrets and private exports remain excluded from Git.

Before removing Firebase or switching the application: reconcile any Firebase writes after the snapshot in a controlled cutover window; separately design/approve Auth and Storage migration; implement application access with explicit grants/RLS and identity mapping; handle the documented legacy unknowns in application logic; audit any file-only data; test the full application and rollback plan. Owner-only Phase 1 permissions intentionally do not enable the application to use these tables. Phase 2 requires separate scope/authorization.
