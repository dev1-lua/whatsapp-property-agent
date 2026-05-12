/**
 * list_pending_approvals — admin-only.
 *
 * Lists tickets stuck in `pending_approval` plus a few related signals: quote
 * amount, vendor name, the configured threshold, and how long the ticket has
 * been waiting. Honors adminScope.
 */

import { LuaTool, User, env } from 'lua-cli';
import { z } from 'zod';
import { Tickets } from '../../services/data.js';
import {
  TicketStatus,
  DEFAULT_APPROVAL_THRESHOLD
} from '../../utils/constants.js';
import {
  resolveAdminScope,
  intersectRequestedProperty,
  recordInScope
} from './_scope.js';

function ageHours(iso?: string): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!t) return null;
  return Math.round((Date.now() - t) / 36e5);
}

export class ListPendingApprovalsTool implements LuaTool {
  name = 'list_pending_approvals';
  description =
    'Admin-only. Lists tickets currently awaiting finance approval (status=pending_approval). Returns ticket id, quote amount, vendor, how long it has been waiting, plus the configured approval threshold for context. Honors admin scope.';

  inputSchema = z.object({
    propertyCode: z
      .string()
      .optional()
      .describe('Optional propertyCode filter. Must be inside the admin\'s scope.'),
    limit: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .describe('Maximum number of approvals to return (default 20).')
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
      const thresholdRaw = env('APPROVAL_THRESHOLD');
      const threshold = Number(thresholdRaw) > 0 ? Number(thresholdRaw) : DEFAULT_APPROVAL_THRESHOLD;
      const currency = String(env('CURRENCY') ?? 'EUR');

      const res: any = await Tickets.get({}, 1, 1000);
      const rows: any[] = (res?.data ?? []).map((e: any) => ({ id: e.id, ...(e.data ?? {}) }));

      const pending = rows
        .filter((t: any) => String(t?.status ?? '') === TicketStatus.PENDING_APPROVAL)
        .filter((t: any) => recordInScope(t, narrowed.effectiveScope))
        .sort((a: any, b: any) => {
          const at = a?.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const bt = b?.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          return at - bt; // oldest waiting first
        })
        .slice(0, cap)
        .map((t: any) => ({
          ticketId: t.ticketId,
          quoteAmount: t.quoteAmount ?? null,
          currency,
          overThresholdBy:
            typeof t.quoteAmount === 'number' && t.quoteAmount > threshold
              ? t.quoteAmount - threshold
              : null,
          assignedVendorName: t.assignedVendorName ?? null,
          propertyName: t.propertyName,
          propertyCode: t.propertyCode,
          unit: t.unit,
          issueType: t.issueType,
          urgency: t.urgency,
          waitingHours: ageHours(t.updatedAt ?? t.createdAt),
          createdAt: t.createdAt,
          updatedAt: t.updatedAt
        }));

      return {
        success: true,
        approvals: pending,
        count: pending.length,
        threshold,
        currency,
        scope: narrowed.effectiveScope,
        generatedAt: new Date().toISOString(),
        message:
          pending.length === 0
            ? 'No tickets are pending approval in scope.'
            : `${pending.length} ticket(s) awaiting approval (threshold ${currency} ${threshold}).`
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message ?? String(err),
        approvals: [],
        count: 0,
        message: 'Failed to list pending approvals.'
      };
    }
  }
}

export default ListPendingApprovalsTool;
