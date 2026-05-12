/**
 * register_self_as_vendor — onboards a caller as a vendor inline.
 *
 * Mirror of `register_self_as_tenant`, used when `get_user_context` returns
 * userType=unregistered AND the caller has identified themselves as a vendor /
 * contractor with at least a company name + one specialty. Phone/email are
 * pulled from the channel automatically.
 *
 * In the unified-contacts model, this writes a `contacts` row with
 * `roles: ['vendor']` plus vendor-shaped fields (companyName, specialties[],
 * optional hourlyRate, active=true).
 *
 * Idempotency / multi-role behavior (mirrors RegisterSelfAsTenant):
 *   - If a contact with this phone already exists:
 *       • 'vendor' is APPENDED to roles[] if missing
 *       • specialties[] are unioned (no duplicates, lowercase)
 *       • companyName fills in if previously empty
 *     Keeps a vendor who is also (e.g.) a tenant on a single contact row.
 *
 * Side effects:
 *   - Creates / updates a `contacts` row
 *   - Updates the User record with userType=vendor + cached identity so the
 *     next turn fast-paths through get_user_context.
 */

import { LuaTool, User, env } from 'lua-cli';
import { z } from 'zod';
import { Contacts } from '../../services/data.js';
import { CONTACT_ROLES, type ContactRole } from '../../utils/constants.js';
import { collectPhones, normalizeEmail } from '../../utils/identity.js';

const KNOWN_SPECIALTIES = ['plumbing', 'electrical', 'hvac', 'appliance', 'structural', 'other'];

function normalizeSpecialties(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const cleaned = list
    .map((s) => String(s ?? '').trim().toLowerCase())
    .filter(Boolean)
    .map((s) => (KNOWN_SPECIALTIES.includes(s) ? s : s)); // pass-through unknowns; persona can normalize
  return Array.from(new Set(cleaned));
}

export class RegisterSelfAsVendorTool implements LuaTool {
  name = 'register_self_as_vendor';
  description =
    "Add the current caller to the system as a vendor / contractor. Use this when `get_user_context` returned userType='unregistered' AND the user has identified as a tradesperson with a company name + at least one specialty (plumbing / electrical / hvac / appliance / structural / other). The phone/email come from the channel automatically — don't ask the user for those. Existing contacts (e.g. a tenant who is also a side-business contractor) are merged by appending the 'vendor' role and union-ing specialties. After registration the vendor can immediately browse available jobs.";

