/**
 * Bulk seed webhook — creates properties and contacts (phone-first unified).
 *
 * Body shape:
 *   POST — { method:'POST', overwrite?: boolean, custom?: SeedPayload }
 *
 * Where SeedPayload = { properties?: any[]; contacts?: any[] }.
 *
 * Each contact row has `roles[]` covering any of: tenant / vendor / admin.
 * Multiple roles allowed on one contact (e.g. building manager who also rents).
 *
 * For backward-compat the webhook ALSO accepts `tenants[]` and `vendors[]`
 * arrays, which it merges into `contacts[]` with the appropriate role injected.
 *
 * Dedup rules (skip unless overwrite===true):
 *   - properties: by propertyCode
 *   - contacts:   by phone (first matching phone wins) or email
 *
 * Response: { success, created:{properties,contacts}, skipped:{...}, message }
 */

import { LuaWebhook } from 'lua-cli';
import { Properties, Contacts } from '../../services/data.js';
import { CONTACT_ROLES, type ContactRole } from '../../utils/constants.js';
import { normalizeEmail, collectPhones } from '../../utils/identity.js';

type SeedPayload = {
  properties?: any[];
  contacts?: any[];
  // Legacy shape — accepted but normalized into `contacts` internally
  tenants?: any[];
  vendors?: any[];
};

// Inlined Dublin demo portfolio. Kept in code so the webhook works on Lua's
// serverless runtime where the JSON file isn't bundled. Mirrors
// seed-data/seed.example.json — keep them in sync.
const DEFAULT_SEED: SeedPayload = {
  properties: [
    { propertyCode: 'TEMPLE-04', name: 'No.4 Temple Place', address: '4 Temple Place', city: 'Dublin', country: 'IE', postalCode: 'D02 P860', type: 'RES', units: 12, notes: 'Edwardian townhouse, 12 residential units across 4 floors' },
    { propertyCode: 'WESTGATE-07', name: 'Westgate Court', address: '7 Westgate Avenue', city: 'Dublin', country: 'IE', postalCode: 'D04 X3K2', type: 'RES', units: 24, notes: 'Modern apartment block, 24 units, lift access, secure entry' },
    { propertyCode: 'QUAY-12', name: 'Custom House Quay 12', address: '12 Custom House Quay', city: 'Dublin', country: 'IE', postalCode: 'D01 V4T5', type: 'COM', units: 6, notes: 'Commercial office, 6 suites, ground floor reception' }
  ],
  contacts: [
    // Tenants
    { name: 'Laura Murphy', phones: ['353861000001'], email: 'laura.murphy@demo.test', roles: ['tenant'], units: [{ propertyCode: 'TEMPLE-04', unit: '3B' }] },
    { name: "James O'Brien", phones: ['353861000002'], email: 'james.obrien@demo.test', roles: ['tenant'], units: [{ propertyCode: 'WESTGATE-07', unit: '7' }, { propertyCode: 'WESTGATE-07', unit: '12' }] },
    { name: 'Aoife Walsh', phones: ['353861000003'], email: 'aoife.walsh@demo.test', roles: ['tenant'], units: [{ propertyCode: 'TEMPLE-04', unit: '1A' }] },
    { name: 'Karim Hassan', phones: ['353861000004'], email: 'karim.hassan@demo.test', roles: ['tenant'], units: [{ propertyCode: 'QUAY-12', unit: 'Suite 4' }] },

    // Vendors
    { name: 'Sean Kelly', companyName: 'Dublin Plumbing Co.', contactName: 'Sean Kelly', phones: ['353112000001'], email: 'ops@dublinplumbing.demo', roles: ['vendor'], specialties: ['plumbing', 'heating'], hourlyRate: 65, rating: 4.7, jobsCompleted: 142 },
    { name: 'Maria Doyle', companyName: 'ElecPro Ireland', contactName: 'Maria Doyle', phones: ['353112000002'], email: 'dispatch@elecpro.demo', roles: ['vendor'], specialties: ['electrical'], hourlyRate: 75, rating: 4.8, jobsCompleted: 89 },
    { name: 'Tom Brennan', companyName: 'CoolAir HVAC Services', contactName: 'Tom Brennan', phones: ['353112000003'], email: 'service@coolair.demo', roles: ['vendor'], specialties: ['hvac', 'appliance'], hourlyRate: 70, rating: 4.5, jobsCompleted: 67 },
    { name: 'Padraig Fitzgerald', companyName: 'StructureFix Building Services', contactName: 'Padraig Fitzgerald', phones: ['353112000004'], email: 'info@structurefix.demo', roles: ['vendor'], specialties: ['structural', 'appliance', 'other'], hourlyRate: 85, rating: 4.6, jobsCompleted: 51 },

    // Admins / managers
    { name: 'Niamh Byrne', phones: ['353871000001'], email: 'niamh.byrne@demo.test', roles: ['admin'], adminScope: 'all' },
    { name: 'Conor Daly', phones: ['353871000002'], email: 'conor.daly@demo.test', roles: ['admin', 'tenant'], adminScope: ['TEMPLE-04'], units: [{ propertyCode: 'TEMPLE-04', unit: '2C' }] }
  ]
};

