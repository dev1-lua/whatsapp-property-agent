/**
 * open-tickets webhook — carryover from v1 contract.
 *
 * Returns every ticket NOT in {closed, cancelled} along with a count and a
 * per-status summary. Mirrors the admin/tickets shape (body.method dispatch)
 * so an external dashboard can call it with `{ method: 'GET' }`.
 *
 * Body:
 *   GET — { status?: string, propertyId?: string, limit?: number }
 *
 * Response:
 *   { success: true, tickets: Ticket[], count, statusSummary, generatedAt }
 *   { success: false, error, message, tickets: [], count: 0 }   on failure
 *
 * Always HTTP 200 — validation errors come back inside the JSON.
 */

import { LuaWebhook } from 'lua-cli';
import { Tickets } from '../services/data.js';
import { TicketStatus } from '../utils/constants.js';

const CLOSED_STATUSES = new Set<string>([
  TicketStatus.CLOSED,
  TicketStatus.CANCELLED
]);

function flatten(entry: any): any {
  if (!entry) return null;
  return { id: entry.id, ...(entry.data ?? entry) };
}

export default new LuaWebhook({
  name: 'open-tickets',
  description:
    'Returns all open maintenance tickets (status NOT IN closed/cancelled), with count + statusSummary.',
  execute: async (event) => {
    const body: any = event?.body ?? {};
    const method = String(body.method ?? 'GET').toUpperCase();

    if (method !== 'GET') {
      return {
        success: false,
        error: 'unsupported_method',
        message: `open-tickets only supports GET, got '${method}'`,
        tickets: [],
        count: 0
      };
    }

    try {
      const limit = Number(body.limit) > 0 ? Math.min(Number(body.limit), 1000) : 500;
      const res: any = await Tickets.get({}, 1, limit);
      const all: any[] = (res?.data ?? []).map(flatten).filter(Boolean);

      let open = all.filter((t: any) => !CLOSED_STATUSES.has(String(t?.status ?? '')));

      if (body.status) {
        const want = String(body.status);
        open = open.filter((t: any) => String(t?.status ?? '') === want);
      }
      if (body.propertyId) {
        const want = String(body.propertyId);
        open = open.filter((t: any) => String(t?.propertyId ?? '') === want);
      }

      // Sort by urgency (emergency first) then createdAt desc.
      const urgencyOrder = ['emergency', 'high', 'medium', 'low'];
      open.sort((a: any, b: any) => {
        const ai = urgencyOrder.indexOf(String(a?.urgency ?? 'low'));
        const bi = urgencyOrder.indexOf(String(b?.urgency ?? 'low'));
        if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        const at = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bt = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
        return bt - at;
      });

      const statusSummary: Record<string, number> = {};
      for (const t of open) {
        const s = String(t?.status ?? 'unknown');
        statusSummary[s] = (statusSummary[s] ?? 0) + 1;
      }

      return {
        success: true,
        tickets: open,
        count: open.length,
        statusSummary,
        generatedAt: new Date().toISOString()
      };
    } catch (err: any) {
      console.error('open-tickets webhook error:', err);
      return {
        success: false,
        error: 'list_failed',
        message: err?.message || 'Failed to list open tickets',
        tickets: [],
        count: 0
      };
    }
  }
});
