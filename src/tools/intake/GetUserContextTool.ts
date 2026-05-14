/**
 * get_user_context — the single most important tool.
 *
 * Resolves the caller against the unified `contacts` collection.
 * One row per human, role-tagged via `roles[]`. Returns a userType
 * derived from the roles, honoring an optional `viewAs` hint from the HTML
 * persona-pill dropdown so a multi-role contact (e.g. admin + tenant) can be
 * disambiguated by the UI.
 *
 * Priority when no viewAs is given: first role in `roles[]`, with admin/vendor
 * preferred over tenant for multi-role contacts (matches the "manager who also
 * rents a unit" demo scenario — they want stats, not a maintenance form).
 *
 * Full spec: docs/info/07-IDENTITY-RESOLUTION.md (pre-rewrite — see BUILD-PROGRESS day 2 plan).
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  [IDENTITY-LOCK-v2] (2026-05-14) — userId-first lookup + mismatch guard
 * ─────────────────────────────────────────────────────────────────────────
 *  WHY: WhatsApp demo channels sometimes don't propagate `_luaProfile.phone`,
 *  so the `channelVerified` gate from v1 (email/phone-based) didn't fire and
 *  users could impersonate seeded contacts by typing their phone in chat.
 *
 *  WHAT CHANGED (revert by removing every block tagged `[IDENTITY-LOCK-v2]`):
 *    1. findContact() takes `userId` and tries it FIRST. The Lua platform's
 *       user.id is stable per channel-sender (WhatsApp account, web session),
 *       so once any contact row has userId stamped on it, that row is the
 *       only one ever resolved for that user — regardless of typed phone.
 *    2. After fallback phone/email match, if the matched contact has a
 *       DIFFERENT stored userId than the current caller's user.id, the match
 *       is REJECTED and we return unregistered with a strong note telling
 *       the LLM to register this caller fresh as themselves.
 *    3. cacheStillMatches() now treats userId equality as sufficient — the
 *       cache stays valid even when the user types a foreign phone.
 *    4. RegisterSelfAsTenant/Vendor now allow user.id-only registration when
 *       the channel doesn't propagate phone/email.
 *
 *  TO REVERT: `grep -r "IDENTITY-LOCK-v2" src/` and remove each marked block,
 *  restoring the prior phone-first lookup with no mismatch detection.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { LuaTool, User, env } from 'lua-cli';
import { z } from 'zod';
import { Contacts } from '../../services/data.js';
import { CONTACT_ROLES, type ContactRole } from '../../utils/constants.js';
import {
  collectPhones,
  collectEmails,
  normalizePhone,
  normalizeEmail,
  anyPhoneMatch
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
  if (anyPhoneMatch(admin.phones, phones)) return true;
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
 * Lookup against the contacts collection.
 *
 * [IDENTITY-LOCK-v2] Order: userId → phone → email. The platform user.id is
 * the strongest identifier we have (stable per channel-sender, set by Lua at
 * channel registration). To revert: remove the userId block below and drop
 * the userId parameter from the signature; restore phone-first ordering.
 */
