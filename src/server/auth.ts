import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Identity operations the server needs. Production uses Supabase Auth; tests inject a fake.
 * Login itself happens in the browser (supabase-js + publishable key); the server only verifies
 * access tokens and performs admin account changes with the server-only secret key.
 */
export interface AuthService {
  /** Returns the auth user id for a valid, non-revoked access token, else null. */
  verifyAccessToken(token: string): Promise<string | null>;
  createUser(input: { email: string; password: string; fullName: string }): Promise<string>;
  updateUser(id: string, input: { email?: string; password?: string; fullName?: string }): Promise<void>;
  deleteUser(id: string): Promise<void>;
  verifyPassword(email: string, password: string): Promise<boolean>;
  /** Drops cached token verifications for a user (after password change/reset or deletion). */
  forget(userId: string): void;
}

const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 1000;

export function createSupabaseAuthService(config: { url: string; secretKey: string; publishableKey: string }): AuthService {
  const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  const admin: SupabaseClient = createClient(config.url, config.secretKey, noSession);
  const cache = new Map<string, { userId: string; until: number }>();

  return {
    async verifyAccessToken(token) {
      const now = Date.now();
      const hit = cache.get(token);
      if (hit && hit.until > now) return hit.userId;
      // getUser asks the Auth server, so signed-out/revoked sessions and deleted users are rejected.
      const { data, error } = await admin.auth.getUser(token);
      if (error || !data.user) {
        cache.delete(token);
        return null;
      }
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(token, { userId: data.user.id, until: now + CACHE_TTL_MS });
      return data.user.id;
    },

    async createUser({ email, password, fullName }) {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName },
      });
      if (error || !data.user) throw new Error(`Auth createUser failed: ${error?.message ?? 'no user returned'}`);
      return data.user.id;
    },

    async updateUser(id, { email, password, fullName }) {
      const { error } = await admin.auth.admin.updateUserById(id, {
        ...(email ? { email, email_confirm: true } : {}),
        ...(password ? { password } : {}),
        ...(fullName ? { user_metadata: { full_name: fullName } } : {}),
      });
      if (error) throw new Error(`Auth updateUser failed: ${error.message}`);
    },

    async deleteUser(id) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw new Error(`Auth deleteUser failed: ${error.message}`);
      this.forget(id);
    },

    async verifyPassword(email, password) {
      // Isolated client: the resulting session is never stored and is revoked by the caller's flow.
      const client = createClient(config.url, config.publishableKey, noSession);
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      return !error && !!data.user;
    },

    forget(userId) {
      for (const [token, v] of cache) if (v.userId === userId) cache.delete(token);
    },
  };
}
