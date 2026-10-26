# Reconstructed Sisters schema

Generated from locally executed PostgreSQL DDL. No production records.

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

- `CREATE UNIQUE INDEX batch_memberships_pkey ON public.batch_memberships USING btree (id)`
- `CREATE UNIQUE INDEX batch_memberships_batch_user_key ON public.batch_memberships USING btree (batch_id, user_id)`
- `CREATE UNIQUE INDEX batch_memberships_one_batch_per_member_idx ON public.batch_memberships USING btree (user_id) WHERE (membership_role = 'member'::text)`
- `CREATE INDEX batch_memberships_user_id_idx ON public.batch_memberships USING btree (user_id)`
- `CREATE INDEX batch_memberships_batch_role_idx ON public.batch_memberships USING btree (batch_id, membership_role)`

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

- `CREATE UNIQUE INDEX batches_pkey ON public.batches USING btree (id)`
- `CREATE UNIQUE INDEX batches_name_unique_idx ON public.batches USING btree (lower(btrim(name)))`

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

Constraints:

- `cycles_batch_id_fkey`: `FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE RESTRICT`
- `cycles_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `cycles_pkey`: `PRIMARY KEY (id)`
- `cycles_status_check`: `CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))`

Indexes:

- `CREATE UNIQUE INDEX cycles_pkey ON public.cycles USING btree (id)`
- `CREATE UNIQUE INDEX cycles_batch_cycle_number_key ON public.cycles USING btree (batch_id, cycle_number)`
- `CREATE UNIQUE INDEX cycles_one_active_per_batch_idx ON public.cycles USING btree (batch_id) WHERE (status = 'active'::text)`
- `CREATE INDEX cycles_batch_status_idx ON public.cycles USING btree (batch_id, status)`

## public.daily_thoughts

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| content_html | text | NO |  |
| published_by | uuid | YES |  |
| published_at | timestamp with time zone | NO | now() |
| is_published | boolean | NO | true |
| batch_id | uuid | NO |  |

Constraints:

- `daily_thoughts_batch_id_fkey`: `FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE RESTRICT`
- `daily_thoughts_pkey`: `PRIMARY KEY (id)`
- `daily_thoughts_published_by_fkey`: `FOREIGN KEY (published_by) REFERENCES profiles(id) ON DELETE SET NULL`

Indexes:

- `CREATE UNIQUE INDEX daily_thoughts_pkey ON public.daily_thoughts USING btree (id)`
- `CREATE INDEX daily_thoughts_published_idx ON public.daily_thoughts USING btree (published_at DESC)`
- `CREATE INDEX daily_thoughts_batch_published_idx ON public.daily_thoughts USING btree (batch_id, is_published, published_at DESC)`

## public.group_rest_days

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| cycle_id | uuid | NO |  |
| rest_date | date | NO |  |
| reason | text | YES |  |
| created_by | uuid | YES |  |
| created_at | timestamp with time zone | NO | now() |

Constraints:

- `group_rest_days_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `group_rest_days_cycle_id_fkey`: `FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE CASCADE`
- `group_rest_days_cycle_id_rest_date_key`: `UNIQUE (cycle_id, rest_date)`
- `group_rest_days_pkey`: `PRIMARY KEY (id)`

Indexes:

- `CREATE UNIQUE INDEX group_rest_days_cycle_id_rest_date_key ON public.group_rest_days USING btree (cycle_id, rest_date)`
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
| start_page | smallint | NO |  |
| start_line | smallint | NO |  |
| end_page | smallint | NO |  |
| end_line | smallint | NO |  |
| actual_lines | smallint | NO |  |
| difficulty_level | text | YES |  |
| errors_count | smallint | YES |  |
| notes | text | YES |  |

Constraints:

- `peer_test_attempt_questions_attempt_id_fkey`: `FOREIGN KEY (attempt_id) REFERENCES peer_test_attempts(id) ON DELETE CASCADE`
- `peer_test_attempt_questions_errors_check`: `CHECK (((errors_count IS NULL) OR ((errors_count >= 0) AND (errors_count <= 99))))`
- `peer_test_attempt_questions_level_check`: `CHECK (((difficulty_level IS NULL) OR (difficulty_level = ANY (ARRAY['easy'::text, 'medium'::text, 'hard'::text]))))`
- `peer_test_attempt_questions_notes_check`: `CHECK (((notes IS NULL) OR (length(notes) <= 300)))`
- `peer_test_attempt_questions_pkey`: `PRIMARY KEY (attempt_id, question_number)`

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

