import fs from 'fs';
import path from 'path';

/**
 * Server configuration from environment variables. The server refuses to start unless every
 * Supabase setting points at the Men project; the Sisters project is rejected outright.
 * Secret values are never logged.
 */
export const MEN_PROJECT_REF = 'uaublandjewfzmhnbflc';
const SISTERS_PROJECT_REF = 'cuexuketulmyskmdvosp';

export interface ServerConfig {
  projectRef: string;
  supabaseUrl: string;
  publishableKey: string;
  secretKey: string;
  databaseUrl: string;
  databaseCa: string | undefined;
}

function env(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (v) return v;
  }
  return undefined;
}

export function loadServerConfig(): ServerConfig {
  const projectRef = env('SUPABASE_PROJECT_REF') || MEN_PROJECT_REF;
  const supabaseUrl = env('SUPABASE_URL', 'VITE_SUPABASE_URL');
  const publishableKey = env('SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY');
  const secretKey = env('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
  const databaseUrl = env('SUPABASE_DB_URL');

  const missing = Object.entries({ SUPABASE_URL: supabaseUrl, SUPABASE_PUBLISHABLE_KEY: publishableKey, SUPABASE_SECRET_KEY: secretKey, SUPABASE_DB_URL: databaseUrl })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);

  if (projectRef !== MEN_PROJECT_REF) throw new Error('SUPABASE_PROJECT_REF must be the Mutqin for Men project.');
  for (const v of [supabaseUrl, databaseUrl] as string[]) {
    if (v.includes(SISTERS_PROJECT_REF)) throw new Error('The Mutqin for Sisters project must never be used by the Men application.');
  }

  let url: URL;
  try {
    url = new URL(supabaseUrl as string);
  } catch {
    throw new Error('SUPABASE_URL is not a valid URL.');
  }
  if (url.hostname !== `${projectRef}.supabase.co`) throw new Error('SUPABASE_URL does not point at the Mutqin for Men project.');

  let db: URL;
  try {
    db = new URL(databaseUrl as string);
  } catch {
    throw new Error('SUPABASE_DB_URL is not a valid URL (value suppressed).');
  }
  const user = decodeURIComponent(db.username);
  const direct = db.hostname === `db.${projectRef}.supabase.co`;
  const pooled = db.hostname.endsWith('.pooler.supabase.com') && user.endsWith(`.${projectRef}`);
  if (!direct && !pooled) throw new Error('SUPABASE_DB_URL does not point at the Mutqin for Men project.');
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) db.searchParams.delete(key);

  if (secretKey === publishableKey || (secretKey as string).startsWith('sb_publishable_')) {
    throw new Error('SUPABASE_SECRET_KEY must be the server secret (or service_role) key, not the publishable key.');
  }
  if ((publishableKey as string).startsWith('sb_secret_')) {
    throw new Error('SUPABASE_PUBLISHABLE_KEY must not be a secret key: it is sent to browsers.');
  }

  // Supabase's public server CA (not in Node's default store). Override with SUPABASE_DB_CA_CERT if needed.
  const caFile = path.join(process.cwd(), 'certs', 'supabase-prod-ca-2021.crt');
  const databaseCa = env('SUPABASE_DB_CA_CERT') || (fs.existsSync(caFile) ? fs.readFileSync(caFile, 'utf-8') : undefined);

  return {
    projectRef,
    supabaseUrl: url.origin,
    publishableKey: publishableKey as string,
    secretKey: secretKey as string,
    databaseUrl: db.toString(),
    databaseCa,
  };
}
