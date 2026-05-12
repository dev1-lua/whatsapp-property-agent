/**
 * Admin CRUD webhook for properties.
 *
 * Single endpoint; HTTP method dispatched by JSON body `method` field.
 * Backs the Properties tab on property-guy-demo.html.
 *
 * Body shapes:
 *   GET    — list all
 *   POST   — { name, address, city, type, units, propertyCode?, country?, postalCode?, notes? }
 *   PUT    — { id, ...partial }
 *   DELETE — { id }
 *
 * Returns:
 *   GET    → { properties: Property[] }
 *   POST   → { success, property }
 *   PUT    → { success, property }
 *   DELETE → { success, deletedId }
 *
 * Always HTTP 200; validation errors come back as { success:false, error, message }.
 */

import { LuaWebhook } from 'lua-cli';
import { Properties } from '../../services/data.js';

function flatten(entry: any) {
  if (!entry) return null;
  return { id: entry.id, ...(entry.data ?? {}) };
}

function buildSearchText(p: any): string {
  return [p?.name, p?.address, p?.city, p?.propertyCode]
    .filter(Boolean)
    .join(' ')
    .trim();
}

export default new LuaWebhook({
  name: 'properties',
  description: 'Admin CRUD for properties — v1 contract: body.method dispatches.',
  execute: async (event) => {
    const body: any = event?.body ?? {};
    const method = String(body.method ?? 'GET').toUpperCase();

    switch (method) {
      case 'GET': {
        try {
          const res: any = await Properties.get({}, 1, 1000);
          const properties = (res?.data ?? []).map(flatten);
          return { success: true, properties };
        } catch (err: any) {
          return {
            success: false,
            error: 'list_failed',
            message: err?.message || 'Failed to list properties',
            properties: []
          };
        }
      }

      case 'POST': {
        const name = String(body.name ?? '').trim();
        if (!name) {
          return { success: false, error: 'validation', message: 'name is required' };
        }
        const now = new Date().toISOString();
        const data: Record<string, any> = {
          propertyCode: String(body.propertyCode ?? '').trim() || name.toUpperCase().replace(/\s+/g, '-').slice(0, 24),
          name,
          address: String(body.address ?? '').trim(),
          city: String(body.city ?? '').trim(),
          country: body.country ? String(body.country).trim() : undefined,
          postalCode: body.postalCode ? String(body.postalCode).trim() : undefined,
          type: body.type ?? 'RES',
          units: Number(body.units) || 0,
          notes: body.notes ? String(body.notes) : undefined,
          createdAt: now,
          updatedAt: now
        };
        try {
          const entry: any = await Properties.create(data, buildSearchText(data));
          return { success: true, property: flatten(entry) };
        } catch (err: any) {
          return { success: false, error: 'create_failed', message: err?.message || 'Failed to create property' };
        }
      }

      case 'PUT': {
        const id = String(body.id ?? '').trim();
        if (!id) {
          return { success: false, error: 'validation', message: 'id is required' };
        }
        try {
          const existing: any = await Properties.getEntry(id);
          if (!existing) {
            return { success: false, error: 'not_found', message: `property ${id} not found` };
          }
          const cur = existing.data ?? {};
          const { id: _ignoreId, method: _ignoreMethod, createdAt: _ignoreCreated, ...updates } = body as any;
          const merged: Record<string, any> = {
            ...cur,
            ...updates,
            updatedAt: new Date().toISOString()
          };
          await Properties.update(id, merged, buildSearchText(merged));
          return { success: true, property: { id, ...merged } };
        } catch (err: any) {
          return { success: false, error: 'update_failed', message: err?.message || 'Failed to update property' };
        }
      }

      case 'DELETE': {
        const id = String(body.id ?? '').trim();
        if (!id) {
          return { success: false, error: 'validation', message: 'id is required' };
        }
        try {
          await Properties.delete(id);
          return { success: true, deletedId: id };
        } catch (err: any) {
          return { success: false, error: 'delete_failed', message: err?.message || 'Failed to delete property' };
        }
      }

      default:
        return { success: false, error: 'unknown_method', message: `unknown method '${method}'` };
    }
  }
});
