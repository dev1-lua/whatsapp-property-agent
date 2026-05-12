/**
 * Admin read webhook for tickets.
 *
 * Tickets are agent-managed; this webhook is read-only for the admin UI.
 * Mutations are rejected with { success:false, error:'tickets are agent-managed' }.
 *
 * Body shape:
 *   GET — { status?, propertyId?, limit? } → { tickets: Ticket[] }
 *
 * Tickets are returned flattened ({ id, ...data }) and sorted by createdAt desc.
 */

import { LuaWebhook } from 'lua-cli';
import { Tickets } from '../../services/data.js';

function flatten(entry: any) {
  if (!entry) return null;
  return { id: entry.id, ...(entry.data ?? {}) };
}

export default new LuaWebhook({
  name: 'tickets',
  description: 'Admin read for tickets — agent-managed; mutations rejected.',
  execute: async (event) => {
    const body: any = event?.body ?? {};
    const method = String(body.method ?? 'GET').toUpperCase();

    switch (method) {
      case 'GET': {
        const filter: Record<string, any> = {};
        if (body.status) filter.status = String(body.status);
        if (body.propertyId) filter.propertyId = String(body.propertyId);

        const limit = Number.isFinite(Number(body.limit)) && Number(body.limit) > 0
          ? Number(body.limit)
          : 200;

        try {
          const res: any = await Tickets.get(filter, 1, limit);
          const tickets = (res?.data ?? [])
            .map(flatten)
            .sort((a: any, b: any) => {
              const ta = String(a?.createdAt ?? '');
              const tb = String(b?.createdAt ?? '');
              if (ta === tb) return 0;
              return ta < tb ? 1 : -1; // desc
            });
          return { success: true, tickets, count: tickets.length };
        } catch (err: any) {
          return {
            success: false,
            error: 'list_failed',
            message: err?.message || 'Failed to list tickets',
            tickets: []
          };
        }
      }

      case 'POST':
      case 'PUT':
      case 'DELETE':
        return {
          success: false,
          error: 'tickets are agent-managed',
          message: 'Tickets cannot be created, updated, or deleted via the admin webhook. Use the agent.'
        };

      default:
        return { success: false, error: 'unknown_method', message: `unknown method '${method}'` };
    }
  }
});
