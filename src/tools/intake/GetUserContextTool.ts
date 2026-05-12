/**
 * get_user_context — the single most important tool.
 *
 * Resolves the caller against the unified `contacts` collection (phone-first
 * lookup). One row per human, role-tagged via `roles[]`. Returns a userType
 * derived from the roles, honoring an optional `viewAs` hint from the HTML
 * persona-pill dropdown so a multi-role contact (e.g. admin + tenant) can be
 * disambiguated by the UI.
 *
 * Priority when no viewAs is given: first role in `roles[]`, with admin/vendor
 * preferred over tenant for multi-role contacts (matches the "manager who also
 * rents a unit" demo scenario — they want stats, not a maintenance form).
 *
 * Full spec: docs/info/07-IDENTITY-RESOLUTION.md (pre-rewrite — see BUILD-PROGRESS day 2 plan).
 */

import { LuaTool, User, env } from 'lua-cli';
import { z } from 'zod';
import { Contacts } from '../../services/data.js';
import { CONTACT_ROLES, type ContactRole } from '../../utils/constants.js';
import {
  collectPhones,
  collectEmails,
  normalizePhone,
  normalizeEmail
} from '../../utils/identity.js';

type UserType = 'tenant' | 'vendor' | 'admin' | 'unregistered';

interface ContactUnit {
  propertyCode?: string;
  propertyId?: string;
  propertyName?: string;
  unit?: string;
  label?: string;
}

