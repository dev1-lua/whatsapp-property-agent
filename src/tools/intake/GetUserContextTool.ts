/**
 * get_user_context — the single most important tool.
 *
 * Resolves the caller to a tenant, vendor, admin, or unregistered identity by
 * matching phone/email candidates (input + `user._luaProfile`) against the
 * tenants and vendors collections. Caches the resolved identity on the User
 * record so subsequent turns short-circuit on the fast path.
 *
 * Full spec: docs/info/07-IDENTITY-RESOLUTION.md
 */

import { LuaTool, User, env } from 'lua-cli';
import { z } from 'zod';
import { Tenants, Vendors } from '../../services/data.js';
import {
  collectPhones,
  collectEmails,
  normalizePhone,
  normalizeEmail
} from '../../utils/identity.js';

type UserType = 'tenant' | 'vendor' | 'admin' | 'unregistered';

interface IdentitySummary {
  id: string;
  name: string;
  propertyId?: string;
  propertyCode?: string;
  propertyName?: string;
  unit?: string;
  specialties?: string[];
  rating?: number;
  hourlyRate?: number;
}

function flatten(entry: any): { id: string; data: any } | null {
  if (!entry) return null;
  return { id: entry.id, data: entry.data ?? {} };
}

function adminIdentifiers(): { emails: string[]; phones: string[] } {
  const rawEmails = String(env('ADMIN_EMAILS') ?? '');
  const rawPhones = String(env('ADMIN_PHONES') ?? '');
  const emails = rawEmails
    .split(',')
    .map((e) => normalizeEmail(e))
    .filter(Boolean);
  const phones = rawPhones
    .split(',')
    .map((p) => normalizePhone(p))
    .filter(Boolean);
  return { emails, phones };
}

function isAdminIdentity(emails: string[], phones: string[]): boolean {
  const admin = adminIdentifiers();
  if (admin.emails.length === 0 && admin.phones.length === 0) return false;
  if (emails.some((e) => admin.emails.includes(e))) return true;
  if (phones.some((p) => admin.phones.includes(p))) return true;
  return false;
}

async function searchCollection(
  collection: typeof Tenants | typeof Vendors,
  phones: string[],
  emails: string[]
): Promise<{ id: string; data: any } | null> {
  // Phone-first: try `$in` against the stored phones[] array
  if (phones.length > 0) {
    try {
      const res: any = await collection.get({ phones: { $in: phones } }, 1, 5);
      const first = res?.data?.[0];
      if (first) return flatten(first);
    } catch {
      // Fall through to per-phone search
    }

    // Fallback: brute-scan and match in memory (in case $in isn't supported)
    try {
      const all: any = await collection.get({}, 1, 500);
      for (const entry of all?.data ?? []) {
        const stored: string[] = entry?.data?.phones ?? [];
        if (stored.some((p) => phones.includes(p))) return flatten(entry);
      }
    } catch {
      // Ignore — fall through to email lookup
    }
  }

  // Email fallback
  for (const e of emails) {
    try {
      const res: any = await collection.get({ email: e }, 1, 5);
      const first = res?.data?.[0];
      if (first) return flatten(first);
    } catch {
      // continue
    }
  }
  return null;
}

function tenantSummary(row: any): IdentitySummary {
  return {
    id: row.id,
    name: row.data?.name ?? '',
    propertyId: row.data?.propertyId,
    propertyCode: row.data?.propertyCode,
    propertyName: row.data?.propertyName,
    unit: row.data?.unit
  };
}

function vendorSummary(row: any): IdentitySummary {
  return {
    id: row.id,
    name: row.data?.name ?? row.data?.companyName ?? '',
    specialties: row.data?.specialties ?? [],
    rating: row.data?.rating,
    hourlyRate: row.data?.hourlyRate
  };
}

function tenantMessage(t: IdentitySummary): string {
  const first = (t.name || '').split(' ')[0] || t.name || 'there';
  const propPart = t.propertyName
    ? ` at ${t.propertyName}${t.unit ? `, unit ${t.unit}` : ''}`
    : '';
  return `Recognized tenant: ${first}${propPart}. Greet warmly and ask how you can help.`;
}

function vendorMessage(v: IdentitySummary): string {
  const specialties = (v.specialties ?? []).join(', ') || 'general';
  return `Recognized vendor: ${v.name} (${specialties}). Offer to show available jobs or current assignments.`;
}

export class GetUserContextTool implements LuaTool {
  name = 'get_user_context';
  description =
    'ALWAYS call this tool FIRST at the start of every conversation to identify the caller as a tenant, vendor, admin, or unregistered user. Resolves identity from phone/email and caches the result on the user record. No input required — falls back to the user profile if no params provided.';

