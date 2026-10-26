# Proposed Men schema — live Sisters foundation

Catalog of locally executed schema-only DDL. No production records.

## migration_private.empty_legacy_arrays

| Column | Type | Nullable | Default |
|---|---|---|---|
| source_path | text | NO |  |
| field_name | text | NO |  |

Constraints:

- `empty_legacy_arrays_pkey`: `PRIMARY KEY (source_path, field_name)`
- `empty_legacy_arrays_source_path_fkey`: `FOREIGN KEY (source_path) REFERENCES migration_private.source_documents(source_path)`

Indexes:

- `CREATE UNIQUE INDEX empty_legacy_arrays_pkey ON migration_private.empty_legacy_arrays USING btree (source_path, field_name)`

## migration_private.source_documents

| Column | Type | Nullable | Default |
|---|---|---|---|
| source_path | text | NO |  |
| collection_path | text | NO |  |
| firestore_id | text | NO |  |
| target_table | text | NO |  |
| target_id | text | NO |  |
| field_types | jsonb | NO |  |
| create_seconds | bigint | NO |  |
| create_nanos | integer | NO |  |
| update_seconds | bigint | NO |  |
| update_nanos | integer | NO |  |

Constraints:

- `source_documents_collection_path_firestore_id_key`: `UNIQUE (collection_path, firestore_id)`
- `source_documents_create_nanos_check`: `CHECK (((create_nanos >= 0) AND (create_nanos <= 999999999)))`
- `source_documents_pkey`: `PRIMARY KEY (source_path)`
- `source_documents_update_nanos_check`: `CHECK (((update_nanos >= 0) AND (update_nanos <= 999999999)))`

Indexes:

- `CREATE UNIQUE INDEX source_documents_collection_path_firestore_id_key ON migration_private.source_documents USING btree (collection_path, firestore_id)`
- `CREATE UNIQUE INDEX source_documents_pkey ON migration_private.source_documents USING btree (source_path)`

## migration_private.source_settings

| Column | Type | Nullable | Default |
|---|---|---|---|
| source_path | text | NO |  |
| firestore_id | text | NO |  |
| embedded_id | text | YES |  |
| cycle_id | uuid | YES |  |
| start_date | date | NO |  |
| total_quarters | integer | NO |  |
| review_window | integer | NO |  |
| current_cycle_number | integer | NO |  |
| is_paused | boolean | NO |  |
| paused_at | date | YES |  |
| total_paused_days | integer | NO |  |
| daily_thought | text | YES |  |
| daily_thought_updated_at | timestamp with time zone | YES |  |
| daily_thought_updated_by | text | YES |  |

Constraints:

- `source_settings_cycle_id_fkey`: `FOREIGN KEY (cycle_id) REFERENCES cycles(id)`
- `source_settings_pkey`: `PRIMARY KEY (source_path)`

Indexes:

- `CREATE UNIQUE INDEX source_settings_pkey ON migration_private.source_settings USING btree (source_path)`

## migration_private.user_credentials

| Column | Type | Nullable | Default |
|---|---|---|---|
| profile_id | uuid | NO |  |
| password_hash | text | NO |  |
| firebase_uid | text | YES |  |

Constraints:

- `user_credentials_pkey`: `PRIMARY KEY (profile_id)`
- `user_credentials_profile_id_fkey`: `FOREIGN KEY (profile_id) REFERENCES profiles(id)`

Indexes:

- `CREATE UNIQUE INDEX user_credentials_pkey ON migration_private.user_credentials USING btree (profile_id)`

## public.batch_membership_transfers

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| user_id | uuid | NO |  |
| from_batch_id | uuid | NO |  |
| to_batch_id | uuid | NO |  |
| moved_by | uuid | YES |  |
| moved_at | timestamp with time zone | NO | now() |

Constraints:

- `batch_membership_transfers_from_batch_id_fkey`: `FOREIGN KEY (from_batch_id) REFERENCES batches(id) ON DELETE RESTRICT`
- `batch_membership_transfers_moved_by_fkey`: `FOREIGN KEY (moved_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `batch_membership_transfers_pkey`: `PRIMARY KEY (id)`
- `batch_membership_transfers_to_batch_id_fkey`: `FOREIGN KEY (to_batch_id) REFERENCES batches(id) ON DELETE RESTRICT`
- `batch_membership_transfers_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE`

Indexes:

- `CREATE UNIQUE INDEX batch_membership_transfers_pkey ON public.batch_membership_transfers USING btree (id)`
- `CREATE INDEX batch_membership_transfers_user_idx ON public.batch_membership_transfers USING btree (user_id, moved_at DESC)`

## public.batch_memberships

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| batch_id | uuid | NO |  |
| user_id | uuid | NO |  |
| membership_role | text | NO |  |
| created_at | timestamp with time zone | NO | now() |
| created_by | uuid | YES |  |
| joined_at | timestamp with time zone | NO | now() |

Constraints:

- `batch_memberships_batch_id_fkey`: `FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE`
- `batch_memberships_batch_user_key`: `UNIQUE (batch_id, user_id)`
- `batch_memberships_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `batch_memberships_pkey`: `PRIMARY KEY (id)`
- `batch_memberships_role_check`: `CHECK ((membership_role = ANY (ARRAY['member'::text, 'admin'::text])))`
- `batch_memberships_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE`

Indexes:

- `CREATE INDEX batch_memberships_batch_role_idx ON public.batch_memberships USING btree (batch_id, membership_role)`
- `CREATE UNIQUE INDEX batch_memberships_batch_user_key ON public.batch_memberships USING btree (batch_id, user_id)`
- `CREATE UNIQUE INDEX batch_memberships_one_batch_per_member_idx ON public.batch_memberships USING btree (user_id) WHERE (membership_role = 'member'::text)`
- `CREATE UNIQUE INDEX batch_memberships_pkey ON public.batch_memberships USING btree (id)`
- `CREATE INDEX batch_memberships_user_id_idx ON public.batch_memberships USING btree (user_id)`

## public.batches

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| name | text | NO |  |
| created_at | timestamp with time zone | NO | now() |
| created_by | uuid | YES |  |
| archived_at | timestamp with time zone | YES |  |

Constraints:

- `batches_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `batches_name_not_blank`: `CHECK ((length(btrim(name)) > 0))`
- `batches_pkey`: `PRIMARY KEY (id)`

Indexes:

- `CREATE UNIQUE INDEX batches_name_unique_idx ON public.batches USING btree (lower(btrim(name)))`
- `CREATE UNIQUE INDEX batches_pkey ON public.batches USING btree (id)`

## public.cycles

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| cycle_number | integer | NO |  |
| name | text | YES |  |
| starts_on | date | NO |  |
| status | text | NO | 'active'::text |
| ended_on | date | YES |  |
| created_by | uuid | YES |  |
| created_at | timestamp with time zone | NO | now() |
| batch_id | uuid | NO |  |
| total_quarters | integer | NO | 240 |
| review_window | integer | NO | 8 |
| legacy_paused_days | integer | NO | 0 |

Constraints:

- `cycles_batch_id_fkey`: `FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE RESTRICT`
- `cycles_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `cycles_legacy_paused_days_check`: `CHECK ((legacy_paused_days >= 0))`
- `cycles_pkey`: `PRIMARY KEY (id)`
- `cycles_review_window_check`: `CHECK ((review_window > 0))`
- `cycles_status_check`: `CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))`
- `cycles_total_quarters_check`: `CHECK ((total_quarters = 240))`

Indexes:

- `CREATE UNIQUE INDEX cycles_batch_cycle_number_key ON public.cycles USING btree (batch_id, cycle_number)`
- `CREATE INDEX cycles_batch_status_idx ON public.cycles USING btree (batch_id, status)`
- `CREATE UNIQUE INDEX cycles_one_active_per_batch_idx ON public.cycles USING btree (batch_id) WHERE (status = 'active'::text)`
- `CREATE UNIQUE INDEX cycles_pkey ON public.cycles USING btree (id)`

## public.daily_thoughts

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| content_html | text | NO |  |
| published_by | uuid | YES |  |
| published_at | timestamp with time zone | NO | now() |
| is_published | boolean | NO | true |
| batch_id | uuid | NO |  |
| published_by_name_snapshot | text | YES |  |

Constraints:

- `daily_thoughts_batch_id_fkey`: `FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE RESTRICT`
- `daily_thoughts_pkey`: `PRIMARY KEY (id)`
- `daily_thoughts_published_by_fkey`: `FOREIGN KEY (published_by) REFERENCES profiles(id) ON DELETE SET NULL`

Indexes:

- `CREATE INDEX daily_thoughts_batch_published_idx ON public.daily_thoughts USING btree (batch_id, is_published, published_at DESC)`
- `CREATE UNIQUE INDEX daily_thoughts_pkey ON public.daily_thoughts USING btree (id)`
- `CREATE INDEX daily_thoughts_published_idx ON public.daily_thoughts USING btree (published_at DESC)`

## public.group_rest_days

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| cycle_id | uuid | NO |  |
| rest_date | date | NO |  |
| reason | text | YES |  |
| created_by | uuid | YES |  |
| created_at | timestamp with time zone | NO | now() |
| firestore_id | text | YES |  |
| created_by_name_snapshot | text | YES |  |

Constraints:

- `group_rest_days_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `group_rest_days_cycle_id_fkey`: `FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE CASCADE`
- `group_rest_days_cycle_id_rest_date_key`: `UNIQUE (cycle_id, rest_date)`
- `group_rest_days_firestore_id_key`: `UNIQUE (firestore_id)`
- `group_rest_days_pkey`: `PRIMARY KEY (id)`

Indexes:

- `CREATE UNIQUE INDEX group_rest_days_cycle_id_rest_date_key ON public.group_rest_days USING btree (cycle_id, rest_date)`
- `CREATE UNIQUE INDEX group_rest_days_firestore_id_key ON public.group_rest_days USING btree (firestore_id)`
- `CREATE UNIQUE INDEX group_rest_days_pkey ON public.group_rest_days USING btree (id)`
- `CREATE INDEX rest_days_cycle_date_idx ON public.group_rest_days USING btree (cycle_id, rest_date)`

## public.peer_test_attempt_questions

| Column | Type | Nullable | Default |
|---|---|---|---|
| attempt_id | uuid | NO |  |
| question_number | smallint | NO |  |
| start_surah | smallint | NO |  |
| start_surah_name | text | NO |  |
| start_ayah | smallint | NO |  |
| end_surah | smallint | NO |  |
| end_surah_name | text | NO |  |
| end_ayah | smallint | NO |  |
| start_page | smallint | YES |  |
| start_line | smallint | YES |  |
| end_page | smallint | YES |  |
| end_line | smallint | YES |  |
| actual_lines | smallint | YES |  |
| difficulty_level | text | YES |  |
| errors_count | smallint | YES |  |
| notes | text | YES |  |
| legacy_incomplete | boolean | NO | false |

Constraints:

- `peer_test_attempt_questions_attempt_id_fkey`: `FOREIGN KEY (attempt_id) REFERENCES peer_test_attempts(id) ON DELETE CASCADE`
- `peer_test_attempt_questions_errors_check`: `CHECK (((errors_count IS NULL) OR ((errors_count >= 0) AND (errors_count <= 99))))`
- `peer_test_attempt_questions_level_check`: `CHECK (((difficulty_level IS NULL) OR (difficulty_level = ANY (ARRAY['easy'::text, 'medium'::text, 'hard'::text]))))`
- `peer_test_attempt_questions_notes_check`: `CHECK (((notes IS NULL) OR (length(notes) <= 300)))`
- `peer_test_attempt_questions_pkey`: `PRIMARY KEY (attempt_id, question_number)`
- `question_geometry_required`: `CHECK ((legacy_incomplete OR ((start_page IS NOT NULL) AND (start_line IS NOT NULL) AND (end_page IS NOT NULL) AND (end_line IS NOT NULL) AND (actual_lines IS NOT NULL))))`

Indexes:

- `CREATE UNIQUE INDEX peer_test_attempt_questions_pkey ON public.peer_test_attempt_questions USING btree (attempt_id, question_number)`

## public.peer_test_attempts

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| test_id | uuid | NO |  |
| candidate_id | uuid | NO |  |
| candidate_name_snapshot | text | NO |  |
| examiner_id | uuid | YES |  |
| examiner_name_snapshot | text | NO |  |
| status | text | NO | 'in_progress'::text |
| total_errors | smallint | YES |  |
| max_errors_snapshot | smallint | YES |  |
| notes | text | YES |  |
| attempt_date | date | NO |  |
| created_at | timestamp with time zone | NO | now() |
| completed_at | timestamp with time zone | YES |  |
| firestore_id | text | YES |  |
| effective_range_end | integer | YES |  |
| covers_full_range | boolean | YES |  |
| legacy_passed | boolean | YES |  |

Constraints:

- `peer_test_attempts_candidate_id_fkey`: `FOREIGN KEY (candidate_id) REFERENCES profiles(id) ON DELETE CASCADE`
- `peer_test_attempts_examiner_id_fkey`: `FOREIGN KEY (examiner_id) REFERENCES profiles(id) ON DELETE SET NULL`
- `peer_test_attempts_firestore_id_key`: `UNIQUE (firestore_id)`
- `peer_test_attempts_notes_check`: `CHECK (((notes IS NULL) OR (length(notes) <= 300)))`
- `peer_test_attempts_pkey`: `PRIMARY KEY (id)`
- `peer_test_attempts_status_check`: `CHECK ((status = ANY (ARRAY['in_progress'::text, 'passed'::text, 'failed'::text, 'cancelled'::text])))`
- `peer_test_attempts_test_id_fkey`: `FOREIGN KEY (test_id) REFERENCES peer_tests(id) ON DELETE RESTRICT`

Indexes:

- `CREATE INDEX peer_test_attempts_candidate_idx ON public.peer_test_attempts USING btree (candidate_id)`
- `CREATE INDEX peer_test_attempts_examiner_idx ON public.peer_test_attempts USING btree (examiner_id)`
- `CREATE UNIQUE INDEX peer_test_attempts_firestore_id_key ON public.peer_test_attempts USING btree (firestore_id)`
- `CREATE UNIQUE INDEX peer_test_attempts_one_open_idx ON public.peer_test_attempts USING btree (test_id, candidate_id) WHERE (status = 'in_progress'::text)`
- `CREATE UNIQUE INDEX peer_test_attempts_pkey ON public.peer_test_attempts USING btree (id)`
- `CREATE INDEX peer_test_attempts_test_candidate_idx ON public.peer_test_attempts USING btree (test_id, candidate_id, status)`

## public.peer_test_selected_members

| Column | Type | Nullable | Default |
|---|---|---|---|
| test_id | uuid | NO |  |
| user_id | uuid | NO |  |
| position | integer | NO |  |

Constraints:

- `peer_test_selected_members_pkey`: `PRIMARY KEY (test_id, user_id)`
- `peer_test_selected_members_position_check`: `CHECK (("position" >= 0))`
- `peer_test_selected_members_test_id_fkey`: `FOREIGN KEY (test_id) REFERENCES peer_tests(id) ON DELETE CASCADE`
- `peer_test_selected_members_test_id_position_key`: `UNIQUE (test_id, "position")`
- `peer_test_selected_members_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE RESTRICT`

Indexes:

- `CREATE UNIQUE INDEX peer_test_selected_members_pkey ON public.peer_test_selected_members USING btree (test_id, user_id)`
- `CREATE UNIQUE INDEX peer_test_selected_members_test_id_position_key ON public.peer_test_selected_members USING btree (test_id, "position")`
- `CREATE INDEX peer_test_selected_members_user_idx ON public.peer_test_selected_members USING btree (user_id)`

## public.peer_tests

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| cycle_id | uuid | NO |  |
| title | text | NO |  |
| range_start | smallint | NO |  |
| range_end | smallint | NO |  |
| questions_count | smallint | NO |  |
| lines_per_question | smallint | NO |  |
| max_errors | smallint | YES |  |
| test_type | text | NO | 'mandatory'::text |
| difficulty | text | NO | 'any'::text |
| status | text | NO | 'draft'::text |
| visible_from | timestamp with time zone | YES |  |
| visible_until | timestamp with time zone | YES |  |
| created_by | uuid | YES |  |
| created_at | timestamp with time zone | NO | now() |
| updated_at | timestamp with time zone | NO | now() |
| finished_at | timestamp with time zone | YES |  |
| firestore_id | text | YES |  |
| require_all_quarters_completed | boolean | NO | false |
| require_revision_completed | boolean | NO | false |
| audience | text | NO | 'all'::text |
| legacy_is_active | boolean | YES |  |
| legacy_is_finished | boolean | YES |  |
| legacy_has_max_errors | boolean | YES |  |
| legacy_max_errors_allowed | integer | YES |  |

Constraints:

- `peer_tests_audience_check`: `CHECK ((audience = ANY (ARRAY['all'::text, 'selected'::text])))`
- `peer_tests_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `peer_tests_cycle_id_fkey`: `FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE RESTRICT`
- `peer_tests_difficulty_check`: `CHECK ((difficulty = ANY (ARRAY['any'::text, 'easy'::text, 'medium'::text, 'hard'::text, 'mixed'::text])))`
- `peer_tests_firestore_id_key`: `UNIQUE (firestore_id)`
- `peer_tests_lines_check`: `CHECK (((lines_per_question >= 1) AND (lines_per_question <= 60)))`
- `peer_tests_max_errors_check`: `CHECK (((max_errors IS NULL) OR ((max_errors >= 0) AND (max_errors <= 100))))`
- `peer_tests_pkey`: `PRIMARY KEY (id)`
- `peer_tests_questions_check`: `CHECK (((questions_count >= 1) AND (questions_count <= 50)))`
- `peer_tests_range_check`: `CHECK (((range_start >= 1) AND (range_start <= 240) AND ((range_end >= 1) AND (range_end <= 240)) AND (range_start <= range_end)))`
- `peer_tests_status_check`: `CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'hidden'::text, 'finished'::text])))`
- `peer_tests_title_check`: `CHECK (((length(btrim(title)) >= 1) AND (length(btrim(title)) <= 120)))`
- `peer_tests_type_check`: `CHECK ((test_type = ANY (ARRAY['mandatory'::text, 'recommended'::text])))`
- `peer_tests_window_check`: `CHECK (((visible_from IS NULL) OR (visible_until IS NULL) OR (visible_from < visible_until)))`