interface IdentitySummary {
  id: string;
  name: string;
  roles: ContactRole[];
  // Tenant view (when userType=tenant)
  propertyId?: string;
  propertyCode?: string;
  propertyName?: string;
  unit?: string;
  units?: ContactUnit[];
  unitCount?: number;
  // Vendor view
  specialties?: string[];
  rating?: number;
  hourlyRate?: number;
  // Admin view
  adminScope?: 'all' | string[];
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

function envAdminMatch(emails: string[], phones: string[]): boolean {
  const admin = adminIdentifiers();
  if (admin.emails.length === 0 && admin.phones.length === 0) return false;
  if (emails.some((e) => admin.emails.includes(e))) return true;
  if (phones.some((p) => admin.phones.includes(p))) return true;
  return false;
}

/**
 * Choose which role to present as for a contact with one-or-more roles.
 * `viewAs` from the HTML dropdown wins if it matches a held role.
 * Otherwise default precedence: admin > vendor > tenant.
 */
function pickActiveRole(roles: ContactRole[], viewAs?: string): ContactRole | null {
  if (!Array.isArray(roles) || roles.length === 0) return null;
  if (viewAs) {
    const v = String(viewAs).toLowerCase();
    if ((roles as string[]).includes(v)) return v as ContactRole;
  }
  if (roles.includes(CONTACT_ROLES.ADMIN)) return CONTACT_ROLES.ADMIN;
  if (roles.includes(CONTACT_ROLES.VENDOR)) return CONTACT_ROLES.VENDOR;
  if (roles.includes(CONTACT_ROLES.TENANT)) return CONTACT_ROLES.TENANT;
  return roles[0];
}

function summarize(entry: { id: string; data: any }, activeRole: ContactRole): IdentitySummary {
  const d = entry.data ?? {};
  let units: ContactUnit[] = Array.isArray(d.units) ? d.units : [];

  // Backward-compat: legacy rows (or rows created via the admin tenants.webhook
  // before it's rebuilt for units[]) store a single flat {propertyCode, unit}.
  // Synthesize a single-unit array so the rest of this function is uniform.
  if (units.length === 0 && (d.propertyCode || d.unit)) {
    units = [{
      propertyCode: d.propertyCode,
      propertyId: d.propertyId,
      propertyName: d.propertyName,
      unit: d.unit
    }];
  }

  const first = units[0] ?? {};

  const out: IdentitySummary = {
    id: entry.id,
    name: d.name ?? d.companyName ?? '',
    roles: Array.isArray(d.roles) ? d.roles : []
  };

  if (activeRole === CONTACT_ROLES.TENANT) {
    out.propertyId = first.propertyId;
    out.propertyCode = first.propertyCode;
    out.propertyName = first.propertyName;
    out.unit = first.unit;
    out.units = units;
    out.unitCount = units.length;
  } else if (activeRole === CONTACT_ROLES.VENDOR) {
    out.specialties = d.specialties ?? [];
    out.rating = d.rating;
    out.hourlyRate = d.hourlyRate;
  } else if (activeRole === CONTACT_ROLES.ADMIN) {
    out.adminScope = d.adminScope ?? 'all';
  }

  return out;
}

function buildMessage(s: IdentitySummary, activeRole: ContactRole): string {
  const first = (s.name || '').split(' ')[0] || s.name || 'there';

  if (activeRole === CONTACT_ROLES.TENANT) {
    if ((s.unitCount ?? 0) > 1) {
      const labels = (s.units ?? [])
        .map((u) => `${u.propertyCode ?? ''}${u.unit ? ` ${u.unit}` : ''}`.trim())
        .filter(Boolean);
      return `Recognized tenant: ${first} — has ${s.unitCount} units (${labels.join(', ')}). On ticket creation, ASK which unit they're reporting from before proceeding.`;
    }
    const propPart = s.propertyName
      ? ` at ${s.propertyName}${s.unit ? `, unit ${s.unit}` : ''}`
      : '';
    return `Recognized tenant: ${first}${propPart}. Greet warmly and ask how you can help.`;
  }

  if (activeRole === CONTACT_ROLES.VENDOR) {
    const specs = (s.specialties ?? []).join(', ') || 'general';
    return `Recognized vendor: ${s.name} (${specs}). Offer to show available jobs or current assignments.`;
  }

  if (activeRole === CONTACT_ROLES.ADMIN) {
    const scope = s.adminScope === 'all' ? 'all properties' : Array.isArray(s.adminScope) ? s.adminScope.join(', ') : 'all';
    return `Recognized admin/manager: ${first} (scope: ${scope}). Skip onboarding. Offer to surface live stats — open ticket counts, in-progress work, pending approvals, recent activity.`;
  }

  return `Recognized contact: ${first}.`;
}

/**
 * Single phone-first lookup against the contacts collection. Tries $in match
 * on phones[] first, brute-scan fallback (the `$in` array-field query has
 * proven unreliable on this platform — same fix as RegisterSelfAsTenant).
 * Email fallback last.
 */
async function findContact(
  phones: string[],
  emails: string[]
): Promise<{ id: string; data: any } | null> {
  if (phones.length > 0) {
    try {
      const res: any = await Contacts.get({ phones: { $in: phones } }, 1, 5);
      const first = res?.data?.[0];
      if (first) return { id: first.id, data: first.data ?? {} };
    } catch {
      /* fall through */
    }

    try {
      const all: any = await Contacts.get({}, 1, 1000);
      for (const entry of all?.data ?? []) {
        const stored: string[] = Array.isArray(entry?.data?.phones) ? entry.data.phones : [];
        if (stored.some((p) => phones.includes(p))) {
          return { id: entry.id, data: entry.data ?? {} };
        }
      }
    } catch {
      /* fall through */
    }
  }

  for (const e of emails) {
    try {
      const res: any = await Contacts.get({ email: e }, 1, 5);
      const first = res?.data?.[0];
      if (first) return { id: first.id, data: first.data ?? {} };
    } catch {
      /* continue */
    }
  }
  return null;
}

export class GetUserContextTool implements LuaTool {
  name = 'get_user_context';
  description =
    "Identify the caller against the unified contacts directory. CALL THIS: (a) at the very start of every conversation, AND (b) whenever the user provides a phone number, email, or role hint in any subsequent message — even if they were previously 'unregistered'. PASS the phone/email/viewAs/name extracted from the message as inputs (strip non-digits from phone); do NOT call with empty args when the user just told you their identity. Falls back to channel profile if no inputs are given.";

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
      .describe('Optional name provided by the user — only used as a fallback hint.'),
    viewAs: z
      .string()
      .optional()
      .describe("Optional role override (one of: 'admin', 'vendor', 'tenant'). Used by the HTML dropdown to disambiguate multi-role contacts. Falls through to _luaProfile.viewAs if not provided.")
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const user: any = await User.get();
      const profile = user?._luaProfile ?? {};
      const userId: string | undefined = profile?.userId ?? user?.id;
      const viewAs: string | undefined = input.viewAs ?? profile?.viewAs ?? user?.viewAs;

