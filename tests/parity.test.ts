// Phase G: what the Supabase repository returns must equal what the Firebase-backed server held.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadState } from '../src/server/store';
import { legacyStateFromExport, compareStates } from '../migration/cutover/parity';
import { serverRoleDatabase } from './support';
// @ts-ignore - shared ESM helper
import { createCutoverDb, defaultBackup } from '../migration/cutover/harness.mjs';

test('Supabase reads match the Firebase snapshot field by field (as the server role)', async () => {
  const dir = defaultBackup();
  const { db } = await createCutoverDb(dir, { linkAuth: false });
  try {
    const state = await serverRoleDatabase(db).transaction((tx) => loadState(tx));
    const result = compareStates(legacyStateFromExport(dir), state);
    assert.deepEqual(result.differences, []);
    assert.deepEqual(result.orderNotes, []);
    assert.deepEqual(result.counts.recitationLogs, { firebase: 388, supabase: 388 });
  } finally {
    await db.close();
  }
});