Indexes:

- `CREATE INDEX peer_tests_cycle_status_idx ON public.peer_tests USING btree (cycle_id, status)`
- `CREATE UNIQUE INDEX peer_tests_firestore_id_key ON public.peer_tests USING btree (firestore_id)`
- `CREATE UNIQUE INDEX peer_tests_pkey ON public.peer_tests USING btree (id)`

## public.personal_test_questions

| Column | Type | Nullable | Default |
|---|---|---|---|
| test_id | uuid | NO |  |
| question_number | integer | NO |  |
| start_surah | integer | NO |  |
| start_surah_name | text | NO |  |
| start_ayah | integer | NO |  |
| end_surah | integer | NO |  |
| end_surah_name | text | NO |  |
| end_ayah | integer | NO |  |
| errors_count | integer | NO |  |
| grade | numeric | NO |  |
| difficulty_level | text | YES |  |

Constraints:

- `personal_test_questions_pkey`: `PRIMARY KEY (test_id, question_number)`
- `personal_test_questions_test_id_fkey`: `FOREIGN KEY (test_id) REFERENCES personal_tests(id) ON DELETE CASCADE`

Indexes:

- `CREATE UNIQUE INDEX personal_test_questions_pkey ON public.personal_test_questions USING btree (test_id, question_number)`