      // CHANNEL IDENTIFIERS ALWAYS WIN — never replace _luaProfile.phone/email
      // with a dev env override, or every channel sender gets mis-identified.
      const profilePhones: string[] = [];
      if (profile?.phone) profilePhones.push(profile.phone);
      if (Array.isArray(profile?.mobileNumbers)) profilePhones.push(...profile.mobileNumbers);
      if (Array.isArray(profile?.phones)) profilePhones.push(...profile.phones);

      const hasRealProfilePhone = profilePhones.length > 0;
      const hasRealProfileEmail = !!(profile?.email || user?.email);
      const testPhone = !hasRealProfilePhone ? env('TEST_USER_PHONE') : null;
      const testEmail = !hasRealProfileEmail ? env('TEST_USER_EMAIL') : null;
      const testPhones = testPhone
        ? String(testPhone).split(',').map((p) => p.trim()).filter(Boolean)
        : [];

      const phoneCandidates = collectPhones(input.phone, ...profilePhones, ...testPhones);
      const emailCandidates = collectEmails(
        input.email,
        profile?.email,
        user?.email,
        testEmail || undefined
      );
      const inputProvidedIdentifier = !!(input.phone || input.email);

      function cacheStillMatches(entryData: any): boolean {
        if (phoneCandidates.length === 0 && emailCandidates.length === 0) return true;
        const storedPhones: string[] = Array.isArray(entryData?.phones) ? entryData.phones : [];
        const storedEmail: string = normalizeEmail(entryData?.email ?? '');
        const phoneOverlap = storedPhones.some((p) => phoneCandidates.includes(p));
        const emailOverlap = !!storedEmail && emailCandidates.includes(storedEmail);
        return phoneOverlap || emailOverlap;
      }

      function viewAsStillMatches(cachedRole?: string): boolean {
        // If the caller didn't supply a viewAs this turn, the cached role is fine.
        if (!viewAs) return true;
        return String(viewAs).toLowerCase() === String(cachedRole ?? '').toLowerCase();
      }

      // ============================================================
      // FAST PATH — already resolved on this user record
      // ============================================================
      if (user?.userType && user?.contactId) {
        try {
          const entry: any = await Contacts.getEntry(user.contactId);
          const data = entry?.data ?? {};
          if (
            entry &&
            cacheStillMatches(data) &&
            viewAsStillMatches(user.userType) &&
            Array.isArray(data.roles) &&
            data.roles.includes(user.userType)
          ) {
            const summary = summarize({ id: entry.id, data }, user.userType as ContactRole);
            return {
              success: true,
              userType: user.userType as UserType,
              identity: summary,
              message: buildMessage(summary, user.userType as ContactRole)
            };
          }
        } catch {
          /* fall through to full resolve */
        }

        // Cache miss (phone changed, viewAs flipped, or roles updated) — clear it.
        try {
          await user.update({
            userType: null,
            identityId: null,
            contactId: null,
            tenantId: null,
            vendorId: null,
            tenantName: null,
            vendorName: null
          });
        } catch {
          /* non-fatal */
        }
      }

