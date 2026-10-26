# Live Sisters versus prior reconstruction — complete comparison

Authoritative source supplied by the user: `C:\Users\Omar\Desktop\متقن نساء\Mutqin-app-for-sisters-\sisters-live-schema.sql` (PostgreSQL 17.6, pg_dump 18.6). This supersedes the old backup plus local migrations as the architectural reference.

**Result: the reconstruction matched the core tables, but was not a complete match to the live schema.** The live dump supplies one additional view, three previously missing legacy helper definitions, and the actual automatic-RLS event trigger. The 30 reconstructed functions, five row triggers and 21 policies match. One check expression differs only in parentheses, with identical behavior.

The entire dump was parsed into object blocks; [LIVE_DUMP_INVENTORY.md](reference/LIVE_DUMP_INVENTORY.md) names **every object**, including Supabase-managed internals omitted from the original application-only reconstruction. [live-comparison.json](reference/live-comparison.json) records every application catalog addition/removal/change with before/after definitions. [LIVE_SCHEMA.md](reference/LIVE_SCHEMA.md) lists all application table columns, constraints, indexes, functions, triggers, policies and the view. The complete original schema-only SQL is retained in `reference/sisters-live-schema.sql`; no Sisters production records were copied.

Both the previous reconstruction and the application subset of the live dump were executed in separate, empty local PostgreSQL/PGlite databases, using the same minimal Auth dependency stub. Catalogs were compared by object identity, not DDL ordering. Supabase-managed objects were inspected in the full dump but not installed into PGlite or into Men. No remote database was accessed or written in this comparison.

## All application differences

| Category | Finding | Men decision |
|---|---|---|
| Tables | Same 13 base tables; none added, removed or renamed. | Use the live CREATE TABLE statements directly. |
| Columns/types/defaults/nullability | All 116 base-table columns match, including order, type, default, nullability, identity/generated state and collation. Eight additional columns belong to the new view, not new stored data. | All live columns/types retained. Six previously documented legacy-null exceptions remain in Men. |
| Primary keys | All match. | Retain. |
| Foreign keys | All 28 match, including actions/deferrability/validation. | Retain except profiles→auth.users, explicitly deferred because Auth is outside Phase 1. All business-record FKs remain. |
| Unique constraints | All match. | Retain except the previously reviewed tasmia duplicate-history extension. |
| Check constraints | One textual grouping difference: peer_tests_range_check (below); all other checks match. | Use exact live expression. No change to accepted data. |
| Indexes | All 42 application indexes match, including unique/partial indexes and indexes backing constraints. | Retain, subject to documented Men preservation key extension. |
| Schemas | `public` and `app_private` already represented; live dump now supplies `private`. No application schema removed. `public` is implicit in the fresh dump rather than an explicit CREATE SCHEMA block. | Keep all as authoritative reference; deploy only Phase 1 public + migration_private. Auth-dependent helper schemas remain deferred as explained below. |
| Functions | All 30 executed reconstruction functions match exactly in catalog definitions, arguments, returns, bodies, volatility, security mode and search_path. Added to that catalog: private.is_active_cycle(uuid), private.is_active_user(), private.is_admin(), public.rls_auto_enable(). | Preserve all 34 definitions in authoritative reference. Deploy sync_deactivated_at and rls_auto_enable in Phase 1; do not activate Auth-dependent runtime APIs. |
| Row triggers | Same five, including trigger definitions/enabled state. | Keep existing Phase 1 deactivation trigger; four Auth/activity guards remain deferred for historical import. |
| Event triggers | `ensure_rls` is present and enabled. It calls public.rls_auto_enable on CREATE TABLE, CREATE TABLE AS, SELECT INTO. Old backup had the same function body but not its registration; old executed catalog omitted the function. | Add exact live function and event-trigger registration to Men. This enables RLS on future public tables; explicit revokes are still required. |
| RLS policies | All 21 match: target roles, commands, permissiveness, USING and WITH CHECK. RLS enabled/forced flags match on all 13 tables. | Retain as reference; Phase 1 has RLS enabled and no allow policies, with all API roles denied. |
| Views | New public.profile_batch_overview, security_invoker=true. No removed views. | Add the exact view to Men, with API grants revoked. Expected 30 derived rows; no separate import. |
| Enums/custom types | No user-defined enum/domain/composite types in public/private/app_private in either application model. Text CHECK conventions match. | Keep Sisters conventions. Platform types are inventoried separately. |
| Grants/default privileges/ownership | **Not verifiable.** The dump has no ACL, DEFAULT ACL, top-level GRANT/REVOKE or owner assignments. Restoring it produces defaults, which are not evidence of live permissions. Prior local migrations do contain grants/revokes. | Do not claim matching or removed grants. Keep explicit Men owner-only grants/revokes. A future ACL-inclusive dump/catalog is needed before reproducing Sisters runtime access. |

