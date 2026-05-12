/**
 * register_self_as_tenant — onboards a caller as a tenant inline.
 *
 * Used when get_user_context returns userType=unregistered AND the caller has
 * provided their name and property/unit. Captures the channel-provided phone +
 * email automatically from `User.get()._luaProfile`, so the agent never has to
 * ask the user for those.
 *
 * In the unified-contacts model, this writes a `contacts` row with
 * `roles: ['tenant']` and a `units[]` array containing the just-supplied unit.
 *
 * Idempotency / multi-role behavior:
 *   - If a contact with this phone already exists:
 *       • role 'tenant' is APPENDED to roles[] if missing
 *       • the new {propertyCode, unit} is APPENDED to units[] if not already there
 *     This keeps a building manager who also rents a unit on a single row.
 *
 * Side effects:
 *   - Creates / updates a `contacts` row
 *   - Updates the User record with userType=tenant + cached identity so the
 *     next turn fast-paths through get_user_context
 */

import { LuaTool, User, env } from 'lua-cli';
import { z } from 'zod';
import { Contacts, Properties } from '../../services/data.js';
import { CONTACT_ROLES, type ContactRole } from '../../utils/constants.js';
import { collectPhones, normalizeEmail } from '../../utils/identity.js';

export class RegisterSelfAsTenantTool implements LuaTool {
  name = 'register_self_as_tenant';
  description =
    "Add the current caller to the system as a tenant. Use this immediately when `get_user_context` returned userType='unregistered' AND the user has told you their name + which property/unit they live in. The phone/email come from the channel automatically — don't ask the user for those. Multi-unit tenants and existing contacts (e.g. admins who are also tenants) are handled by appending — no duplicate rows. After registration succeeds you can immediately proceed with creating their maintenance ticket.";

  inputSchema = z.object({
    name: z.string().describe("Tenant's full name as they provided it"),
    propertyCode: z
      .string()
      .optional()
      .describe('Short property code if known (the slug used in the directory). Either this or propertyName must be provided.'),
    propertyName: z
      .string()
      .optional()
      .describe('Property name as the user described it (full building name or address). Used for matching when propertyCode is unknown.'),
    unit: z
      .string()
      .optional()
      .describe('Unit / suite / apartment number. Omit for single-family / single-tenant properties.'),
    email: z
      .string()
      .optional()
      .describe('Email address if the user explicitly provided one. Otherwise the channel email is used automatically.'),
    propertyAddress: z
      .string()
      .optional()
      .describe('Street address of the property. REQUIRED if the property is new (not in our portfolio) so we can auto-add it.'),
    propertyCity: z
      .string()
      .optional()
      .describe('City of the property. Used when auto-creating a new property; falls back to env DEFAULT_CITY (or empty) if missing.'),
    propertyType: z
      .string()
      .optional()
      .describe('Property type when auto-creating: "RES" (residential), "COM" (commercial), or "DEV" (development). Defaults to RES.'),
    autoCreateIfMissing: z
      .boolean()
      .optional()
      .describe('Set true to auto-create the property if no match. Requires propertyAddress to be present.')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      if (!input.name || (!input.propertyCode && !input.propertyName)) {
        return {
          success: false,
          error: 'missing_fields',
          message: 'Need a name and at least one of propertyCode or propertyName.'
        };
      }

      const user: any = await User.get();
      const profile = user?._luaProfile ?? {};
      const userId: string | undefined = profile?.userId ?? user?.id;

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

      // ----- Property resolution -----
      let property = await resolveProperty(input.propertyCode, input.propertyName);

      if (!property && input.autoCreateIfMissing && input.propertyAddress) {
        property = await createPropertyOnDemand({
          name: input.propertyName ?? input.propertyAddress,
          address: input.propertyAddress,
          city: input.propertyCity ?? String(env('DEFAULT_CITY') ?? ''),
          type: normalizePropertyType(input.propertyType)
        });
      }

      if (!property) {
        const all = await Properties.get({}, 1, 50).catch(() => ({ data: [] } as any));
        const choices = (all?.data ?? []).map((e: any) => {
          const d = e?.data ?? {};
          return `${d.propertyCode} — ${d.name}${d.address ? ` (${d.address})` : ''}`;
        });
        return {
          success: false,
          error: 'property_not_found',
          message: `Couldn't match "${input.propertyName ?? input.propertyCode}". Either ask the user which of: ${choices.join(' | ')}, OR if it's a new property, ask for the street address + city and retry with autoCreateIfMissing=true plus propertyAddress.`,
          availableProperties: choices
        };
      }

      const propertyData = property.data ?? {};
      const newUnit = {
        propertyCode: propertyData.propertyCode,
        propertyId: property.id,
        propertyName: propertyData.name,
        unit: input.unit
      };

      // ----- Dedupe by phone (brute-scan fallback) -----
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
        // Merge: ensure 'tenant' is in roles, append unit if not already there.
        const currentRoles: ContactRole[] = Array.isArray(existing.data.roles) ? existing.data.roles : [];
        const mergedRoles: ContactRole[] = currentRoles.includes(CONTACT_ROLES.TENANT)
          ? currentRoles
          : [...currentRoles, CONTACT_ROLES.TENANT];

        const currentUnits: any[] = Array.isArray(existing.data.units) ? existing.data.units : [];
        const unitAlreadyPresent = currentUnits.some(
          (u) => u?.propertyCode === newUnit.propertyCode && (u?.unit ?? '') === (newUnit.unit ?? '')
        );
        const mergedUnits = unitAlreadyPresent ? currentUnits : [...currentUnits, newUnit];

        const mergedPhones = Array.from(new Set([...(existing.data.phones ?? []), ...phones]));
        const mergedData = {
          ...existing.data,
          name: existing.data.name || input.name,
          phones: mergedPhones,
          email: existing.data.email || email || undefined,
          roles: mergedRoles,
          units: mergedUnits,
          userId: userId ?? existing.data.userId,
          updatedAt: now
        };

        try {
          await Contacts.update(existing.id, mergedData);
          await user.update?.({
            userType: CONTACT_ROLES.TENANT,
            contactId: existing.id,
            identityId: existing.id,
            tenantId: existing.id,
            tenantName: mergedData.name,
            propertyId: newUnit.propertyId,
            propertyCode: newUnit.propertyCode,
            propertyName: newUnit.propertyName,
            unit: newUnit.unit
          });
        } catch {
          /* noop */
        }

        return {
          success: true,
          alreadyRegistered: unitAlreadyPresent,
          tenantId: existing.id,
          contactId: existing.id,
          identity: {
            id: existing.id,
            name: mergedData.name,
            roles: mergedRoles,
            propertyId: newUnit.propertyId,
            propertyCode: newUnit.propertyCode,
            propertyName: newUnit.propertyName,
            unit: newUnit.unit,
            unitCount: mergedUnits.length
          },
          message: unitAlreadyPresent
            ? `Already on file as ${mergedData.name} at ${newUnit.propertyName}${newUnit.unit ? `, unit ${newUnit.unit}` : ''}.`
            : `Updated ${mergedData.name}'s record — added unit ${newUnit.unit ?? ''} at ${newUnit.propertyName}.`
        };
      }

      // ----- Create new contact -----
      const payload: Record<string, any> = {
        name: input.name,
        phones,
        email: email || undefined,
        roles: [CONTACT_ROLES.TENANT],
        units: [newUnit],
        userId,
        active: true,
        createdAt: now,
        updatedAt: now
      };

      const searchText = [input.name, propertyData.name, input.unit ?? '', email]
        .filter(Boolean)
        .join(' ')
        .trim();

      const created: any = await Contacts.create(payload, searchText);

      try {
        await user.update?.({
          userType: CONTACT_ROLES.TENANT,
          contactId: created.id,
          identityId: created.id,
          tenantId: created.id,
          tenantName: input.name,
          propertyId: property.id,
          propertyCode: propertyData.propertyCode,
          propertyName: propertyData.name,
          unit: input.unit
        });
      } catch {
        /* noop */
      }

      return {
        success: true,
        tenantId: created.id,
        contactId: created.id,
        identity: {
          id: created.id,
          name: input.name,
          roles: [CONTACT_ROLES.TENANT],
          propertyId: property.id,
          propertyCode: propertyData.propertyCode,
          propertyName: propertyData.name,
          unit: input.unit,
          unitCount: 1
        },
        message: `Welcome ${input.name}! Registered at ${propertyData.name}${input.unit ? `, unit ${input.unit}` : ''}.`
      };
    } catch (err: any) {
      return {
        success: false,
        error: 'register_failed',
        message: `Could not register: ${err?.message ?? 'unknown error'}`
      };
    }
  }
}

