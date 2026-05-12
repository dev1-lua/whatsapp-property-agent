/**
 * Create a new escalation entry for a ticket and notify the manager via email.
 * Stamps `ticket.escalatedAt` and audits the action.
 */

import { LuaTool, env } from 'lua-cli';
import { z } from 'zod';
import { Tickets, Escalations } from '../../services/data.js';
import {
  ActorType,
  EventType,
  EscalationType,
  EscalationStatus
} from '../../utils/constants.js';
import { logEvent } from '../../utils/audit-log.js';
import { sendEmail } from '../../utils/email-notifications.js';
import { escalationNotificationEmail } from '../../utils/email-templates.js';

export class EscalateTicketTool implements LuaTool {
  name = 'escalate_ticket';
  description = 'Create an escalation for a maintenance ticket that needs manager attention (vendor no-response, SLA breach, cost overrun, dispute, etc). Notifies the manager via email.';

  inputSchema = z.object({
    ticketId: z.string().describe('Display ticket ID, e.g. MT-2605-A8F2K9'),
    escalationType: z.string().describe('Type of escalation — one of: approval_delay, vendor_no_response, sla_breach, cost_overrun, dispute_raised, stale_ticket, vendor_declined, unhandled_scenario'),
    reason: z.string().describe('Detailed reason for the escalation'),
    severity: z.string().optional().describe('Optional severity level (defaults to medium) — one of: low, medium, high')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const { ticketId, escalationType, reason, severity } = input;

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

      const now = new Date().toISOString();
      const managerEmail = env('MANAGER_EMAIL') || 'manager@example.com';

      // Create escalation record
      const escalationData = {
        ticketId,
        escalationType,
        status: EscalationStatus.OPEN,
        reason,
        severity: severity ?? 'medium',
        createdBy: ActorType.AGENT,
        createdAt: now,
        assignedTo: managerEmail
      };
      const created = await Escalations.create(
        escalationData,
        `${escalationType} ${ticketId} ${reason}`
      );
      const escalationId = created?.id ?? null;

      // Stamp ticket
      await Tickets.update(entry.id, {
        ...ticket,
        escalatedAt: now,
        updatedAt: now
      });

      // Audit
      await logEvent({
        ticketId,
        ticketDataId: entry.id,
        eventType: EventType.ESCALATION_CREATED,
        actorType: ActorType.AGENT,
        payload: {
          escalationId,
          escalationType,
          reason,
          severity: severity ?? 'medium',
          assignedTo: managerEmail
        }
      });

      // Notify manager
      try {
        const emailData = escalationNotificationEmail({
          ticketId,
          escalationType,
          reason,
          urgency: severity ?? ticket.urgency ?? 'medium',
          propertyName: ticket.propertyName ?? ticket.propertyCode ?? 'Unknown property',
          vendorName: ticket.assignedVendorName ?? 'N/A',
          currentStatus: ticket.status ?? 'unknown',
          tenantName: ticket.tenantName ?? 'Unknown tenant'
        });
        await sendEmail({
          to: managerEmail,
          subject: emailData.subject,
          html: emailData.html,
          text: emailData.body,
          ticketId
        });
      } catch (err: any) {
        console.error('escalate_ticket: email send failed (non-fatal):', err?.message);
      }

      return {
        success: true,
        escalationId,
        ticketId,
        assignedTo: managerEmail,
        message: `Escalation ${escalationId ?? ''} created for ticket ${ticketId} (${escalationType}). Notified ${managerEmail}.`
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message ?? String(err),
        message: 'Failed to create escalation.'
      };
    }
  }
}

export default EscalateTicketTool;
