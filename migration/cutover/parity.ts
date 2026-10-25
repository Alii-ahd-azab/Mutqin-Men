// Firebase ↔ Supabase read parity for the Sisters-style application data layer.
//
// Rebuilds the exact in-memory state the legacy Firebase server held (same field normalization as the
// old firestoreService) from a Firestore export, and compares it field by field with what the new
// browser data layer (src/lib/menData.ts → supabase-js → PostgREST) returns from Men production.
//
//   npx tsx --env-file=.env.local migration/cutover/parity.ts BACKUP_DIR --project uaublandjewfzmhnbflc
// Reads only (secret key, so RLS does not hide rows). Exit code 1 when any difference is found.
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { loadBatchIds, loadProgram, type ProgramState } from '../../src/lib/menData';

type AppState = ProgramState;
// @ts-ignore - shared ESM tooling
import { readBackup, decode } from '../analyze.mjs';
// @ts-ignore
import { uuid } from '../transform.mjs';

type Doc = { path: string; id: string; data: unknown };

/** Legacy users normalization (copy of normalizeUserFromFirestore, without credentials). */
function legacyUser(docId: string, raw: Record<string, any>) {
  const clean: Record<string, any> = {};
  for (const [k, v] of Object.entries(raw)) clean[k.trim().toLowerCase()] = typeof v === 'string' ? v.trim() : v;
  return {
    id: String(clean.id || docId).trim(),
    name: String(clean.name || clean.display_name || clean.fullname || clean.user_name || docId).trim(),
    phone: String(clean.phone || clean.mobile || clean.phone_number || clean.phonenumber || '').trim(),
    role: clean.role === 'admin' ? 'admin' : 'member',
    is_active: typeof clean.is_active === 'boolean' ? clean.is_active : true,
    created_at: String(clean.created_at || '').trim(),
  };
}

export function legacyStateFromExport(dir: string) {
  const { docs } = readBackup(dir) as { docs: Doc[] };
  const by = (c: string) => docs.filter((d) => d.path.split('/')[0] === c).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const withId = (c: string) => by(c).map((d) => ({ ...(decode(d.data) as object), id: d.id }));
  const settingsDoc = docs.find((d) => d.path === 'settings/group_settings');
  return {
    users: by('users').map((d) => legacyUser(d.id, decode(d.data))),
    settings: settingsDoc ? decode(settingsDoc.data) : null,
    restDays: withId('rest_days'),
    recitationLogs: withId('recitations'),
    revisionLogs: withId('revisions'),
    tests: withId('tests'),
    testAttempts: withId('test_attempts'),
    personalTests: withId('personal_tests'),
  };
}

const ID_REFS: Record<string, string> = {
  member_id: 'users',
  reciter_id: 'users',
  listener_id: 'users',
  added_by_admin_id: 'users',
  created_by_admin_id: 'users',
  candidate_id: 'users',
  examiner_id: 'users',
  test_id: 'tests',
};

function mapIds(collection: string, obj: Record<string, any>) {
  const out: Record<string, any> = { ...obj, id: uuid(`${collection}/${obj.id}`) };
  for (const [k, c] of Object.entries(ID_REFS)) if (typeof out[k] === 'string') out[k] = uuid(`${c}/${out[k]}`);
  if (Array.isArray(out.selected_member_ids)) out.selected_member_ids = out.selected_member_ids.map((u: string) => uuid(`users/${u}`));
  return out;
}

const absent = (v: unknown) => v === undefined || v === null;

function diffValues(where: string, expected: any, actual: any, out: string[]) {
  if (absent(expected) && absent(actual)) return;
  // Legacy optional flags were simply missing when false (e.g. is_finished); treat as equal.
  if ((expected === false && absent(actual)) || (absent(expected) && actual === false)) return;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) {
      out.push(`${where}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
      return;
    }
    expected.forEach((e, i) => diffValues(`${where}[${i}]`, e, actual[i], out));
    return;
  }
  if (expected && typeof expected === 'object' && actual && typeof actual === 'object') {
    for (const k of new Set([...Object.keys(expected), ...Object.keys(actual)])) diffValues(`${where}.${k}`, expected[k], actual[k], out);
    return;
  }
  if (expected !== actual) out.push(`${where}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
}

export function compareStates(legacy: ReturnType<typeof legacyStateFromExport>, current: AppState) {
  const differences: string[] = [];
  const orderNotes: string[] = [];
  const collections: [keyof AppState & string, string][] = [
    ['users', 'users'],
    ['restDays', 'rest_days'],
    ['recitationLogs', 'recitations'],
    ['revisionLogs', 'revisions'],
    ['tests', 'tests'],
    ['testAttempts', 'test_attempts'],
  ];
  const counts: Record<string, { firebase: number; supabase: number }> = {};
  for (const [key, collection] of collections) {
    const expected = (legacy as any)[key].map((x: any) => mapIds(collection, x));
    const actual = current[key] as any[];
    counts[key] = { firebase: expected.length, supabase: actual.length };
    const byId = new Map(actual.map((x) => [x.id, x]));
    for (const e of expected) {
      const a = byId.get(e.id);
      if (!a) differences.push(`${key}: missing ${e.id}`);
      else diffValues(`${key}[${e.id}]`, e, a, differences);
      byId.delete(e.id);
    }
    for (const id of byId.keys()) differences.push(`${key}: extra ${id} (not in Firebase export)`);
    const eo = expected.map((x: any) => x.id).join(',');
    const ao = actual.filter((x) => expected.some((e: any) => e.id === x.id)).map((x) => x.id).join(',');
    if (eo !== ao) orderNotes.push(`${key}: list order differs from Firestore document order`);
  }
  if (legacy.settings) {
    const { id: _ignored, ...expected } = legacy.settings as any;
    const { id: _id, ...actual } = current.settings as any;
    diffValues('settings', expected, actual, differences);
  }
  if (legacy.personalTests.length) differences.push(`personal_tests: ${legacy.personalTests.length} Firestore record(s) need explicit comparison`);
  return { counts, differences, orderNotes };
}

async function main() {
  const args = process.argv.slice(2);
  const dir = args[0];
  if (!dir) throw new Error('Usage: npx tsx migration/cutover/parity.ts BACKUP_DIR --project REF');
  const legacy = legacyStateFromExport(dir);
  // @ts-ignore
  const { authAdmin, requireProjectArg } = await import('./production.mjs');
  const client = authAdmin(requireProjectArg(args));
  const batches = await loadBatchIds(client);
  if (batches.length !== 1) throw new Error(`Expected one Men batch, found ${batches.length}`);
  const state: AppState = await loadProgram(client, batches[0]);
  const result = compareStates(legacy, state);
  const report = { source: path.resolve(dir), target: 'production via supabase-js (read-only)', ...result };
  fs.writeFileSync(path.join(dir, 'parity-supabase-js.json'), JSON.stringify(report, null, 2));
  // Console shows field paths only; values (member data) stay in the private report file.
  const paths = result.differences.map((d) => d.split(': expected')[0]);
  console.log(JSON.stringify({ ...report, differences: paths.slice(0, 50), differenceCount: paths.length }, null, 2));
  if (result.differences.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
