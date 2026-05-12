/**
 * Ask the tenant to confirm work completion. Tries `User.send` when we have
 * `tenantUserId`; otherwise falls back to `sendEmail`. Stamps
 * ticket.confirmationRequested.
 */

import { LuaTool, User } from 'lua-cli';
import { z } from 'zod';
import { Tickets } from '../../services/data.js';
import { ActorType, EventType } from '../../utils/constants.js';
import { logEvent } from '../../utils/audit-log.js';
import { sendEmail } from '../../utils/email-notifications.js';
import { logCommunication } from '../../utils/communication-log.js';

export class RequestTenantConfirmationTool implements LuaTool {
  name = 'request_tenant_confirmation';
  description = 'Send a confirmation request to the tenant asking whether the completed work is satisfactory. Uses in-app messaging when the tenant userId is known, otherwise falls back to email.';

  inputSchema = z.object({
    ticketId: z.string().describe('Display ticket ID, e.g. MT-2605-A8F2K9'),
    message: z.string().optional().describe('Optional custom message to include with the confirmation request')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const { ticketId, message } = input;

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

      const confirmationMessage = message ??
        `The maintenance work for ticket ${ticketId} has been marked complete. Could you confirm whether the work was done to your satisfaction? Reply "yes" if all good, or let us know if there are any issues.`;

      const now = new Date().toISOString();
      let deliveryMethod: 'in-app' | 'email' | 'none' = 'none';

      // Try in-app message first
      if (ticket.tenantUserId) {
        try {
          const tenant = await User.get(ticket.tenantUserId);
          if (tenant) {
            await tenant.send([{ type: 'text', text: confirmationMessage }]);
            deliveryMethod = 'in-app';
            await logCommunication({
              ticketId,
              direction: 'Outbound',
              channel: 'Chat',
              senderType: 'Agent',
              senderName: 'Property Maintenance Agent',
              recipient: ticket.tenantUserId,
              subject: `Ticket ${ticketId} — please confirm completion`,
              body: confirmationMessage,
              contentType: 'Plain Text',
              delivery: 'sent'
            });
          }
        } catch (err: any) {
          console.error('request_tenant_confirmation: User.send failed, will fall back to email:', err?.message);
        }
      }

      // Fall back to email
      if (deliveryMethod === 'none' && ticket.tenantEmail) {
        try {
          await sendEmail({
            to: ticket.tenantEmail,
            subject: `Ticket ${ticketId} — please confirm completion`,
            text: confirmationMessage,
            ticketId
          });
          deliveryMethod = 'email';
        } catch (err: any) {
          console.error('request_tenant_confirmation: email send failed:', err?.message);
        }
      }

      if (deliveryMethod === 'none') {
        return {
          success: false,
          error: 'no_contact_method',
          message: `Cannot reach tenant for ticket ${ticketId}: no userId and no email on file.`
        };
      }

      // Stamp the ticket
      await Tickets.update(entry.id, {
        ...ticket,
        confirmationRequested: now,
        updatedAt: now
      });

      // Audit
      await logEvent({
        ticketId,
        ticketDataId: entry.id,
        eventType: EventType.TICKET_UPDATED,
        actorType: ActorType.AGENT,
        payload: {
          action: 'confirmation_requested',
          deliveryMethod
        }
      });

      return {
        success: true,
        ticketId,
        sentAt: now,
        message: `Confirmation request sent to tenant via ${deliveryMethod} for ticket ${ticketId}.`
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message ?? String(err),
        message: 'Failed to send tenant confirmation request.'
      };
    }
  }
}

export default RequestTenantConfirmationTool;
