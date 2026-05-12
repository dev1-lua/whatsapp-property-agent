/**
 * escalation-response webhook — inbound when a manager updates an escalation
 * (in_review / resolved / closed). If the escalation is being resolved AND
 * its linked ticket is DISPUTED, we move the ticket back to COMPLETED so the
 * normal closure path can resume.
 *
 * Body:
 *   {
 *     escalationId: string,
 *     status: 'in_review' | 'resolved' | 'closed',
 *     resolution?: string,
 *     resolutionBy: string
 *   }
 *
 * Response:
 *   { success: true, escalationId, status, message, ticketUpdated? }
 *   { success: false, error, message }
 */

import { LuaWebhook } from 'lua-cli';
import { Escalations, Tickets } from '../services/data.js';
import {
  EscalationStatus,
  TicketStatus,
  ActorType,
  EventType
} from '../utils/constants.js';
import { logEvent, logStatusChange } from '../utils/audit-log.js';
import { canTransition } from '../utils/ticket-helpers.js';

const VALID_STATUSES = new Set<string>([
  EscalationStatus.IN_REVIEW,
  EscalationStatus.RESOLVED,
  EscalationStatus.CLOSED
]);

export default new LuaWebhook({
  name: 'escalation-response',
  description:
    'Update an escalation status (in_review / resolved / closed). On resolved, un-dispute the linked ticket if needed.',
  execute: async (event) => {
    const body: any = event?.body ?? {};
    const { escalationId, status, resolution, resolutionBy } = body;

    if (!escalationId) {
      return { success: false, error: 'validation', message: 'Missing escalationId' };
    }
    if (!status || !VALID_STATUSES.has(String(status))) {
      return {
        success: false,
        error: 'validation',
        message: `Invalid status '${status}'. Expected one of: in_review, resolved, closed`
      };
    }
    if (!resolutionBy) {
      return { success: false, error: 'validation', message: 'Missing resolutionBy' };
    }

    try {
      const entry: any = await Escalations.getEntry(escalationId).catch(() => null);
      if (!entry) {
        return {
          success: false,
          error: 'not_found',
          message: `Escalation ${escalationId} not found.`
        };
      }

      const current: any = entry.data ?? entry;
      const now = new Date().toISOString();

      const updated: Record<string, any> = {
        ...current,
        status,
        updatedAt: now
      };

      if (status === EscalationStatus.RESOLVED || status === EscalationStatus.CLOSED) {
        updated.resolution = resolution ?? current.resolution ?? null;
        updated.resolutionBy = resolutionBy;
        updated.resolvedAt = now;
      }

      await Escalations.update(escalationId, updated);

      // Audit event tied to the linked ticket if we have one
      if (current.ticketId) {
        await logEvent({
          ticketId: current.ticketId,
          ticketDataId: current.ticketDataId,
          eventType:
            status === EscalationStatus.RESOLVED
              ? EventType.ESCALATION_RESOLVED
              : EventType.TICKET_UPDATED,
          actorType: ActorType.MANAGER,
          actorName: resolutionBy,
          payload: {
            escalationId,
            escalationType: current.escalationType ?? null,
            newStatus: status,
            resolution: resolution ?? null
          }
        });
      }

      // On resolution, if linked ticket is DISPUTED, push it back to COMPLETED
      let ticketUpdated: { ticketId: string; fromStatus: string; toStatus: string } | null = null;
      if (status === EscalationStatus.RESOLVED && current.ticketId) {
        try {
          const tRes: any = await Tickets.get({ ticketId: current.ticketId });
          const tEntry: any = tRes?.data?.[0];
          const ticket: any = tEntry?.data;

          if (tEntry && ticket?.status === TicketStatus.DISPUTED) {
            const target = TicketStatus.COMPLETED;
            if (canTransition(TicketStatus.DISPUTED, target)) {
              await Tickets.update(tEntry.id, {
                ...ticket,
                status: target,
                updatedAt: now
              });

              await logStatusChange({
                ticketId: ticket.ticketId,
                ticketDataId: tEntry.id,
                fromStatus: TicketStatus.DISPUTED,
                toStatus: target,
                actorType: ActorType.MANAGER,
                actorName: resolutionBy,
                reason: `Escalation ${escalationId} resolved by ${resolutionBy}`
              });

              ticketUpdated = {
                ticketId: ticket.ticketId,
                fromStatus: TicketStatus.DISPUTED,
                toStatus: target
              };
            }
          }
        } catch (innerErr: any) {
          console.error('escalation-response: failed to update linked ticket:', innerErr);
        }
      }

      return {
        success: true,
        escalationId,
        status,
        ticketUpdated,
        message: `Escalation ${escalationId} marked ${status} by ${resolutionBy}.`
      };
    } catch (err: any) {
      console.error('escalation-response webhook error:', err);
      return {
        success: false,
        error: 'unexpected',
        message: err?.message || 'Failed to update escalation'
      };
    }
  }
});
