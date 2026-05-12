/**
 * Demo-reset webhook — bulk-deletes collection contents.
 *
 * Body shape:
 *   DELETE — { method:'DELETE', confirm:true, full?:boolean }
 *
 * confirm:true (alone) clears tickets, audit_events, communications, escalations.
 * confirm:true + full:true also clears contacts (all tenants/vendors/admins) and properties.
 *
 * Response: { success, deleted: { tickets, audit_events, communications,
 *                                  escalations, contacts?, properties? } }
 */

import { LuaWebhook } from 'lua-cli';
import {
  Tickets,
  AuditEvents,
  Communications,
  Escalations,
  Contacts,
  Properties
} from '../../services/data.js';

async function clearCollection(coll: any): Promise<{ deleted: number; errors: string[] }> {
  const errors: string[] = [];
  let deleted = 0;
  // Drain in pages until empty
  while (true) {
    let page: any[] = [];
    try {
      const res: any = await coll.get({}, 1, 500);
      page = res?.data ?? [];
    } catch (err: any) {
      errors.push(`${coll.name} list: ${err?.message || err}`);
      break;
    }
    if (!page.length) break;
    for (const entry of page) {
      try {
        await coll.delete(entry.id);
        deleted++;
      } catch (err: any) {
        errors.push(`${coll.name} delete ${entry.id}: ${err?.message || err}`);
      }
    }
    // If everything in this page failed to delete, bail out to prevent infinite loop
    if (deleted === 0 && errors.length >= page.length) break;
  }
  return { deleted, errors };
}

export default new LuaWebhook({
  name: 'clear-data',
  description: 'Bulk-delete demo data. confirm:true clears ticket-related collections; full:true also clears directories.',
  execute: async (event) => {
    const body: any = event?.body ?? {};
    const method = String(body.method ?? 'DELETE').toUpperCase();
    if (method !== 'DELETE') {
      return { success: false, error: 'unknown_method', message: `unknown method '${method}'` };
    }
    if (body.confirm !== true) {
      return {
        success: false,
        error: 'confirmation_required',
        message: 'Pass { confirm: true } to confirm. Add { full: true } to also wipe directories.'
      };
    }

    const full = body.full === true;
    const deleted: Record<string, number> = {};
    const errors: string[] = [];

    // Always: ticket-related (agent-generated state)
    const ticketColls = [
      { key: 'tickets', coll: Tickets },
      { key: 'audit_events', coll: AuditEvents },
      { key: 'communications', coll: Communications },
      { key: 'escalations', coll: Escalations }
    ];
    for (const { key, coll } of ticketColls) {
      const r = await clearCollection(coll);
      deleted[key] = r.deleted;
      errors.push(...r.errors);
    }

    // Full reset: also nuke directory data. Use Contacts directly (not the
    // role-filtered Tenants/Vendors views) so admin-only rows get cleared too.
    if (full) {
      const dirColls = [
        { key: 'contacts', coll: Contacts },
        { key: 'properties', coll: Properties }
      ];
      for (const { key, coll } of dirColls) {
        const r = await clearCollection(coll);
        deleted[key] = r.deleted;
        errors.push(...r.errors);
      }
    }

    const total = Object.values(deleted).reduce((a, b) => a + b, 0);
    return {
      success: errors.length === 0,
      deleted,
      message: `Cleared ${total} entries across ${Object.keys(deleted).length} collection(s)` +
        (errors.length ? `, ${errors.length} error(s)` : ''),
      errors: errors.length ? errors : undefined
    };
  }
});
