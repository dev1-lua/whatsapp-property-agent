/**
 * get_open_ticket_count — admin-only stats.
 *
 * Counts tickets whose status is NOT in {closed, cancelled}, optionally
 * grouped by status, urgency, issueType, or propertyCode. Honors the admin's
 * `adminScope` ('all' | propertyCode[]) and respects an explicit `propertyCode`
 * override when supplied.
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

const CLOSED_STATUSES = new Set<string>([
  TicketStatus.CLOSED,
  TicketStatus.CANCELLED
]);

export class GetOpenTicketCountTool implements LuaTool {
  name = 'get_open_ticket_count';
  description =
    'Admin-only. Count maintenance tickets that are NOT closed or cancelled. Optionally restrict to a propertyCode (must lie within the admin\'s scope) and/or break the count down by a field. Returns a total plus the requested breakdown.';

  inputSchema = z.object({
    propertyCode: z
      .string()
      .optional()
      .describe('Optional propertyCode filter. Must be inside the admin\'s scope; otherwise the call returns out_of_scope.'),
    groupBy: z
      .string()
      .optional()
      .describe('Optional grouping dimension — one of: status, urgency, issueType, propertyCode. Omit for a single total.')
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

      const res: any = await Tickets.get({}, 1, 1000);
      const all: any[] = (res?.data ?? [])
        .map((e: any) => ({ id: e.id, ...(e.data ?? {}) }))
        .filter((t: any) => !CLOSED_STATUSES.has(String(t?.status ?? '')))
        .filter((t: any) => recordInScope(t, narrowed.effectiveScope));

      const total = all.length;

      const allowedGroups = new Set(['status', 'urgency', 'issueType', 'propertyCode']);
      const groupBy = input.groupBy && allowedGroups.has(input.groupBy) ? input.groupBy : null;

      let breakdown: Record<string, number> | undefined;
      if (groupBy) {
        breakdown = {};
        for (const t of all) {
          const key = String(t?.[groupBy] ?? 'unknown');
          breakdown[key] = (breakdown[key] ?? 0) + 1;
        }
      }

      return {
        success: true,
        total,
        groupBy: groupBy ?? null,
        breakdown: breakdown ?? null,
        scope: narrowed.effectiveScope,
        generatedAt: new Date().toISOString(),
        message:
          total === 0
            ? 'No open tickets in scope.'
            : `${total} open ticket(s)${groupBy ? ` grouped by ${groupBy}` : ''}.`
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message ?? String(err),
        message: 'Failed to compute open ticket count.'
      };
    }
  }
}

export default GetOpenTicketCountTool;
