/**
 * Bulk seed webhook — creates properties, tenants, vendors.
 *
 * Body shape:
 *   POST — { method:'POST', overwrite?: boolean, custom?: SeedPayload }
 *
 * If `custom` is absent, reads seed-data/seed.example.json relative to process.cwd().
 *
 * Dedup rules (skip unless overwrite===true):
 *   - properties: by propertyCode
 *   - tenants:    by email
 *   - vendors:    by email
 *
 * Tenant property linking: looks up propertyCode in existing or just-created
 * Properties. If no match, tenant is skipped.
 *
 * Response: { success, created:{properties,tenants,vendors}, skipped:{...}, message }
 */

import { LuaWebhook } from 'lua-cli';
import { Properties, Tenants, Vendors } from '../../services/data.js';
import { normalizeEmail, collectPhones } from '../../utils/identity.js';

type SeedPayload = {
  properties?: any[];
  tenants?: any[];
  vendors?: any[];
};

// Inlined Dublin demo portfolio (3 properties, 4 tenants, 4 vendors).
// Mirrors seed-data/seed.example.json — kept in code so the webhook works on
// Lua's serverless runtime where the JSON file isn't bundled.
const DEFAULT_SEED: SeedPayload = {
  properties: [
    { propertyCode: 'TEMPLE-04', name: 'No.4 Temple Place', address: '4 Temple Place', city: 'Dublin', country: 'IE', postalCode: 'D02 P860', type: 'RES', units: 12, notes: 'Edwardian townhouse, 12 residential units across 4 floors' },
    { propertyCode: 'WESTGATE-07', name: 'Westgate Court', address: '7 Westgate Avenue', city: 'Dublin', country: 'IE', postalCode: 'D04 X3K2', type: 'RES', units: 24, notes: 'Modern apartment block, 24 units, lift access, secure entry' },
    { propertyCode: 'QUAY-12', name: 'Custom House Quay 12', address: '12 Custom House Quay', city: 'Dublin', country: 'IE', postalCode: 'D01 V4T5', type: 'COM', units: 6, notes: 'Commercial office, 6 suites, ground floor reception' }
  ],
  tenants: [
    { name: 'Laura Murphy', phones: ['353861000001'], email: 'laura.murphy@demo.test', propertyCode: 'TEMPLE-04', unit: '3B' },
    { name: "James O'Brien", phones: ['353861000002'], email: 'james.obrien@demo.test', propertyCode: 'WESTGATE-07', unit: '7' },
    { name: 'Aoife Walsh', phones: ['353861000003'], email: 'aoife.walsh@demo.test', propertyCode: 'TEMPLE-04', unit: '1A' },
    { name: 'Karim Hassan', phones: ['353861000004'], email: 'karim.hassan@demo.test', propertyCode: 'QUAY-12', unit: 'Suite 4' }
  ],
  vendors: [
    { name: 'Dublin Plumbing Co.', companyName: 'Dublin Plumbing Co.', contactName: 'Sean Kelly', phones: ['353112000001'], email: 'ops@dublinplumbing.demo', specialties: ['plumbing', 'heating'], hourlyRate: 65, rating: 4.7, jobsCompleted: 142 },
    { name: 'ElecPro Ireland', companyName: 'ElecPro Ireland', contactName: 'Maria Doyle', phones: ['353112000002'], email: 'dispatch@elecpro.demo', specialties: ['electrical'], hourlyRate: 75, rating: 4.8, jobsCompleted: 89 },
    { name: 'CoolAir HVAC Services', companyName: 'CoolAir HVAC Services', contactName: 'Tom Brennan', phones: ['353112000003'], email: 'service@coolair.demo', specialties: ['hvac', 'appliance'], hourlyRate: 70, rating: 4.5, jobsCompleted: 67 },
    { name: 'StructureFix Building Services', companyName: 'StructureFix Building Services', contactName: 'Padraig Fitzgerald', phones: ['353112000004'], email: 'info@structurefix.demo', specialties: ['structural', 'appliance', 'other'], hourlyRate: 85, rating: 4.6, jobsCompleted: 51 }
  ]
};

function loadDefaultSeed(): SeedPayload {
  return DEFAULT_SEED;
}

function buildPropertySearchText(p: any): string {
  return [p?.name, p?.address, p?.city, p?.propertyCode].filter(Boolean).join(' ').trim();
}
function buildTenantSearchText(t: any): string {
  return [t?.name, t?.propertyName, t?.unit || '', t?.email || ''].filter(Boolean).join(' ').trim();
}
function buildVendorSearchText(v: any): string {
  const specs = Array.isArray(v?.specialties) ? v.specialties.join(' ') : '';
  return [v?.companyName, specs, v?.contactName || ''].filter(Boolean).join(' ').trim();
}

