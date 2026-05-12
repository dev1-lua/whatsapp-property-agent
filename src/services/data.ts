/**
 * Typed wrappers around the lua-cli Data API, one namespace per collection.
 *
 * Usage:
 *   import { Contacts, Tenants, Tickets } from '../services/data.js';
 *   const laura = await Contacts.search('Laura Murphy', 5);
 *   const ticket = await Tickets.getEntry(id);
 *
 * These are intentionally thin — no business logic, no validation. They exist
 * to (a) prevent collection-name typos and (b) give the rest of the codebase a
 * single import surface for storage.
 *
 * `Contacts` is the unified phone-first identity directory — one row per human,
 * with `roles[]` covering any of tenant / vendor / admin. `Tenants` and
 * `Vendors` are role-filtered views over the SAME collection, preserved so the
 * existing tool surface keeps working without per-callsite rewrites.
 */

import { Data } from 'lua-cli';
import { COLLECTIONS, CONTACT_ROLES, type CollectionName, type ContactRole } from '../utils/constants.js';

function collection(name: CollectionName) {
  return {
    create: (data: Record<string, any>, searchText?: string) =>
      Data.create(name, data, searchText),

    get: (filter?: any, page?: number, limit?: number) =>
      Data.get(name, filter, page, limit),

    getEntry: (entryId: string) => Data.getEntry(name, entryId),

    update: (entryId: string, data: Record<string, any>, searchText?: string) =>
      Data.update(name, entryId, data, searchText),

    search: (searchText: string, limit?: number, scoreThreshold?: number) =>
      Data.search(name, searchText, limit, scoreThreshold),

    delete: (entryId: string) => Data.delete(name, entryId),

    name,
  };
}

// Real collections backing the storage
export const Properties = collection(COLLECTIONS.PROPERTIES);
export const Contacts = collection(COLLECTIONS.CONTACTS);
export const Tickets = collection(COLLECTIONS.TICKETS);
export const AuditEvents = collection(COLLECTIONS.AUDIT_EVENTS);
export const Communications = collection(COLLECTIONS.COMMUNICATIONS);
export const Escalations = collection(COLLECTIONS.ESCALATIONS);

/**
 * Build a role-filtered view over the Contacts collection. The returned object
 * mirrors the `collection()` shape so existing call sites that used the old
 * `Tenants` / `Vendors` wrappers keep compiling.
 *
 * Notes:
 *   - `get(filter)` merges in `{ roles: { $in: [role] } }`. Filter on roles
 *     directly is unreliable on some array fields, so consumers that need
 *     guaranteed correctness still rely on the brute-scan fallback patterns.
 *   - `create()` injects the role into `roles[]` if absent. Existing callers
 *     write tenant-shaped or vendor-shaped data without specifying roles[],
 *     so this is the safety net.
 *   - `update()` is a passthrough — callers are expected to spread existing
 *     data (preserving roles[]) when patching.
 *   - `delete()` is a hard delete on the underlying contact row. Tools that
 *     need role-removal (e.g. revoke a vendor role without nuking the human)
 *     should call Contacts.update directly to splice the role out of roles[].
 *   - `getEntry()` ignores role filters by design — direct id lookup.
 */
function roleView(role: ContactRole) {
  return {
    create: (data: Record<string, any>, searchText?: string) => {
      const roles: ContactRole[] = Array.isArray(data.roles) && data.roles.length > 0
        ? data.roles
        : [role];
      return Data.create(COLLECTIONS.CONTACTS, { ...data, roles }, searchText);
    },

    /**
     * Role-filtered list. `$in` against the `roles[]` array is unreliable on
     * this platform (silently returns 0 — same bug we hit for `phones[]`), so
     * we fetch all contacts and filter in memory. Other filter keys are passed
     * through as-is to the underlying Data.get call.
     */
    get: async (filter: any = {}, page?: number, limit?: number) => {
      const otherFilter = { ...(filter ?? {}) };
      delete otherFilter.roles;
      const res: any = await Data.get(COLLECTIONS.CONTACTS, otherFilter, page, limit ?? 1000);
      const rows = Array.isArray(res?.data) ? res.data : [];
      const filtered = rows.filter((entry: any) => {
        const roles = entry?.data?.roles;
        return Array.isArray(roles) && roles.includes(role);
      });
      return { ...res, data: filtered };
    },

    getEntry: (entryId: string) => Data.getEntry(COLLECTIONS.CONTACTS, entryId),

    update: (entryId: string, data: Record<string, any>, searchText?: string) =>
      Data.update(COLLECTIONS.CONTACTS, entryId, data, searchText),

    search: (searchText: string, limit?: number, scoreThreshold?: number) =>
      Data.search(COLLECTIONS.CONTACTS, searchText, limit, scoreThreshold),

    delete: (entryId: string) => Data.delete(COLLECTIONS.CONTACTS, entryId),

    name: COLLECTIONS.CONTACTS,
  };
}

export const Tenants = roleView(CONTACT_ROLES.TENANT);
export const Vendors = roleView(CONTACT_ROLES.VENDOR);
export const Admins = roleView(CONTACT_ROLES.ADMIN);
