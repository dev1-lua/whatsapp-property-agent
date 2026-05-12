/**
 * submit_quote — vendor submits an initial quote.
 *
 * Writes `ticket.quote` and `ticket.estimatedCost`. If the amount is ≤ the
 * configured approval threshold (env.APPROVAL_THRESHOLD or DEFAULT_APPROVAL_THRESHOLD)
 * the ticket auto-approves; otherwise it moves to pending_approval and an
 * approval-request email is sent.
 *
 * Logs QUOTE_RECEIVED and a STATUS_CHANGED event.
 */

import { LuaTool, User, env } from 'lua-cli';
import { z } from 'zod';
import { Tickets } from '../../services/data.js';
import { logEvent, logStatusChange } from '../../utils/audit-log.js';
import {
  ActorType,
  DEFAULT_APPROVAL_THRESHOLD,
  EventType,
  TicketStatus
} from '../../utils/constants.js';
import { canTransition } from '../../utils/ticket-helpers.js';
import { sendEmail } from '../../utils/email-notifications.js';
import { approvalRequestEmail } from '../../utils/email-templates.js';

export class SubmitQuoteTool implements LuaTool {
  name = 'submit_quote';
  description = `Submits an initial quote for a maintenance job. If the amount is at or below the approval threshold the ticket auto-approves and is ready for work; otherwise it moves to pending_approval and an approval-request email is sent.`;

