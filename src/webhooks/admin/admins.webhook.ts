/**
 * Admin CRUD webhook for admin/manager contacts.
 *
 * Mirrors tenants.webhook.ts and vendors.webhook.ts as a role-filtered view
 * over the unified `contacts` collection (rows where roles[] includes 'admin').
 *
 * Body shapes:
 *   GET    — list all admins
 *   POST   — { name, email?, phone?, phones?[], adminScope? }
 *   PUT    — { id, ...partial }
 *   DELETE — { id }
 *
 * Notes:
 *   - DELETE here is HARD delete on the underlying contact row. If a contact
 *     is also tenant/vendor, DELETE removes the whole human. For role-only
 *     revocation, use the /contacts CRUD (M2) and splice 'admin' out of roles[].
 *   - adminScope is either 'all' (string) or a list of property codes.
 *   - GET response flattens to { id, ...data, phone } for HTML.
 */

import { LuaWebhook } from 'lua-cli';
import { Admins, Contacts } from '../../services/data.js';
import { CONTACT_ROLES } from '../../utils/constants.js';
import { normalizeEmail, collectPhones, anyPhoneMatch } from '../../utils/identity.js';

function flatten(entry: any) {
  if (!entry) return null;
  const d = entry.data ?? {};
  const scope = d.adminScope ?? 'all';
  const scopeLabel = scope === 'all'
    ? 'all properties'
    : Array.isArray(scope) ? scope.join(', ') : String(scope);
  return {
    id: entry.id,
    ...d,
    phone: Array.isArray(d.phones) ? (d.phones[0] ?? '') : (d.phone ?? ''),
    adminScopeLabel: scopeLabel
  };
}

function buildSearchText(a: any): string {
  const scope = a?.adminScope === 'all' ? 'all'
    : Array.isArray(a?.adminScope) ? a.adminScope.join(' ') : '';
  return [a?.name, a?.email, 'admin manager', scope].filter(Boolean).join(' ').trim();
}

export default new LuaWebhook({
  name: 'admins',
  description: 'Admin CRUD for admin/manager contacts (role-filtered view over contacts).',
  execute: async (event) => {
    const body: any = event?.body ?? {};
    const method = String(body.method ?? 'GET').toUpperCase();

    switch (method) {
      case 'GET': {
        try {
          const res: any = await Admins.get({}, 1, 1000);
          const admins = (res?.data ?? []).map(flatten);
          return { success: true, admins };
        } catch (err: any) {
          return { success: false, error: 'list_failed', message: err?.message || 'failed', admins: [] };
        }
      }

      case 'POST': {
        const name = String(body.name ?? '').trim();
        if (!name) return { success: false, error: 'validation', message: 'name is required' };
        const phones = collectPhones(body.phones, body.phone);
        const email = normalizeEmail(body.email);
        if (phones.length === 0 && !email) {
          return { success: false, error: 'validation', message: 'phone or email required' };
        }
        const now = new Date().toISOString();

        // Dedup by phone: if a contact with this phone exists, append 'admin' role.
        let existing: any = null;
        if (phones.length > 0) {
          try {
            const all: any = await Contacts.get({}, 1, 1000);
            for (const e of all?.data ?? []) {
              const stored: string[] = Array.isArray(e?.data?.phones) ? e.data.phones : [];
              if (anyPhoneMatch(stored, phones)) {
                existing = e;
                break;
              }
            }
          } catch { /* noop */ }
        }

        if (existing) {
          const currentRoles: string[] = Array.isArray(existing.data?.roles) ? existing.data.roles : [];
          const mergedRoles = currentRoles.includes(CONTACT_ROLES.ADMIN)
            ? currentRoles
            : [...currentRoles, CONTACT_ROLES.ADMIN];
          const merged = {
            ...(existing.data ?? {}),
            name: existing.data?.name || name,
            phones: Array.from(new Set([...(existing.data?.phones ?? []), ...phones])),
            email: existing.data?.email || email || undefined,
            roles: mergedRoles,
            adminScope: body.adminScope ?? existing.data?.adminScope ?? 'all',
            updatedAt: now
          };
          try {
            await Admins.update(existing.id, merged, buildSearchText(merged));
            return { success: true, admin: flatten({ id: existing.id, data: merged }), merged: true };
          } catch (err: any) {
            return { success: false, error: 'update_failed', message: err?.message || 'failed' };
          }
        }

        const data: Record<string, any> = {
          name,
          phones,
          email: email || undefined,
          roles: [CONTACT_ROLES.ADMIN],
          adminScope: body.adminScope ?? 'all',
          active: true,
          createdAt: now,
          updatedAt: now
        };
        try {
          const entry: any = await Admins.create(data, buildSearchText(data));
          return { success: true, admin: flatten(entry) };
        } catch (err: any) {
          return { success: false, error: 'create_failed', message: err?.message || 'failed' };
        }
      }

      case 'PUT': {
        const id = String(body.id ?? '').trim();
        if (!id) return { success: false, error: 'validation', message: 'id required' };
        try {
          const existing: any = await Admins.getEntry(id);
          if (!existing) return { success: false, error: 'not_found', message: 'admin not found' };
          const cur = existing.data ?? {};
          const { id: _i, method: _m, createdAt: _c, phone, phones, email, ...rest } = body as any;
          const merged: Record<string, any> = { ...cur, ...rest, updatedAt: new Date().toISOString() };
          if (phone !== undefined || phones !== undefined) {
            merged.phones = collectPhones(phones, phone);
          }
          if (email !== undefined) {
            merged.email = normalizeEmail(email) || undefined;
          }
          // Don't let the PUT strip the admin role accidentally
          if (Array.isArray(merged.roles) && !merged.roles.includes(CONTACT_ROLES.ADMIN)) {
            merged.roles = [...merged.roles, CONTACT_ROLES.ADMIN];
          }
          await Admins.update(id, merged, buildSearchText(merged));
          return { success: true, admin: flatten({ id, data: merged }) };
        } catch (err: any) {
          return { success: false, error: 'update_failed', message: err?.message || 'failed' };
        }
      }

      case 'DELETE': {
        const id = String(body.id ?? '').trim();
        if (!id) return { success: false, error: 'validation', message: 'id required' };
        try {
          await Admins.delete(id);
          return { success: true };
        } catch (err: any) {
          return { success: false, error: 'delete_failed', message: err?.message || 'failed' };
        }
      }

      default:
        return { success: false, error: 'unknown_method', message: `unknown method '${method}'` };
    }
  }
});