      // ============================================================
      // FULL RESOLVE
      // ============================================================
      if (phoneCandidates.length === 0 && emailCandidates.length === 0) {
        try {
          await user.update?.({ userType: 'unregistered' });
        } catch {
          /* noop */
        }
        return {
          success: true,
          userType: 'unregistered' as const,
          identity: null,
          capturedPhone: null,
          capturedEmail: null,
          message:
            'No phone or email available for this user. Ask politely for a contact number or email so we can register them.'
        };
      }

      const contact = await findContact(phoneCandidates, emailCandidates);

      if (contact) {
        const roles: ContactRole[] = Array.isArray(contact.data?.roles) ? contact.data.roles : [];
        const activeRole = pickActiveRole(roles, viewAs);

        if (!activeRole) {
          // Contact row exists but has no valid roles — treat as unregistered.
          return {
            success: true,
            userType: 'unregistered' as const,
            identity: null,
            capturedPhone: phoneCandidates[0] ?? null,
            capturedEmail: emailCandidates[0] ?? null,
            message: `Contact ${contact.data?.name ?? ''} found but has no roles set. Ask whether they're a tenant or vendor and re-register accordingly.`
          };
        }

        const summary = summarize(contact, activeRole);

        // Backfill userId on the contact so outbound User.get(userId).send works later
        if (userId && contact.data?.userId !== userId) {
          try {
            await Contacts.update(contact.id, { ...contact.data, userId, updatedAt: new Date().toISOString() });
          } catch {
            /* noop */
          }
        }

        // Cache identity on the user record. Keep tenantId/vendorId aliases for
        // tools that still read those names (CreateMaintenanceTicket, etc.).
        try {
          const update: any = {
            userType: activeRole,
            contactId: contact.id,
            identityId: contact.id, // legacy alias
            tenantId: activeRole === CONTACT_ROLES.TENANT ? contact.id : null,
            vendorId: activeRole === CONTACT_ROLES.VENDOR ? contact.id : null,
            tenantName: activeRole === CONTACT_ROLES.TENANT ? summary.name : null,
            vendorName: activeRole === CONTACT_ROLES.VENDOR ? summary.name : null
          };
          if (activeRole === CONTACT_ROLES.TENANT) {
            update.propertyId = summary.propertyId;
            update.propertyCode = summary.propertyCode;
            update.propertyName = summary.propertyName;
            update.unit = summary.unit;
          } else if (activeRole === CONTACT_ROLES.VENDOR) {
            update.vendorSpecialties = summary.specialties;
            update.vendorRating = summary.rating;
          }
          await user.update?.(update);
        } catch {
          /* noop */
        }

        return {
          success: true,
          userType: activeRole as UserType,
          identity: summary,
          message: buildMessage(summary, activeRole)
        };
      }

      // No contact match. Fall back to env-based admin allowlist.
      if (envAdminMatch(emailCandidates, phoneCandidates)) {
        try {
          await user.update?.({ userType: 'admin', identityId: null, contactId: null });
        } catch {
          /* noop */
        }
        return {
          success: true,
          userType: 'admin' as const,
          identity: null,
          message: 'Admin mode — env-allowlisted administrator (no contacts row). Full access to admin operations.'
        };
      }

      // Truly unknown.
      try {
        await user.update?.({ userType: 'unregistered' });
      } catch {
        /* noop */
      }
      return {
        success: true,
        userType: 'unregistered' as const,
        identity: null,
        capturedPhone: phoneCandidates[0] ?? null,
        capturedEmail: emailCandidates[0] ?? null,
        message:
          "Caller is not in the contacts directory. If their first message is intent-bearing (e.g. 'my sink is leaking' → tenant, 'I'm available for the plumbing job' → vendor), confirm the inferred role and then call `register_self_as_tenant` (or `register_self_as_vendor` once available). Otherwise greet them and ask whether they're a tenant or a vendor."
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
