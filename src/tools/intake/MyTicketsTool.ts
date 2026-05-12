/**
 * my_tickets — tenant-scoped list / cancel.
 *
 * Resolves the tenantId from the cached identity on `User.get()` (set by
 * get_user_context). Lists all tickets belonging to that tenant, or cancels a
 * single one when allowed by the state machine. Other vendor-side actions on
 * a tenant ticket flow through their own dedicated tools.
 */

import { LuaTool, User } from 'lua-cli';
import { z } from 'zod';
import { Tickets } from '../../services/data.js';
import {
  TicketStatus,
  ActorType,
  EventType
} from '../../utils/constants.js';
import { logEvent, logStatusChange } from '../../utils/audit-log.js';

const NON_CANCELLABLE: string[] = [
  TicketStatus.IN_PROGRESS,
  TicketStatus.COMPLETED,
  TicketStatus.CLOSED,
  TicketStatus.CANCELLED
];

function summarize(t: any) {
  return {
    ticketId: t.ticketId,
    status: t.status,
    issueType: t.issueType,
    urgency: t.urgency,
    description:
      typeof t.description === 'string' && t.description.length > 120
        ? `${t.description.slice(0, 117)}...`
        : t.description,
    propertyName: t.propertyName,
    unit: t.unit,
    assignedVendorName: t.assignedVendorName ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    imageCount: Array.isArray(t.images) ? t.images.length : 0
  };
}

export class MyTicketsTool implements LuaTool {
  name = 'my_tickets';
  description =
    'List the current tenant\'s maintenance tickets, or cancel one of them. Requires the user to be a recognized tenant (call get_user_context first). For cancel, the ticket must not be in progress, completed, closed, or already cancelled.';

  inputSchema = z.object({
    action: z
      .enum(['list', 'cancel'])
      .describe('"list" returns all of the tenant\'s tickets; "cancel" cancels a single ticket by display id.'),
    ticketId: z
      .string()
      .optional()
      .describe('Display ticket ID — required when action is "cancel".'),
    cancelReason: z
      .string()
      .optional()
      .describe('Reason for cancellation — required when action is "cancel".')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const user: any = await User.get();
      const userId: string | undefined = user?._luaProfile?.userId ?? user?.id;

      // Tenant id comes from cached identity (set by get_user_context).
      const tenantId: string | undefined =
        user?.tenantId ?? (user?.userType === 'tenant' ? user?.identityId : undefined);

      if (!tenantId) {
        return {
          success: false,
          error: 'not_a_tenant',
          message:
            'I could not find a tenant identity on this session. Please call get_user_context first or provide your phone/email.'
        };
      }

      if (input.action === 'list') {
        const res: any = await Tickets.get({ tenantId }, 1, 200);
        const rows: any[] = res?.data ?? [];
        const tickets = rows
          .map((r) => summarize(r.data ?? {}))
          .sort((a, b) => {
            const ta = new Date(a.createdAt ?? 0).getTime();
            const tb = new Date(b.createdAt ?? 0).getTime();
            return tb - ta;
          });

        return {
          success: true,
          action: 'list' as const,
          tickets,
          count: tickets.length,
          message:
            tickets.length > 0
              ? `Found ${tickets.length} ticket(s) for you.`
              : 'You have no maintenance tickets on file.'
        };
      }

      // action === 'cancel'
      const { ticketId, cancelReason } = input;
      if (!ticketId) {
        return {
          success: false,
          error: 'missing_ticket_id',
          message: 'ticketId is required to cancel a ticket.'
        };
      }
      if (!cancelReason || !cancelReason.trim()) {
        return {
          success: false,
          error: 'missing_reason',
          message: 'A cancellation reason is required.'
        };
      }

      const lookup: any = await Tickets.get({ ticketId }, 1, 1);
      const entry: any = lookup?.data?.[0];
      if (!entry) {
        return {
          success: false,
          error: 'ticket_not_found',
          message: `Ticket ${ticketId} not found.`
        };
      }

      const current = entry.data ?? {};

      // Ownership check
      if (current.tenantId && current.tenantId !== tenantId) {
        return {
          success: false,
          error: 'forbidden',
          message: `Ticket ${ticketId} does not belong to you.`
        };
      }

      if (NON_CANCELLABLE.includes(current.status)) {
        return {
          success: false,
          error: 'not_cancellable',
          status: current.status,
          message: `Ticket ${ticketId} is ${current.status} and cannot be cancelled. Please contact support if you need help.`
        };
      }

      const previousStatus = current.status as TicketStatus;
      const cancelledAt = new Date().toISOString();

      await Tickets.update(entry.id, {
        ...current,
        status: TicketStatus.CANCELLED,
        cancelledBy: 'tenant',
        cancelledAt,
        cancelReason,
        updatedAt: cancelledAt
      });

      await logStatusChange({
        ticketId,
        ticketDataId: entry.id,
        fromStatus: previousStatus,
        toStatus: TicketStatus.CANCELLED,
        actorType: ActorType.TENANT,
        actorId: userId,
        reason: cancelReason
      });

      await logEvent({
        ticketId,
        ticketDataId: entry.id,
        eventType: EventType.TICKET_CANCELLED,
        actorType: ActorType.TENANT,
        actorId: userId,
        payload: { cancelReason, previousStatus }
      });

      return {
        success: true,
        action: 'cancel' as const,
        ticketId,
        status: TicketStatus.CANCELLED,
        message: `Ticket ${ticketId} cancelled. Reason: ${cancelReason}`
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message ?? String(err),
        message: 'Failed to process my_tickets request.'
      };
    }
  }
}

export default MyTicketsTool;