function loadDefaultSeed(): SeedPayload {
  return DEFAULT_SEED;
}

function buildPropertySearchText(p: any): string {
  return [p?.name, p?.address, p?.city, p?.propertyCode].filter(Boolean).join(' ').trim();
}

function buildContactSearchText(c: any): string {
  const specs = Array.isArray(c?.specialties) ? c.specialties.join(' ') : '';
  const unitLabels = Array.isArray(c?.units)
    ? c.units.map((u: any) => `${u?.propertyCode ?? ''} ${u?.unit ?? ''}`).join(' ')
    : '';
  const roles = Array.isArray(c?.roles) ? c.roles.join(' ') : '';
  return [c?.name, c?.companyName, c?.email, roles, specs, unitLabels]
    .filter(Boolean)
    .join(' ')
    .trim();
}

// Normalize legacy `tenants[]` / `vendors[]` shapes into the new contact shape.
function legacyTenantToContact(t: any): any {
  return {
    name: t?.name,
    phones: t?.phones,
    email: t?.email,
    roles: ['tenant' as ContactRole],
    units: t?.propertyCode
      ? [{ propertyCode: String(t.propertyCode), unit: t.unit ? String(t.unit) : undefined }]
      : Array.isArray(t?.units) ? t.units : [],
    userId: t?.userId,
    notes: t?.notes,
    active: t?.active ?? true
  };
}

function legacyVendorToContact(v: any): any {
  return {
    name: v?.name,
    companyName: v?.companyName,
    contactName: v?.contactName,
    phones: v?.phones,
    email: v?.email,
    roles: ['vendor' as ContactRole],
    specialties: v?.specialties,
    hourlyRate: v?.hourlyRate,
    rating: v?.rating,
    jobsCompleted: v?.jobsCompleted,
    totalRevenue: v?.totalRevenue,
    userId: v?.userId,
    notes: v?.notes,
    active: v?.active ?? true
  };
}