export default RegisterSelfAsTenantTool;

// ─── Helpers ─────────────────────────────────────────────────────

async function resolveProperty(
  code?: string,
  name?: string
): Promise<{ id: string; data: any } | null> {
  if (code) {
    const wanted = code.trim();
    try {
      const r: any = await Properties.get({}, 1, 500);
      const hit = (r?.data ?? []).find(
        (e: any) =>
          String(e?.data?.propertyCode ?? '').trim().toLowerCase() === wanted.toLowerCase()
      );
      if (hit) return { id: hit.id, data: hit.data };
    } catch {
      /* ignore */
    }
  }

  if (name) {
    const needle = name.trim().toLowerCase();
    try {
      const r: any = await Properties.get({}, 1, 500);
      const hit = (r?.data ?? []).find((e: any) => {
        const d = e?.data ?? {};
        const hay = `${d.name ?? ''} ${d.address ?? ''} ${d.propertyCode ?? ''}`.toLowerCase();
        return hay.includes(needle);
      });
      if (hit) return { id: hit.id, data: hit.data };
    } catch {
      /* ignore */
    }
  }

  return null;
}

async function createPropertyOnDemand(args: {
  name: string;
  address: string;
  city: string;
  type: 'RES' | 'COM' | 'DEV';
}): Promise<{ id: string; data: any } | null> {
  try {
    const propertyCode = generatePropertyCode(args.name, args.address);
    const now = new Date().toISOString();
    const payload = {
      propertyCode,
      name: args.name,
      address: args.address,
      city: args.city,
      type: args.type,
      units: 1,
      notes: 'Auto-created via tenant self-registration',
      createdAt: now,
      updatedAt: now
    };
    const searchText = `${payload.name} ${payload.address} ${payload.city} ${propertyCode}`.trim();
    const created: any = await Properties.create(payload, searchText);
    return { id: created.id, data: payload };
  } catch {
    return null;
  }
}

function generatePropertyCode(name: string, address: string): string {
  const seed = (name || address || 'PROP').trim();
  const firstWord = seed.split(/[\s,]+/)[0] ?? 'PROP';
  const slug = firstWord
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 8) || 'PROP';
  const suffix = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `${slug}-${suffix}`;
}

function normalizePropertyType(raw?: string): 'RES' | 'COM' | 'DEV' {
  const t = String(raw ?? '').trim().toUpperCase();
  if (t === 'COM' || t === 'COMMERCIAL') return 'COM';
  if (t === 'DEV' || t === 'DEVELOPMENT') return 'DEV';
  return 'RES';
}