## public.personal_tests

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO |  |
| firestore_id | text | YES |  |
| member_id | uuid | NO |  |
| range_type | text | YES |  |
| range_label | text | YES |  |
| start_surah | integer | NO |  |
| start_surah_name | text | NO |  |
| end_surah | integer | NO |  |
| end_surah_name | text | NO |  |
| start_juz | integer | YES |  |
| end_juz | integer | YES |  |
| start_quarter | integer | YES |  |
| end_quarter | integer | YES |  |
| questions_count | integer | NO |  |
| lines_per_question | integer | NO |  |
| difficulty | text | NO |  |
| total_errors | integer | NO |  |
| grade | numeric | NO |  |
| grade_label | text | NO |  |
| notes | text | YES |  |
| date | date | NO |  |
| created_at | timestamp with time zone | NO |  |

Constraints:

- `personal_tests_firestore_id_key`: `UNIQUE (firestore_id)`
- `personal_tests_member_id_fkey`: `FOREIGN KEY (member_id) REFERENCES profiles(id)`
- `personal_tests_pkey`: `PRIMARY KEY (id)`
- `personal_tests_range_type_check`: `CHECK ((range_type = ANY (ARRAY['surah'::text, 'juz'::text, 'quarter'::text])))`

Indexes:

- `CREATE UNIQUE INDEX personal_tests_firestore_id_key ON public.personal_tests USING btree (firestore_id)`
- `CREATE INDEX personal_tests_member_date_idx ON public.personal_tests USING btree (member_id, date)`
- `CREATE UNIQUE INDEX personal_tests_pkey ON public.personal_tests USING btree (id)`

