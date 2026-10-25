import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Browser Supabase client — Auth/session only (sign-in, token refresh, sign-out).
 * Uses only the project URL and the publishable key; data still flows through the /api server.
 * Build-time VITE_* values are used when present, otherwise the server's public runtime config.
 */
let clientPromise: Promise<SupabaseClient> | null = null;

async function resolveConfig(): Promise<{ url: string; key: string }> {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
  if (url && key) return { url, key };
  const res = await fetch('/api/public-config');
  if (!res.ok) throw new Error('تعذر تحميل إعدادات الاتصال');
  const cfg = await res.json();
  return { url: cfg.supabaseUrl, key: cfg.supabasePublishableKey };
}

export function getSupabase(): Promise<SupabaseClient> {
  if (!clientPromise) {
    clientPromise = resolveConfig()
      .then(({ url, key }) =>
        createClient(url, key, {
          auth: { persistSession: true, autoRefreshToken: true, storageKey: 'mutqin-men-auth' },
        })
      )
      .catch((err) => {
        clientPromise = null; // allow a retry after a transient failure
        throw err;
      });
  }
  return clientPromise;
}
