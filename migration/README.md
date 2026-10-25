# Mutqin Men — Firestore migration preparation

Read REVIEW.md first. The user approved the updated review and authorized production migration into Men project `uaublandjewfzmhnbflc` on 2026-10-25, including reuse of the existing Men RLS helper. See PRODUCTION_PREFLIGHT.md and the production report for execution status.

**Completed:** Men production now contains 2,007 rows across 20 tables representing all 926 source documents plus normalized/derived/private records. Import-time and separate post-commit validation passed. See PRODUCTION_REPORT.md. Do not run `--apply-schema` again on this populated destination; a future source delta requires explicit reconciliation.

**Application cutover (Phase 2 of the move to Supabase):** see cutover/CUTOVER_REPORT.md for the code changes, verification, reconciliation results and the go-live runbook. Note: `database.mjs` `applySchema` now applies only the Phase 1 (20261025*) migrations.

Run from the Mutqin Men repository root in PowerShell. No app startup is needed.

```powershell
npm.cmd ci --prefix migration --ignore-scripts --no-audit --no-fund
$env:GOOGLE_APPLICATION_CREDENTIALS = 'C:\Users\Omar\Desktop\Mutqin-Men\mutqin-7f0bb-firebase-adminsdk-fbsvc-6be4741cf5.json'
# Use a NEW directory for each export (existing data is never overwritten).
node migration/export.mjs migration/backups/NEW-SNAPSHOT
node migration/analyze.mjs migration/backups/NEW-SNAPSHOT
node migration/compare-exports.mjs migration/backups/OLD-SNAPSHOT migration/backups/NEW-SNAPSHOT
node migration/compare-live.mjs "C:\Users\Omar\Desktop\متقن نساء\Mutqin-app-for-sisters-\sisters-live-schema.sql"
node migration/build-schema.mjs
node migration/rehearse.mjs migration/backups/NEW-SNAPSHOT
node migration/render-catalog.mjs
$env:MEN_TEST_BACKUP = (Resolve-Path migration/backups/2026-10-25-verification).Path
npm.cmd test --prefix migration
```

The regression suite includes observed 926-document snapshot assertions; update those deliberately if a later snapshot changes counts. The rehearsal accepts a new snapshot without fixed-count expectations. New fields, subcollections or unsupported types require explicit mapping changes.

The exporter reads only Firestore with the existing service account. It never initializes the application or calls write operations. Backups include sensitive member information and credential hashes: keep local, private and outside Git. The key stays outside the Git root. Do not share the backup, private files or connection strings in chat.

`build-schema.mjs` regenerates ONLY the Sisters foundation migration directly from the authoritative schema-only live dump; the Men extension migration is maintained separately. `reconstruct-reference.mjs` executes local reference SQL in disposable PostgreSQL memory with Auth stubs (never production). `reference/` is documentation, not a deployable migration directory: it intentionally includes historic DDL and backfills.

The target importer uses `MEN_MIGRATION_DATABASE_URL` from the environment. It only accepts a local server or the confirmed Men project `uaublandjewfzmhnbflc`; the Sisters project is blocked. It verifies TLS on remote connections. Set the connection string through your local credential mechanism, never a command-line argument.

Only AFTER explicit human approval of REVIEW.md and read-only target inspection:

```powershell
# Establish MEN_MIGRATION_DATABASE_URL securely first.
# Trust the official Supabase CA while preserving TLS/hostname verification:
$env:NODE_EXTRA_CA_CERTS = (Resolve-Path migration/private/supabase-prod-ca-2021.crt).Path
node migration/target.mjs preflight --project uaublandjewfzmhnbflc
# Set this approval marker only after actual review approval:
$env:MEN_MIGRATION_APPROVED_PROJECT = 'uaublandjewfzmhnbflc'
node migration/target.mjs import migration/backups/FINAL-SNAPSHOT --project uaublandjewfzmhnbflc --apply-schema
node migration/target.mjs validate migration/backups/FINAL-SNAPSHOT --project uaublandjewfzmhnbflc
```

`--apply-schema` requires an empty public schema. Omit it for identical reruns after schema creation. Never apply the migrations to Sisters. No Supabase CLI link/push is configured here. Target validation runs a repeatable-read read-only transaction. Import commits only after all expected rows pass validation; a failed import rolls back its data, but a separately successful schema creation remains. Reports go into the ignored backup directory. SQL errors log only codes/table/constraint, never parameter values.

Preflight saves a read-only catalog under `migration/private/destination-preflight.json`. Schema application repeats the conflict check immediately before DDL and refuses existing application objects. Validation compares the approved columns, constraints, indexes, views, row triggers, policies, required functions/event triggers, and effective API-role/table privileges. Any schema mismatch stops validation and produces `schema-validation-failure.json` in the private snapshot directory. Existing platform objects that conflict with the migration require inspection; they are never silently overwritten.

Files:

- LIVE_COMPARISON.md: full live-versus-reconstructed comparison and grant limitations.
- reference/LIVE_SCHEMA.md / live-catalog.json: authoritative live application structure.
- reference/LIVE_DUMP_INVENTORY.md: all 526 objects, including platform objects not cloned.
- roundtrip.mjs: reconstructs original source fields from SQL rows, checking array order and timestamps.
- REVIEW.md: approval review, field mappings, decisions and risks.
- PROPOSED_SCHEMA.md / proposed-schema-catalog.json: proposed columns, keys, checks and indexes.
- reference/SCHEMA.md / reconstructed-catalog.json: exact locally reconstructed Sisters model, functions, triggers and RLS.
- firestore-inventory.json: collection counts, type/optionality and shape inventory without member values.
- export.mjs / analyze.mjs / compare-exports.mjs: read-only export and source checks.
- transform.mjs: explicit normalized mapping, unknown-field rejection and deterministic ID mapping.
- database.mjs / target.mjs: dependency-safe transactional import and complete typed-row validation.
- rehearse.mjs / test.mjs: local PostgreSQL rehearsal and failure-path tests.
- inspect-reference.sql: catalog-only read query for optional later live verification.
- ../supabase/migrations/: proposed owner-only Phase 1 SQL.

The live overview view and automatic-RLS event trigger are included. No runtime Sisters RPCs or auth-dependent policies are activated in Phase 1. All such reference definitions are retained for the later independently scoped application/Auth work. The production migration goal remains open until actual Men import and validation succeed.

Approved Men baseline adjustment: `reference/men-approved-rls-helper.json` records the verified existing helper and event trigger. The installer reuses that exact helper body (no replacement) and event registration, or creates the same baseline in an empty local database. Preflight rejects other function/event differences. The helper's sole behavioral change from Sisters is resolving the table name from its OID and using separate `%I` quoting for schema/table names. API-role and PUBLIC execution grants on both installed helper functions are explicitly revoked. Schema validation runs before schema commit and again during record validation. The reference Sisters dump remains unchanged.