Constraints:

- `peer_test_attempts_candidate_id_fkey`: `FOREIGN KEY (candidate_id) REFERENCES profiles(id) ON DELETE CASCADE`
- `peer_test_attempts_examiner_id_fkey`: `FOREIGN KEY (examiner_id) REFERENCES profiles(id) ON DELETE SET NULL`
- `peer_test_attempts_notes_check`: `CHECK (((notes IS NULL) OR (length(notes) <= 300)))`
- `peer_test_attempts_pkey`: `PRIMARY KEY (id)`
- `peer_test_attempts_status_check`: `CHECK ((status = ANY (ARRAY['in_progress'::text, 'passed'::text, 'failed'::text, 'cancelled'::text])))`
- `peer_test_attempts_test_id_fkey`: `FOREIGN KEY (test_id) REFERENCES peer_tests(id) ON DELETE RESTRICT`

Indexes:

- `CREATE UNIQUE INDEX peer_test_attempts_pkey ON public.peer_test_attempts USING btree (id)`
- `CREATE UNIQUE INDEX peer_test_attempts_one_open_idx ON public.peer_test_attempts USING btree (test_id, candidate_id) WHERE (status = 'in_progress'::text)`
- `CREATE INDEX peer_test_attempts_test_candidate_idx ON public.peer_test_attempts USING btree (test_id, candidate_id, status)`
- `CREATE INDEX peer_test_attempts_candidate_idx ON public.peer_test_attempts USING btree (candidate_id)`
- `CREATE INDEX peer_test_attempts_examiner_idx ON public.peer_test_attempts USING btree (examiner_id)`

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

Constraints:

