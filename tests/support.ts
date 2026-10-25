// In-process test support: the real Express app over a local PGlite copy of the migrated data,
// queried as the restricted mutqin_app_server role, with a fake Auth service. Never touches production.
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { randomUUID } from 'crypto';
import { createApp } from '../src/server/app';
import type { AuthService } from '../src/server/auth';
import type { Database, Queryable } from '../src/server/store';
// @ts-ignore - plain ESM helper shared with the migration tooling
import { createCutoverDb, defaultBackup } from '../migration/cutover/harness.mjs';

export function serverRoleDatabase(pglite: any): Database {
  const asServer = (tx: any): Queryable => ({ query: (text, params) => tx.query(text, params) });
  return {
    query: (text, params) =>
      pglite.transaction(async (tx: any) => {
        await tx.exec('set local role mutqin_app_server');
        return tx.query(text, params);
      }),
    transaction: (fn) =>
      pglite.transaction(async (tx: any) => {
        await tx.exec('set local role mutqin_app_server');
        return fn(asServer(tx));
      }),
    close: async () => undefined,
  };
}

export class FakeAuth implements AuthService {
  tokens = new Map<string, string>();
  passwords = new Map<string, string>(); // email → password
  emails = new Map<string, string>(); // user id → email
  deleted: string[] = [];
  failNextCreate = false;

  tokenFor(userId: string): string {
    const token = `test-token-${userId}`;
    this.tokens.set(token, userId);
    return token;
  }
  async verifyAccessToken(token: string) {
    return this.tokens.get(token) ?? null;
  }
  async createUser({ email, password }: { email: string; password: string; fullName: string }) {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error('simulated auth failure');
    }
    const id = randomUUID();
    this.emails.set(id, email);
    this.passwords.set(email, password);
    return id;
  }
  async updateUser(id: string, input: { email?: string; password?: string }) {
    const old = this.emails.get(id);
    const email = input.email ?? old;
    if (input.email) this.emails.set(id, input.email);
    if (email && input.password) this.passwords.set(email, input.password);
    if (old && input.email && !input.password && this.passwords.has(old)) this.passwords.set(input.email, this.passwords.get(old)!);
  }
  async deleteUser(id: string) {
    this.deleted.push(id);
    this.forget(id);
  }
  async verifyPassword(email: string, password: string) {
    return this.passwords.get(email) === password;
  }
  forget(userId: string) {
    for (const [t, u] of this.tokens) if (u === userId) this.tokens.delete(t);
  }
}

export async function startTestApp() {
  const { db: pglite } = await createCutoverDb(defaultBackup(), { linkAuth: false });
  const auth = new FakeAuth();
  const app = createApp({
    db: serverRoleDatabase(pglite),
    auth,
    publicConfig: { supabaseUrl: 'https://example.supabase.co', supabasePublishableKey: 'sb_publishable_test' },
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(method: string, path: string, opts: { token?: string; body?: unknown; date?: string } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.date ? { 'X-Client-Date': opts.date } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  }

  return {
    pglite,
    auth,
    call,
    close: async () => {
      await new Promise((r) => server.close(r));
      await pglite.close();
    },
  };
}
