// Phase H: post-migration Firestore writes are added without touching existing or app-created rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadState } from '../src/server/store';
import { legacyStateFromExport, compareStates } from '../migration/cutover/parity';
import { serverRoleDatabase } from './support';
// @ts-ignore - shared ESM tooling
import { createCutoverDb } from '../migration/cutover/harness.mjs';
// @ts-ignore
import { reconcile } from '../migration/cutover/reconcile.mjs';

const backups = path.resolve('migration/backups');
const base = process.env.MEN_TEST_BACKUP || path.join(backups, '2026-10-25-final-production');
const fresh = process.env.MEN_RECONCILE_BACKUP || path.join(backups, '2026-10-26-cutover-reconciliation');

test('reconciliation inserts only the Firestore delta and then matches Firebase exactly', { skip: !fs.existsSync(fresh) && 'no reconciliation export' }, async () => {
  const { db } = await createCutoverDb(base, { linkAuth: false });
  try {
    // A row written natively by the new application must survive untouched.
    const cycle = ((await db.query("select id from cycles where status='active'")).rows[0] as any).id;
    const user = ((await db.query("select id from profiles where role='member' and active limit 1")).rows[0] as any).id;
    await db.query(
      "insert into review_confirmations(cycle_id,user_id,start_quarter,end_quarter,legacy_date) values($1,$2,1,8,'2030-01-01')",
      [cycle, user]
    );

    const plan = await reconcile(db, fresh);
    assert.equal(plan.conflicts, 0);
    assert.equal(plan.removed, 0);

    const applied = await db.transaction((tx: any) => reconcile(tx, fresh, { apply: true }));
    const missingBefore = Object.values(plan.tables).reduce((n: number, t: any) => n + t.missing, 0);
    assert.equal(applied.inserted, missingBefore);
    const again = await reconcile(db, fresh);
    assert.equal(Object.values(again.tables).reduce((n: number, t: any) => n + t.missing, 0), 0, 'rerun finds nothing to insert');

    const state = await serverRoleDatabase(db).transaction((tx) => loadState(tx));
    const result = compareStates(legacyStateFromExport(fresh), state);
    // The only difference allowed is the app-created review, which Firebase never had.
    assert.equal(result.differences.length, 1);
    assert.match(result.differences[0], /^revisionLogs: extra /);
  } finally {
    await db.close();
  }
});

test('a changed legacy row is reported as a conflict and nothing is written', { skip: !fs.existsSync(fresh) && 'no reconciliation export' }, async () => {
  const { db } = await createCutoverDb(base, { linkAuth: false });
  try {
    await db.query("update tasmia_submissions set notes = coalesce(notes,'') || ' (edited in Supabase)' where id = (select id from tasmia_submissions order by id limit 1)");
    const plan = await reconcile(db, fresh);
    assert.equal(plan.tables.tasmia_submissions.conflicts, 1);
    const before = ((await db.query('select count(*)::int n from tasmia_submissions')).rows[0] as any).n;
    await assert.rejects(db.transaction((tx: any) => reconcile(tx, fresh, { apply: true })), /explicit decision/);
    assert.equal(((await db.query('select count(*)::int n from tasmia_submissions')).rows[0] as any).n, before);
  } finally {
    await db.close();
  }
});
