/**
 * Record a vendor's quote against a ticket. Sets ticket.quote and
 * estimatedCost, transitions to QUOTED. If amount > APPROVAL_THRESHOLD,
 * inline-triggers the send-for-approval flow.
 */

import { LuaTool, User, env } from 'lua-cli';
import { z } from 'zod';
import { Tickets } from '../../services/data.js';
import {
  TicketStatus,
  ActorType,
  EventType,
  DEFAULT_APPROVAL_THRESHOLD
} from '../../utils/constants.js';
import { canTransition } from '../../utils/ticket-helpers.js';
import { logEvent, logStatusChange } from '../../utils/audit-log.js';
import { sendEmail } from '../../utils/email-notifications.js';
import { approvalRequestEmail } from '../../utils/email-templates.js';

export class RecordVendorQuoteTool implements LuaTool {
  name = 'record_vendor_quote';
  description = "Record a vendor's quote on a ticket (used when the quote comes in out-of-band, not via the vendor skill). Transitions to quoted, and auto-sends for approval if the amount exceeds the configured threshold.";

  inputSchema = z.object({
    ticketId: z.string().describe('Display ticket ID, e.g. MT-2605-A8F2K9'),
    vendorId: z.string().describe('Data entry id of the quoting vendor'),
    amount: z.number().positive().describe('Quoted amount in firm currency'),
    currency: z.string().optional().describe('Three-letter ISO currency code (default EUR)'),
    scopeNotes: z.string().describe('Vendor description of the work scope covered by the quote')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const { ticketId, vendorId, amount, currency, scopeNotes } = input;

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
      if (!canTransition(currentStatus, TicketStatus.QUOTED)) {
        return {
          success: false,
          error: 'invalid_transition',
          message: `Cannot record quote from '${currentStatus}'. Ticket must be vendor_contacted.`
        };
      }

      const now = new Date().toISOString();
      const quote = {
        amount,
        currency: currency ?? 'EUR',
        scopeNotes,
        submittedAt: now,
        vendorId
      };

      // Step 1 — transition to QUOTED with quote attached
      await Tickets.update(entry.id, {
        ...ticket,
        status: TicketStatus.QUOTED,
        quote,
        estimatedCost: amount,
        updatedAt: now
      });

      const user = await User.get();
      const userId = user?._luaProfile?.userId ?? user?.id;

      await logStatusChange({
        ticketId,
        ticketDataId: entry.id,
        fromStatus: currentStatus,
        toStatus: TicketStatus.QUOTED,
        actorType: ActorType.AGENT,
        actorId: userId,
        reason: `Quote recorded: ${quote.currency}${amount}`
      });

      await logEvent({
        ticketId,
        ticketDataId: entry.id,
        eventType: EventType.QUOTE_RECEIVED,
        actorType: ActorType.VENDOR,
        actorId: vendorId,
        payload: {
          amount,
          currency: quote.currency,
          scopeNotes
        }
      });

      // Step 2 — if over threshold, auto-send for approval inline.
      const threshold = Number(env('APPROVAL_THRESHOLD')) || DEFAULT_APPROVAL_THRESHOLD;
      let autoSentForApproval = false;

      if (amount > threshold && canTransition(TicketStatus.QUOTED, TicketStatus.PENDING_APPROVAL)) {
        const approverEmail = env('APPROVER_EMAIL') || 'finance@example.com';
        const approvalNow = new Date().toISOString();

        const updatedApproval = {
          ...(ticket.approval ?? {}),
          required: true,
          requestedAt: approvalNow,
          approvedBy: null,
          approvedAt: null,
          approvedAmount: null,
          comments: null,
          conditions: [],
          externalRequestId: null
        };

        // Refetch latest ticket fields after the previous update
        const reread = await Tickets.getEntry(entry.id);
        const latest: any = reread?.data ?? ticket;

        await Tickets.update(entry.id, {
          ...latest,
          status: TicketStatus.PENDING_APPROVAL,
          approval: updatedApproval,
          updatedAt: approvalNow
        });

        await logStatusChange({
          ticketId,
          ticketDataId: entry.id,
          fromStatus: TicketStatus.QUOTED,
          toStatus: TicketStatus.PENDING_APPROVAL,
          actorType: ActorType.AGENT,
          actorId: userId,
          reason: `Quote ${amount} exceeds threshold ${threshold}; auto-sent for approval.`
        });

        await logEvent({
          ticketId,
          ticketDataId: entry.id,
          eventType: EventType.APPROVAL_REQUESTED,
          actorType: ActorType.AGENT,
          actorId: userId,
          payload: {
            amount,
            threshold,
            approverEmail,
            triggeredBy: 'record_vendor_quote'
          }
        });

        try {
          const emailData = approvalRequestEmail({
            ticketId,
            vendorName: ticket.assignedVendorName ?? 'Vendor',
            amount,
            currency: quote.currency,
            scopeNotes,
            propertyName: ticket.propertyName ?? ticket.propertyCode ?? ''
          });
          await sendEmail({
            to: approverEmail,
            subject: emailData.subject,
            html: emailData.html,
            ticketId
          });
        } catch (err: any) {
          console.error('record_vendor_quote: approval email send failed (non-fatal):', err?.message);
        }

        autoSentForApproval = true;
      }

      return {
        success: true,
        ticketId,
        amount,
        currency: quote.currency,
        requiresApproval: autoSentForApproval,
        autoSentForApproval,
        newStatus: autoSentForApproval ? TicketStatus.PENDING_APPROVAL : TicketStatus.QUOTED,
        message: autoSentForApproval
          ? `Quote of ${quote.currency}${amount} recorded and auto-sent for finance approval (exceeds threshold of ${threshold}).`
          : `Quote of ${quote.currency}${amount} recorded for ticket ${ticketId}. Within auto-approval threshold.`
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message ?? String(err),
        message: 'Failed to record vendor quote.'
      };
    }
  }
}

export default RecordVendorQuoteTool;