  inputSchema = z.object({
    ticketId: z.string().describe('Display ticket ID (e.g. MT-2605-A8F2K9)'),
    vendorId: z
      .string()
      .optional()
      .describe('Vendor entry id (falls back to the cached identity set by get_user_context)'),
    estimatedCost: z.number().positive().describe('Quote amount in the chosen currency'),
    scopeNotes: z.string().describe('Description of the work to be done'),
    currency: z.string().optional().describe('Currency code (default EUR)')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const vendorId = await resolveVendorId(input.vendorId);
      if (!vendorId) {
        return {
          success: false,
          error: 'no vendor identity',
          message: 'Could not resolve vendor identity. Call get_user_context first or pass vendorId.'
        };
      }

      const ticket = await findTicketByDisplayId(input.ticketId);
      if (!ticket) {
        return {
          success: false,
          error: 'ticket not found',
          message: `No ticket found with id ${input.ticketId}.`
        };
      }

      if (!ticket.assignedVendorId || ticket.assignedVendorId !== vendorId) {
        return {
          success: false,
          error: 'not assigned to you',
          message: 'You are not assigned to this ticket. Claim it first with claim_job.'
        };
      }

      const currentStatus = ticket.status as TicketStatus;
      const acceptableStatuses: TicketStatus[] = [
        TicketStatus.VENDOR_CONTACTED,
        TicketStatus.REJECTED
      ];
      if (!acceptableStatuses.includes(currentStatus)) {
        return {
          success: false,
          error: 'invalid status',
          message: `Cannot submit quote — ticket status is '${currentStatus}'. Expected vendor_contacted or rejected.`
        };
      }

      const threshold = Number(env('APPROVAL_THRESHOLD')) || DEFAULT_APPROVAL_THRESHOLD;
      const currency = input.currency || 'EUR';
      const now = new Date().toISOString();
      const isAutoApproved = input.estimatedCost <= threshold;
      // State machine requires vendor_contacted → quoted → (approved | pending_approval).
      // Always land at QUOTED first; auto-approval moves it forward to APPROVED.
      const targetStatus = isAutoApproved
        ? TicketStatus.APPROVED
        : TicketStatus.PENDING_APPROVAL;
      const intermediateStatus = TicketStatus.QUOTED;

      if (currentStatus !== intermediateStatus && !canTransition(currentStatus, intermediateStatus)) {
        return {
          success: false,
          error: 'invalid transition',
          message: `Cannot go from ${currentStatus} to ${intermediateStatus}.`
        };
      }
      if (!canTransition(intermediateStatus, targetStatus)) {
        return {
          success: false,
          error: 'invalid transition',
          message: `Cannot go from ${intermediateStatus} to ${targetStatus}.`
        };
      }

      const quote = {
        amount: input.estimatedCost,
        currency,
        scopeNotes: input.scopeNotes,
        submittedAt: now
      };

      const approval = isAutoApproved
        ? {
            required: false,
            requestedAt: now,
            approvedBy: 'auto',
            approvedAt: now,
            approvedAmount: input.estimatedCost,
            comments: `Auto-approved: amount (${currency}${input.estimatedCost.toFixed(2)}) ≤ threshold (${currency}${threshold.toFixed(2)})`,
            conditions: [],
            externalRequestId: null
          }
        : {
            required: true,
            requestedAt: now,
            approvedBy: null,
            approvedAt: null,
            approvedAmount: null,
            comments: null,
            conditions: [],
            externalRequestId: null
          };

      await Tickets.update(ticket.id, {
        status: targetStatus,
        estimatedCost: input.estimatedCost,
        quote,
        approval,
        updatedAt: now
      });

      await logEvent({
        ticketId: ticket.ticketId,
        ticketDataId: ticket.id,
        eventType: EventType.QUOTE_RECEIVED,
        actorType: ActorType.VENDOR,
        actorId: vendorId,
        actorName: ticket.assignedVendorName,
        payload: {
          amount: input.estimatedCost,
          currency,
          scopeNotes: input.scopeNotes,
          threshold,
          autoApproved: isAutoApproved,
          requiresApproval: !isAutoApproved
        }
      });

      await logStatusChange({
        ticketId: ticket.ticketId,
        ticketDataId: ticket.id,
        fromStatus: currentStatus,
        toStatus: targetStatus,
        actorType: ActorType.VENDOR,
        actorId: vendorId,
        actorName: ticket.assignedVendorName,
        reason: isAutoApproved
          ? `Quote ${currency}${input.estimatedCost} — auto-approved (≤ ${currency}${threshold})`
          : `Quote ${currency}${input.estimatedCost} — pending approval`
      });

      // Approval request email if needed
      if (!isAutoApproved) {
        const approverEmail = env('APPROVER_EMAIL');
        if (approverEmail) {
          try {
            const tpl = approvalRequestEmail({
              ticketId: ticket.ticketId,
              vendorName: ticket.assignedVendorName || 'Vendor',
              amount: input.estimatedCost,
              currency,
              scopeNotes: input.scopeNotes,
              propertyName: ticket.propertyName || ticket.propertyCode || ''
            });
            await sendEmail({
              to: approverEmail,
              subject: tpl.subject,
              html: tpl.html,
              ticketId: ticket.ticketId
            });
          } catch (e) {
            console.error('approval email failed (non-fatal):', e);
          }
        }
      }

      return {
        success: true,
        ticketId: ticket.ticketId,
        requiresApproval: !isAutoApproved,
        autoApproved: isAutoApproved,
        message: isAutoApproved
          ? `Quote of ${currency}${input.estimatedCost} submitted and auto-approved (within ${currency}${threshold} threshold). You can start work.`
          : `Quote of ${currency}${input.estimatedCost} submitted. Awaiting finance approval.`
      };
    } catch (err: any) {
      console.error('submit_quote error:', err);
      return {
        success: false,
        error: 'unexpected',
        message: `Could not submit quote: ${err?.message ?? 'unknown error'}`
      };
    }
  }
}

async function resolveVendorId(provided?: string): Promise<string | null> {
  if (provided) return provided;
  try {
    const u: any = await User.get();
    if (u?.userType === 'vendor' && u?.identityId) return u.identityId;
    if (u?.vendorId) return u.vendorId;
    return null;
  } catch {
    return null;
  }
}

async function findTicketByDisplayId(displayId: string): Promise<any | null> {
  const res: any = await Tickets.get({ ticketId: displayId }).catch(() => ({ data: [] }));
  const entry = (res?.data ?? [])[0];
  if (!entry) return null;
  return { id: entry.id, ...(entry.data ?? entry) };
}

export default SubmitQuoteTool;