## public.profiles

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO |  |
| full_name | text | NO |  |
| phone | text | NO |  |
| role | text | NO | 'member'::text |
| active | boolean | NO | true |
| created_at | timestamp with time zone | NO | now() |
| deactivated_at | timestamp with time zone | YES |  |
| is_master_admin | boolean | NO | false |
| firestore_id | text | YES |  |

Constraints:

- `profiles_firestore_id_key`: `UNIQUE (firestore_id)`
- `profiles_master_admin_requires_admin_role`: `CHECK (((NOT is_master_admin) OR (role = 'admin'::text)))`
- `profiles_phone_key`: `UNIQUE (phone)`
- `profiles_pkey`: `PRIMARY KEY (id)`
- `profiles_role_check`: `CHECK ((role = ANY (ARRAY['member'::text, 'admin'::text])))`

Indexes:

- `CREATE UNIQUE INDEX profiles_firestore_id_key ON public.profiles USING btree (firestore_id)`
- `CREATE UNIQUE INDEX profiles_phone_key ON public.profiles USING btree (phone)`
- `CREATE UNIQUE INDEX profiles_pkey ON public.profiles USING btree (id)`

## public.program_pauses

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| cycle_id | uuid | NO |  |
| paused_on | date | NO |  |
| resumed_on | date | YES |  |
| reason | text | YES |  |
| created_by | uuid | YES |  |
| created_at | timestamp with time zone | NO | now() |

Constraints:

