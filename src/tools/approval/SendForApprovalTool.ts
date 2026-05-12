/**
 * Send a quoted ticket to finance for approval. Updates ticket status to
 * `pending_approval`, stamps `approval.requestedAt`, emails `APPROVER_EMAIL`
 * with the quote details, and writes audit events.
 */

import { LuaTool, User, env } from 'lua-cli';
import { z } from 'zod';
import { Tickets } from '../../services/data.js';
import {
  TicketStatus,
  ActorType,
  EventType
} from '../../utils/constants.js';
import { canTransition } from '../../utils/ticket-helpers.js';
import { logEvent, logStatusChange } from '../../utils/audit-log.js';
import { sendEmail } from '../../utils/email-notifications.js';
import { approvalRequestEmail } from '../../utils/email-templates.js';

export class SendForApprovalTool implements LuaTool {
  name = 'send_for_approval';
  description = 'Submit a quoted maintenance ticket for finance approval. Sets status to pending_approval, stamps the approval request time, and emails the approver with quote details.';

  inputSchema = z.object({
    ticketId: z.string().describe('Display ticket ID, e.g. MT-2605-A8F2K9'),
    justification: z.string().optional().describe('Optional business justification shown to the approver')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const { ticketId, justification } = input;

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
      if (!canTransition(currentStatus, TicketStatus.PENDING_APPROVAL)) {
        return {
          success: false,
          error: 'invalid_transition',
          message: `Cannot send for approval from '${currentStatus}'. Ticket must be in a state that allows transition to pending_approval.`
        };
      }

      const amount = ticket.estimatedCost ?? ticket.quote?.amount;
      if (amount === undefined || amount === null) {
        return {
          success: false,
          error: 'no_quote',
          message: `Ticket ${ticketId} has no quote/estimated cost. Record a vendor quote first.`
        };
      }

      const now = new Date().toISOString();
      const approverEmail = env('APPROVER_EMAIL') || 'finance@example.com';

      // Update ticket
      const updatedApproval = {
        ...(ticket.approval ?? {}),
        required: true,
        requestedAt: now,
        approvedBy: ticket.approval?.approvedBy ?? null,
        approvedAt: ticket.approval?.approvedAt ?? null,
        approvedAmount: ticket.approval?.approvedAmount ?? null,
        comments: justification ?? ticket.approval?.comments ?? null,
        conditions: ticket.approval?.conditions ?? [],
        externalRequestId: ticket.approval?.externalRequestId ?? null
      };

      await Tickets.update(entry.id, {
        ...ticket,
        status: TicketStatus.PENDING_APPROVAL,
        approval: updatedApproval,
        updatedAt: now
      });

      // Audit
      const user = await User.get();
      const userId = user?._luaProfile?.userId ?? user?.id;

      await logStatusChange({
        ticketId,
        ticketDataId: entry.id,
        fromStatus: currentStatus,
        toStatus: TicketStatus.PENDING_APPROVAL,
        actorType: ActorType.AGENT,
        actorId: userId,
        reason: justification ? `Sent for approval: ${justification}` : 'Sent for approval'
      });

      await logEvent({
        ticketId,
        ticketDataId: entry.id,
        eventType: EventType.APPROVAL_REQUESTED,
        actorType: ActorType.AGENT,
        actorId: userId,
        payload: {
          amount,
          approverEmail,
          justification: justification ?? null
        }
      });

      // Email approver
      try {
        const emailData = approvalRequestEmail({
          ticketId,
          vendorName: ticket.assignedVendorName ?? 'N/A',
          amount: Number(amount),
          currency: ticket.quote?.currency ?? 'EUR',
          scopeNotes: ticket.quote?.scopeNotes ?? ticket.description ?? '',
          propertyName: ticket.propertyName ?? ticket.propertyCode ?? ''
        });
        await sendEmail({
          to: approverEmail,
          subject: emailData.subject,
          html: emailData.html,
          ticketId
        });
      } catch (err: any) {
        console.error('send_for_approval: email send failed (non-fatal):', err?.message);
      }

      return {
        success: true,
        ticketId,
        sentAt: now,
        approverEmail,
        message: `Approval request for ticket ${ticketId} sent to ${approverEmail}. Awaiting finance decision.`
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message ?? String(err),
        message: 'Failed to send ticket for approval.'
      };
    }
  }
}

export default SendForApprovalTool;
