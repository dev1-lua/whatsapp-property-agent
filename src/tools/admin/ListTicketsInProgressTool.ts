/**
 * list_tickets_in_progress — admin-only.
 *
 * Returns tickets that are actively being worked: anything between
 * vendor_contacted and in_progress (inclusive), sorted by urgency then
 * createdAt desc. Honors the admin's adminScope.
 */

import { LuaTool, User } from 'lua-cli';
import { z } from 'zod';
import { Tickets } from '../../services/data.js';
import { TicketStatus } from '../../utils/constants.js';
import {
  resolveAdminScope,
  intersectRequestedProperty,
  recordInScope
} from './_scope.js';

const ACTIVE_STATUSES = new Set<string>([
  TicketStatus.VENDOR_CONTACTED,
  TicketStatus.QUOTED,
  TicketStatus.PENDING_APPROVAL,
  TicketStatus.APPROVED,
  TicketStatus.IN_PROGRESS,
  TicketStatus.ON_HOLD
]);

const URGENCY_ORDER = ['emergency', 'high', 'medium', 'low'];

function summarize(t: any) {
  return {
    ticketId: t.ticketId,
    status: t.status,
    urgency: t.urgency,
    issueType: t.issueType,
    description:
      typeof t.description === 'string' && t.description.length > 140
        ? `${t.description.slice(0, 137)}...`
        : t.description,
    propertyName: t.propertyName,
    propertyCode: t.propertyCode,
    unit: t.unit,
    tenantName: t.tenantName ?? null,
    assignedVendorName: t.assignedVendorName ?? null,
    quoteAmount: t.quoteAmount ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt
  };
}

export class ListTicketsInProgressTool implements LuaTool {
  name = 'list_tickets_in_progress';
  description =
    'Admin-only. Lists tickets currently being worked (status in vendor_contacted, quoted, pending_approval, approved, in_progress, on_hold). Sorted by urgency then most-recent first. Honors admin scope.';

  inputSchema = z.object({
    propertyCode: z
      .string()
      .optional()
      .describe('Optional propertyCode filter. Must be inside the admin\'s scope.'),
    status: z
      .string()
      .optional()
      .describe('Optional single status filter — one of: vendor_contacted, quoted, pending_approval, approved, in_progress, on_hold. Omit to see all active states.'),
    limit: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .describe('Maximum number of tickets to return (default 20).')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const user: any = await User.get();
      const scopeRes = await resolveAdminScope(user);
      if (!scopeRes.ok) {
        return { success: false, error: 'forbidden', message: scopeRes.message };
      }

      const narrowed = intersectRequestedProperty(scopeRes.scope, input.propertyCode);
      if (!narrowed.allowed) {
        return {
          success: false,
          error: 'out_of_scope',
          message: `Property ${input.propertyCode} is not in your admin scope.`
        };
      }

      const cap = input.limit ?? 20;
      const wantedStatus = input.status && ACTIVE_STATUSES.has(input.status) ? input.status : null;

      const res: any = await Tickets.get({}, 1, 1000);
      const rows: any[] = (res?.data ?? []).map((e: any) => ({ id: e.id, ...(e.data ?? {}) }));

      const active = rows
        .filter((t: any) => ACTIVE_STATUSES.has(String(t?.status ?? '')))
        .filter((t: any) => (wantedStatus ? String(t?.status ?? '') === wantedStatus : true))
        .filter((t: any) => recordInScope(t, narrowed.effectiveScope))
        .sort((a: any, b: any) => {
          const ai = URGENCY_ORDER.indexOf(String(a?.urgency ?? 'low'));
          const bi = URGENCY_ORDER.indexOf(String(b?.urgency ?? 'low'));
          if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
          const at = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
          const bt = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
          return bt - at;
        })
        .slice(0, cap)
        .map(summarize);

      return {
        success: true,
        tickets: active,
        count: active.length,
        scope: narrowed.effectiveScope,
        generatedAt: new Date().toISOString(),
        message:
          active.length === 0
            ? 'No tickets are currently in progress in scope.'
            : `${active.length} ticket(s) in progress.`
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message ?? String(err),
        tickets: [],
        count: 0,
        message: 'Failed to list tickets in progress.'
      };
    }
  }
}

export default ListTicketsInProgressTool;
