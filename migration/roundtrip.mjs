import { readBackup, decode } from "./analyze.mjs";
// Independently reconstruct every original business field from stored relational values.
// Only source shape (presence/order), never source values, guides field selection.
export async function validateSourceRoundtrip(db, backup) {
  const { docs } = readBackup(backup);
  const tables = {};
  for (const table of [
    "personal_tests",
    "personal_test_questions",
    "profiles",
    "batches",
    "cycles",
    "tasmia_submissions",
    "review_confirmations",
    "group_rest_days",
    "peer_tests",
    "peer_test_selected_members",
    "peer_test_attempts",
    "peer_test_attempt_questions",
    "migration_private.user_credentials",
    "migration_private.source_settings",
    "migration_private.source_documents",
    "migration_private.empty_legacy_arrays",
  ]) {
    tables[table] = (
      await db.query(`select to_jsonb(t) as row from ${table} t`)
    ).rows.map((x) => x.row);
  }
  const find = (t, k, v) => {
    const rows = tables[t].filter((x) => x[k] === v);
    if (rows.length !== 1)
      throw Error("Roundtrip missing/duplicate lookup in " + t);
    return rows[0];
  };
  const user = (id) => find("profiles", "id", id).firestore_id;
  let fieldsChecked = 0;
  function equal(expected, actual, path) {
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual) || expected.length !== actual.length)
        throw Error("Roundtrip array mismatch at " + path);
      expected.forEach((x, i) => equal(x, actual[i], path + "[" + i + "]"));
      return;
    }
    if (expected !== null && typeof expected === "object") {
      if (!actual) throw Error("Roundtrip object missing at " + path);
      for (const [k, v] of Object.entries(expected))
        equal(v, actual[k], path + "." + k);
      return;
    }
    fieldsChecked++;
    if (
      typeof expected === "string" &&
      /^\d{4}-\d{2}-\d{2}T/.test(expected) &&
      typeof actual === "string"
    ) {
      if (
        Number.isFinite(Date.parse(expected)) &&
        Date.parse(expected) === Date.parse(actual)
      )
        return;
    }
    if (expected !== actual) throw Error("Roundtrip field mismatch at " + path);
  }
  for (const d of docs) {
    const original = decode(d.data),
      collection = d.path.split("/")[0],
      provenance = find(
        "migration_private.source_documents",
        "source_path",
        d.path,
      );
    for (const [prefix, time] of [
      ["create", d.createTime],
      ["update", d.updateTime],
    ]) {
      if (
        String(provenance[prefix + "_seconds"]) !== time.seconds ||
        provenance[prefix + "_nanos"] !== time.nanoseconds
      )
        throw Error("Native timestamp precision mismatch");
    }
    let value;
    switch (collection) {
      case "users": {
        const r = find("profiles", "firestore_id", d.id),
          c = find("migration_private.user_credentials", "profile_id", r.id);
        value = {
          id: r.firestore_id,
          name: r.full_name,
          phone: r.phone,
          role: r.role,
          is_active: r.active,
          created_at: r.created_at,
          password_hash: c.password_hash,
          firebase_uid: c.firebase_uid,
        };
        break;
      }
      case "recitations": {
        const r = find("tasmia_submissions", "firestore_id", d.id);
        value = {
          id: r.firestore_id,
          member_id: user(r.user_id),
          member_name: r.member_name_snapshot,
          reciter_id: user(r.user_id),
          reciter_name: r.member_name_snapshot,
          listener_id: user(r.listener_id),
          listener_name: r.listener_name_snapshot,
          quarter_number: r.quarter_number,
          cycle_number: find("cycles", "id", r.cycle_id).cycle_number,
          date: r.legacy_date,
          notes: r.notes,
          created_at: r.submitted_at,
        };
        break;
      }
      case "revisions": {
        const r = find("review_confirmations", "firestore_id", d.id);
        value = {
          id: r.firestore_id,
          member_id: user(r.user_id),
          member_name: r.member_name_snapshot,
          cycle_number: find("cycles", "id", r.cycle_id).cycle_number,
          date: r.legacy_date,
          review_start_quarter: r.start_quarter,
          review_end_quarter: r.end_quarter,
          notes: r.notes,
          created_at: r.confirmed_at,
        };
        break;
      }
      case "rest_days": {
        const r = find("group_rest_days", "firestore_id", d.id);
        value = {
          id: r.firestore_id,
          date: r.rest_date,
          note: r.reason,
          added_by_admin_id: user(r.created_by),
          added_by_name: r.created_by_name_snapshot,
          created_at: r.created_at,
        };
        break;
      }
      case "tests": {
        const r = find("peer_tests", "firestore_id", d.id);
        value = {
          ...r,
          id: r.firestore_id,
          created_by_admin_id: user(r.created_by),
          has_max_errors: r.legacy_has_max_errors,
          max_errors_allowed: r.legacy_max_errors_allowed,
          is_active: r.legacy_is_active,
          is_finished: r.legacy_is_finished,
          prerequisites: {
            require_all_quarters_completed: r.require_all_quarters_completed,
            require_revision_completed: r.require_revision_completed,
          },
          selected_member_ids: tables.peer_test_selected_members
            .filter((x) => x.test_id === r.id)
            .sort((a, b) => a.position - b.position)
            .map((x) => user(x.user_id)),
        };
        break;
      }
      case "test_attempts": {
        const r = find("peer_test_attempts", "firestore_id", d.id);
        value = {
          ...r,
          id: r.firestore_id,
          test_id: find("peer_tests", "id", r.test_id).firestore_id,
          candidate_id: user(r.candidate_id),
          candidate_name: r.candidate_name_snapshot,
          examiner_id: user(r.examiner_id),
          examiner_name: r.examiner_name_snapshot,
          date: r.attempt_date,
          passed: r.legacy_passed,
          questions_results: tables.peer_test_attempt_questions
            .filter((q) => q.attempt_id === r.id)
            .sort((a, b) => a.question_number - b.question_number),
        };
        break;
      }
      case "personal_tests": {
        const r = find("personal_tests", "firestore_id", d.id);
        value = {
          ...r,
          id: r.firestore_id,
          member_id: user(r.member_id),
          questions: tables.personal_test_questions
            .filter((q) => q.test_id === r.id)
            .sort((a, b) => a.question_number - b.question_number),
        };
        break;
      }
      case "settings":
      case "groupSettings": {
        if (d.path === "settings/far_revisions") {
          const marker = find(
            "migration_private.empty_legacy_arrays",
            "source_path",
            d.path,
          );
          if (marker.field_name !== "logs")
            throw Error("Legacy empty-array marker mismatch");
          value = { logs: [] };
        } else {
          const r = find(
            "migration_private.source_settings",
            "source_path",
            d.path,
          );
          value = { ...r, id: r.embedded_id };
        }
        break;
      }
      default:
        throw Error("Roundtrip mapping required for collection " + collection);
    }
    equal(original, value, d.path);
  }
  return {
    sourceDocumentsChecked: docs.length,
    sourceScalarFieldsChecked: fieldsChecked,
    nativeTimestampNanoseconds: "exact",
    arrayOrder: "verified",
  };
}