export default new LuaWebhook({
  name: 'seed-data',
  description: 'Bulk-create properties/tenants/vendors from default or custom seed payload.',
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
    const seedTenants = Array.isArray(payload.tenants) ? payload.tenants : [];
    const seedVendors = Array.isArray(payload.vendors) ? payload.vendors : [];

    const created = { properties: 0, tenants: 0, vendors: 0 };
    const skipped = { properties: 0, tenants: 0, vendors: 0 };
    const errors: string[] = [];

    // ---- Load existing for dedup + property code → id lookup ----
    let existingProps: any[] = [];
    let existingTenants: any[] = [];
    let existingVendors: any[] = [];
    try {
      const r: any = await Properties.get({}, 1, 1000);
      existingProps = (r?.data ?? []).map((e: any) => ({ id: e.id, ...(e.data ?? {}) }));
    } catch (err: any) {
      errors.push(`load properties: ${err?.message || err}`);
    }
    try {
      const r: any = await Tenants.get({}, 1, 1000);
      existingTenants = (r?.data ?? []).map((e: any) => ({ id: e.id, ...(e.data ?? {}) }));
    } catch (err: any) {
      errors.push(`load tenants: ${err?.message || err}`);
    }
    try {
      const r: any = await Vendors.get({}, 1, 1000);
      existingVendors = (r?.data ?? []).map((e: any) => ({ id: e.id, ...(e.data ?? {}) }));
    } catch (err: any) {
      errors.push(`load vendors: ${err?.message || err}`);
    }

    // propertyCode → { id, name } index, kept current as we create properties
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

    // ---- Tenants ---- (require matching property)
    const tenantEmails = new Set<string>(
      existingTenants.map((t) => normalizeEmail(t?.email)).filter(Boolean) as string[]
    );

    for (const raw of seedTenants) {
      const email = normalizeEmail(raw?.email);
      const code = String(raw?.propertyCode ?? '').trim();
      const prop = code ? propByCode.get(code) : null;

      if (!prop) {
        skipped.tenants++;
        errors.push(`tenant '${raw?.name || '?'}': no matching property '${code}'`);
        continue;
      }
      if (!overwrite && email && tenantEmails.has(email)) {
        skipped.tenants++;
        continue;
      }
      const phones = collectPhones(raw?.phones, raw?.phone);
      const ts = now();
      const data: Record<string, any> = {
        name: String(raw?.name ?? '').trim(),
        phones,
        email: email || undefined,
        propertyId: prop.id,
        propertyCode: prop.propertyCode,
        propertyName: prop.name,
        unit: raw?.unit ? String(raw.unit) : undefined,
        userId: raw?.userId ? String(raw.userId) : undefined,
        active: true,
        createdAt: ts,
        updatedAt: ts
      };
      if (!data.name) {
        skipped.tenants++;
        errors.push("tenant skipped: missing name");
        continue;
      }
      try {
        await Tenants.create(data, buildTenantSearchText(data));
        if (email) tenantEmails.add(email);
        created.tenants++;
      } catch (err: any) {
        errors.push(`tenant '${data.name}': ${err?.message || err}`);
      }
    }

    // ---- Vendors ----
    const vendorEmails = new Set<string>(
      existingVendors.map((v) => normalizeEmail(v?.email)).filter(Boolean) as string[]
    );

    for (const raw of seedVendors) {
      const email = normalizeEmail(raw?.email);
      const name = String(raw?.name ?? '').trim();
      if (!name) {
        skipped.vendors++;
        errors.push("vendor skipped: missing name");
        continue;
      }
      if (!overwrite && email && vendorEmails.has(email)) {
        skipped.vendors++;
        continue;
      }
      const phones = collectPhones(raw?.phones, raw?.phone);
      const specialties = Array.isArray(raw?.specialties)
        ? raw.specialties.map((s: any) => String(s).trim()).filter(Boolean)
        : [];
      const ts = now();
      const data: Record<string, any> = {
        name,
        companyName: raw?.companyName ? String(raw.companyName) : name,
        contactName: raw?.contactName ? String(raw.contactName) : undefined,
        phones,
        email: email || undefined,
        specialties,
        hourlyRate: raw?.hourlyRate !== undefined ? Number(raw.hourlyRate) : undefined,
        rating: raw?.rating !== undefined ? Number(raw.rating) : undefined,
        jobsCompleted: raw?.jobsCompleted !== undefined ? Number(raw.jobsCompleted) : 0,
        totalRevenue: raw?.totalRevenue !== undefined ? Number(raw.totalRevenue) : 0,
        notes: raw?.notes ? String(raw.notes) : undefined,
        active: true,
        createdAt: ts,
        updatedAt: ts
      };
      try {
        await Vendors.create(data, buildVendorSearchText(data));
        if (email) vendorEmails.add(email);
        created.vendors++;
      } catch (err: any) {
        errors.push(`vendor '${name}': ${err?.message || err}`);
      }
    }

    const totalCreated = created.properties + created.tenants + created.vendors;
    const totalSkipped = skipped.properties + skipped.tenants + skipped.vendors;
    const message =
      `Seed complete: ${totalCreated} created ` +
      `(${created.properties}p, ${created.tenants}t, ${created.vendors}v), ` +
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
