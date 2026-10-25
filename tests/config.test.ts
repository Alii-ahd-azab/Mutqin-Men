// Startup guards: the server only ever talks to the Men project.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadServerConfig } from '../src/server/config';

const KEYS = ['SUPABASE_URL', 'VITE_SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DB_URL', 'SUPABASE_PROJECT_REF'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
});

function setEnv(overrides: Record<string, string | undefined> = {}) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, {
    SUPABASE_URL: 'https://uaublandjewfzmhnbflc.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
    SUPABASE_SECRET_KEY: 'sb_secret_example',
    SUPABASE_DB_URL: 'postgresql://mutqin_app_server.uaublandjewfzmhnbflc:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?sslmode=require',
    ...overrides,
  });
  for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete process.env[k];
}

test('valid Men configuration loads and strips libpq ssl parameters', () => {
  setEnv();
  const c = loadServerConfig();
  assert.equal(c.supabaseUrl, 'https://uaublandjewfzmhnbflc.supabase.co');
  assert.equal(new URL(c.databaseUrl).searchParams.has('sslmode'), false);
  assert.ok(c.databaseCa?.includes('BEGIN CERTIFICATE'));
});

test('missing variables are named, values never echoed', () => {
  setEnv({ SUPABASE_SECRET_KEY: undefined, SUPABASE_DB_URL: undefined });
  assert.throws(() => loadServerConfig(), /SUPABASE_SECRET_KEY, SUPABASE_DB_URL/);
});

test('Sisters and other projects are refused', () => {
  setEnv({ SUPABASE_URL: 'https://cuexuketulmyskmdvosp.supabase.co' });
  assert.throws(() => loadServerConfig(), /Sisters/);
  setEnv({ SUPABASE_DB_URL: 'postgresql://postgres.cuexuketulmyskmdvosp:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres' });
  assert.throws(() => loadServerConfig(), /Sisters/);
  setEnv({ SUPABASE_URL: 'https://vvurdfmrpbvrugnevmsh.supabase.co' });
  assert.throws(() => loadServerConfig(), /Men project/);
  setEnv({ SUPABASE_DB_URL: 'postgresql://postgres:pw@db.vvurdfmrpbvrugnevmsh.supabase.co:5432/postgres' });
  assert.throws(() => loadServerConfig(), /Men project/);
  setEnv({ SUPABASE_PROJECT_REF: 'vvurdfmrpbvrugnevmsh' });
  assert.throws(() => loadServerConfig(), /Men project/);
});

test('keys cannot be swapped', () => {
  setEnv({ SUPABASE_SECRET_KEY: 'sb_publishable_example' });
  assert.throws(() => loadServerConfig(), /secret/);
  setEnv({ SUPABASE_PUBLISHABLE_KEY: 'sb_secret_other' });
  assert.throws(() => loadServerConfig(), /browsers/);
});
