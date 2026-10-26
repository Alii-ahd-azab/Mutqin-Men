# Complete live dump inventory

Every pg_dump object block was inspected and classified. Inline column/check definitions remain in their TABLE block; full SQL is linked by source line. The prior reconstruction covered the application model, not Supabase-managed internals. Platform entries below are outside that previous scope, not evidence that Sisters recently created them. No ACL blocks or production data blocks exist in this dump.

SHA-256: `041bccfc29ebdd1d2015058a143da5e0bd0c5a33cb3141e0a7ce091b75312db8`. 526 object blocks.

| Scope | Schema | Type | Object | Live SQL line |
|---|---|---|---|---|
| Application | - | SCHEMA | app_private | [23](sisters-live-schema.sql#L23) |
| Platform / dump metadata | - | SCHEMA | auth | [30](sisters-live-schema.sql#L30) |
| Platform / dump metadata | - | SCHEMA | extensions | [37](sisters-live-schema.sql#L37) |
| Platform / dump metadata | - | SCHEMA | graphql | [44](sisters-live-schema.sql#L44) |
| Platform / dump metadata | - | SCHEMA | graphql_public | [51](sisters-live-schema.sql#L51) |
| Platform / dump metadata | - | SCHEMA | pgbouncer | [58](sisters-live-schema.sql#L58) |
| Application | - | SCHEMA | private | [65](sisters-live-schema.sql#L65) |
| Platform / dump metadata | - | SCHEMA | realtime | [72](sisters-live-schema.sql#L72) |
| Platform / dump metadata | - | SCHEMA | storage | [79](sisters-live-schema.sql#L79) |
| Platform / dump metadata | - | SCHEMA | supabase_migrations | [86](sisters-live-schema.sql#L86) |
| Platform / dump metadata | - | SCHEMA | vault | [93](sisters-live-schema.sql#L93) |
| Platform / dump metadata | - | EXTENSION | pg_stat_statements | [100](sisters-live-schema.sql#L100) |
| Platform / dump metadata | - | COMMENT | EXTENSION pg_stat_statements | [107](sisters-live-schema.sql#L107) |
| Platform / dump metadata | - | EXTENSION | pgcrypto | [114](sisters-live-schema.sql#L114) |
| Platform / dump metadata | - | COMMENT | EXTENSION pgcrypto | [121](sisters-live-schema.sql#L121) |
| Platform / dump metadata | - | EXTENSION | supabase_vault | [128](sisters-live-schema.sql#L128) |
| Platform / dump metadata | - | COMMENT | EXTENSION supabase_vault | [135](sisters-live-schema.sql#L135) |
| Platform / dump metadata | - | EXTENSION | uuid-ossp | [142](sisters-live-schema.sql#L142) |
| Platform / dump metadata | - | COMMENT | EXTENSION "uuid-ossp" | [149](sisters-live-schema.sql#L149) |
| Platform / dump metadata | auth | TYPE | aal_level | [156](sisters-live-schema.sql#L156) |
| Platform / dump metadata | auth | TYPE | code_challenge_method | [167](sisters-live-schema.sql#L167) |
| Platform / dump metadata | auth | TYPE | factor_status | [177](sisters-live-schema.sql#L177) |
| Platform / dump metadata | auth | TYPE | factor_type | [187](sisters-live-schema.sql#L187) |
| Platform / dump metadata | auth | TYPE | oauth_authorization_status | [199](sisters-live-schema.sql#L199) |
| Platform / dump metadata | auth | TYPE | oauth_client_type | [211](sisters-live-schema.sql#L211) |
| Platform / dump metadata | auth | TYPE | oauth_registration_type | [221](sisters-live-schema.sql#L221) |
| Platform / dump metadata | auth | TYPE | oauth_response_type | [231](sisters-live-schema.sql#L231) |
| Platform / dump metadata | auth | TYPE | one_time_token_type | [240](sisters-live-schema.sql#L240) |
| Platform / dump metadata | realtime | TYPE | action | [254](sisters-live-schema.sql#L254) |
| Platform / dump metadata | realtime | TYPE | equality_op | [267](sisters-live-schema.sql#L267) |
| Platform / dump metadata | realtime | TYPE | user_defined_filter | [288](sisters-live-schema.sql#L288) |
| Platform / dump metadata | realtime | TYPE | wal_column | [300](sisters-live-schema.sql#L300) |
| Platform / dump metadata | realtime | TYPE | wal_rls | [314](sisters-live-schema.sql#L314) |
| Platform / dump metadata | storage | TYPE | buckettype | [326](sisters-live-schema.sql#L326) |
| Application | app_private | FUNCTION | assert_no_overlapping_peer_test(uuid, uuid[], timestamp with time zone, timestamp with time zone) | [337](sisters-live-schema.sql#L337) |
| Application | app_private | FUNCTION | batch_memberships_guard() | [362](sisters-live-schema.sql#L362) |
| Application | app_private | FUNCTION | cycle_batch_id(uuid) | [416](sisters-live-schema.sql#L416) |
| Application | app_private | FUNCTION | is_master_admin() | [428](sisters-live-schema.sql#L428) |
| Application | app_private | FUNCTION | managed_batch_ids() | [447](sisters-live-schema.sql#L447) |
| Application | app_private | FUNCTION | managed_cycle_ids() | [469](sisters-live-schema.sql#L469) |
| Application | app_private | FUNCTION | managed_peer_test_ids() | [483](sisters-live-schema.sql#L483) |
| Application | app_private | FUNCTION | member_active_cycle_id() | [497](sisters-live-schema.sql#L497) |
| Application | app_private | FUNCTION | member_batch_id() | [513](sisters-live-schema.sql#L513) |
| Application | app_private | FUNCTION | peer_test_future_window(timestamp with time zone, timestamp with time zone) | [532](sisters-live-schema.sql#L532) |
| Application | app_private | FUNCTION | peer_test_is_live(text, timestamp with time zone, timestamp with time zone) | [553](sisters-live-schema.sql#L553) |
| Application | app_private | FUNCTION | profiles_batch_guard() | [567](sisters-live-schema.sql#L567) |
| Application | app_private | FUNCTION | review_batch_guard() | [594](sisters-live-schema.sql#L594) |
| Application | app_private | FUNCTION | tasmia_batch_guard() | [636](sisters-live-schema.sql#L636) |
| Application | app_private | FUNCTION | tasmia_listener_name(uuid, uuid, uuid) | [729](sisters-live-schema.sql#L729) |
| Application | app_private | FUNCTION | viewable_batch_ids() | [749](sisters-live-schema.sql#L749) |
| Application | app_private | FUNCTION | viewable_profile_ids() | [764](sisters-live-schema.sql#L764) |
| Application | app_private | FUNCTION | visible_peer_attempt_ids() | [795](sisters-live-schema.sql#L795) |
| Platform / dump metadata | auth | FUNCTION | email() | [811](sisters-live-schema.sql#L811) |
| Platform / dump metadata | auth | COMMENT | FUNCTION email() | [826](sisters-live-schema.sql#L826) |
| Platform / dump metadata | auth | FUNCTION | jwt() | [833](sisters-live-schema.sql#L833) |
| Platform / dump metadata | auth | FUNCTION | role() | [848](sisters-live-schema.sql#L848) |
| Platform / dump metadata | auth | COMMENT | FUNCTION role() | [863](sisters-live-schema.sql#L863) |
| Platform / dump metadata | auth | FUNCTION | uid() | [870](sisters-live-schema.sql#L870) |
| Platform / dump metadata | auth | COMMENT | FUNCTION uid() | [885](sisters-live-schema.sql#L885) |
| Platform / dump metadata | extensions | FUNCTION | grant_pg_cron_access() | [892](sisters-live-schema.sql#L892) |
| Platform / dump metadata | extensions | COMMENT | FUNCTION grant_pg_cron_access() | [931](sisters-live-schema.sql#L931) |
| Platform / dump metadata | extensions | FUNCTION | grant_pg_graphql_access() | [938](sisters-live-schema.sql#L938) |
| Platform / dump metadata | extensions | COMMENT | FUNCTION grant_pg_graphql_access() | [986](sisters-live-schema.sql#L986) |
| Platform / dump metadata | extensions | FUNCTION | grant_pg_net_access() | [993](sisters-live-schema.sql#L993) |
| Platform / dump metadata | extensions | COMMENT | FUNCTION grant_pg_net_access() | [1045](sisters-live-schema.sql#L1045) |
| Platform / dump metadata | extensions | FUNCTION | pgrst_ddl_watch() | [1052](sisters-live-schema.sql#L1052) |
| Platform / dump metadata | extensions | FUNCTION | pgrst_drop_watch() | [1086](sisters-live-schema.sql#L1086) |
| Platform / dump metadata | extensions | FUNCTION | set_graphql_placeholder() | [1118](sisters-live-schema.sql#L1118) |
| Platform / dump metadata | extensions | COMMENT | FUNCTION set_graphql_placeholder() | [1177](sisters-live-schema.sql#L1177) |
| Platform / dump metadata | graphql_public | FUNCTION | graphql(text, text, jsonb, jsonb) | [1184](sisters-live-schema.sql#L1184) |
| Platform / dump metadata | pgbouncer | FUNCTION | get_auth(text) | [1217](sisters-live-schema.sql#L1217) |
| Application | private | FUNCTION | is_active_cycle(uuid) | [1241](sisters-live-schema.sql#L1241) |
| Application | private | FUNCTION | is_active_user() | [1258](sisters-live-schema.sql#L1258) |
| Application | private | FUNCTION | is_admin() | [1275](sisters-live-schema.sql#L1275) |
| Application | public | FUNCTION | correct_tasmia_listener(uuid, uuid) | [1293](sisters-live-schema.sql#L1293) |
| Application | public | FUNCTION | create_batch_with_cycle(text, date, uuid) | [1379](sisters-live-schema.sql#L1379) |
| Application | public | FUNCTION | create_profile_with_membership(uuid, text, text, text, boolean, uuid, uuid[], uuid) | [1415](sisters-live-schema.sql#L1415) |
| Application | public | FUNCTION | history_member_names(uuid) | [1462](sisters-live-schema.sql#L1462) |
| Application | public | FUNCTION | move_member_batch(uuid, uuid, uuid, uuid) | [1499](sisters-live-schema.sql#L1499) |
| Application | public | FUNCTION | peer_test_save(uuid, uuid, text, integer, integer, integer, integer, integer, text, text, text, timestamp with time zone, timestamp with time zone, uuid) | [1597](sisters-live-schema.sql#L1597) |
| Application | public | FUNCTION | peer_test_set_status(uuid, text, uuid) | [1697](sisters-live-schema.sql#L1697) |
| Application | public | FUNCTION | peer_test_start_attempt(uuid, uuid, uuid, jsonb) | [1753](sisters-live-schema.sql#L1753) |
| Application | public | FUNCTION | peer_test_submit_attempt(uuid, uuid, integer[], text[], text) | [1857](sisters-live-schema.sql#L1857) |
| Application | public | FUNCTION | rls_auto_enable() | [1923](sisters-live-schema.sql#L1923) |
| Application | public | FUNCTION | set_admin_batches(uuid, uuid[], uuid) | [1956](sisters-live-schema.sql#L1956) |
| Application | public | FUNCTION | start_next_cycle(uuid, date, uuid, uuid) | [1983](sisters-live-schema.sql#L1983) |
| Application | public | FUNCTION | sync_deactivated_at() | [2073](sisters-live-schema.sql#L2073) |
| Platform / dump metadata | realtime | FUNCTION | apply_rls(jsonb, integer) | [2092](sisters-live-schema.sql#L2092) |
| Platform / dump metadata | realtime | FUNCTION | authorize(text, text, text, text, text, text[], text[]) | [2467](sisters-live-schema.sql#L2467) |
| Platform / dump metadata | realtime | FUNCTION | broadcast_changes(text, text, text, text, text, record, record, text) | [2536](sisters-live-schema.sql#L2536) |
| Platform / dump metadata | realtime | FUNCTION | build_prepared_statement_sql(text, regclass, realtime.wal_column[]) | [2565](sisters-live-schema.sql#L2565) |
| Platform / dump metadata | realtime | FUNCTION | cast(text, regtype) | [2598](sisters-live-schema.sql#L2598) |
| Platform / dump metadata | realtime | FUNCTION | check_equality_op(realtime.equality_op, regtype, text, text) | [2617](sisters-live-schema.sql#L2617) |
| Platform / dump metadata | realtime | FUNCTION | check_equality_op(realtime.equality_op, regtype, text, text, boolean) | [2656](sisters-live-schema.sql#L2656) |
| Platform / dump metadata | realtime | FUNCTION | is_visible_through_filters(realtime.wal_column[], realtime.user_defined_filter[]) | [2728](sisters-live-schema.sql#L2728) |
| Platform / dump metadata | realtime | FUNCTION | list_changes(name, name, integer, integer) | [2758](sisters-live-schema.sql#L2758) |
| Platform / dump metadata | realtime | FUNCTION | list_changes_sync(name, name, integer, integer) | [2828](sisters-live-schema.sql#L2828) |
| Platform / dump metadata | realtime | FUNCTION | quote_wal2json(regclass) | [2898](sisters-live-schema.sql#L2898) |
| Platform / dump metadata | realtime | FUNCTION | send(jsonb, text, text, boolean) | [2915](sisters-live-schema.sql#L2915) |
| Platform / dump metadata | realtime | FUNCTION | send_binary(bytea, text, text, boolean) | [2949](sisters-live-schema.sql#L2949) |
| Platform / dump metadata | realtime | FUNCTION | settled_changes(name, integer, text[]) | [2974](sisters-live-schema.sql#L2974) |
| Platform / dump metadata | realtime | FUNCTION | subscription_check_filters() | [3065](sisters-live-schema.sql#L3065) |
| Platform / dump metadata | realtime | FUNCTION | to_regrole(text) | [3194](sisters-live-schema.sql#L3194) |
| Platform / dump metadata | realtime | FUNCTION | topic() | [3203](sisters-live-schema.sql#L3203) |
| Platform / dump metadata | realtime | FUNCTION | wal2json_escape_identifier(text) | [3214](sisters-live-schema.sql#L3214) |
| Platform / dump metadata | storage | FUNCTION | allow_any_operation(text[]) | [3226](sisters-live-schema.sql#L3226) |
| Platform / dump metadata | storage | FUNCTION | allow_only_operation(text) | [3257](sisters-live-schema.sql#L3257) |
| Platform / dump metadata | storage | FUNCTION | can_insert_object(text, text, uuid, jsonb) | [3287](sisters-live-schema.sql#L3287) |
| Platform / dump metadata | storage | FUNCTION | enforce_bucket_lifecycle_service_role() | [3304](sisters-live-schema.sql#L3304) |
| Platform / dump metadata | storage | FUNCTION | enforce_bucket_name_length() | [3333](sisters-live-schema.sql#L3333) |
| Platform / dump metadata | storage | FUNCTION | extension(text) | [3349](sisters-live-schema.sql#L3349) |
| Platform / dump metadata | storage | FUNCTION | filename(text) | [3370](sisters-live-schema.sql#L3370) |
| Platform / dump metadata | storage | FUNCTION | foldername(text) | [3386](sisters-live-schema.sql#L3386) |
| Platform / dump metadata | storage | FUNCTION | get_common_prefix(text, text, text) | [3404](sisters-live-schema.sql#L3404) |
| Platform / dump metadata | storage | FUNCTION | get_size_by_bucket(text, text) | [3425](sisters-live-schema.sql#L3425) |
| Platform / dump metadata | storage | FUNCTION | list_multipart_uploads_with_delimiter(text, text, text, integer, text, text, text) | [3456](sisters-live-schema.sql#L3456) |
| Platform / dump metadata | storage | FUNCTION | list_objects_with_delimiter(text, text, text, integer, text, text, text, text, text, timestamp with time zone, text) | [3520](sisters-live-schema.sql#L3520) |
| Platform / dump metadata | storage | FUNCTION | operation() | [4150](sisters-live-schema.sql#L4150) |
| Platform / dump metadata | storage | FUNCTION | protect_bucket_control_columns() | [4163](sisters-live-schema.sql#L4163) |
| Platform / dump metadata | storage | FUNCTION | protect_delete() | [4221](sisters-live-schema.sql#L4221) |
| Platform / dump metadata | storage | FUNCTION | search(text, text, integer, integer, integer, text, text, text, text, text) | [4240](sisters-live-schema.sql#L4240) |
| Platform / dump metadata | storage | FUNCTION | search_by_timestamp(text, text, integer, integer, text, text, text, text, text, text, text) | [4796](sisters-live-schema.sql#L4796) |
| Platform / dump metadata | storage | FUNCTION | search_v2(text, text, integer, integer, text, text, text, text, text, text, timestamp with time zone, text, boolean) | [4968](sisters-live-schema.sql#L4968) |
| Platform / dump metadata | storage | FUNCTION | update_updated_at_column() | [5037](sisters-live-schema.sql#L5037) |
| Platform / dump metadata | auth | TABLE | audit_log_entries | [5055](sisters-live-schema.sql#L5055) |
| Platform / dump metadata | auth | COMMENT | TABLE audit_log_entries | [5068](sisters-live-schema.sql#L5068) |
| Platform / dump metadata | auth | TABLE | custom_oauth_providers | [5075](sisters-live-schema.sql#L5075) |
| Platform / dump metadata | auth | TABLE | flow_state | [5126](sisters-live-schema.sql#L5126) |
| Platform / dump metadata | auth | COMMENT | TABLE flow_state | [5151](sisters-live-schema.sql#L5151) |
| Platform / dump metadata | auth | TABLE | identities | [5158](sisters-live-schema.sql#L5158) |
| Platform / dump metadata | auth | COMMENT | TABLE identities | [5175](sisters-live-schema.sql#L5175) |
| Platform / dump metadata | auth | COMMENT | COLUMN identities.email | [5182](sisters-live-schema.sql#L5182) |
| Platform / dump metadata | auth | TABLE | instances | [5189](sisters-live-schema.sql#L5189) |
| Platform / dump metadata | auth | COMMENT | TABLE instances | [5202](sisters-live-schema.sql#L5202) |
| Platform / dump metadata | auth | TABLE | mfa_amr_claims | [5209](sisters-live-schema.sql#L5209) |
| Platform / dump metadata | auth | COMMENT | TABLE mfa_amr_claims | [5222](sisters-live-schema.sql#L5222) |
| Platform / dump metadata | auth | TABLE | mfa_challenges | [5229](sisters-live-schema.sql#L5229) |
| Platform / dump metadata | auth | COMMENT | TABLE mfa_challenges | [5244](sisters-live-schema.sql#L5244) |
| Platform / dump metadata | auth | TABLE | mfa_factors | [5251](sisters-live-schema.sql#L5251) |
| Platform / dump metadata | auth | COMMENT | TABLE mfa_factors | [5272](sisters-live-schema.sql#L5272) |
| Platform / dump metadata | auth | COMMENT | COLUMN mfa_factors.last_webauthn_challenge_data | [5279](sisters-live-schema.sql#L5279) |
| Platform / dump metadata | auth | TABLE | mfa_recovery_code_sets | [5286](sisters-live-schema.sql#L5286) |
| Platform / dump metadata | auth | TABLE | mfa_recovery_codes | [5302](sisters-live-schema.sql#L5302) |
| Platform / dump metadata | auth | TABLE | oauth_authorizations | [5315](sisters-live-schema.sql#L5315) |
| Platform / dump metadata | auth | TABLE | oauth_client_states | [5348](sisters-live-schema.sql#L5348) |
| Platform / dump metadata | auth | COMMENT | TABLE oauth_client_states | [5360](sisters-live-schema.sql#L5360) |
| Platform / dump metadata | auth | TABLE | oauth_clients | [5367](sisters-live-schema.sql#L5367) |
| Platform / dump metadata | auth | TABLE | oauth_consents | [5392](sisters-live-schema.sql#L5392) |
| Platform / dump metadata | auth | TABLE | one_time_tokens | [5409](sisters-live-schema.sql#L5409) |
| Platform / dump metadata | auth | TABLE | refresh_tokens | [5426](sisters-live-schema.sql#L5426) |
| Platform / dump metadata | auth | COMMENT | TABLE refresh_tokens | [5443](sisters-live-schema.sql#L5443) |
| Platform / dump metadata | auth | SEQUENCE | refresh_tokens_id_seq | [5450](sisters-live-schema.sql#L5450) |
| Platform / dump metadata | auth | SEQUENCE OWNED BY | refresh_tokens_id_seq | [5462](sisters-live-schema.sql#L5462) |
| Platform / dump metadata | auth | TABLE | saml_providers | [5469](sisters-live-schema.sql#L5469) |
| Platform / dump metadata | auth | COMMENT | TABLE saml_providers | [5489](sisters-live-schema.sql#L5489) |
| Platform / dump metadata | auth | TABLE | saml_relay_states | [5496](sisters-live-schema.sql#L5496) |
| Platform / dump metadata | auth | COMMENT | TABLE saml_relay_states | [5513](sisters-live-schema.sql#L5513) |
| Platform / dump metadata | auth | TABLE | schema_migrations | [5520](sisters-live-schema.sql#L5520) |
| Platform / dump metadata | auth | COMMENT | TABLE schema_migrations | [5529](sisters-live-schema.sql#L5529) |
| Platform / dump metadata | auth | TABLE | scim_tokens | [5536](sisters-live-schema.sql#L5536) |
| Platform / dump metadata | auth | TABLE | scim_users | [5555](sisters-live-schema.sql#L5555) |
| Platform / dump metadata | auth | TABLE | sessions | [5573](sisters-live-schema.sql#L5573) |
| Platform / dump metadata | auth | COMMENT | TABLE sessions | [5597](sisters-live-schema.sql#L5597) |
| Platform / dump metadata | auth | COMMENT | COLUMN sessions.not_after | [5604](sisters-live-schema.sql#L5604) |
| Platform / dump metadata | auth | COMMENT | COLUMN sessions.refresh_token_hmac_key | [5611](sisters-live-schema.sql#L5611) |
| Platform / dump metadata | auth | COMMENT | COLUMN sessions.refresh_token_counter | [5618](sisters-live-schema.sql#L5618) |
| Platform / dump metadata | auth | TABLE | sso_domains | [5625](sisters-live-schema.sql#L5625) |
| Platform / dump metadata | auth | COMMENT | TABLE sso_domains | [5639](sisters-live-schema.sql#L5639) |
| Platform / dump metadata | auth | TABLE | sso_providers | [5646](sisters-live-schema.sql#L5646) |
| Platform / dump metadata | auth | COMMENT | TABLE sso_providers | [5660](sisters-live-schema.sql#L5660) |
| Platform / dump metadata | auth | COMMENT | COLUMN sso_providers.resource_id | [5667](sisters-live-schema.sql#L5667) |
| Platform / dump metadata | auth | TABLE | users | [5674](sisters-live-schema.sql#L5674) |
| Platform / dump metadata | auth | COMMENT | TABLE users | [5718](sisters-live-schema.sql#L5718) |
| Platform / dump metadata | auth | COMMENT | COLUMN users.is_sso_user | [5725](sisters-live-schema.sql#L5725) |
| Platform / dump metadata | auth | TABLE | webauthn_challenges | [5732](sisters-live-schema.sql#L5732) |
| Platform / dump metadata | auth | TABLE | webauthn_credentials | [5747](sisters-live-schema.sql#L5747) |
| Application | public | TABLE | batch_membership_transfers | [5769](sisters-live-schema.sql#L5769) |
| Application | public | TABLE | batch_memberships | [5783](sisters-live-schema.sql#L5783) |
| Application | public | TABLE | batches | [5799](sisters-live-schema.sql#L5799) |
| Application | public | TABLE | cycles | [5813](sisters-live-schema.sql#L5813) |
| Application | public | TABLE | daily_thoughts | [5831](sisters-live-schema.sql#L5831) |
| Application | public | TABLE | group_rest_days | [5845](sisters-live-schema.sql#L5845) |
| Application | public | TABLE | peer_test_attempt_questions | [5859](sisters-live-schema.sql#L5859) |
| Application | public | TABLE | peer_test_attempts | [5886](sisters-live-schema.sql#L5886) |
| Application | public | TABLE | peer_tests | [5909](sisters-live-schema.sql#L5909) |
| Application | public | TABLE | profiles | [5943](sisters-live-schema.sql#L5943) |
| Application | public | VIEW | profile_batch_overview | [5961](sisters-live-schema.sql#L5961) |
| Application | public | TABLE | program_pauses | [5984](sisters-live-schema.sql#L5984) |
| Application | public | TABLE | review_confirmations | [6000](sisters-live-schema.sql#L6000) |
| Application | public | TABLE | tasmia_submissions | [6019](sisters-live-schema.sql#L6019) |
| Platform / dump metadata | realtime | TABLE | messages | [6038](sisters-live-schema.sql#L6038) |
| Platform / dump metadata | realtime | TABLE | schema_migrations | [6057](sisters-live-schema.sql#L6057) |
| Platform / dump metadata | realtime | TABLE | subscription | [6067](sisters-live-schema.sql#L6067) |
| Platform / dump metadata | realtime | SEQUENCE | subscription_id_seq | [6085](sisters-live-schema.sql#L6085) |
| Platform / dump metadata | storage | TABLE | buckets | [6099](sisters-live-schema.sql#L6099) |
| Platform / dump metadata | storage | COMMENT | COLUMN buckets.owner | [6131](sisters-live-schema.sql#L6131) |
| Platform / dump metadata | storage | TABLE | buckets_analytics | [6138](sisters-live-schema.sql#L6138) |
| Platform / dump metadata | storage | TABLE | buckets_vectors | [6153](sisters-live-schema.sql#L6153) |
| Platform / dump metadata | storage | TABLE | migrations | [6165](sisters-live-schema.sql#L6165) |
| Platform / dump metadata | storage | TABLE | objects | [6177](sisters-live-schema.sql#L6177) |
| Platform / dump metadata | storage | COMMENT | COLUMN objects.owner | [6200](sisters-live-schema.sql#L6200) |
| Platform / dump metadata | storage | TABLE | s3_multipart_uploads | [6207](sisters-live-schema.sql#L6207) |
| Platform / dump metadata | storage | TABLE | s3_multipart_uploads_parts | [6225](sisters-live-schema.sql#L6225) |
| Platform / dump metadata | storage | TABLE | vector_indexes | [6243](sisters-live-schema.sql#L6243) |
| Platform / dump metadata | supabase_migrations | TABLE | schema_migrations | [6260](sisters-live-schema.sql#L6260) |
| Platform / dump metadata | auth | DEFAULT | refresh_tokens id | [6271](sisters-live-schema.sql#L6271) |
| Platform / dump metadata | auth | CONSTRAINT | mfa_amr_claims amr_id_pk | [6278](sisters-live-schema.sql#L6278) |
| Platform / dump metadata | auth | CONSTRAINT | audit_log_entries audit_log_entries_pkey | [6286](sisters-live-schema.sql#L6286) |
| Platform / dump metadata | auth | CONSTRAINT | custom_oauth_providers custom_oauth_providers_identifier_key | [6294](sisters-live-schema.sql#L6294) |
| Platform / dump metadata | auth | CONSTRAINT | custom_oauth_providers custom_oauth_providers_pkey | [6302](sisters-live-schema.sql#L6302) |
| Platform / dump metadata | auth | CONSTRAINT | flow_state flow_state_pkey | [6310](sisters-live-schema.sql#L6310) |
| Platform / dump metadata | auth | CONSTRAINT | identities identities_pkey | [6318](sisters-live-schema.sql#L6318) |
| Platform / dump metadata | auth | CONSTRAINT | identities identities_provider_id_provider_unique | [6326](sisters-live-schema.sql#L6326) |
| Platform / dump metadata | auth | CONSTRAINT | instances instances_pkey | [6334](sisters-live-schema.sql#L6334) |
| Platform / dump metadata | auth | CONSTRAINT | mfa_amr_claims mfa_amr_claims_session_id_authentication_method_pkey | [6342](sisters-live-schema.sql#L6342) |
| Platform / dump metadata | auth | CONSTRAINT | mfa_challenges mfa_challenges_pkey | [6350](sisters-live-schema.sql#L6350) |
| Platform / dump metadata | auth | CONSTRAINT | mfa_factors mfa_factors_last_challenged_at_key | [6358](sisters-live-schema.sql#L6358) |
| Platform / dump metadata | auth | CONSTRAINT | mfa_factors mfa_factors_pkey | [6366](sisters-live-schema.sql#L6366) |
| Platform / dump metadata | auth | CONSTRAINT | mfa_recovery_code_sets mfa_recovery_code_sets_mfa_factor_id_key | [6374](sisters-live-schema.sql#L6374) |
| Platform / dump metadata | auth | CONSTRAINT | mfa_recovery_code_sets mfa_recovery_code_sets_pkey | [6382](sisters-live-schema.sql#L6382) |
| Platform / dump metadata | auth | CONSTRAINT | mfa_recovery_code_sets mfa_recovery_code_sets_user_id_key | [6390](sisters-live-schema.sql#L6390) |
| Platform / dump metadata | auth | CONSTRAINT | mfa_recovery_codes mfa_recovery_codes_pkey | [6398](sisters-live-schema.sql#L6398) |
| Platform / dump metadata | auth | CONSTRAINT | oauth_authorizations oauth_authorizations_authorization_code_key | [6406](sisters-live-schema.sql#L6406) |
| Platform / dump metadata | auth | CONSTRAINT | oauth_authorizations oauth_authorizations_authorization_id_key | [6414](sisters-live-schema.sql#L6414) |
| Platform / dump metadata | auth | CONSTRAINT | oauth_authorizations oauth_authorizations_pkey | [6422](sisters-live-schema.sql#L6422) |
| Platform / dump metadata | auth | CONSTRAINT | oauth_client_states oauth_client_states_pkey | [6430](sisters-live-schema.sql#L6430) |
| Platform / dump metadata | auth | CONSTRAINT | oauth_clients oauth_clients_pkey | [6438](sisters-live-schema.sql#L6438) |
| Platform / dump metadata | auth | CONSTRAINT | oauth_consents oauth_consents_pkey | [6446](sisters-live-schema.sql#L6446) |
| Platform / dump metadata | auth | CONSTRAINT | oauth_consents oauth_consents_user_client_unique | [6454](sisters-live-schema.sql#L6454) |
| Platform / dump metadata | auth | CONSTRAINT | one_time_tokens one_time_tokens_pkey | [6462](sisters-live-schema.sql#L6462) |
| Platform / dump metadata | auth | CONSTRAINT | refresh_tokens refresh_tokens_pkey | [6470](sisters-live-schema.sql#L6470) |
| Platform / dump metadata | auth | CONSTRAINT | refresh_tokens refresh_tokens_token_unique | [6478](sisters-live-schema.sql#L6478) |
| Platform / dump metadata | auth | CONSTRAINT | saml_providers saml_providers_entity_id_key | [6486](sisters-live-schema.sql#L6486) |
| Platform / dump metadata | auth | CONSTRAINT | saml_providers saml_providers_pkey | [6494](sisters-live-schema.sql#L6494) |
| Platform / dump metadata | auth | CONSTRAINT | saml_relay_states saml_relay_states_pkey | [6502](sisters-live-schema.sql#L6502) |
| Platform / dump metadata | auth | CONSTRAINT | schema_migrations schema_migrations_pkey | [6510](sisters-live-schema.sql#L6510) |
| Platform / dump metadata | auth | CONSTRAINT | scim_tokens scim_tokens_pkey | [6518](sisters-live-schema.sql#L6518) |
| Platform / dump metadata | auth | CONSTRAINT | scim_users scim_users_pkey | [6526](sisters-live-schema.sql#L6526) |
| Platform / dump metadata | auth | CONSTRAINT | sessions sessions_pkey | [6534](sisters-live-schema.sql#L6534) |
| Platform / dump metadata | auth | CONSTRAINT | sso_domains sso_domains_pkey | [6542](sisters-live-schema.sql#L6542) |
| Platform / dump metadata | auth | CONSTRAINT | sso_providers sso_providers_pkey | [6550](sisters-live-schema.sql#L6550) |
| Platform / dump metadata | auth | CONSTRAINT | users users_phone_key | [6558](sisters-live-schema.sql#L6558) |
| Platform / dump metadata | auth | CONSTRAINT | users users_pkey | [6566](sisters-live-schema.sql#L6566) |
| Platform / dump metadata | auth | CONSTRAINT | webauthn_challenges webauthn_challenges_pkey | [6574](sisters-live-schema.sql#L6574) |
| Platform / dump metadata | auth | CONSTRAINT | webauthn_credentials webauthn_credentials_pkey | [6582](sisters-live-schema.sql#L6582) |
| Application | public | CONSTRAINT | batch_membership_transfers batch_membership_transfers_pkey | [6590](sisters-live-schema.sql#L6590) |
| Application | public | CONSTRAINT | batch_memberships batch_memberships_batch_user_key | [6598](sisters-live-schema.sql#L6598) |
| Application | public | CONSTRAINT | batch_memberships batch_memberships_pkey | [6606](sisters-live-schema.sql#L6606) |
| Application | public | CONSTRAINT | batches batches_pkey | [6614](sisters-live-schema.sql#L6614) |
| Application | public | CONSTRAINT | cycles cycles_pkey | [6622](sisters-live-schema.sql#L6622) |
| Application | public | CONSTRAINT | daily_thoughts daily_thoughts_pkey | [6630](sisters-live-schema.sql#L6630) |
| Application | public | CONSTRAINT | group_rest_days group_rest_days_cycle_id_rest_date_key | [6638](sisters-live-schema.sql#L6638) |
| Application | public | CONSTRAINT | group_rest_days group_rest_days_pkey | [6646](sisters-live-schema.sql#L6646) |
| Application | public | CONSTRAINT | peer_test_attempt_questions peer_test_attempt_questions_pkey | [6654](sisters-live-schema.sql#L6654) |
| Application | public | CONSTRAINT | peer_test_attempts peer_test_attempts_pkey | [6662](sisters-live-schema.sql#L6662) |
| Application | public | CONSTRAINT | peer_tests peer_tests_pkey | [6670](sisters-live-schema.sql#L6670) |
| Application | public | CONSTRAINT | profiles profiles_phone_key | [6678](sisters-live-schema.sql#L6678) |
| Application | public | CONSTRAINT | profiles profiles_pkey | [6686](sisters-live-schema.sql#L6686) |
| Application | public | CONSTRAINT | program_pauses program_pauses_pkey | [6694](sisters-live-schema.sql#L6694) |
| Application | public | CONSTRAINT | review_confirmations review_confirmations_cycle_id_user_id_program_day_key | [6702](sisters-live-schema.sql#L6702) |
| Application | public | CONSTRAINT | review_confirmations review_confirmations_pkey | [6710](sisters-live-schema.sql#L6710) |
| Application | public | CONSTRAINT | tasmia_submissions tasmia_submissions_cycle_id_user_id_quarter_number_key | [6718](sisters-live-schema.sql#L6718) |
| Application | public | CONSTRAINT | tasmia_submissions tasmia_submissions_pkey | [6726](sisters-live-schema.sql#L6726) |
| Platform / dump metadata | realtime | CHECK CONSTRAINT | messages messages_payload_exclusive | [6734](sisters-live-schema.sql#L6734) |
| Platform / dump metadata | realtime | CONSTRAINT | messages messages_pkey | [6742](sisters-live-schema.sql#L6742) |
| Platform / dump metadata | realtime | CONSTRAINT | subscription pk_subscription | [6750](sisters-live-schema.sql#L6750) |
| Platform / dump metadata | realtime | CONSTRAINT | schema_migrations schema_migrations_pkey | [6758](sisters-live-schema.sql#L6758) |
| Platform / dump metadata | storage | CONSTRAINT | buckets_analytics buckets_analytics_pkey | [6766](sisters-live-schema.sql#L6766) |
| Platform / dump metadata | storage | CONSTRAINT | buckets buckets_pkey | [6774](sisters-live-schema.sql#L6774) |
| Platform / dump metadata | storage | CONSTRAINT | buckets_vectors buckets_vectors_pkey | [6782](sisters-live-schema.sql#L6782) |
| Platform / dump metadata | storage | CONSTRAINT | migrations migrations_name_key | [6790](sisters-live-schema.sql#L6790) |
| Platform / dump metadata | storage | CONSTRAINT | migrations migrations_pkey | [6798](sisters-live-schema.sql#L6798) |
| Platform / dump metadata | storage | CONSTRAINT | objects objects_pkey | [6806](sisters-live-schema.sql#L6806) |
| Platform / dump metadata | storage | CONSTRAINT | s3_multipart_uploads_parts s3_multipart_uploads_parts_pkey | [6814](sisters-live-schema.sql#L6814) |
| Platform / dump metadata | storage | CONSTRAINT | s3_multipart_uploads s3_multipart_uploads_pkey | [6822](sisters-live-schema.sql#L6822) |
| Platform / dump metadata | storage | CONSTRAINT | vector_indexes vector_indexes_pkey | [6830](sisters-live-schema.sql#L6830) |
| Platform / dump metadata | supabase_migrations | CONSTRAINT | schema_migrations schema_migrations_pkey | [6838](sisters-live-schema.sql#L6838) |
| Platform / dump metadata | auth | INDEX | audit_logs_instance_id_idx | [6846](sisters-live-schema.sql#L6846) |
| Platform / dump metadata | auth | INDEX | confirmation_token_idx | [6853](sisters-live-schema.sql#L6853) |
| Platform / dump metadata | auth | INDEX | custom_oauth_providers_created_at_idx | [6860](sisters-live-schema.sql#L6860) |
| Platform / dump metadata | auth | INDEX | custom_oauth_providers_enabled_idx | [6867](sisters-live-schema.sql#L6867) |
| Platform / dump metadata | auth | INDEX | custom_oauth_providers_identifier_idx | [6874](sisters-live-schema.sql#L6874) |
| Platform / dump metadata | auth | INDEX | custom_oauth_providers_provider_type_idx | [6881](sisters-live-schema.sql#L6881) |
| Platform / dump metadata | auth | INDEX | email_change_token_current_idx | [6888](sisters-live-schema.sql#L6888) |
| Platform / dump metadata | auth | INDEX | email_change_token_new_idx | [6895](sisters-live-schema.sql#L6895) |
| Platform / dump metadata | auth | INDEX | factor_id_created_at_idx | [6902](sisters-live-schema.sql#L6902) |
| Platform / dump metadata | auth | INDEX | flow_state_created_at_idx | [6909](sisters-live-schema.sql#L6909) |
| Platform / dump metadata | auth | INDEX | identities_email_idx | [6916](sisters-live-schema.sql#L6916) |
| Platform / dump metadata | auth | COMMENT | INDEX identities_email_idx | [6923](sisters-live-schema.sql#L6923) |
| Platform / dump metadata | auth | INDEX | identities_user_id_idx | [6930](sisters-live-schema.sql#L6930) |
| Platform / dump metadata | auth | INDEX | idx_auth_code | [6937](sisters-live-schema.sql#L6937) |
| Platform / dump metadata | auth | INDEX | idx_oauth_client_states_created_at | [6944](sisters-live-schema.sql#L6944) |
| Platform / dump metadata | auth | INDEX | idx_user_id_auth_method | [6951](sisters-live-schema.sql#L6951) |
| Platform / dump metadata | auth | INDEX | idx_users_created_at_desc | [6958](sisters-live-schema.sql#L6958) |
| Platform / dump metadata | auth | INDEX | idx_users_email | [6965](sisters-live-schema.sql#L6965) |
| Platform / dump metadata | auth | INDEX | idx_users_last_sign_in_at_desc | [6972](sisters-live-schema.sql#L6972) |
| Platform / dump metadata | auth | INDEX | idx_users_name | [6979](sisters-live-schema.sql#L6979) |
| Platform / dump metadata | auth | INDEX | mfa_challenge_created_at_idx | [6986](sisters-live-schema.sql#L6986) |
| Platform / dump metadata | auth | INDEX | mfa_factors_user_friendly_name_unique | [6993](sisters-live-schema.sql#L6993) |
| Platform / dump metadata | auth | INDEX | mfa_factors_user_id_idx | [7000](sisters-live-schema.sql#L7000) |
| Platform / dump metadata | auth | INDEX | mfa_recovery_codes_set_id_idx | [7007](sisters-live-schema.sql#L7007) |
| Platform / dump metadata | auth | INDEX | oauth_auth_pending_exp_idx | [7014](sisters-live-schema.sql#L7014) |
| Platform / dump metadata | auth | INDEX | oauth_clients_deleted_at_idx | [7021](sisters-live-schema.sql#L7021) |
| Platform / dump metadata | auth | INDEX | oauth_consents_active_client_idx | [7028](sisters-live-schema.sql#L7028) |
| Platform / dump metadata | auth | INDEX | oauth_consents_active_user_client_idx | [7035](sisters-live-schema.sql#L7035) |
| Platform / dump metadata | auth | INDEX | oauth_consents_user_order_idx | [7042](sisters-live-schema.sql#L7042) |
| Platform / dump metadata | auth | INDEX | one_time_tokens_relates_to_hash_idx | [7049](sisters-live-schema.sql#L7049) |
| Platform / dump metadata | auth | INDEX | one_time_tokens_token_hash_hash_idx | [7056](sisters-live-schema.sql#L7056) |
| Platform / dump metadata | auth | INDEX | one_time_tokens_user_id_token_type_key | [7063](sisters-live-schema.sql#L7063) |
| Platform / dump metadata | auth | INDEX | reauthentication_token_idx | [7070](sisters-live-schema.sql#L7070) |
| Platform / dump metadata | auth | INDEX | recovery_token_idx | [7077](sisters-live-schema.sql#L7077) |
| Platform / dump metadata | auth | INDEX | refresh_tokens_instance_id_idx | [7084](sisters-live-schema.sql#L7084) |
| Platform / dump metadata | auth | INDEX | refresh_tokens_instance_id_user_id_idx | [7091](sisters-live-schema.sql#L7091) |
| Platform / dump metadata | auth | INDEX | refresh_tokens_parent_idx | [7098](sisters-live-schema.sql#L7098) |
| Platform / dump metadata | auth | INDEX | refresh_tokens_session_id_revoked_idx | [7105](sisters-live-schema.sql#L7105) |
| Platform / dump metadata | auth | INDEX | refresh_tokens_updated_at_idx | [7112](sisters-live-schema.sql#L7112) |
| Platform / dump metadata | auth | INDEX | saml_providers_sso_provider_id_idx | [7119](sisters-live-schema.sql#L7119) |
| Platform / dump metadata | auth | INDEX | saml_relay_states_created_at_idx | [7126](sisters-live-schema.sql#L7126) |
| Platform / dump metadata | auth | INDEX | saml_relay_states_for_email_idx | [7133](sisters-live-schema.sql#L7133) |
| Platform / dump metadata | auth | INDEX | saml_relay_states_sso_provider_id_idx | [7140](sisters-live-schema.sql#L7140) |
| Platform / dump metadata | auth | INDEX | scim_tokens_expires_at_idx | [7147](sisters-live-schema.sql#L7147) |
| Platform / dump metadata | auth | INDEX | scim_tokens_revoked_at_idx | [7154](sisters-live-schema.sql#L7154) |
| Platform / dump metadata | auth | INDEX | scim_tokens_sso_provider_id_idx | [7161](sisters-live-schema.sql#L7161) |
| Platform / dump metadata | auth | INDEX | scim_tokens_token_hash_key | [7168](sisters-live-schema.sql#L7168) |
| Platform / dump metadata | auth | INDEX | scim_users_created_at_idx | [7175](sisters-live-schema.sql#L7175) |
| Platform / dump metadata | auth | INDEX | scim_users_deleted_at_idx | [7182](sisters-live-schema.sql#L7182) |
| Platform / dump metadata | auth | INDEX | scim_users_external_id_key | [7189](sisters-live-schema.sql#L7189) |
| Platform / dump metadata | auth | INDEX | scim_users_id_idx | [7196](sisters-live-schema.sql#L7196) |
| Platform / dump metadata | auth | INDEX | scim_users_sso_provider_id_idx | [7203](sisters-live-schema.sql#L7203) |
| Platform / dump metadata | auth | INDEX | scim_users_updated_at_idx | [7210](sisters-live-schema.sql#L7210) |
| Platform / dump metadata | auth | INDEX | scim_users_user_id_idx | [7217](sisters-live-schema.sql#L7217) |
| Platform / dump metadata | auth | INDEX | scim_users_user_name_idx | [7224](sisters-live-schema.sql#L7224) |
| Platform / dump metadata | auth | INDEX | scim_users_user_name_key | [7231](sisters-live-schema.sql#L7231) |
| Platform / dump metadata | auth | INDEX | sessions_not_after_idx | [7238](sisters-live-schema.sql#L7238) |
| Platform / dump metadata | auth | INDEX | sessions_oauth_client_id_idx | [7245](sisters-live-schema.sql#L7245) |
| Platform / dump metadata | auth | INDEX | sessions_user_id_idx | [7252](sisters-live-schema.sql#L7252) |
| Platform / dump metadata | auth | INDEX | sso_domains_domain_idx | [7259](sisters-live-schema.sql#L7259) |
| Platform / dump metadata | auth | INDEX | sso_domains_sso_provider_id_idx | [7266](sisters-live-schema.sql#L7266) |
| Platform / dump metadata | auth | INDEX | sso_providers_resource_id_idx | [7273](sisters-live-schema.sql#L7273) |
| Platform / dump metadata | auth | INDEX | sso_providers_resource_id_pattern_idx | [7280](sisters-live-schema.sql#L7280) |
| Platform / dump metadata | auth | INDEX | unique_phone_factor_per_user | [7287](sisters-live-schema.sql#L7287) |
| Platform / dump metadata | auth | INDEX | user_id_created_at_idx | [7294](sisters-live-schema.sql#L7294) |
| Platform / dump metadata | auth | INDEX | users_email_partial_key | [7301](sisters-live-schema.sql#L7301) |
| Platform / dump metadata | auth | COMMENT | INDEX users_email_partial_key | [7308](sisters-live-schema.sql#L7308) |
| Platform / dump metadata | auth | INDEX | users_instance_id_email_idx | [7315](sisters-live-schema.sql#L7315) |
| Platform / dump metadata | auth | INDEX | users_instance_id_idx | [7322](sisters-live-schema.sql#L7322) |
| Platform / dump metadata | auth | INDEX | users_is_anonymous_idx | [7329](sisters-live-schema.sql#L7329) |
| Platform / dump metadata | auth | INDEX | webauthn_challenges_expires_at_idx | [7336](sisters-live-schema.sql#L7336) |
| Platform / dump metadata | auth | INDEX | webauthn_challenges_user_id_idx | [7343](sisters-live-schema.sql#L7343) |
| Platform / dump metadata | auth | INDEX | webauthn_credentials_credential_id_key | [7350](sisters-live-schema.sql#L7350) |
| Platform / dump metadata | auth | INDEX | webauthn_credentials_user_id_idx | [7357](sisters-live-schema.sql#L7357) |
| Application | public | INDEX | batch_membership_transfers_user_idx | [7364](sisters-live-schema.sql#L7364) |
| Application | public | INDEX | batch_memberships_batch_role_idx | [7371](sisters-live-schema.sql#L7371) |
| Application | public | INDEX | batch_memberships_one_batch_per_member_idx | [7378](sisters-live-schema.sql#L7378) |
| Application | public | INDEX | batch_memberships_user_id_idx | [7385](sisters-live-schema.sql#L7385) |
| Application | public | INDEX | batches_name_unique_idx | [7392](sisters-live-schema.sql#L7392) |
| Application | public | INDEX | cycles_batch_cycle_number_key | [7399](sisters-live-schema.sql#L7399) |
| Application | public | INDEX | cycles_batch_status_idx | [7406](sisters-live-schema.sql#L7406) |
| Application | public | INDEX | cycles_one_active_per_batch_idx | [7413](sisters-live-schema.sql#L7413) |
| Application | public | INDEX | daily_thoughts_batch_published_idx | [7420](sisters-live-schema.sql#L7420) |
| Application | public | INDEX | daily_thoughts_published_idx | [7427](sisters-live-schema.sql#L7427) |
| Application | public | INDEX | peer_test_attempts_candidate_idx | [7434](sisters-live-schema.sql#L7434) |
| Application | public | INDEX | peer_test_attempts_examiner_idx | [7441](sisters-live-schema.sql#L7441) |
| Application | public | INDEX | peer_test_attempts_one_open_idx | [7448](sisters-live-schema.sql#L7448) |
| Application | public | INDEX | peer_test_attempts_test_candidate_idx | [7455](sisters-live-schema.sql#L7455) |
| Application | public | INDEX | peer_tests_cycle_status_idx | [7462](sisters-live-schema.sql#L7462) |
| Application | public | INDEX | program_pauses_cycle_idx | [7469](sisters-live-schema.sql#L7469) |
| Application | public | INDEX | rest_days_cycle_date_idx | [7476](sisters-live-schema.sql#L7476) |
| Application | public | INDEX | review_confirmations_cycle_day_idx | [7483](sisters-live-schema.sql#L7483) |
| Application | public | INDEX | reviews_cycle_idx | [7490](sisters-live-schema.sql#L7490) |
| Application | public | INDEX | reviews_user_idx | [7497](sisters-live-schema.sql#L7497) |
| Application | public | INDEX | tasmia_cycle_idx | [7504](sisters-live-schema.sql#L7504) |
| Application | public | INDEX | tasmia_listener_idx | [7511](sisters-live-schema.sql#L7511) |
| Application | public | INDEX | tasmia_submissions_cycle_submitted_idx | [7518](sisters-live-schema.sql#L7518) |
| Application | public | INDEX | tasmia_user_idx | [7525](sisters-live-schema.sql#L7525) |
| Platform / dump metadata | realtime | INDEX | ix_realtime_subscription_entity | [7532](sisters-live-schema.sql#L7532) |
| Platform / dump metadata | realtime | INDEX | messages_inserted_at_topic_index | [7539](sisters-live-schema.sql#L7539) |
| Platform / dump metadata | realtime | INDEX | subscription_subscription_id_entity_filters_action_filter_selec | [7546](sisters-live-schema.sql#L7546) |
| Platform / dump metadata | storage | INDEX | bname | [7553](sisters-live-schema.sql#L7553) |
| Platform / dump metadata | storage | INDEX | buckets_analytics_unique_name_idx | [7560](sisters-live-schema.sql#L7560) |
| Platform / dump metadata | storage | INDEX | idx_multipart_uploads_list | [7567](sisters-live-schema.sql#L7567) |
| Platform / dump metadata | storage | INDEX | idx_objects_bucket_id_name | [7574](sisters-live-schema.sql#L7574) |
| Platform / dump metadata | storage | INDEX | idx_objects_bucket_id_name_lower | [7581](sisters-live-schema.sql#L7581) |
| Platform / dump metadata | storage | INDEX | idx_objects_current_version | [7588](sisters-live-schema.sql#L7588) |
| Platform / dump metadata | storage | INDEX | idx_objects_delete_markers | [7595](sisters-live-schema.sql#L7595) |
| Platform / dump metadata | storage | INDEX | idx_objects_null_version | [7602](sisters-live-schema.sql#L7602) |
| Platform / dump metadata | storage | INDEX | name_prefix_search | [7609](sisters-live-schema.sql#L7609) |
| Platform / dump metadata | storage | INDEX | objects_bucket_id_name_version_key | [7616](sisters-live-schema.sql#L7616) |
| Platform / dump metadata | storage | INDEX | vector_indexes_name_bucket_id_idx | [7623](sisters-live-schema.sql#L7623) |
| Application | public | TRIGGER | batch_memberships batch_memberships_guard | [7630](sisters-live-schema.sql#L7630) |
| Application | public | TRIGGER | profiles profiles_batch_guard | [7637](sisters-live-schema.sql#L7637) |
| Application | public | TRIGGER | review_confirmations review_batch_guard | [7644](sisters-live-schema.sql#L7644) |
| Application | public | TRIGGER | tasmia_submissions tasmia_batch_guard | [7651](sisters-live-schema.sql#L7651) |
| Application | public | TRIGGER | profiles trg_sync_deactivated_at | [7658](sisters-live-schema.sql#L7658) |
| Platform / dump metadata | realtime | TRIGGER | subscription tr_check_filters | [7665](sisters-live-schema.sql#L7665) |
| Platform / dump metadata | storage | TRIGGER | buckets enforce_bucket_name_length_trigger | [7672](sisters-live-schema.sql#L7672) |
| Platform / dump metadata | storage | TRIGGER | buckets protect_bucket_control_insert | [7679](sisters-live-schema.sql#L7679) |
| Platform / dump metadata | storage | TRIGGER | buckets protect_bucket_control_update | [7686](sisters-live-schema.sql#L7686) |
| Platform / dump metadata | storage | TRIGGER | buckets protect_bucket_control_update_role | [7693](sisters-live-schema.sql#L7693) |
| Platform / dump metadata | storage | TRIGGER | buckets protect_buckets_delete | [7700](sisters-live-schema.sql#L7700) |
| Platform / dump metadata | storage | TRIGGER | objects protect_objects_delete | [7707](sisters-live-schema.sql#L7707) |
| Platform / dump metadata | storage | TRIGGER | objects update_objects_updated_at | [7714](sisters-live-schema.sql#L7714) |
| Platform / dump metadata | auth | FK CONSTRAINT | identities identities_user_id_fkey | [7721](sisters-live-schema.sql#L7721) |
| Platform / dump metadata | auth | FK CONSTRAINT | mfa_amr_claims mfa_amr_claims_session_id_fkey | [7729](sisters-live-schema.sql#L7729) |
| Platform / dump metadata | auth | FK CONSTRAINT | mfa_challenges mfa_challenges_auth_factor_id_fkey | [7737](sisters-live-schema.sql#L7737) |
| Platform / dump metadata | auth | FK CONSTRAINT | mfa_factors mfa_factors_user_id_fkey | [7745](sisters-live-schema.sql#L7745) |
| Platform / dump metadata | auth | FK CONSTRAINT | mfa_recovery_code_sets mfa_recovery_code_sets_mfa_factor_id_fkey | [7753](sisters-live-schema.sql#L7753) |
| Platform / dump metadata | auth | FK CONSTRAINT | mfa_recovery_code_sets mfa_recovery_code_sets_user_id_fkey | [7761](sisters-live-schema.sql#L7761) |
| Platform / dump metadata | auth | FK CONSTRAINT | mfa_recovery_codes mfa_recovery_codes_mfa_recovery_code_set_id_fkey | [7769](sisters-live-schema.sql#L7769) |
| Platform / dump metadata | auth | FK CONSTRAINT | oauth_authorizations oauth_authorizations_client_id_fkey | [7777](sisters-live-schema.sql#L7777) |
| Platform / dump metadata | auth | FK CONSTRAINT | oauth_authorizations oauth_authorizations_user_id_fkey | [7785](sisters-live-schema.sql#L7785) |
| Platform / dump metadata | auth | FK CONSTRAINT | oauth_consents oauth_consents_client_id_fkey | [7793](sisters-live-schema.sql#L7793) |
| Platform / dump metadata | auth | FK CONSTRAINT | oauth_consents oauth_consents_user_id_fkey | [7801](sisters-live-schema.sql#L7801) |
| Platform / dump metadata | auth | FK CONSTRAINT | one_time_tokens one_time_tokens_user_id_fkey | [7809](sisters-live-schema.sql#L7809) |
| Platform / dump metadata | auth | FK CONSTRAINT | refresh_tokens refresh_tokens_session_id_fkey | [7817](sisters-live-schema.sql#L7817) |
| Platform / dump metadata | auth | FK CONSTRAINT | saml_providers saml_providers_sso_provider_id_fkey | [7825](sisters-live-schema.sql#L7825) |
| Platform / dump metadata | auth | FK CONSTRAINT | saml_relay_states saml_relay_states_flow_state_id_fkey | [7833](sisters-live-schema.sql#L7833) |
| Platform / dump metadata | auth | FK CONSTRAINT | saml_relay_states saml_relay_states_sso_provider_id_fkey | [7841](sisters-live-schema.sql#L7841) |
| Platform / dump metadata | auth | FK CONSTRAINT | scim_tokens scim_tokens_sso_provider_id_fkey | [7849](sisters-live-schema.sql#L7849) |
| Platform / dump metadata | auth | FK CONSTRAINT | scim_users scim_users_sso_provider_id_fkey | [7857](sisters-live-schema.sql#L7857) |
| Platform / dump metadata | auth | FK CONSTRAINT | scim_users scim_users_user_id_fkey | [7865](sisters-live-schema.sql#L7865) |
| Platform / dump metadata | auth | FK CONSTRAINT | sessions sessions_oauth_client_id_fkey | [7873](sisters-live-schema.sql#L7873) |
| Platform / dump metadata | auth | FK CONSTRAINT | sessions sessions_user_id_fkey | [7881](sisters-live-schema.sql#L7881) |
| Platform / dump metadata | auth | FK CONSTRAINT | sso_domains sso_domains_sso_provider_id_fkey | [7889](sisters-live-schema.sql#L7889) |
| Platform / dump metadata | auth | FK CONSTRAINT | webauthn_challenges webauthn_challenges_user_id_fkey | [7897](sisters-live-schema.sql#L7897) |
| Platform / dump metadata | auth | FK CONSTRAINT | webauthn_credentials webauthn_credentials_user_id_fkey | [7905](sisters-live-schema.sql#L7905) |
| Application | public | FK CONSTRAINT | batch_membership_transfers batch_membership_transfers_from_batch_id_fkey | [7913](sisters-live-schema.sql#L7913) |
| Application | public | FK CONSTRAINT | batch_membership_transfers batch_membership_transfers_moved_by_fkey | [7921](sisters-live-schema.sql#L7921) |
| Application | public | FK CONSTRAINT | batch_membership_transfers batch_membership_transfers_to_batch_id_fkey | [7929](sisters-live-schema.sql#L7929) |
| Application | public | FK CONSTRAINT | batch_membership_transfers batch_membership_transfers_user_id_fkey | [7937](sisters-live-schema.sql#L7937) |
| Application | public | FK CONSTRAINT | batch_memberships batch_memberships_batch_id_fkey | [7945](sisters-live-schema.sql#L7945) |
| Application | public | FK CONSTRAINT | batch_memberships batch_memberships_created_by_fkey | [7953](sisters-live-schema.sql#L7953) |
| Application | public | FK CONSTRAINT | batch_memberships batch_memberships_user_id_fkey | [7961](sisters-live-schema.sql#L7961) |
| Application | public | FK CONSTRAINT | batches batches_created_by_fkey | [7969](sisters-live-schema.sql#L7969) |
| Application | public | FK CONSTRAINT | cycles cycles_batch_id_fkey | [7977](sisters-live-schema.sql#L7977) |
| Application | public | FK CONSTRAINT | cycles cycles_created_by_fkey | [7985](sisters-live-schema.sql#L7985) |
| Application | public | FK CONSTRAINT | daily_thoughts daily_thoughts_batch_id_fkey | [7993](sisters-live-schema.sql#L7993) |
| Application | public | FK CONSTRAINT | daily_thoughts daily_thoughts_published_by_fkey | [8001](sisters-live-schema.sql#L8001) |
| Application | public | FK CONSTRAINT | group_rest_days group_rest_days_created_by_fkey | [8009](sisters-live-schema.sql#L8009) |
| Application | public | FK CONSTRAINT | group_rest_days group_rest_days_cycle_id_fkey | [8017](sisters-live-schema.sql#L8017) |
| Application | public | FK CONSTRAINT | peer_test_attempt_questions peer_test_attempt_questions_attempt_id_fkey | [8025](sisters-live-schema.sql#L8025) |
| Application | public | FK CONSTRAINT | peer_test_attempts peer_test_attempts_candidate_id_fkey | [8033](sisters-live-schema.sql#L8033) |
| Application | public | FK CONSTRAINT | peer_test_attempts peer_test_attempts_examiner_id_fkey | [8041](sisters-live-schema.sql#L8041) |
| Application | public | FK CONSTRAINT | peer_test_attempts peer_test_attempts_test_id_fkey | [8049](sisters-live-schema.sql#L8049) |
| Application | public | FK CONSTRAINT | peer_tests peer_tests_created_by_fkey | [8057](sisters-live-schema.sql#L8057) |
| Application | public | FK CONSTRAINT | peer_tests peer_tests_cycle_id_fkey | [8065](sisters-live-schema.sql#L8065) |
| Application | public | FK CONSTRAINT | profiles profiles_id_fkey | [8073](sisters-live-schema.sql#L8073) |
| Application | public | FK CONSTRAINT | program_pauses program_pauses_created_by_fkey | [8081](sisters-live-schema.sql#L8081) |
| Application | public | FK CONSTRAINT | program_pauses program_pauses_cycle_id_fkey | [8089](sisters-live-schema.sql#L8089) |
| Application | public | FK CONSTRAINT | review_confirmations review_confirmations_cycle_id_fkey | [8097](sisters-live-schema.sql#L8097) |
| Application | public | FK CONSTRAINT | review_confirmations review_confirmations_user_id_fkey | [8105](sisters-live-schema.sql#L8105) |
| Application | public | FK CONSTRAINT | tasmia_submissions tasmia_submissions_cycle_id_fkey | [8113](sisters-live-schema.sql#L8113) |
| Application | public | FK CONSTRAINT | tasmia_submissions tasmia_submissions_listener_id_fkey | [8121](sisters-live-schema.sql#L8121) |
| Application | public | FK CONSTRAINT | tasmia_submissions tasmia_submissions_user_id_fkey | [8129](sisters-live-schema.sql#L8129) |
| Platform / dump metadata | storage | FK CONSTRAINT | objects objects_bucketId_fkey | [8137](sisters-live-schema.sql#L8137) |
| Platform / dump metadata | storage | FK CONSTRAINT | s3_multipart_uploads s3_multipart_uploads_bucket_id_fkey | [8145](sisters-live-schema.sql#L8145) |
| Platform / dump metadata | storage | FK CONSTRAINT | s3_multipart_uploads_parts s3_multipart_uploads_parts_bucket_id_fkey | [8153](sisters-live-schema.sql#L8153) |
| Platform / dump metadata | storage | FK CONSTRAINT | s3_multipart_uploads_parts s3_multipart_uploads_parts_upload_id_fkey | [8161](sisters-live-schema.sql#L8161) |
| Platform / dump metadata | storage | FK CONSTRAINT | vector_indexes vector_indexes_bucket_id_fkey | [8169](sisters-live-schema.sql#L8169) |
| Platform / dump metadata | auth | ROW SECURITY | audit_log_entries | [8177](sisters-live-schema.sql#L8177) |
| Platform / dump metadata | auth | ROW SECURITY | flow_state | [8183](sisters-live-schema.sql#L8183) |
| Platform / dump metadata | auth | ROW SECURITY | identities | [8189](sisters-live-schema.sql#L8189) |
| Platform / dump metadata | auth | ROW SECURITY | instances | [8195](sisters-live-schema.sql#L8195) |
| Platform / dump metadata | auth | ROW SECURITY | mfa_amr_claims | [8201](sisters-live-schema.sql#L8201) |
| Platform / dump metadata | auth | ROW SECURITY | mfa_challenges | [8207](sisters-live-schema.sql#L8207) |
| Platform / dump metadata | auth | ROW SECURITY | mfa_factors | [8213](sisters-live-schema.sql#L8213) |
| Platform / dump metadata | auth | ROW SECURITY | one_time_tokens | [8219](sisters-live-schema.sql#L8219) |
| Platform / dump metadata | auth | ROW SECURITY | refresh_tokens | [8225](sisters-live-schema.sql#L8225) |
| Platform / dump metadata | auth | ROW SECURITY | saml_providers | [8231](sisters-live-schema.sql#L8231) |
| Platform / dump metadata | auth | ROW SECURITY | saml_relay_states | [8237](sisters-live-schema.sql#L8237) |
| Platform / dump metadata | auth | ROW SECURITY | schema_migrations | [8243](sisters-live-schema.sql#L8243) |
| Platform / dump metadata | auth | ROW SECURITY | sessions | [8249](sisters-live-schema.sql#L8249) |
| Platform / dump metadata | auth | ROW SECURITY | sso_domains | [8255](sisters-live-schema.sql#L8255) |
| Platform / dump metadata | auth | ROW SECURITY | sso_providers | [8261](sisters-live-schema.sql#L8261) |
| Platform / dump metadata | auth | ROW SECURITY | users | [8267](sisters-live-schema.sql#L8267) |
| Application | public | ROW SECURITY | batch_membership_transfers | [8273](sisters-live-schema.sql#L8273) |
| Application | public | ROW SECURITY | batch_memberships | [8279](sisters-live-schema.sql#L8279) |
| Application | public | POLICY | batch_memberships batch_memberships_select_accessible | [8285](sisters-live-schema.sql#L8285) |
| Application | public | ROW SECURITY | batches | [8292](sisters-live-schema.sql#L8292) |
| Application | public | POLICY | batches batches_select_accessible | [8298](sisters-live-schema.sql#L8298) |
| Application | public | ROW SECURITY | cycles | [8305](sisters-live-schema.sql#L8305) |
| Application | public | POLICY | cycles cycles_select_accessible | [8311](sisters-live-schema.sql#L8311) |
| Application | public | POLICY | cycles cycles_update_managed | [8318](sisters-live-schema.sql#L8318) |
| Application | public | ROW SECURITY | daily_thoughts | [8325](sisters-live-schema.sql#L8325) |
| Application | public | POLICY | daily_thoughts daily_thoughts_insert_managed | [8331](sisters-live-schema.sql#L8331) |
| Application | public | POLICY | daily_thoughts daily_thoughts_select_accessible | [8338](sisters-live-schema.sql#L8338) |
| Application | public | POLICY | daily_thoughts daily_thoughts_update_managed | [8345](sisters-live-schema.sql#L8345) |
| Application | public | ROW SECURITY | group_rest_days | [8352](sisters-live-schema.sql#L8352) |
| Application | public | POLICY | group_rest_days group_rest_days_delete_managed | [8358](sisters-live-schema.sql#L8358) |
| Application | public | POLICY | group_rest_days group_rest_days_insert_managed | [8365](sisters-live-schema.sql#L8365) |
| Application | public | POLICY | group_rest_days group_rest_days_select_accessible | [8372](sisters-live-schema.sql#L8372) |
| Application | public | ROW SECURITY | peer_test_attempt_questions | [8379](sisters-live-schema.sql#L8379) |
| Application | public | POLICY | peer_test_attempt_questions peer_test_attempt_questions_select | [8385](sisters-live-schema.sql#L8385) |
| Application | public | ROW SECURITY | peer_test_attempts | [8392](sisters-live-schema.sql#L8392) |
| Application | public | POLICY | peer_test_attempts peer_test_attempts_select | [8398](sisters-live-schema.sql#L8398) |
| Application | public | ROW SECURITY | peer_tests | [8405](sisters-live-schema.sql#L8405) |
| Application | public | POLICY | peer_tests peer_tests_select | [8411](sisters-live-schema.sql#L8411) |
| Application | public | ROW SECURITY | profiles | [8418](sisters-live-schema.sql#L8418) |
| Application | public | POLICY | profiles profiles_select_visible | [8424](sisters-live-schema.sql#L8424) |
| Application | public | ROW SECURITY | program_pauses | [8431](sisters-live-schema.sql#L8431) |
| Application | public | POLICY | program_pauses program_pauses_insert_managed | [8437](sisters-live-schema.sql#L8437) |
| Application | public | POLICY | program_pauses program_pauses_select_accessible | [8444](sisters-live-schema.sql#L8444) |
| Application | public | POLICY | program_pauses program_pauses_update_managed | [8451](sisters-live-schema.sql#L8451) |
| Application | public | ROW SECURITY | review_confirmations | [8458](sisters-live-schema.sql#L8458) |
| Application | public | POLICY | review_confirmations review_confirmations_insert_own_batch | [8464](sisters-live-schema.sql#L8464) |
| Application | public | POLICY | review_confirmations review_confirmations_select_accessible | [8471](sisters-live-schema.sql#L8471) |
| Application | public | ROW SECURITY | tasmia_submissions | [8478](sisters-live-schema.sql#L8478) |
| Application | public | POLICY | tasmia_submissions tasmia_submissions_insert_own_batch | [8484](sisters-live-schema.sql#L8484) |
| Application | public | POLICY | tasmia_submissions tasmia_submissions_select_accessible | [8491](sisters-live-schema.sql#L8491) |
| Platform / dump metadata | realtime | ROW SECURITY | messages | [8498](sisters-live-schema.sql#L8498) |
| Platform / dump metadata | storage | ROW SECURITY | buckets | [8504](sisters-live-schema.sql#L8504) |
| Platform / dump metadata | storage | ROW SECURITY | buckets_analytics | [8510](sisters-live-schema.sql#L8510) |
| Platform / dump metadata | storage | ROW SECURITY | buckets_vectors | [8516](sisters-live-schema.sql#L8516) |
| Platform / dump metadata | storage | ROW SECURITY | migrations | [8522](sisters-live-schema.sql#L8522) |
| Platform / dump metadata | storage | ROW SECURITY | objects | [8528](sisters-live-schema.sql#L8528) |
| Platform / dump metadata | storage | ROW SECURITY | s3_multipart_uploads | [8534](sisters-live-schema.sql#L8534) |
| Platform / dump metadata | storage | ROW SECURITY | s3_multipart_uploads_parts | [8540](sisters-live-schema.sql#L8540) |
| Platform / dump metadata | storage | ROW SECURITY | vector_indexes | [8546](sisters-live-schema.sql#L8546) |
| Platform / dump metadata | - | PUBLICATION | supabase_realtime | [8552](sisters-live-schema.sql#L8552) |
| Application | - | EVENT TRIGGER | ensure_rls | [8559](sisters-live-schema.sql#L8559) |
| Platform / dump metadata | - | EVENT TRIGGER | issue_graphql_placeholder | [8568](sisters-live-schema.sql#L8568) |
| Platform / dump metadata | - | EVENT TRIGGER | issue_pg_cron_access | [8577](sisters-live-schema.sql#L8577) |
| Platform / dump metadata | - | EVENT TRIGGER | issue_pg_graphql_access | [8586](sisters-live-schema.sql#L8586) |
| Platform / dump metadata | - | EVENT TRIGGER | issue_pg_net_access | [8595](sisters-live-schema.sql#L8595) |
| Platform / dump metadata | - | EVENT TRIGGER | pgrst_ddl_watch | [8604](sisters-live-schema.sql#L8604) |
| Platform / dump metadata | - | EVENT TRIGGER | pgrst_drop_watch | [8612](sisters-live-schema.sql#L8612) |
