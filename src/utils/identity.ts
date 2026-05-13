/**
 * Identity normalization helpers — used by GetUserContext, admin webhooks, and
 * any tool that searches by phone/email.
 *
 * Phones stored as digits-only strings (no `+`, no spaces/dashes/parens).
 * Emails stored lowercased + trimmed.
 */

export function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return '';
  return String(raw)
    .replace(/[\s\-()\.]/g, '')
    .replace(/^\+/, '')
    .replace(/^00/, '');
}

export function normalizePhones(raws: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of raws) {
    const n = normalizePhone(raw);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

export function normalizeEmail(raw: string | null | undefined): string {
  if (!raw) return '';
  return String(raw).trim().toLowerCase();
}

export function collectPhones(...candidates: Array<string | string[] | null | undefined>): string[] {
  const flat: Array<string | null | undefined> = [];
  for (const c of candidates) {
    if (!c) continue;
    if (Array.isArray(c)) flat.push(...c);
    else flat.push(c);
  }
  return normalizePhones(flat);
}

export function collectEmails(...candidates: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    const n = normalizeEmail(c);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/**
 * Same-number check that tolerates country-code mismatch.
 *
 * The HTML "Add tenant" form lets operators type a phone freeform; some rows
 * end up stored as the 10-digit local number ("9675151149") while the
 * WhatsApp channel always delivers the full international form ("919675151149").
 * Exact equality misses these; comparing the last 10 digits reconciles them.
 *
 * 10 digits is the safe suffix length — covers India / US / UK / IE local
 * numbers without false-positive collisions on different real numbers.
 */
export function phonesMatch(a: string, b: string): boolean {
  const da = normalizePhone(a);
  const db = normalizePhone(b);
  if (!da || !db) return false;
  if (da === db) return true;
  if (da.length < 7 || db.length < 7) return false;
  const window = Math.min(da.length, db.length, 10);
  return da.slice(-window) === db.slice(-window);
}

export function anyPhoneMatch(stored: string[], candidates: string[]): boolean {
  if (!Array.isArray(stored) || stored.length === 0) return false;
  if (!Array.isArray(candidates) || candidates.length === 0) return false;
  return stored.some((s) => candidates.some((c) => phonesMatch(s, c)));
}
