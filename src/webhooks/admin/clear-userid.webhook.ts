/**
 * [IDENTITY-LOCK-v2] One-shot cleanup webhook — clears contaminated `userId`
 * field on seeded contact rows.
 *
 * Why this exists: pre-fix versions of GetUserContextTool auto-backfilled the
 * caller's user.id onto whichever contact they matched by phone. Over the
 * course of demos/QA, that contaminated seeded contacts (Laura/Aoife/etc.)
 * with random testers' user.ids. After the v2 fix, GUC's userId-first lookup
 * would resolve those polluted user.ids to seeded contacts forever — locking
 * the wrong people to the wrong identities.
 *
 * This webhook scans contacts whose (name, phone) pair matches a known seed
 * row and clears the `userId` field on those — preserving every other field
 * so any data added through the demo (extra units, role merges) stays intact.
 *
 * Contacts NOT in the seed list (real registrations like Mahmoud Saleh,
 * mayank, Firdosh) are left untouched.
 *
 * Body shape:
 *   POST — { method:'POST', confirm: true, dryRun?: boolean }
 *
 * Response: { success, scanned, cleaned, dryRun, entries: [{id, name, phoneMatch, hadUserId}] }
 *
 * TO REVERT THIS FILE: delete this webhook + unregister it from src/index.ts.
 */

import { LuaWebhook } from 'lua-cli';
import { Contacts } from '../../services/data.js';
import { normalizePhone, anyPhoneMatch } from '../../utils/identity.js';

// Mirrors seed-data.webhook.ts DEFAULT_SEED — keep in sync. The pair (name,
// phone) is the identity signal; either match is enough.
const SEEDED_CONTACTS: Array<{ name: string; phones: string[] }> = [
  { name: 'Laura Murphy', phones: ['353861000001'] },
  { name: "James O'Brien", phones: ['353861000002'] },
  { name: 'Aoife Walsh', phones: ['353861000003'] },
  { name: 'Karim Hassan', phones: ['353861000004'] },
  { name: 'Sean Kelly', phones: ['353112000001'] },
  { name: 'Maria Doyle', phones: ['353112000002'] },
  { name: 'Tom Brennan', phones: ['353112000003'] },
  { name: 'Padraig Fitzgerald', phones: ['353112000004'] },
  { name: 'Niamh Byrne', phones: ['353871000001'] },
  { name: 'Conor Daly', phones: ['353871000002'] }
];

function isSeeded(contactName: string, contactPhones: string[]): { matched: boolean; by: 'name' | 'phone' | null } {
  const nameNorm = String(contactName || '').trim().toLowerCase();
  const phonesNorm = contactPhones.map((p) => normalizePhone(p)).filter(Boolean);
  for (const s of SEEDED_CONTACTS) {
    if (nameNorm && nameNorm === s.name.toLowerCase()) return { matched: true, by: 'name' };
    if (phonesNorm.length && anyPhoneMatch(phonesNorm, s.phones)) return { matched: true, by: 'phone' };
  }
  return { matched: false, by: null };
}

export default new LuaWebhook({
  name: 'clear-userid',
  description: '[IDENTITY-LOCK-v2] Clear contaminated userId from seeded contact rows. Pass { confirm: true } to apply; { dryRun: true } to preview.',
  execute: async (event) => {
    const body: any = event?.body ?? {};
    const method = String(body.method ?? 'POST').toUpperCase();
    if (method !== 'POST') {
      return { success: false, error: 'unknown_method', message: `unknown method '${method}'` };
    }
    const dryRun = body.dryRun === true;
    if (!dryRun && body.confirm !== true) {
      return {
        success: false,
        error: 'confirmation_required',
        message: 'Pass { confirm: true } to apply, or { dryRun: true } to preview.'
      };
    }

    const entries: Array<{ id: string; name: string; matchedBy: string; hadUserId: string | null; action: string }> = [];
    let scanned = 0;
    let cleaned = 0;
    const errors: string[] = [];

    try {
      const all: any = await Contacts.get({}, 1, 1000);
      const rows = all?.data ?? [];
      scanned = rows.length;

      for (const entry of rows) {
        const data = entry?.data ?? {};
        const phones: string[] = Array.isArray(data.phones) ? data.phones : [];
        const { matched, by } = isSeeded(data.name ?? '', phones);
        if (!matched) continue;

        const hadUserId: string | null = data.userId ? String(data.userId) : null;
        if (!hadUserId) {
          entries.push({ id: entry.id, name: data.name ?? '', matchedBy: by ?? '', hadUserId: null, action: 'already_clean' });
          continue;
        }

        if (dryRun) {
          entries.push({ id: entry.id, name: data.name ?? '', matchedBy: by ?? '', hadUserId, action: 'would_clear' });
          continue;
        }

        try {
          // Lua Data.update is a PATCH (merges), so `undefined` is a no-op
          // and the existing userId would stay. We must explicitly set null
          // to clear the field. Other fields are preserved by spreading the
          // existing data first.
          const { userId: _drop, ...rest } = data;
          await Contacts.update(entry.id, {
            ...rest,
            userId: null,
            updatedAt: new Date().toISOString()
          });
          cleaned++;
          entries.push({ id: entry.id, name: data.name ?? '', matchedBy: by ?? '', hadUserId, action: 'cleared' });
        } catch (err: any) {
          errors.push(`update ${entry.id}: ${err?.message || err}`);
          entries.push({ id: entry.id, name: data.name ?? '', matchedBy: by ?? '', hadUserId, action: 'error' });
        }
      }
    } catch (err: any) {
      return {
        success: false,
        error: 'scan_failed',
        message: `Couldn't list contacts: ${err?.message || err}`
      };
    }

    return {
      success: errors.length === 0,
      dryRun,
      scanned,
      cleaned,
      entries,
      message: dryRun
        ? `Dry run — would clear userId on ${entries.filter((e) => e.action === 'would_clear').length} seeded contact(s).`
        : `Cleared userId on ${cleaned} seeded contact(s).`,
      errors: errors.length ? errors : undefined
    };
  }
});
