/**
 * Typed wrappers around the lua-cli Data API, one namespace per collection.
 *
 * Usage:
 *   import { Tenants, Tickets } from '../services/data.js';
 *   const laura = await Tenants.search('Laura Murphy', 5);
 *   const ticket = await Tickets.getEntry(id);
 *
 * These are intentionally thin — no business logic, no validation. They exist
 * to (a) prevent collection-name typos and (b) give the rest of the codebase a
 * single import surface for storage.
 */

import { Data } from 'lua-cli';
import { COLLECTIONS, type CollectionName } from '../utils/constants.js';

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

export const Properties = collection(COLLECTIONS.PROPERTIES);
export const Tenants = collection(COLLECTIONS.TENANTS);
export const Vendors = collection(COLLECTIONS.VENDORS);
export const Tickets = collection(COLLECTIONS.TICKETS);
export const AuditEvents = collection(COLLECTIONS.AUDIT_EVENTS);
export const Communications = collection(COLLECTIONS.COMMUNICATIONS);
export const Escalations = collection(COLLECTIONS.ESCALATIONS);
