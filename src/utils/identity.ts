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
