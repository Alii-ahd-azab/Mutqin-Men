# Production preflight — 2026-10-25

## Approved resolution

The user subsequently approved retaining the existing Men helper. Exact comparison confirmed that only the added `tbl name` declaration and the catalog lookup/qualified-identifier quoting differ; all other function attributes and the event trigger match. The installer and expected catalog now use this baseline. Existing helper OID/body are preserved; PUBLIC/API-role EXECUTE grants are explicitly revoked. Six local tests pass, including existing-helper reuse and quoted-identifier automatic RLS. Repeated TLS-verified production preflight for `uaublandjewfzmhnbflc` passes with no other conflicts. The historical findings below describe the original stop, not the current approval status.

Production import has not started. No schema or data writes have occurred.

The supplied session-pooler username routes to the authorized Men project `uaublandjewfzmhnbflc`. TLS certificate and hostname verification succeeded after adding the official Supabase production CA to the Node trust store for this process. Connected database and role: `postgres` / `postgres`. Sisters was not connected to or modified.

Certificate source was resolved from the official Supabase Studio source:
https://raw.githubusercontent.com/supabase/supabase/master/apps/studio/hooks/custom-content/custom-content.json

Downloaded public CA (ignored private directory):
https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt

The read-only catalog found no tables, views, policies, or standalone custom types in the inspected application schemas (`public`, `private`, `app_private`, `migration_private`). It found an existing `public.rls_auto_enable()` function and `ensure_rls` event trigger. Full catalog is in ignored `migration/private/destination-preflight.json`.

The event trigger definition matches the approved target. The existing function has the same signature, return type, security-definer setting, search path, volatility, and command filters, but its body differs:

Approved Sisters-derived version:

```sql
EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
```

Existing Men version adds `tbl name` to its declarations and uses:

```sql
SELECT c.relname INTO tbl FROM pg_catalog.pg_class c WHERE c.oid = cmd.objid;
EXECUTE format('alter table if exists %I.%I enable row level security', cmd.schema_name, tbl);
```

The existing version resolves the table name through the catalog and quotes schema/table identifiers separately. Both versions intend to enable RLS automatically for new public tables. Existing function EXECUTE grants include PUBLIC and the API roles; these are not inferred as the intended Phase 1 permissions.

The current migration would attempt to CREATE these existing objects and fail. The preflight correctly rejected this state before DDL. No final Firestore snapshot was taken because it must be taken immediately before the eventual import.

Recommended resolution, pending user direction: retain the existing Men helper body and matching event trigger; adapt schema installation to verify and reuse these exact existing definitions; explicitly revoke helper EXECUTE grants from PUBLIC and API roles as part of approved owner-only Phase 1 permissions; update the expected schema catalog and rerun local tests. This avoids downgrading or replacing the existing platform helper. This resolution has not been applied.

After resolution: repeat read-only destination verification, take a new Firestore export, compare with the validated 926-document snapshot, rehearse transformation, import transactionally, and run complete production validation. The migration remains incomplete.
