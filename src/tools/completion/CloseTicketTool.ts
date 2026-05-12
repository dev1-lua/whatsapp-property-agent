/**
 * Close a ticket. Allowed only when:
 *   - status=COMPLETED and tenantSatisfied===true, OR
 *   - manager override is provided, OR
 *   - status=CANCELLED already (terminal-to-terminal soft-close passthrough).
 * Sets ticket.closure and status=CLOSED.
 */

import { LuaTool, User } from 'lua-cli';
import { z } from 'zod';
import { Tickets } from '../../services/data.js';
import {
  TicketStatus,
  ActorType,
  EventType
} from '../../utils/constants.js';
import { canTransition } from '../../utils/ticket-helpers.js';
import { logEvent, logStatusChange } from '../../utils/audit-log.js';

export class CloseTicketTool implements LuaTool {
  name = 'close_ticket';
  description = 'Close a maintenance ticket. Requires status=completed with tenantSatisfied=true, OR a manager override, OR status=cancelled. Sets the closure record and final status.';

  inputSchema = z.object({
    ticketId: z.string().describe('Display ticket ID, e.g. MT-2605-A8F2K9'),
    closeReason: z.string().describe('Reason / notes for closing the ticket'),
    override: z.object({
      manager: z.string().describe('Name of the manager authorizing the override'),
      reason: z.string().describe('Justification for closing without tenant confirmation')
    }).optional().describe('Optional manager override to close without tenant confirmation')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const { ticketId, closeReason, override } = input;

      const result = await Tickets.get({ ticketId });
      const entry = result?.data?.[0];
      const ticket: any = entry?.data;

      if (!entry || !ticket) {
        return {
          success: false,
          error: 'ticket_not_found',
          message: `Ticket ${ticketId} not found.`
        };
      }

      const currentStatus = ticket.status as TicketStatus;

      // Eligibility check
      const cancelledSoftClose = currentStatus === TicketStatus.CANCELLED;
      const completedSatisfied =
        currentStatus === TicketStatus.COMPLETED && ticket.tenantSatisfied === true;
      const completedOverride = currentStatus === TicketStatus.COMPLETED && !!override;

      if (!cancelledSoftClose && !completedSatisfied && !completedOverride) {
        return {
          success: false,
          error: 'not_closable',
          message: `Cannot close ticket in '${currentStatus}' status. Must be completed with tenant satisfaction, or cancelled, or have a manager override.`
        };
      }

      // For non-cancelled tickets, validate state-machine transition COMPLETED → CLOSED
      if (!cancelledSoftClose && !canTransition(currentStatus, TicketStatus.CLOSED)) {
        return {
          success: false,
          error: 'invalid_transition',
          message: `Invalid transition from '${currentStatus}' to closed.`
        };
      }

      // Cancelled tickets are terminal per VALID_TRANSITIONS; we soft-record closure
      // metadata but keep status as CANCELLED to honor the state machine. The tool
      // still reports success because the user-intent is "this ticket is done".
      const user = await User.get();
      const userId = user?._luaProfile?.userId ?? user?.id;
      const now = new Date().toISOString();
      const closedBy = override?.manager ?? (user?._luaProfile as any)?.name ?? 'agent';

      const closure = {
        closedBy,
        closedAt: now,
        closeReason,
        override: override ? { manager: override.manager, reason: override.reason } : undefined
      };

      const newStatus = cancelledSoftClose ? TicketStatus.CANCELLED : TicketStatus.CLOSED;

      await Tickets.update(entry.id, {
        ...ticket,
        status: newStatus,
        closure,
        updatedAt: now
      });

      if (!cancelledSoftClose) {
        await logStatusChange({
          ticketId,
          ticketDataId: entry.id,
          fromStatus: currentStatus,
          toStatus: TicketStatus.CLOSED,
          actorType: override ? ActorType.MANAGER : ActorType.AGENT,
          actorId: userId,
          actorName: closedBy,
          reason: override ? `Manager override: ${override.reason}` : closeReason
        });
      }

      await logEvent({
        ticketId,
        ticketDataId: entry.id,
        eventType: EventType.TICKET_CLOSED,
        actorType: override ? ActorType.MANAGER : ActorType.AGENT,
        actorId: userId,
        actorName: closedBy,
        payload: {
          closeReason,
          override: override ?? null,
          softCloseOnCancelled: cancelledSoftClose
        }
      });

      return {
        success: true,
        ticketId,
        closedAt: now,
        message: cancelledSoftClose
          ? `Ticket ${ticketId} was already cancelled; closure record stamped.`
          : `Ticket ${ticketId} closed by ${closedBy}${override ? ' (manager override)' : ''}.`
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message ?? String(err),
        message: 'Failed to close ticket.'
      };
    }
  }
}

export default CloseTicketTool;
