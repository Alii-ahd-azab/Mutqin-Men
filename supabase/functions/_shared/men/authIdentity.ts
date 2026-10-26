/**
 * Supabase Auth identity for a member: phone numbers are mapped to a synthetic e-mail
 * (same convention as Mutqin for Sisters). Shared by the browser, the server and the
 * one-time account link script, so all three always derive the same login identity.
 */
export const AUTH_EMAIL_DOMAIN = 'members.mutqin.local';

export function normalizePhone(phone: string): string {
  return String(phone).replace(/\s+/g, '').trim();
}

export function phoneToAuthEmail(phone: string): string {
  return `${normalizePhone(phone)}@${AUTH_EMAIL_DOMAIN}`;
}
