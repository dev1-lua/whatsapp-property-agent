/**
 * Admin CRUD webhook for vendors.
 *
 * Body shapes:
 *   GET    — list all
 *   POST   — { name, email?, phone?, phones?[], specialties[], hourlyRate?, companyName?, contactName? }
 *   PUT    — { id, ...partial }
 *   DELETE — { id }
 *
 * On create: companyName defaults to name; active defaults to true; phones stored as digits-only array.
 * GET response flattens entries to { id, ...data, phone } for HTML compatibility.
 */

import { LuaWebhook } from 'lua-cli';
import { Vendors } from '../../services/data.js';
import { normalizeEmail, collectPhones } from '../../utils/identity.js';

function flatten(entry: any) {
  if (!entry) return null;
  const d = entry.data ?? {};
  return {
    id: entry.id,
    ...d,
    phone: Array.isArray(d.phones) ? (d.phones[0] ?? '') : (d.phone ?? '')
  };
}

function buildSearchText(v: any): string {
  const specs = Array.isArray(v?.specialties) ? v.specialties.join(' ') : '';
  return [v?.companyName, specs, v?.contactName || '']
    .filter(Boolean)
    .join(' ')
    .trim();
}

export default new LuaWebhook({
  name: 'vendors',
  description: 'Admin CRUD for vendors — v1 contract: body.method dispatches.',
  execute: async (event) => {
    const body: any = event?.body ?? {};
    const method = String(body.method ?? 'GET').toUpperCase();

    switch (method) {
      case 'GET': {
        try {
          const res: any = await Vendors.get({}, 1, 1000);
          const vendors = (res?.data ?? []).map(flatten);
          return { success: true, vendors };
        } catch (err: any) {
          return {
            success: false,
            error: 'list_failed',
            message: err?.message || 'Failed to list vendors',
            vendors: []
          };
        }
      }

      case 'POST': {
        const name = String(body.name ?? '').trim();
        if (!name) {
          return { success: false, error: 'validation', message: 'name is required' };
        }
        const phones = collectPhones(body.phones, body.phone);
        const specialties = Array.isArray(body.specialties)
          ? body.specialties.map((s: any) => String(s).trim()).filter(Boolean)
          : [];
        const now = new Date().toISOString();
        const data: Record<string, any> = {
          name,
          companyName: body.companyName ? String(body.companyName).trim() : name,
          contactName: body.contactName ? String(body.contactName).trim() : undefined,
          phones,
          email: normalizeEmail(body.email) || undefined,
          specialties,
          hourlyRate: body.hourlyRate !== undefined && body.hourlyRate !== '' ? Number(body.hourlyRate) : undefined,
          rating: body.rating !== undefined ? Number(body.rating) : undefined,
          jobsCompleted: body.jobsCompleted !== undefined ? Number(body.jobsCompleted) : 0,
          totalRevenue: body.totalRevenue !== undefined ? Number(body.totalRevenue) : 0,
          notes: body.notes ? String(body.notes) : undefined,
          active: body.active === false ? false : true,
          userId: body.userId ? String(body.userId) : undefined,
          createdAt: now,
          updatedAt: now
        };
        try {
          const entry: any = await Vendors.create(data, buildSearchText(data));
          return { success: true, vendor: flatten(entry) };
        } catch (err: any) {
          return { success: false, error: 'create_failed', message: err?.message || 'Failed to create vendor' };
        }
      }

      case 'PUT': {
        const id = String(body.id ?? '').trim();
        if (!id) {
          return { success: false, error: 'validation', message: 'id is required' };
        }
        try {
          const existing: any = await Vendors.getEntry(id);
          if (!existing) {
            return { success: false, error: 'not_found', message: `vendor ${id} not found` };
          }
          const cur = existing.data ?? {};
          const { id: _i, method: _m, createdAt: _c, phone, phones, email, specialties, ...rest } = body as any;

          const merged: Record<string, any> = { ...cur, ...rest };

          if (phone !== undefined || phones !== undefined) {
            merged.phones = collectPhones(phones, phone);
          }
          if (email !== undefined) {
            merged.email = normalizeEmail(email) || undefined;
          }
          if (specialties !== undefined) {
            merged.specialties = Array.isArray(specialties)
              ? specialties.map((s: any) => String(s).trim()).filter(Boolean)
              : [];
          }
          // Keep companyName=name fallback in sync if name changed and companyName wasn't explicitly set
          if (rest.name && !rest.companyName && cur.companyName === cur.name) {
            merged.companyName = rest.name;
          }

          merged.updatedAt = new Date().toISOString();
          await Vendors.update(id, merged, buildSearchText(merged));
          return {
            success: true,
            vendor: {
              id,
              ...merged,
              phone: Array.isArray(merged.phones) ? (merged.phones[0] ?? '') : ''
            }
          };
        } catch (err: any) {
          return { success: false, error: 'update_failed', message: err?.message || 'Failed to update vendor' };
        }
      }

      case 'DELETE': {
        const id = String(body.id ?? '').trim();
        if (!id) {
          return { success: false, error: 'validation', message: 'id is required' };
        }
        try {
          await Vendors.delete(id);
          return { success: true, deletedId: id };
        } catch (err: any) {
          return { success: false, error: 'delete_failed', message: err?.message || 'Failed to delete vendor' };
        }
      }

      default:
        return { success: false, error: 'unknown_method', message: `unknown method '${method}'` };
    }
  }
});