  inputSchema = z.object({
    companyName: z
      .string()
      .describe("Vendor's company / trading name as they provided it. If they only gave a personal name, use that."),
    specialties: z
      .array(z.string())
      .describe("Issue types this vendor handles — one or more of: plumbing, electrical, hvac, appliance, structural, other. Pass at least one."),
    hourlyRate: z
      .number()
      .optional()
      .describe('Hourly rate in the firm currency. Omit if not provided.'),
    email: z
      .string()
      .optional()
      .describe('Email address if the user explicitly provided one. Otherwise the channel email is used automatically.')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const specialties = normalizeSpecialties(input.specialties);

      if (!input.companyName || specialties.length === 0) {
        return {
          success: false,
          error: 'missing_fields',
          message: 'Need a company name and at least one specialty (e.g. plumbing).'
        };
      }

      const user: any = await User.get();
      const profile = user?._luaProfile ?? {};
      const userId: string | undefined = profile?.userId ?? user?.id;

      // Channel identifiers ALWAYS win — never replace _luaProfile with TEST overrides.
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

      const phones = collectPhones(...profilePhones, ...testPhones);
      const email = normalizeEmail(
        input.email ?? profile?.email ?? user?.email ?? testEmail ?? ''
      );

      if (phones.length === 0 && !email) {
        return {
          success: false,
          error: 'no_identifier',
          message: "Can't register without at least a phone or email on the channel."
        };
      }

      // ----- Dedupe by phone (brute-scan fallback per known $in-on-array bug) -----
      let existing: { id: string; data: any } | null = null;
      if (phones.length > 0) {
        try {
          const r: any = await Contacts.get({ phones: { $in: phones } }, 1, 5);
          const first = r?.data?.[0];
          if (first) existing = { id: first.id, data: first.data ?? {} };
        } catch {
          /* fall through */
        }
        if (!existing) {
          try {
            const all: any = await Contacts.get({}, 1, 1000);
            for (const entry of all?.data ?? []) {
              const stored: string[] = Array.isArray(entry?.data?.phones) ? entry.data.phones : [];
              if (stored.some((p: string) => phones.includes(p))) {
                existing = { id: entry.id, data: entry.data ?? {} };
                break;
              }
            }
          } catch {
            /* noop */
          }
        }
      }

      const now = new Date().toISOString();

      if (existing) {
        const currentRoles: ContactRole[] = Array.isArray(existing.data.roles) ? existing.data.roles : [];
        const mergedRoles: ContactRole[] = currentRoles.includes(CONTACT_ROLES.VENDOR)
          ? currentRoles
          : [...currentRoles, CONTACT_ROLES.VENDOR];

        const currentSpecs: string[] = Array.isArray(existing.data.specialties)
          ? existing.data.specialties
          : [];
        const mergedSpecs = Array.from(new Set([...currentSpecs.map((s) => String(s).toLowerCase()), ...specialties]));

        const mergedPhones = Array.from(new Set([...(existing.data.phones ?? []), ...phones]));

        const mergedData = {
          ...existing.data,
          companyName: existing.data.companyName || input.companyName,
          name: existing.data.name || input.companyName,
          phones: mergedPhones,
          email: existing.data.email || email || undefined,
          roles: mergedRoles,
          specialties: mergedSpecs,
          hourlyRate: existing.data.hourlyRate ?? input.hourlyRate,
          rating: existing.data.rating ?? null,
          jobsCompleted: existing.data.jobsCompleted ?? 0,
          active: existing.data.active !== false,
          userId: userId ?? existing.data.userId,
          updatedAt: now
        };

        const wasAlreadyVendor = currentRoles.includes(CONTACT_ROLES.VENDOR);

        try {
          await Contacts.update(existing.id, mergedData);
          await user.update?.({
            userType: CONTACT_ROLES.VENDOR,
            contactId: existing.id,
            identityId: existing.id,
            vendorId: existing.id,
            vendorName: mergedData.companyName,
            vendorSpecialties: mergedSpecs
          });
        } catch {
          /* noop */
        }

        return {
          success: true,
          alreadyRegistered: wasAlreadyVendor,
          vendorId: existing.id,
          contactId: existing.id,
          identity: {
            id: existing.id,
            name: mergedData.companyName,
            companyName: mergedData.companyName,
            roles: mergedRoles,
            specialties: mergedSpecs,
            hourlyRate: mergedData.hourlyRate ?? null,
            rating: mergedData.rating ?? null
          },
          message: wasAlreadyVendor
            ? `Already on file as ${mergedData.companyName}.`
            : `Added vendor role to ${mergedData.companyName} — specialties: ${mergedSpecs.join(', ')}.`
        };
      }

      // ----- Create new vendor contact -----
      const payload: Record<string, any> = {
        name: input.companyName,
        companyName: input.companyName,
        phones,
        email: email || undefined,
        roles: [CONTACT_ROLES.VENDOR],
        specialties,
        hourlyRate: input.hourlyRate,
        rating: null,
        jobsCompleted: 0,
        active: true,
        userId,
        createdAt: now,
        updatedAt: now
      };

      const searchText = [input.companyName, specialties.join(' '), email].filter(Boolean).join(' ').trim();

      const created: any = await Contacts.create(payload, searchText);

      try {
        await user.update?.({
          userType: CONTACT_ROLES.VENDOR,
          contactId: created.id,
          identityId: created.id,
          vendorId: created.id,
          vendorName: input.companyName,
          vendorSpecialties: specialties
        });
      } catch {
        /* noop */
      }

      return {
        success: true,
        vendorId: created.id,
        contactId: created.id,
        identity: {
          id: created.id,
          name: input.companyName,
          companyName: input.companyName,
          roles: [CONTACT_ROLES.VENDOR],
          specialties,
          hourlyRate: input.hourlyRate ?? null,
          rating: null
        },
        message: `Welcome ${input.companyName}! Registered as vendor — specialties: ${specialties.join(', ')}.`
      };
    } catch (err: any) {
      return {
        success: false,
        error: 'register_failed',
        message: `Could not register vendor: ${err?.message ?? 'unknown error'}`
      };
    }
  }
}

export default RegisterSelfAsVendorTool;
