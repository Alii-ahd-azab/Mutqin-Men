import crypto from "node:crypto";
import { readBackup, decode } from "./analyze.mjs";
export function uuid(key) {
  const h = crypto
    .createHash("sha256")
    .update("mutqin-men/phase1/v1/" + key)
    .digest("hex")
    .slice(0, 32)
    .split("");
  h[12] = "8";
  h[16] = ((parseInt(h[16], 16) & 3) | 8).toString(16);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    h.slice(12, 16),
    h.slice(16, 20),
    h.slice(20),
  ]
    .map((x) => x.join(""))
    .join("-");
}
export const keys = {
  profiles: ["id"],
  batches: ["id"],
  batch_memberships: ["id"],
  cycles: ["id"],
  daily_thoughts: ["id"],
  group_rest_days: ["id"],
  program_pauses: ["id"],
  tasmia_submissions: ["id"],
  review_confirmations: ["id"],
  peer_tests: ["id"],
  peer_test_selected_members: ["test_id", "user_id"],
  peer_test_attempts: ["id"],
  peer_test_attempt_questions: ["attempt_id", "question_number"],
  personal_tests: ["id"],
  personal_test_questions: ["test_id", "question_number"],
  "migration_private.source_settings": ["source_path"],
  "migration_private.user_credentials": ["profile_id"],
  "migration_private.source_documents": ["source_path"],
  "migration_private.empty_legacy_arrays": ["source_path", "field_name"],
  batch_membership_transfers: ["id"],
};
export const qualified = (t) => (t.includes(".") ? t : "public." + t);
export function transform(dir) {
  const { docs, manifest } = readBackup(dir);
  const rows = Object.fromEntries(Object.keys(keys).map((k) => [k, []]));
  const warnings = [];
  const byPath = new Map(docs.map((d) => [d.path, d]));
  if (byPath.size !== docs.length) throw Error("Duplicate source paths");
  const data = (p) => decode(byPath.get(p)?.data || { t: "null" });
  const active = data("settings/group_settings");
  if (!active) throw Error("Missing authoritative settings");
  const add = (t, r) => {
    rows[t].push(r);
    return r;
  };
  const batch = uuid("batch/main"),
    cycle = uuid("cycle/" + active.current_cycle_number);
  const earliest = docs
    .filter((d) => d.path.startsWith("users/"))
    .map((d) => decode(d.data).created_at)
    .sort()[0];
  add("batches", {
    id: batch,
    name: "Mutqin for Men",
    created_at: earliest,
    created_by: null,
    archived_at: null,
  });
  add("cycles", {
    id: cycle,
    batch_id: batch,
    cycle_number: active.current_cycle_number,
    name: "Cycle " + active.current_cycle_number,
    starts_on: active.start_date,
    status: "active",
    ended_on: null,
    created_by: null,
    created_at: earliest,
    total_quarters: active.total_quarters,
    review_window: active.review_window,
    legacy_paused_days: active.total_paused_days,
  });
  const knownUsers = new Set(
    docs.filter((d) => d.path.startsWith("users/")).map((d) => d.id),
  );
  const user = (id) => {
    if (!knownUsers.has(id)) throw Error("Unresolved user reference");
    return uuid("users/" + id);
  };
  const test = (id) => {
    if (!byPath.has("tests/" + id)) throw Error("Unresolved test reference");
    return uuid("tests/" + id);
  };
  const occurrences = new Map();
  const occurrence = (k) => {
    const n = occurrences.get(k) || 0;
    occurrences.set(k, n + 1);
    return n;
  };
  const source = (d, t, id) => {
    const types = {};
    function walk(x, p) {
      types[p] = x.t;
      if (x.t === "map")
        for (const [k, v] of Object.entries(x.v)) walk(v, p ? `${p}.${k}` : k);
      if (x.t === "array") x.v.forEach((v, i) => walk(v, `${p}[${i}]`));
    }
    walk(d.data, "");
    add("migration_private.source_documents", {
      source_path: d.path,
      collection_path: d.path.split("/").slice(0, -1).join("/"),
      firestore_id: d.id,
      target_table: t,
      target_id: String(id),
      field_types: types,
      create_seconds: d.createTime.seconds,
      create_nanos: d.createTime.nanoseconds,
      update_seconds: d.updateTime.seconds,
      update_nanos: d.updateTime.nanoseconds,
    });
  };
  for (const d of [...docs].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = d.path.split("/");
    if (parts.length !== 2)
      throw Error("New subcollection requires explicit mapping: " + d.path);
    const c = parts[0],
      x = decode(d.data),
      id = uuid(d.path),
      used = new Set();
    const take = (k) => {
      used.add(k);
      return x[k] === undefined ? null : x[k];
    };
    const fields = (...names) =>
      Object.fromEntries(names.map((k) => [k, take(k)]));
    const embedded = take("id");
    if (embedded !== null && embedded !== d.id && c !== "settings")
      throw Error("Embedded/document ID mismatch");
    const cycleFor = () => {
      if (take("cycle_number") !== active.current_cycle_number)
        throw Error("Unmapped historical cycle");
      return cycle;
    };
    let table,
      target = id;
    switch (c) {
      case "users": {
        table = "profiles";
        add(table, {
          id,
          firestore_id: d.id,
          full_name: take("name"),
          phone: take("phone"),
          role: take("role"),
          active: take("is_active"),
          created_at: take("created_at"),
          deactivated_at: null,
          is_master_admin: x.role === "admin",
        });
        add("migration_private.user_credentials", {
          profile_id: id,
          password_hash: take("password_hash"),
          firebase_uid: take("firebase_uid"),
        });
        add("batch_memberships", {
          id: uuid("membership/" + d.id),
          batch_id: batch,
          user_id: id,
          membership_role: x.role,
          created_at: x.created_at,
          joined_at: x.created_at,
          created_by: null,
        });
        break;
      }
      case "recitations": {
        table = "tasmia_submissions";
        const member = take("member_id"),
          memberName = take("member_name");
        if (
          take("reciter_id") !== member ||
          take("reciter_name") !== memberName
        )
          throw Error("Conflicting reciter aliases");
        const cid = cycleFor(),
          quarter = take("quarter_number");
        add(table, {
          id,
          firestore_id: d.id,
          cycle_id: cid,
          user_id: user(member),
          listener_id: user(take("listener_id")),
          listener_name_snapshot: take("listener_name"),
          member_name_snapshot: memberName,
          quarter_number: quarter,
          notes: take("notes"),
          submitted_at: take("created_at"),
          legacy_date: take("date"),
          listener_changed_at: null,
          legacy_occurrence: occurrence(
            "rec/" + cid + "/" + member + "/" + quarter,
          ),
        });
        break;
      }
      case "revisions": {
        table = "review_confirmations";
        const cid = cycleFor(),
          member = take("member_id"),
          date = take("date");
        add(table, {
          id,
          firestore_id: d.id,
          cycle_id: cid,
          user_id: user(member),
          program_day: null,
          start_quarter: take("review_start_quarter"),
          end_quarter: take("review_end_quarter"),
          confirmed_at: take("created_at"),
          legacy_date: date,
          member_name_snapshot: take("member_name"),
          notes: take("notes"),
          legacy_occurrence: occurrence(
            "rev/" + cid + "/" + member + "/" + date,
          ),
        });
        break;
      }
      case "rest_days":
        table = "group_rest_days";
        add(table, {
          id,
          firestore_id: d.id,
          cycle_id: cycle,
          rest_date: take("date"),
          reason: take("note"),
          created_by: user(take("added_by_admin_id")),
          created_by_name_snapshot: take("added_by_name"),
          created_at: take("created_at"),
        });
        break;
      case "tests": {
        table = "peer_tests";
        const pre = take("prerequisites");
        if (
          Object.keys(pre).sort().join(",") !==
          "require_all_quarters_completed,require_revision_completed"
        )
          throw Error("Unknown prerequisite structure");
        const has = take("has_max_errors"),
          max = take("max_errors_allowed"),
          activeFlag = take("is_active"),
          finished = take("is_finished");
        add(table, {
          id,
          firestore_id: d.id,
          cycle_id: cycle,
          ...fields(
            "title",
            "range_start",
            "range_end",
            "questions_count",
            "lines_per_question",
            "test_type",
            "difficulty",
            "audience",
            "created_at",
            "updated_at",
            "finished_at",
          ),
          max_errors: has ? max : null,
          legacy_is_active: activeFlag,
          legacy_is_finished: finished,
          legacy_has_max_errors: has,
          legacy_max_errors_allowed: max,
          status: finished ? "finished" : activeFlag ? "published" : "hidden",
          visible_from: null,
          visible_until: null,
          created_by: user(take("created_by_admin_id")),
          ...pre,
        });
        const selected = take("selected_member_ids");
        if (!Array.isArray(selected))
          throw Error("Missing selected members array");
        selected.forEach((uid, position) =>
          add("peer_test_selected_members", {
            test_id: id,
            user_id: user(uid),
            position,
          }),
        );
        break;
      }
      case "test_attempts": {
        table = "peer_test_attempts";
        const tid = take("test_id"),
          status = take("status"),
          passed = take("passed");
        if (passed !== (status === "passed"))
          throw Error("Passed/status conflict");
        add(table, {
          id,
          firestore_id: d.id,
          test_id: test(tid),
          candidate_id: user(take("candidate_id")),
          candidate_name_snapshot: take("candidate_name"),
          examiner_id: user(take("examiner_id")),
          examiner_name_snapshot: take("examiner_name"),
          status,
          ...fields(
            "total_errors",
            "notes",
            "created_at",
            "effective_range_end",
            "covers_full_range",
          ),
          legacy_passed: passed,
          attempt_date: take("date"),
          completed_at: null,
          max_errors_snapshot: null,
        });
        const qs = take("questions_results");
        if (qs.reduce((n, q) => n + q.errors_count, 0) !== x.total_errors)
          throw Error("Question error sum mismatch");
        for (const q of qs) {
          const allowed = [
            "question_number",
            "start_surah",
            "start_surah_name",
            "start_ayah",
            "end_surah",
            "end_surah_name",
            "end_ayah",
            "errors_count",
            "notes",
          ];
          if (Object.keys(q).some((k) => !allowed.includes(k)))
            throw Error("Unknown question field");
          add("peer_test_attempt_questions", {
            attempt_id: id,
            ...Object.fromEntries(allowed.map((k) => [k, q[k] ?? null])),
            start_page: null,
            start_line: null,
            end_page: null,
            end_line: null,
            actual_lines: null,
            difficulty_level: null,
            legacy_incomplete: true,
          });
        }
        break;
      }
      case "groupSettings":
      case "settings": {
        if (d.path === "settings/far_revisions") {
          const logs = take("logs");
          if (!Array.isArray(logs) || logs.length)
            throw Error("Non-empty far revision logs require mapping");
          table = "migration_private.empty_legacy_arrays";
          target = d.path;
          add(table, { source_path: d.path, field_name: "logs" });
          break;
        }
        table = "migration_private.source_settings";
        target = d.path;
        add(table, {
          source_path: d.path,
          firestore_id: d.id,
          embedded_id: embedded,
          cycle_id: c === "settings" ? cycle : null,
          ...fields(
            "start_date",
            "total_quarters",
            "review_window",
            "current_cycle_number",
            "is_paused",
            "paused_at",
            "total_paused_days",
            "daily_thought",
            "daily_thought_updated_at",
            "daily_thought_updated_by",
          ),
        });
        if (d.path === "settings/group_settings") {
          if (x.is_paused)
            add("program_pauses", {
              id: uuid(d.path + "/open-pause"),
              cycle_id: cycle,
              paused_on: x.paused_at,
              resumed_on: null,
              reason: null,
              created_by: null,
              created_at: new Date(
                Number(d.updateTime.seconds) * 1000,
              ).toISOString(),
            });
          if (x.daily_thought)
            add("daily_thoughts", {
              id: uuid(d.path + "/daily-thought"),
              batch_id: batch,
              content_html: x.daily_thought,
              published_by: null,
              published_by_name_snapshot: x.daily_thought_updated_by,
              published_at: x.daily_thought_updated_at,
              is_published: true,
            });
        }
        break;
      }
      case "personal_tests": {
        table = "personal_tests";
        add(table, {
          id,
          firestore_id: d.id,
          member_id: user(take("member_id")),
          ...fields(
            "range_type",
            "range_label",
            "start_surah",
            "start_surah_name",
            "end_surah",
            "end_surah_name",
            "start_juz",
            "end_juz",
            "start_quarter",
            "end_quarter",
            "questions_count",
            "lines_per_question",
            "difficulty",
            "total_errors",
            "grade",
            "grade_label",
            "notes",
            "date",
            "created_at",
          ),
        });
        for (const q of take("questions")) {
          const cols = [
            "question_number",
            "start_surah",
            "start_surah_name",
            "start_ayah",
            "end_surah",
            "end_surah_name",
            "end_ayah",
            "errors_count",
            "grade",
            "difficulty_level",
          ];
          if (Object.keys(q).some((k) => !cols.includes(k)))
            throw Error("Unknown personal question field");
          add("personal_test_questions", {
            test_id: id,
            ...Object.fromEntries(cols.map((k) => [k, q[k] ?? null])),
          });
        }
        break;
      }
      default:
        throw Error("Unmapped collection: " + c);
    }
    const unknown = Object.keys(x).filter((k) => !used.has(k));
    if (unknown.length)
      throw Error("Unmapped fields at " + d.path + ": " + unknown.join(","));
    source(d, table, target);
  }
  // Membership/derived timestamps are explicitly assumptions, never claimed as source facts.
  warnings.push(
    "No historical pause dates; preserve six-day aggregate and leave historical program_day unknown.",
    "Four recitation duplicates and fourteen revision date duplicates retained by legacy_occurrence.",
    "UUIDs are deterministic SHA-256-derived identifiers; exact document IDs retained.",
    "Auth FK and runtime authorization deferred; owner-only tables.",
    "Daily thought author name cannot establish a user ID; published_by remains null.",
    "Current cycle assigned to tests/rest days lacking source cycle IDs; requires review.",
  );
  for (const [t, list] of Object.entries(rows)) {
    const seen = new Set();
    for (const r of list) {
      const k = keys[t].map((f) => r[f]).join("|");
      if (seen.has(k)) throw Error("Duplicate target primary key in " + t);
      seen.add(k);
    }
  }
  return { rows, warnings, manifest };
}