export default new LuaWebhook({
  name: 'seed-data',
  description: 'Bulk-create properties and contacts (phone-first, role-tagged).',
  execute: async (event) => {
    const body: any = event?.body ?? {};
    const method = String(body.method ?? 'POST').toUpperCase();
    if (method !== 'POST') {
      return { success: false, error: 'unknown_method', message: `unknown method '${method}'` };
    }

    const overwrite = body.overwrite === true;
    const payload: SeedPayload = (body.custom && typeof body.custom === 'object')
      ? body.custom
      : loadDefaultSeed();

    const seedProps = Array.isArray(payload.properties) ? payload.properties : [];

    // Merge contacts[] with legacy tenants[]/vendors[] shapes (if present).
    const seedContacts: any[] = [
      ...(Array.isArray(payload.contacts) ? payload.contacts : []),
      ...(Array.isArray(payload.tenants) ? payload.tenants.map(legacyTenantToContact) : []),
      ...(Array.isArray(payload.vendors) ? payload.vendors.map(legacyVendorToContact) : [])
    ];

    const created = { properties: 0, contacts: 0 };
    const skipped = { properties: 0, contacts: 0 };
    const errors: string[] = [];

    // ---- Load existing for dedup + property code → id lookup ----
    let existingProps: any[] = [];
    let existingContacts: any[] = [];
    try {
      const r: any = await Properties.get({}, 1, 1000);
      existingProps = (r?.data ?? []).map((e: any) => ({ id: e.id, ...(e.data ?? {}) }));
    } catch (err: any) {
      errors.push(`load properties: ${err?.message || err}`);
    }
    try {
      const r: any = await Contacts.get({}, 1, 1000);
      existingContacts = (r?.data ?? []).map((e: any) => ({ id: e.id, ...(e.data ?? {}) }));
    } catch (err: any) {
      errors.push(`load contacts: ${err?.message || err}`);
    }

    const propByCode = new Map<string, { id: string; name: string; propertyCode: string }>();
    for (const p of existingProps) {
      if (p?.propertyCode) {
        propByCode.set(String(p.propertyCode), { id: p.id, name: p.name, propertyCode: p.propertyCode });
      }
    }

    const now = () => new Date().toISOString();

    // ---- Properties ----
    for (const raw of seedProps) {
      const code = String(raw?.propertyCode ?? '').trim();
      if (!code) {
        skipped.properties++;
        errors.push('property skipped: missing propertyCode');
        continue;
      }
      if (!overwrite && propByCode.has(code)) {
        skipped.properties++;
        continue;
      }
      const ts = now();
      const data: Record<string, any> = {
        propertyCode: code,
        name: String(raw.name ?? code),
        address: raw.address ? String(raw.address) : '',
        city: raw.city ? String(raw.city) : '',
        country: raw.country ? String(raw.country) : undefined,
        postalCode: raw.postalCode ? String(raw.postalCode) : undefined,
        type: raw.type ?? 'RES',
        units: Number(raw.units) || 0,
        notes: raw.notes ? String(raw.notes) : undefined,
        createdAt: ts,
        updatedAt: ts
      };
      try {
        const entry: any = await Properties.create(data, buildPropertySearchText(data));
        propByCode.set(code, { id: entry.id, name: data.name, propertyCode: code });
        created.properties++;
      } catch (err: any) {
        errors.push(`property '${code}': ${err?.message || err}`);
      }
    }

    // ---- Contacts ----
    // Dedup index: phone → existing contact, email → existing contact
    const contactByPhone = new Map<string, any>();
    const contactByEmail = new Map<string, any>();
    for (const c of existingContacts) {
      const phones: string[] = Array.isArray(c?.phones) ? c.phones : [];
      phones.forEach((p) => contactByPhone.set(p, c));
      const e = normalizeEmail(c?.email);
      if (e) contactByEmail.set(e, c);
    }

    for (const raw of seedContacts) {
      const name = String(raw?.name ?? '').trim();
      if (!name) {
        skipped.contacts++;
        errors.push('contact skipped: missing name');
        continue;
      }

      const phones = collectPhones(raw?.phones, raw?.phone);
      const email = normalizeEmail(raw?.email);
      const roles: ContactRole[] = Array.isArray(raw?.roles) && raw.roles.length > 0
        ? raw.roles
        : ([CONTACT_ROLES.TENANT] as ContactRole[]);

      // Validate roles
      const validRoles = new Set(Object.values(CONTACT_ROLES));
      const cleanRoles = roles.filter((r) => validRoles.has(r as any));
      if (cleanRoles.length === 0) {
        skipped.contacts++;
        errors.push(`contact '${name}': no valid roles`);
        continue;
      }

      // Dedup by phone first, then email
      const phoneHit = phones.find((p) => contactByPhone.has(p));
      const dup = phoneHit ? contactByPhone.get(phoneHit) : (email ? contactByEmail.get(email) : null);
      if (!overwrite && dup) {
        skipped.contacts++;
        continue;
      }

      // Resolve property linkages for tenant units (warns if propertyCode missing)
      let units: any[] | undefined;
      if (cleanRoles.includes(CONTACT_ROLES.TENANT)) {
        const rawUnits = Array.isArray(raw?.units) ? raw.units : [];
        units = rawUnits
          .map((u: any) => {
            const code = String(u?.propertyCode ?? '').trim();
            const prop = code ? propByCode.get(code) : null;
            if (!prop) {
              errors.push(`contact '${name}': tenant unit references unknown propertyCode '${code}'`);
              return null;
            }
            return {
              propertyCode: code,
              propertyId: prop.id,
              propertyName: prop.name,
              unit: u?.unit ? String(u.unit) : undefined,
              label: u?.label ? String(u.label) : undefined
            };
          })
          .filter(Boolean);
      }

      const ts = now();
      const data: Record<string, any> = {
        name,
        phones,
        email: email || undefined,
        roles: cleanRoles,
        userId: raw?.userId ? String(raw.userId) : undefined,
        notes: raw?.notes ? String(raw.notes) : undefined,
        active: raw?.active ?? true,
        createdAt: ts,
        updatedAt: ts
      };

      if (units && units.length > 0) {
        data.units = units;
      }

      if (cleanRoles.includes(CONTACT_ROLES.VENDOR)) {
        const specialties = Array.isArray(raw?.specialties)
          ? raw.specialties.map((s: any) => String(s).trim()).filter(Boolean)
          : [];
        if (raw?.companyName) data.companyName = String(raw.companyName);
        if (raw?.contactName) data.contactName = String(raw.contactName);
        data.specialties = specialties;
        if (raw?.hourlyRate !== undefined) data.hourlyRate = Number(raw.hourlyRate);
        if (raw?.rating !== undefined) data.rating = Number(raw.rating);
        data.jobsCompleted = raw?.jobsCompleted !== undefined ? Number(raw.jobsCompleted) : 0;
        data.totalRevenue = raw?.totalRevenue !== undefined ? Number(raw.totalRevenue) : 0;
      }

      if (cleanRoles.includes(CONTACT_ROLES.ADMIN)) {
        if (raw?.adminScope !== undefined) data.adminScope = raw.adminScope;
      }

      try {
        const entry: any = await Contacts.create(data, buildContactSearchText(data));
        phones.forEach((p) => contactByPhone.set(p, { id: entry.id, ...data }));
        if (email) contactByEmail.set(email, { id: entry.id, ...data });
        created.contacts++;
      } catch (err: any) {
        errors.push(`contact '${name}': ${err?.message || err}`);
      }
    }

    const totalCreated = created.properties + created.contacts;
    const totalSkipped = skipped.properties + skipped.contacts;
    const message =
      `Seed complete: ${totalCreated} created ` +
      `(${created.properties}p, ${created.contacts}c), ` +
      `${totalSkipped} skipped` +
      (errors.length ? `, ${errors.length} error(s)` : '');

    return {
      success: errors.length === 0,
      created,
      skipped,
      message,
      errors: errors.length ? errors : undefined
    };
  }
});