  inputSchema = z.object({
    phone: z
      .string()
      .optional()
      .describe('Optional phone number provided by the user. Will be normalized (digits-only).'),
    email: z
      .string()
      .optional()
      .describe('Optional email address provided by the user. Will be lowercased.'),
    name: z
      .string()
      .optional()
      .describe('Optional name provided by the user — only used as a fallback hint.')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const user: any = await User.get();
      const profile = user?._luaProfile ?? {};
      const userId: string | undefined = profile?.userId ?? user?.id;

      // Build candidates up-front so the fast path can verify the cached
      // identity still matches what the caller is presenting THIS turn (the
      // persona pill / different message sender switches identity mid-session).
      const profilePhones: string[] = [];
      if (profile?.phone) profilePhones.push(profile.phone);
      if (Array.isArray(profile?.mobileNumbers)) profilePhones.push(...profile.mobileNumbers);
      if (Array.isArray(profile?.phones)) profilePhones.push(...profile.phones);

      const phoneCandidates = collectPhones(input.phone, ...profilePhones);
      const emailCandidates = collectEmails(input.email, profile?.email, user?.email);
      const inputProvidedIdentifier = !!(input.phone || input.email);

      function cacheStillMatches(entryData: any): boolean {
        // No identifiers presented this turn → trust the cache.
        if (phoneCandidates.length === 0 && emailCandidates.length === 0) return true;
        const storedPhones: string[] = Array.isArray(entryData?.phones) ? entryData.phones : [];
        const storedEmail: string = normalizeEmail(entryData?.email ?? '');
        const phoneOverlap = storedPhones.some((p) => phoneCandidates.includes(p));
        const emailOverlap = !!storedEmail && emailCandidates.includes(storedEmail);
        return phoneOverlap || emailOverlap;
      }

      // ============================================================
      // FAST PATH — already resolved on this user record
      // ============================================================
      if (user?.userType && user?.identityId) {
        const cachedType: UserType = user.userType;
        if (cachedType === 'tenant') {
          try {
            const entry: any = await Tenants.getEntry(user.identityId);
            if (entry && cacheStillMatches(entry.data ?? {})) {
              const summary = tenantSummary({ id: entry.id, data: entry.data ?? {} });
              return {
                success: true,
                userType: 'tenant' as const,
                identity: summary,
                message: tenantMessage(summary)
              };
            }
          } catch {
            // fall through to full resolve
          }
        } else if (cachedType === 'vendor') {
          try {
            const entry: any = await Vendors.getEntry(user.identityId);
            if (entry && cacheStillMatches(entry.data ?? {})) {
              const summary = vendorSummary({ id: entry.id, data: entry.data ?? {} });
              return {
                success: true,
                userType: 'vendor' as const,
                identity: summary,
                message: vendorMessage(summary)
              };
            }
          } catch {
            // fall through
          }
        } else if (cachedType === 'admin' && !inputProvidedIdentifier) {
          return {
            success: true,
            userType: 'admin' as const,
            identity: null,
            message: 'Admin mode — full access to admin operations.'
          };
        }

        // Cache miss-by-identifier — clear it so the full resolve doesn't get
        // confused by stale fields downstream.
        try {
          await user.update({
            userType: null,
            identityId: null,
            tenantId: null,
            vendorId: null
          });
        } catch {
          // non-fatal
        }
      }

      // ============================================================
      // FULL RESOLVE — uses the phoneCandidates/emailCandidates built above
      // ============================================================
      if (phoneCandidates.length === 0 && emailCandidates.length === 0) {
        // Nothing to match against — explicitly mark unregistered
        try {
          await user.update?.({ userType: 'unregistered' });
        } catch {
          /* noop */
        }
        return {
          success: true,
          userType: 'unregistered' as const,
          identity: null,
          message:
            'No phone or email available for this user. Ask politely for a contact number or email, or direct them to their landlord/property manager.'
        };
      }

      // SEARCH TENANTS first (tenant wins on ties)
      const tenantMatch = await searchCollection(Tenants, phoneCandidates, emailCandidates);
      if (tenantMatch) {
        const summary = tenantSummary(tenantMatch);
        try {
          await user.update?.({
            userType: 'tenant',
            identityId: tenantMatch.id,
            tenantId: tenantMatch.id,
            tenantName: summary.name,
            propertyId: summary.propertyId,
            propertyCode: summary.propertyCode,
            propertyName: summary.propertyName,
            unit: summary.unit
          });
        } catch {
          /* noop */
        }
        // Backfill userId on the tenant record so admin UI can see it
        if (userId && tenantMatch.data?.userId !== userId) {
          try {
            await Tenants.update(tenantMatch.id, { ...tenantMatch.data, userId });
          } catch {
            /* noop */
          }
        }
        return {
          success: true,
          userType: 'tenant' as const,
          identity: summary,
          message: tenantMessage(summary)
        };
      }

      // SEARCH VENDORS
      const vendorMatch = await searchCollection(Vendors, phoneCandidates, emailCandidates);
      if (vendorMatch) {
        const summary = vendorSummary(vendorMatch);
        try {
          await user.update?.({
            userType: 'vendor',
            identityId: vendorMatch.id,
            vendorId: vendorMatch.id,
            vendorName: summary.name,
            vendorSpecialties: summary.specialties,
            vendorRating: summary.rating
          });
        } catch {
          /* noop */
        }
        if (userId && vendorMatch.data?.userId !== userId) {
          try {
            await Vendors.update(vendorMatch.id, { ...vendorMatch.data, userId });
          } catch {
            /* noop */
          }
        }
        return {
          success: true,
          userType: 'vendor' as const,
          identity: summary,
          message: vendorMessage(summary)
        };
      }

      // ADMIN check (env allowlist)
      if (isAdminIdentity(emailCandidates, phoneCandidates)) {
        try {
          await user.update?.({ userType: 'admin', identityId: null });
        } catch {
          /* noop */
        }
        return {
          success: true,
          userType: 'admin' as const,
          identity: null,
          message: 'Admin mode — recognized administrator. Full access to admin operations.'
        };
      }

      // No match at all
      try {
        await user.update?.({ userType: 'unregistered' });
      } catch {
        /* noop */
      }
      return {
        success: true,
        userType: 'unregistered' as const,
        identity: null,
        message:
          'Caller is not registered. Politely let them know they are not in our system and ask them to contact their landlord or property manager to be added. Do NOT proceed with maintenance or vendor operations.'
      };
    } catch (err: any) {
      return {
        success: false,
        userType: 'unregistered' as const,
        identity: null,
        error: err?.message ?? String(err),
        message: 'Identity resolution failed. Please try again.'
      };
    }
  }
}

export default GetUserContextTool;
