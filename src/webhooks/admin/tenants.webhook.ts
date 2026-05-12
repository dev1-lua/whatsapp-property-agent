/**
 * Admin CRUD webhook for tenants.
 *
 * Body shapes:
 *   GET    — list all
 *   POST   — { name, email?, phone?, phones?[], propertyId | propertyCode, unit?, propertyName? }
 *   PUT    — { id, ...partial }
 *   DELETE — { id }
 *
 * On write: phone normalized (digits-only), always stored as phones[].
 * Email lowercased. propertyName/propertyCode denormalized from Properties on create.
 *
 * GET response flattens entries to { id, ...data, phone } so the HTML page can
 * render `t.phone` without knowing the internal phones[] shape.
 */

import { LuaWebhook } from 'lua-cli';
import { Tenants, Properties } from '../../services/data.js';
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

function buildSearchText(t: any): string {
  return [t?.name, t?.propertyName, t?.unit || '', t?.email || '']
    .filter(Boolean)
    .join(' ')
    .trim();
}

async function findPropertyById(id: string): Promise<any | null> {
  if (!id) return null;
  try {
    const entry: any = await Properties.getEntry(id);
    return entry ? { id: entry.id, ...(entry.data ?? {}) } : null;
  } catch {
    return null;
  }
}

async function findPropertyByCode(code: string): Promise<any | null> {
  if (!code) return null;
  try {
    const res: any = await Properties.get({ propertyCode: code }, 1, 5);
    const first = res?.data?.[0];
    return first ? { id: first.id, ...(first.data ?? {}) } : null;
  } catch {
    return null;
  }
}

export default new LuaWebhook({
  name: 'tenants',
  description: 'Admin CRUD for tenants — v1 contract: body.method dispatches.',
  execute: async (event) => {
    const body: any = event?.body ?? {};
    const method = String(body.method ?? 'GET').toUpperCase();

    switch (method) {
      case 'GET': {
        try {
          const res: any = await Tenants.get({}, 1, 1000);
          const tenants = (res?.data ?? []).map(flatten);
          return { success: true, tenants };
        } catch (err: any) {
          return {
            success: false,
            error: 'list_failed',
            message: err?.message || 'Failed to list tenants',
            tenants: []
          };
        }
      }

      case 'POST': {
        const name = String(body.name ?? '').trim();
        if (!name) {
          return { success: false, error: 'validation', message: 'name is required' };
        }
        // Resolve property (by id, falling back to propertyCode)
        let property: any = null;
        if (body.propertyId) property = await findPropertyById(String(body.propertyId));
        if (!property && body.propertyCode) property = await findPropertyByCode(String(body.propertyCode));
        if (!property) {
          return {
            success: false,
            error: 'validation',
            message: 'propertyId (or propertyCode) is required and must match an existing property'
          };
        }

        const phones = collectPhones(body.phones, body.phone);
        const now = new Date().toISOString();
        const data: Record<string, any> = {
          name,
          phones,
          email: normalizeEmail(body.email) || undefined,
          propertyId: property.id,
          propertyCode: property.propertyCode,
          propertyName: body.propertyName ? String(body.propertyName) : property.name,
          unit: body.unit ? String(body.unit).trim() : undefined,
          userId: body.userId ? String(body.userId) : undefined,
          active: body.active === false ? false : true,
          createdAt: now,
          updatedAt: now
        };
        try {
          const entry: any = await Tenants.create(data, buildSearchText(data));
          return { success: true, tenant: flatten(entry) };
        } catch (err: any) {
          return { success: false, error: 'create_failed', message: err?.message || 'Failed to create tenant' };
        }
      }

      case 'PUT': {
        const id = String(body.id ?? '').trim();
        if (!id) {
          return { success: false, error: 'validation', message: 'id is required' };
        }
        try {
          const existing: any = await Tenants.getEntry(id);
          if (!existing) {
            return { success: false, error: 'not_found', message: `tenant ${id} not found` };
          }
          const cur = existing.data ?? {};
          const { id: _i, method: _m, createdAt: _c, phone, phones, email, propertyId, propertyCode, ...rest } = body as any;

          const merged: Record<string, any> = { ...cur, ...rest };

          // Phone normalization — if either phone or phones was sent, recompute phones[]
          if (phone !== undefined || phones !== undefined) {
            merged.phones = collectPhones(phones, phone);
          }

          // Email normalization
          if (email !== undefined) {
            merged.email = normalizeEmail(email) || undefined;
          }

          // Property re-resolution if changed
          if (propertyId && propertyId !== cur.propertyId) {
            const prop = await findPropertyById(String(propertyId));
            if (prop) {
              merged.propertyId = prop.id;
              merged.propertyCode = prop.propertyCode;
              merged.propertyName = prop.name;
            }
          } else if (propertyCode && propertyCode !== cur.propertyCode) {
            const prop = await findPropertyByCode(String(propertyCode));
            if (prop) {
              merged.propertyId = prop.id;
              merged.propertyCode = prop.propertyCode;
              merged.propertyName = prop.name;
            }
          }

          merged.updatedAt = new Date().toISOString();
          await Tenants.update(id, merged, buildSearchText(merged));
          return {
            success: true,
            tenant: {
              id,
              ...merged,
              phone: Array.isArray(merged.phones) ? (merged.phones[0] ?? '') : ''
            }
          };
        } catch (err: any) {
          return { success: false, error: 'update_failed', message: err?.message || 'Failed to update tenant' };
        }
      }

      case 'DELETE': {
        const id = String(body.id ?? '').trim();
        if (!id) {
          return { success: false, error: 'validation', message: 'id is required' };
        }
        try {
          await Tenants.delete(id);
          return { success: true, deletedId: id };
        } catch (err: any) {
          return { success: false, error: 'delete_failed', message: err?.message || 'Failed to delete tenant' };
        }
      }

      default:
        return { success: false, error: 'unknown_method', message: `unknown method '${method}'` };
    }
  }
});