- `program_pauses_check`: `CHECK (((resumed_on IS NULL) OR (resumed_on >= paused_on)))`
- `program_pauses_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `program_pauses_cycle_id_fkey`: `FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE CASCADE`
- `program_pauses_pkey`: `PRIMARY KEY (id)`

Indexes:

- `CREATE INDEX program_pauses_cycle_idx ON public.program_pauses USING btree (cycle_id)`
- `CREATE UNIQUE INDEX program_pauses_pkey ON public.program_pauses USING btree (id)`

## public.review_confirmations

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| cycle_id | uuid | NO |  |
| user_id | uuid | NO |  |
| program_day | integer | YES |  |
| start_quarter | integer | NO |  |
| end_quarter | integer | NO |  |
| confirmed_at | timestamp with time zone | NO | now() |
| firestore_id | text | YES |  |
| legacy_date | date | YES |  |
| member_name_snapshot | text | YES |  |
| notes | text | YES |  |
| legacy_occurrence | integer | NO | 0 |

Constraints:

- `review_confirmations_check`: `CHECK ((end_quarter >= start_quarter))`
- `review_confirmations_cycle_id_fkey`: `FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE CASCADE`
- `review_confirmations_cycle_id_user_id_program_day_key`: `UNIQUE (cycle_id, user_id, program_day)`
- `review_confirmations_end_quarter_check`: `CHECK (((end_quarter >= 1) AND (end_quarter <= 240)))`
- `review_confirmations_firestore_id_key`: `UNIQUE (firestore_id)`
- `review_confirmations_legacy_occurrence_check`: `CHECK ((legacy_occurrence >= 0))`
- `review_confirmations_pkey`: `PRIMARY KEY (id)`
- `review_confirmations_program_day_check`: `CHECK (((program_day >= 1) AND (program_day <= 240)))`
- `review_confirmations_start_quarter_check`: `CHECK (((start_quarter >= 1) AND (start_quarter <= 240)))`
- `review_confirmations_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE`
- `reviews_legacy_date_key`: `UNIQUE (cycle_id, user_id, legacy_date, legacy_occurrence)`
- `reviews_legacy_unknown_day`: `CHECK (((program_day IS NOT NULL) OR ((firestore_id IS NOT NULL) AND (legacy_date IS NOT NULL))))`

Indexes:

- `CREATE INDEX review_confirmations_cycle_day_idx ON public.review_confirmations USING btree (cycle_id, program_day)`
- `CREATE UNIQUE INDEX review_confirmations_cycle_id_user_id_program_day_key ON public.review_confirmations USING btree (cycle_id, user_id, program_day)`
- `CREATE UNIQUE INDEX review_confirmations_firestore_id_key ON public.review_confirmations USING btree (firestore_id)`
- `CREATE UNIQUE INDEX review_confirmations_pkey ON public.review_confirmations USING btree (id)`
- `CREATE INDEX reviews_cycle_idx ON public.review_confirmations USING btree (cycle_id)`
- `CREATE UNIQUE INDEX reviews_legacy_date_key ON public.review_confirmations USING btree (cycle_id, user_id, legacy_date, legacy_occurrence)`
- `CREATE INDEX reviews_user_idx ON public.review_confirmations USING btree (user_id)`

## public.tasmia_submissions

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| cycle_id | uuid | NO |  |
| user_id | uuid | NO |  |
| listener_id | uuid | YES |  |
| quarter_number | integer | NO |  |
| notes | text | YES |  |
| submitted_at | timestamp with time zone | NO | now() |
| listener_name_snapshot | text | NO |  |
| listener_changed_at | timestamp with time zone | YES |  |
| firestore_id | text | YES |  |
| legacy_date | date | YES |  |
| member_name_snapshot | text | YES |  |
| legacy_occurrence | integer | NO | 0 |

Constraints:

- `tasmia_legacy_occurrence_source`: `CHECK (((legacy_occurrence = 0) OR (firestore_id IS NOT NULL)))`
- `tasmia_listener_present`: `CHECK (((listener_id IS NOT NULL) OR (listener_name_snapshot IS NOT NULL)))`
- `tasmia_submissions_cycle_id_fkey`: `FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE CASCADE`
- `tasmia_submissions_firestore_id_key`: `UNIQUE (firestore_id)`
- `tasmia_submissions_history_key`: `UNIQUE (cycle_id, user_id, quarter_number, legacy_occurrence)`
- `tasmia_submissions_legacy_occurrence_check`: `CHECK ((legacy_occurrence >= 0))`
- `tasmia_submissions_listener_id_fkey`: `FOREIGN KEY (listener_id) REFERENCES profiles(id) ON DELETE SET NULL`
- `tasmia_submissions_pkey`: `PRIMARY KEY (id)`
- `tasmia_submissions_quarter_number_check`: `CHECK (((quarter_number >= 1) AND (quarter_number <= 240)))`
- `tasmia_submissions_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE`

Indexes:

- `CREATE INDEX tasmia_cycle_idx ON public.tasmia_submissions USING btree (cycle_id)`
- `CREATE INDEX tasmia_listener_idx ON public.tasmia_submissions USING btree (listener_id)`
- `CREATE INDEX tasmia_submissions_cycle_submitted_idx ON public.tasmia_submissions USING btree (cycle_id, submitted_at)`
- `CREATE UNIQUE INDEX tasmia_submissions_firestore_id_key ON public.tasmia_submissions USING btree (firestore_id)`
- `CREATE UNIQUE INDEX tasmia_submissions_history_key ON public.tasmia_submissions USING btree (cycle_id, user_id, quarter_number, legacy_occurrence)`
- `CREATE UNIQUE INDEX tasmia_submissions_pkey ON public.tasmia_submissions USING btree (id)`
- `CREATE INDEX tasmia_user_idx ON public.tasmia_submissions USING btree (user_id)`

## Views

### public.profile_batch_overview

Options: ["security_invoker=true"]

```sql
 SELECT p.id AS user_id,
    p.full_name,
    p.phone,
    p.role,
    p.active,
    p.deactivated_at,
    p.is_master_admin,
        CASE
            WHEN ((p.role = 'admin'::text) AND (p.is_master_admin = true)) THEN 'Master Admin - All Batches'::text
            WHEN (count(b.id) = 0) THEN 'No batch assigned'::text
            ELSE string_agg(DISTINCT b.name, ', '::text ORDER BY b.name)
        END AS batches
   FROM ((profiles p
     LEFT JOIN batch_memberships bm ON ((bm.user_id = p.id)))
     LEFT JOIN batches b ON ((b.id = bm.batch_id)))
  GROUP BY p.id, p.full_name, p.phone, p.role, p.active, p.deactivated_at, p.is_master_admin;
```

## Functions

- `public.rls_auto_enable()`: event_trigger; SECURITY DEFINER=true; volatility=v; config=["search_path=pg_catalog"]. Exact body in companion catalog JSON.
- `public.sync_deactivated_at()`: trigger; SECURITY DEFINER=false; volatility=v; config=null. Exact body in companion catalog JSON.

## Triggers and event triggers

- `CREATE TRIGGER trg_sync_deactivated_at BEFORE UPDATE OF active ON public.profiles FOR EACH ROW EXECUTE FUNCTION sync_deactivated_at()`
- `ensure_rls`: ddl_command_end; tags=["CREATE TABLE","CREATE TABLE AS","SELECT INTO"]; function=rls_auto_enable(); enabled=O.

## Policies
