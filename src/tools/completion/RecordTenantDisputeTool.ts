/**
 * Record a tenant-raised dispute on a completed ticket. Transitions status to
 * DISPUTED, creates a `dispute_raised` escalation entry, and audits.
 */

import { LuaTool, User } from 'lua-cli';
import { z } from 'zod';
import { Tickets, Escalations } from '../../services/data.js';
import {
  TicketStatus,
  ActorType,
  EventType,
  EscalationType,
  EscalationStatus
} from '../../utils/constants.js';
import { canTransition } from '../../utils/ticket-helpers.js';
import { logEvent, logStatusChange } from '../../utils/audit-log.js';

export class RecordTenantDisputeTool implements LuaTool {
  name = 'record_tenant_dispute';
  description = 'Record a tenant dispute against a completed maintenance ticket. Transitions ticket to disputed status and creates an escalation entry of type dispute_raised.';

  inputSchema = z.object({
    ticketId: z.string().describe('Display ticket ID, e.g. MT-2605-A8F2K9'),
    disputeReason: z.string().describe('Reason for the dispute (e.g. work quality issue, cost disagreement)'),
    severity: z.string().optional().describe('Optional severity level for the dispute — one of: low, medium, high')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const { ticketId, disputeReason, severity } = input;

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
      if (!canTransition(currentStatus, TicketStatus.DISPUTED)) {
        return {
          success: false,
          error: 'invalid_transition',
          message: `Cannot dispute ticket in '${currentStatus}' status. Only completed tickets can be disputed.`
        };
      }

      const now = new Date().toISOString();

      // Update ticket
      await Tickets.update(entry.id, {
        ...ticket,
        status: TicketStatus.DISPUTED,
        dispute: {
          reason: disputeReason,
          severity: severity ?? 'medium',
          raisedAt: now
        },
        updatedAt: now
      });

      // Create escalation
      const escalationData = {
        ticketId,
        escalationType: EscalationType.DISPUTE_RAISED,
        status: EscalationStatus.OPEN,
        reason: disputeReason,
        severity: severity ?? 'medium',
        createdBy: ActorType.TENANT,
        createdAt: now
      };
      const created = await Escalations.create(
        escalationData,
        `dispute ${ticketId} ${disputeReason}`
      );
      const escalationId = created?.id ?? null;

      const user = await User.get();
      const userId = user?._luaProfile?.userId ?? user?.id;

      await logStatusChange({
        ticketId,
        ticketDataId: entry.id,
        fromStatus: currentStatus,
        toStatus: TicketStatus.DISPUTED,
        actorType: ActorType.TENANT,
        actorId: userId,
        reason: `Dispute raised: ${disputeReason}`
      });

      await logEvent({
        ticketId,
        ticketDataId: entry.id,
        eventType: EventType.DISPUTE_RAISED,
        actorType: ActorType.TENANT,
        actorId: userId,
        payload: {
          disputeReason,
          severity: severity ?? 'medium',
          escalationId
        }
      });

      return {
        success: true,
        ticketId,
        escalationId,
        message: `Dispute recorded on ticket ${ticketId}. Status set to disputed, escalation ${escalationId ?? '(unknown id)'} created for manager review.`
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message ?? String(err),
        message: 'Failed to record tenant dispute.'
      };
    }
  }
}

export default RecordTenantDisputeTool;
