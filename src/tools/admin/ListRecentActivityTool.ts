/**
 * list_recent_activity — admin-only.
 *
 * Returns the most recent audit events newest-first. Optionally filters by
 * event type. Honors adminScope by restricting events to tickets in the
 * admin's allowed properties (joins audit_events.ticketId → tickets.propertyCode).
 */

import { LuaTool, User } from 'lua-cli';
import { z } from 'zod';
import { AuditEvents, Tickets } from '../../services/data.js';
import { resolveAdminScope, recordInScope } from './_scope.js';

function summarize(e: any) {
  return {
    eventType: e.eventType,
    ticketId: e.ticketId,
    actorType: e.actorType,
    actorName: e.actorName ?? null,
    fromStatus: e.fromStatus ?? null,
    toStatus: e.toStatus ?? null,
    reason: e?.payload?.reason ?? null,
    at: e.at ?? e.createdAt
  };
}

export class ListRecentActivityTool implements LuaTool {
  name = 'list_recent_activity';
  description =
    'Admin-only. Returns the most recent audit events newest-first across all tickets in the admin\'s scope. Optional filter by eventType. Useful for "what happened recently", "show me the latest activity", etc.';

  inputSchema = z.object({
    limit: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .describe('Maximum number of events to return (default 20).'),
    eventType: z
      .string()
      .optional()
      .describe('Optional event-type filter — one of: status_changed, ticket_created, ticket_updated, quote_received, approval_requested, approved, rejected, work_started, completion_docs_received, tenant_confirmed, payment_initiated, ticket_closed, escalated, dispute_raised, ticket_cancelled.')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const user: any = await User.get();
      const scopeRes = await resolveAdminScope(user);
      if (!scopeRes.ok) {
        return { success: false, error: 'forbidden', message: scopeRes.message };
      }

      const cap = input.limit ?? 20;

      // For scope-aware filtering we need to know which ticketIds are in scope.
      // Audit events without a ticketId (e.g. system events) are excluded from
      // scoped views — if we can't prove the event belongs to an allowed
      // property, we hide it. Env-allowlisted ('all') admins see everything.
      let allowedTicketIds: Set<string> | null = null;
      if (scopeRes.scope !== 'all' && Array.isArray(scopeRes.scope)) {
        const ticketRes: any = await Tickets.get({}, 1, 1000);
        const tickets: any[] = (ticketRes?.data ?? []).map((e: any) => e.data ?? {});
        allowedTicketIds = new Set(
          tickets
            .filter((t: any) => recordInScope(t, scopeRes.scope))
            .map((t: any) => String(t?.ticketId ?? ''))
            .filter(Boolean)
        );
      }

      const res: any = await AuditEvents.get({}, 1, 1000);
      const rows: any[] = (res?.data ?? []).map((e: any) => e.data ?? {});

      const events = rows
        .filter((e: any) => (input.eventType ? String(e?.eventType ?? '') === input.eventType : true))
        .filter((e: any) => {
          if (!allowedTicketIds) return true;
          return allowedTicketIds.has(String(e?.ticketId ?? ''));
        })
        .sort((a: any, b: any) => {
          const at = a?.at ? new Date(a.at).getTime() : 0;
          const bt = b?.at ? new Date(b.at).getTime() : 0;
          return bt - at;
        })
        .slice(0, cap)
        .map(summarize);

      return {
        success: true,
        events,
        count: events.length,
        scope: scopeRes.scope,
        generatedAt: new Date().toISOString(),
        message:
          events.length === 0
            ? 'No recent activity in scope.'
            : `Latest ${events.length} event(s).`
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message ?? String(err),
        events: [],
        count: 0,
        message: 'Failed to list recent activity.'
      };
    }
  }
}

export default ListRecentActivityTool;