The four functions above are additions to the **previous executed catalog**, not four newly discovered business behaviors: `private.*` had unresolved references in the old backup, and `rls_auto_enable` already appeared verbatim there. Their definitions and active event registration are now known from live evidence.

`peer_tests_range_check` before:

```sql
CHECK ((((range_start >= 1) AND (range_start <= 240))
 AND ((range_end >= 1) AND (range_end <= 240))
 AND (range_start <= range_end)))
```

Live:

```sql
CHECK (((range_start >= 1) AND (range_start <= 240)
 AND ((range_end >= 1) AND (range_end <= 240))
 AND (range_start <= range_end)))
```

AND is associative, including PostgreSQL's NULL logic. The same five predicates apply; there is no behavior difference. A local regression check also covers boundary, out-of-range and null inputs. Raw catalog comparison retains this difference rather than silently hiding it.

## New view, fully specified

`public.profile_batch_overview` uses invoker privileges and joins profiles → batch_memberships → batches, grouped by profile. Columns:

| Column | Type |
|---|---|
| user_id | uuid |
| full_name | text |
| phone | text |
| role | text |
| active | boolean |
| deactivated_at | timestamptz |
| is_master_admin | boolean |
| batches | text |

`batches` reports “Master Admin - All Batches” for master admins, “No batch assigned” if none, otherwise a distinct, sorted comma-separated list of batch names. The exact live view SQL and security_invoker option are in the foundation migration. Its data is derived from Men profiles/memberships; no Sisters rows are involved.

## Full-dump platform scope (previously not reconstructed)

The dump also includes Supabase-managed infrastructure. These are **scope additions relative to the previous application-only reference**, not changes inferred to have occurred in Sisters. The object-by-object inventory enumerates all of them, including constraint and index names and links to exact SQL.

| Schema/scope | Objects represented |
|---|---|
| auth | 27 tables, 9 enum types, 4 functions, 1 sequence and ownership/default metadata; 39 standalone constraints, 24 FKs, 72 explicit indexes, 16 RLS-enable blocks, comments |
| realtime | 3 tables, 5 types (2 enums + 3 composites), 18 functions, 1 sequence, 3 standalone constraints, 1 separate CHECK, 3 explicit indexes, 1 row trigger, 1 RLS-enable block |
| storage | 8 tables, 1 enum, 19 functions, 9 standalone constraints, 5 FKs, 11 explicit indexes, 7 row triggers, 8 RLS-enable blocks, comments |
| supabase_migrations | 1 migration-history table and PK; no migration-history records |
| extensions | 6 platform functions plus extension comments |
| graphql_public | graphql function |
| pgbouncer | get_auth function definition; no credentials/results read |
| graphql, vault | schema declarations; extension-managed objects supplied by extensions rather than individual DDL |
| Extensions | pg_stat_statements, pgcrypto, supabase_vault, uuid-ossp |
| Publication | supabase_realtime (definition only) |
| Additional event triggers | issue_graphql_placeholder, issue_pg_cron_access, issue_pg_graphql_access, issue_pg_net_access, pgrst_ddl_watch, pgrst_drop_watch |

Full-dump totals: 52 tables, 83 functions, 15 types (12 enums + 3 composites), one view, 13 row triggers, seven event triggers, two sequences, 21 policies, four extensions and one publication. Inline checks are included in table definitions; standalone object counts are not the total number of constraints. All 39 non-application tables are excluded from the Men migration. Supabase provisions its own Auth/Storage/Realtime/extension infrastructure; cloning these internal schemas could conflict with the destination platform and would exceed Phase 1.

## Updated target and mapping impact

Men's foundation migration now reads the live dump directly rather than reconstructing table DDL from the old files. It keeps exact live table/constraint/index definitions, creates the new view, and registers ensure_rls. All source mappings and expected imported counts remain unchanged. Existing preservation extensions remain necessary because the live schema has the same historical-data limitations as the reconstruction.

Phase 1 deviations remain explicit: no Auth migration/FK; no Auth-dependent RLS policies or RPC activation; no historical guard triggers that reject archived records or overwrite snapshots; extra original-ID, duplicate-history, unknown-day/layout, audience/prerequisite and provenance fields. These are not claims that the full runtime schema is already deployed. See [REVIEW.md](REVIEW.md) for every field mapping, extension, row count, import order and approval decision.