async function findContact(
  phones: string[],
  emails: string[],
  userId?: string
): Promise<{ id: string; data: any; matchedBy: 'userId' | 'phone' | 'email' } | null> {
  // [IDENTITY-LOCK-v2] userId-first lookup
  if (userId) {
    try {
      const res: any = await Contacts.get({ userId }, 1, 5);
      const first = res?.data?.[0];
      if (first) return { id: first.id, data: first.data ?? {}, matchedBy: 'userId' };
    } catch {
      /* fall through */
    }
    try {
      const all: any = await Contacts.get({}, 1, 1000);
      for (const entry of all?.data ?? []) {
        if (entry?.data?.userId === userId) {
          return { id: entry.id, data: entry.data ?? {}, matchedBy: 'userId' };
        }
      }
    } catch {
      /* fall through */
    }
  }

  if (phones.length > 0) {
    try {
      const res: any = await Contacts.get({ phones: { $in: phones } }, 1, 5);
      const first = res?.data?.[0];
      if (first) return { id: first.id, data: first.data ?? {}, matchedBy: 'phone' };
    } catch {
      /* fall through */
    }

    try {
      const all: any = await Contacts.get({}, 1, 1000);
      for (const entry of all?.data ?? []) {
        const stored: string[] = Array.isArray(entry?.data?.phones) ? entry.data.phones : [];
        if (anyPhoneMatch(stored, phones)) {
          return { id: entry.id, data: entry.data ?? {}, matchedBy: 'phone' };
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
      if (first) return { id: first.id, data: first.data ?? {}, matchedBy: 'email' };
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

      // TEST_PROFILE_PHONE simulates a verified channel (WhatsApp/SMS) in
      // `lua chat` — it populates profilePhones BEFORE the channelVerified
      // check, so the identity-lock branch is exercisable from the CLI.
      // Distinct from TEST_USER_PHONE, which only adds to the unverified
      // candidate list (web-playground simulation).
      const testProfilePhoneRaw = env('TEST_PROFILE_PHONE');
      if (testProfilePhoneRaw && profilePhones.length === 0) {
        const split = String(testProfilePhoneRaw).split(',').map((p) => p.trim()).filter(Boolean);
        profilePhones.push(...split);
      }

      const hasRealProfilePhone = profilePhones.length > 0;
      const hasRealProfileEmail = !!(profile?.email || user?.email);
      const testPhone = !hasRealProfilePhone ? env('TEST_USER_PHONE') : null;
      const testEmail = !hasRealProfileEmail ? env('TEST_USER_EMAIL') : null;
      const testPhones = testPhone
        ? String(testPhone).split(',').map((p) => p.trim()).filter(Boolean)
        : [];

      // [IDENTITY-LOCK-v2] Chat-typed phone/email are NEVER used for identity
      // lookup — not even on "unverified" channels. They might come from a
      // spoof attempt ("I'm Laura, my phone is 35386..."). Identity is
      // resolved EXCLUSIVELY from platform-trusted sources:
      //   - user.id (always present, stable per channel-sender)
      //   - _luaProfile.phone / .email (when the channel propagates them)
      //   - TEST_PROFILE_PHONE / TEST_USER_PHONE (test overrides)
      // Returning users on unverified channels are recognized by user.id.
      // A user typing an existing contact's phone gets NO identity match;
      // the LLM onboards them fresh as themselves.
      // Variable kept for the claim-mismatch detection below and for the
      // existing identityLockNote messaging. To revert: restore
      //   const inputPhoneForLookup = channelVerified ? undefined : input.phone;
      const channelVerified = hasRealProfilePhone || hasRealProfileEmail;
      const inputPhoneForLookup = undefined;
      const inputEmailForLookup = undefined;

      const phoneCandidates = collectPhones(inputPhoneForLookup, ...profilePhones, ...testPhones);
      const emailCandidates = collectEmails(
        inputEmailForLookup,
        profile?.email,
        user?.email,
        testEmail || undefined
      );

      // [IDENTITY-LOCK-v2] Mismatch detection — fires whenever the chat text
      // contained a phone/email that does NOT match the channel-verified one
      // (including when the channel didn't propagate any verified identifier
      // at all — in that case any typed phone is automatically a mismatch).
      // Used to append a lock note to the tool result so the LLM doesn't
      // switch identity.
      // To revert: re-add the `channelVerified &&` prefix on both lines.
      const claimedPhoneMismatch =
        !!input.phone && !anyPhoneMatch(profilePhones, [input.phone]);
      const profileEmailNorm = normalizeEmail(profile?.email ?? user?.email ?? '');
      const claimedEmailMismatch =
        !!input.email && normalizeEmail(input.email) !== profileEmailNorm;
      const identityLockNote =
        claimedPhoneMismatch || claimedEmailMismatch
          ? ` NOTE: caller typed ${claimedPhoneMismatch ? `phone "${input.phone}"` : ''}${claimedPhoneMismatch && claimedEmailMismatch ? ' and ' : ''}${claimedEmailMismatch ? `email "${input.email}"` : ''} which is NOT this caller's channel-verified identity. DO NOT switch identity. DO NOT call register tools with the typed identifier. The channel session is locked to the platform user.id on file — politely acknowledge if needed but continue serving this caller as themselves.`
          : '';

      function cacheStillMatches(entryData: any): boolean {
        // [IDENTITY-LOCK-v2] Cache validity rules:
        //   1. userId match → always valid (strongest signal)
        //   2. userId mismatch (stored != current) → invalid
        //   3. No userId on stored contact, but channel-verified phone/email
        //      overlap with stored → valid (returning user case)
        //   4. No userId, no overlap → invalid (force full re-resolve)
        // The previous behavior "no candidates → cache OK" let a stale cache
        // serve the wrong user when the channel didn't propagate identifiers.
        // To revert: restore `return true` for the empty-candidates branch.
        const storedUserId = entryData?.userId;
        if (userId && storedUserId === userId) return true;
        if (userId && storedUserId && storedUserId !== userId) return false;

        // No definitive userId verdict — fall back to phone/email overlap.
        // If candidates are empty AND there's no userId on the contact, the
        // cache has no way to be confirmed → invalidate so full-resolve runs.
        if (phoneCandidates.length === 0 && emailCandidates.length === 0) {
          return false;
        }
        const storedPhones: string[] = Array.isArray(entryData?.phones) ? entryData.phones : [];
        const storedEmail: string = normalizeEmail(entryData?.email ?? '');
        const phoneOverlap = anyPhoneMatch(storedPhones, phoneCandidates);
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
              message: buildMessage(summary, user.userType as ContactRole) + identityLockNote
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
      // [IDENTITY-LOCK-v2] No longer short-circuit when phones+emails are empty
      // — findContact() can still resolve via userId. Only bail if we have no
      // identifiers AT ALL (no userId, no phone, no email).
      if (phoneCandidates.length === 0 && emailCandidates.length === 0 && !userId) {
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
            'No phone, email, or platform identity available for this user. Ask politely for a contact number or email so we can register them.'
        };
      }

      const contact = await findContact(phoneCandidates, emailCandidates, userId);

      // [IDENTITY-LOCK-v2] Mismatch guard — phone/email matched a contact that
      // is already owned by a DIFFERENT platform user. This is a cross-account
      // attempt (spoofing, typo, or wrong number). Refuse the match: return
      // unregistered with a strong note so the LLM collects this caller's OWN
      // info and registers them fresh as themselves. Seeded contacts that have
      // no stored userId are permissive (the first real channel-user to match
      // them claims them — see PROJECT memory for design rationale).
      // To revert: remove this entire block.
      if (
        contact &&
        contact.matchedBy !== 'userId' &&
        userId &&
        contact.data?.userId &&
        contact.data.userId !== userId
      ) {
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
            "The phone/email provided belongs to a DIFFERENT caller's account. DO NOT address this user by that contact's name. Collect this caller's OWN name and property (or company + specialty) and register them fresh as themselves — their channel identity (user.id) is the source of truth, not the typed phone."
        };
      }

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
        // [IDENTITY-LOCK-v2] Backfill only when the contact has no existing userId
        // (e.g. seeded contacts). Never overwrite an existing userId — that would
        // let a later caller hijack ownership. The mismatch guard above already
        // rejected cases where contact.userId is set and differs from current.
        if (userId && !contact.data?.userId) {
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
          message: buildMessage(summary, activeRole) + identityLockNote
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