- `peer_tests_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `peer_tests_cycle_id_fkey`: `FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE RESTRICT`
- `peer_tests_difficulty_check`: `CHECK ((difficulty = ANY (ARRAY['any'::text, 'easy'::text, 'medium'::text, 'hard'::text, 'mixed'::text])))`
- `peer_tests_lines_check`: `CHECK (((lines_per_question >= 1) AND (lines_per_question <= 60)))`
- `peer_tests_max_errors_check`: `CHECK (((max_errors IS NULL) OR ((max_errors >= 0) AND (max_errors <= 100))))`
- `peer_tests_pkey`: `PRIMARY KEY (id)`
- `peer_tests_questions_check`: `CHECK (((questions_count >= 1) AND (questions_count <= 50)))`
- `peer_tests_range_check`: `CHECK ((((range_start >= 1) AND (range_start <= 240)) AND ((range_end >= 1) AND (range_end <= 240)) AND (range_start <= range_end)))`
- `peer_tests_status_check`: `CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'hidden'::text, 'finished'::text])))`
- `peer_tests_title_check`: `CHECK (((length(btrim(title)) >= 1) AND (length(btrim(title)) <= 120)))`
- `peer_tests_type_check`: `CHECK ((test_type = ANY (ARRAY['mandatory'::text, 'recommended'::text])))`
- `peer_tests_window_check`: `CHECK (((visible_from IS NULL) OR (visible_until IS NULL) OR (visible_from < visible_until)))`

Indexes:

- `CREATE UNIQUE INDEX peer_tests_pkey ON public.peer_tests USING btree (id)`
- `CREATE INDEX peer_tests_cycle_status_idx ON public.peer_tests USING btree (cycle_id, status)`

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

Constraints:

- `profiles_id_fkey`: `FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE`
- `profiles_master_admin_requires_admin_role`: `CHECK (((NOT is_master_admin) OR (role = 'admin'::text)))`
- `profiles_phone_key`: `UNIQUE (phone)`
- `profiles_pkey`: `PRIMARY KEY (id)`
- `profiles_role_check`: `CHECK ((role = ANY (ARRAY['member'::text, 'admin'::text])))`

Indexes:

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

- `CREATE UNIQUE INDEX program_pauses_pkey ON public.program_pauses USING btree (id)`
- `CREATE INDEX program_pauses_cycle_idx ON public.program_pauses USING btree (cycle_id)`

## public.review_confirmations

| Column | Type | Nullable | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| cycle_id | uuid | NO |  |
| user_id | uuid | NO |  |
| program_day | integer | NO |  |
| start_quarter | integer | NO |  |
| end_quarter | integer | NO |  |
| confirmed_at | timestamp with time zone | NO | now() |

Constraints:

- `review_confirmations_check`: `CHECK ((end_quarter >= start_quarter))`
- `review_confirmations_cycle_id_fkey`: `FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE CASCADE`
- `review_confirmations_cycle_id_user_id_program_day_key`: `UNIQUE (cycle_id, user_id, program_day)`
- `review_confirmations_end_quarter_check`: `CHECK (((end_quarter >= 1) AND (end_quarter <= 240)))`
- `review_confirmations_pkey`: `PRIMARY KEY (id)`
- `review_confirmations_program_day_check`: `CHECK (((program_day >= 1) AND (program_day <= 240)))`
- `review_confirmations_start_quarter_check`: `CHECK (((start_quarter >= 1) AND (start_quarter <= 240)))`
- `review_confirmations_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE`

Indexes:

- `CREATE UNIQUE INDEX review_confirmations_cycle_id_user_id_program_day_key ON public.review_confirmations USING btree (cycle_id, user_id, program_day)`
- `CREATE UNIQUE INDEX review_confirmations_pkey ON public.review_confirmations USING btree (id)`
- `CREATE INDEX reviews_cycle_idx ON public.review_confirmations USING btree (cycle_id)`
- `CREATE INDEX reviews_user_idx ON public.review_confirmations USING btree (user_id)`
- `CREATE INDEX review_confirmations_cycle_day_idx ON public.review_confirmations USING btree (cycle_id, program_day)`

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

Constraints:

- `tasmia_listener_present`: `CHECK (((listener_id IS NOT NULL) OR (listener_name_snapshot IS NOT NULL)))`
- `tasmia_submissions_cycle_id_fkey`: `FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE CASCADE`
- `tasmia_submissions_cycle_id_user_id_quarter_number_key`: `UNIQUE (cycle_id, user_id, quarter_number)`
- `tasmia_submissions_listener_id_fkey`: `FOREIGN KEY (listener_id) REFERENCES profiles(id) ON DELETE SET NULL`
- `tasmia_submissions_pkey`: `PRIMARY KEY (id)`
- `tasmia_submissions_quarter_number_check`: `CHECK (((quarter_number >= 1) AND (quarter_number <= 240)))`
- `tasmia_submissions_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE`

Indexes:

- `CREATE UNIQUE INDEX tasmia_submissions_cycle_id_user_id_quarter_number_key ON public.tasmia_submissions USING btree (cycle_id, user_id, quarter_number)`
- `CREATE UNIQUE INDEX tasmia_submissions_pkey ON public.tasmia_submissions USING btree (id)`
- `CREATE INDEX tasmia_cycle_idx ON public.tasmia_submissions USING btree (cycle_id)`
- `CREATE INDEX tasmia_listener_idx ON public.tasmia_submissions USING btree (listener_id)`
- `CREATE INDEX tasmia_user_idx ON public.tasmia_submissions USING btree (user_id)`
- `CREATE INDEX tasmia_submissions_cycle_submitted_idx ON public.tasmia_submissions USING btree (cycle_id, submitted_at)`

## Functions

- `public.sync_deactivated_at` — full definition and ACL in reconstructed-catalog.json.
- `public.create_batch_with_cycle` — full definition and ACL in reconstructed-catalog.json.
- `public.start_next_cycle` — full definition and ACL in reconstructed-catalog.json.
- `public.create_profile_with_membership` — full definition and ACL in reconstructed-catalog.json.
- `public.set_admin_batches` — full definition and ACL in reconstructed-catalog.json.
- `public.move_member_batch` — full definition and ACL in reconstructed-catalog.json.
- `public.history_member_names` — full definition and ACL in reconstructed-catalog.json.
- `public.peer_test_set_status` — full definition and ACL in reconstructed-catalog.json.
- `public.peer_test_start_attempt` — full definition and ACL in reconstructed-catalog.json.
- `public.peer_test_submit_attempt` — full definition and ACL in reconstructed-catalog.json.
- `public.peer_test_save` — full definition and ACL in reconstructed-catalog.json.
- `public.correct_tasmia_listener` — full definition and ACL in reconstructed-catalog.json.
- `app_private.viewable_batch_ids` — full definition and ACL in reconstructed-catalog.json.
- `app_private.managed_cycle_ids` — full definition and ACL in reconstructed-catalog.json.
- `app_private.member_active_cycle_id` — full definition and ACL in reconstructed-catalog.json.
- `app_private.is_master_admin` — full definition and ACL in reconstructed-catalog.json.
- `app_private.member_batch_id` — full definition and ACL in reconstructed-catalog.json.
- `app_private.managed_batch_ids` — full definition and ACL in reconstructed-catalog.json.
- `app_private.viewable_profile_ids` — full definition and ACL in reconstructed-catalog.json.
- `app_private.cycle_batch_id` — full definition and ACL in reconstructed-catalog.json.
- `app_private.batch_memberships_guard` — full definition and ACL in reconstructed-catalog.json.
- `app_private.profiles_batch_guard` — full definition and ACL in reconstructed-catalog.json.
- `app_private.review_batch_guard` — full definition and ACL in reconstructed-catalog.json.
- `app_private.managed_peer_test_ids` — full definition and ACL in reconstructed-catalog.json.
- `app_private.assert_no_overlapping_peer_test` — full definition and ACL in reconstructed-catalog.json.
- `app_private.peer_test_is_live` — full definition and ACL in reconstructed-catalog.json.
- `app_private.visible_peer_attempt_ids` — full definition and ACL in reconstructed-catalog.json.
- `app_private.peer_test_future_window` — full definition and ACL in reconstructed-catalog.json.
- `app_private.tasmia_listener_name` — full definition and ACL in reconstructed-catalog.json.
- `app_private.tasmia_batch_guard` — full definition and ACL in reconstructed-catalog.json.

## Policies

- `public.cycles.cycles_select_accessible`: SELECT; roles authenticated; USING `((batch_id IN ( SELECT app_private.managed_batch_ids() AS managed_batch_ids)) OR (id = ( SELECT app_private.member_active_cycle_id() AS member_active_cycle_id)))`; CHECK ``.
- `public.cycles.cycles_update_managed`: UPDATE; roles authenticated; USING `(batch_id IN ( SELECT app_private.managed_batch_ids() AS managed_batch_ids))`; CHECK `(batch_id IN ( SELECT app_private.managed_batch_ids() AS managed_batch_ids))`.
- `public.daily_thoughts.daily_thoughts_insert_managed`: INSERT; roles authenticated; USING ``; CHECK `((batch_id IN ( SELECT app_private.managed_batch_ids() AS managed_batch_ids)) AND (published_by = ( SELECT auth.uid() AS uid)))`.
- `public.daily_thoughts.daily_thoughts_select_accessible`: SELECT; roles authenticated; USING `((batch_id IN ( SELECT app_private.managed_batch_ids() AS managed_batch_ids)) OR (is_published AND (batch_id IN ( SELECT app_private.viewable_batch_ids() AS viewable_batch_ids))))`; CHECK ``.
- `public.daily_thoughts.daily_thoughts_update_managed`: UPDATE; roles authenticated; USING `(batch_id IN ( SELECT app_private.managed_batch_ids() AS managed_batch_ids))`; CHECK `(batch_id IN ( SELECT app_private.managed_batch_ids() AS managed_batch_ids))`.
- `public.group_rest_days.group_rest_days_delete_managed`: DELETE; roles authenticated; USING `(cycle_id IN ( SELECT app_private.managed_cycle_ids() AS managed_cycle_ids))`; CHECK ``.
- `public.group_rest_days.group_rest_days_insert_managed`: INSERT; roles authenticated; USING ``; CHECK `((cycle_id IN ( SELECT app_private.managed_cycle_ids() AS managed_cycle_ids)) AND (created_by = ( SELECT auth.uid() AS uid)))`.
- `public.group_rest_days.group_rest_days_select_accessible`: SELECT; roles authenticated; USING `((cycle_id IN ( SELECT app_private.managed_cycle_ids() AS managed_cycle_ids)) OR (cycle_id = ( SELECT app_private.member_active_cycle_id() AS member_active_cycle_id)))`; CHECK ``.
- `public.profiles.profiles_select_visible`: SELECT; roles authenticated; USING `((id = ( SELECT auth.uid() AS uid)) OR (id IN ( SELECT app_private.viewable_profile_ids() AS viewable_profile_ids)))`; CHECK ``.
- `public.program_pauses.program_pauses_insert_managed`: INSERT; roles authenticated; USING ``; CHECK `((cycle_id IN ( SELECT app_private.managed_cycle_ids() AS managed_cycle_ids)) AND (created_by = ( SELECT auth.uid() AS uid)))`.
- `public.program_pauses.program_pauses_select_accessible`: SELECT; roles authenticated; USING `((cycle_id IN ( SELECT app_private.managed_cycle_ids() AS managed_cycle_ids)) OR (cycle_id = ( SELECT app_private.member_active_cycle_id() AS member_active_cycle_id)))`; CHECK ``.
- `public.program_pauses.program_pauses_update_managed`: UPDATE; roles authenticated; USING `(cycle_id IN ( SELECT app_private.managed_cycle_ids() AS managed_cycle_ids))`; CHECK `(cycle_id IN ( SELECT app_private.managed_cycle_ids() AS managed_cycle_ids))`.
- `public.review_confirmations.review_confirmations_insert_own_batch`: INSERT; roles authenticated; USING ``; CHECK `((user_id = ( SELECT auth.uid() AS uid)) AND (cycle_id = ( SELECT app_private.member_active_cycle_id() AS member_active_cycle_id)))`.
- `public.review_confirmations.review_confirmations_select_accessible`: SELECT; roles authenticated; USING `((cycle_id IN ( SELECT app_private.managed_cycle_ids() AS managed_cycle_ids)) OR ((cycle_id = ( SELECT app_private.member_active_cycle_id() AS member_active_cycle_id)) AND (user_id = ( SELECT auth.uid() AS uid))))`; CHECK ``.
- `public.tasmia_submissions.tasmia_submissions_insert_own_batch`: INSERT; roles authenticated; USING ``; CHECK `((user_id = ( SELECT auth.uid() AS uid)) AND (cycle_id = ( SELECT app_private.member_active_cycle_id() AS member_active_cycle_id)))`.
- `public.tasmia_submissions.tasmia_submissions_select_accessible`: SELECT; roles authenticated; USING `((cycle_id IN ( SELECT app_private.managed_cycle_ids() AS managed_cycle_ids)) OR ((cycle_id = ( SELECT app_private.member_active_cycle_id() AS member_active_cycle_id)) AND ((user_id = ( SELECT auth.uid() AS uid)) OR (listener_id = ( SELECT auth.uid() AS uid)))))`; CHECK ``.
- `public.batches.batches_select_accessible`: SELECT; roles authenticated; USING `(id IN ( SELECT app_private.viewable_batch_ids() AS viewable_batch_ids))`; CHECK ``.
- `public.batch_memberships.batch_memberships_select_accessible`: SELECT; roles authenticated; USING `((user_id = ( SELECT auth.uid() AS uid)) OR (batch_id IN ( SELECT app_private.viewable_batch_ids() AS viewable_batch_ids)))`; CHECK ``.
- `public.peer_tests.peer_tests_select`: SELECT; roles authenticated; USING `((cycle_id IN ( SELECT app_private.managed_cycle_ids() AS managed_cycle_ids)) OR ((cycle_id = ( SELECT app_private.member_active_cycle_id() AS member_active_cycle_id)) AND app_private.peer_test_is_live(status, visible_from, visible_until)))`; CHECK ``.
- `public.peer_test_attempts.peer_test_attempts_select`: SELECT; roles authenticated; USING `(id IN ( SELECT app_private.visible_peer_attempt_ids() AS visible_peer_attempt_ids))`; CHECK ``.
- `public.peer_test_attempt_questions.peer_test_attempt_questions_select`: SELECT; roles authenticated; USING `(attempt_id IN ( SELECT app_private.visible_peer_attempt_ids() AS visible_peer_attempt_ids))`; CHECK ``.

## Triggers

- CREATE TRIGGER profiles_batch_guard BEFORE UPDATE OF role, is_master_admin ON public.profiles FOR EACH ROW EXECUTE FUNCTION app_private.profiles_batch_guard()
- CREATE TRIGGER trg_sync_deactivated_at BEFORE UPDATE OF active ON public.profiles FOR EACH ROW EXECUTE FUNCTION sync_deactivated_at()
- CREATE TRIGGER review_batch_guard BEFORE INSERT ON public.review_confirmations FOR EACH ROW EXECUTE FUNCTION app_private.review_batch_guard()
- CREATE TRIGGER tasmia_batch_guard BEFORE INSERT ON public.tasmia_submissions FOR EACH ROW EXECUTE FUNCTION app_private.tasmia_batch_guard()
- CREATE TRIGGER batch_memberships_guard BEFORE INSERT OR UPDATE OF batch_id, user_id, membership_role ON public.batch_memberships FOR EACH ROW EXECUTE FUNCTION app_private.batch_memberships_guard()
