/**
 * submit_revised_quote — vendor revises an existing quote.
 *
 * Auto-approves if the new amount is ≤ the previously approved amount,
 * otherwise resets approval and moves to pending_approval. Logs
 * REVISED_QUOTE_SUBMITTED + status change.
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

export class SubmitRevisedQuoteTool implements LuaTool {
  name = 'submit_revised_quote';
  description = `Submits a revised quote for a job. If the new amount is at or below the previously approved amount it auto-approves immediately; otherwise it returns to pending_approval for finance review.`;

  inputSchema = z.object({
    ticketId: z.string().describe('Display ticket ID (e.g. MT-2605-A8F2K9)'),
    vendorId: z
      .string()
      .optional()
      .describe('Vendor entry id (falls back to the cached identity set by get_user_context)'),
    estimatedCost: z.number().positive().describe('Revised total quote amount'),
    scopeNotes: z.string().describe('Updated description of the work to be done'),
    revisionReason: z.string().describe('Why the quote changed (e.g. corroded pipe found behind wall)'),
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
          message: 'You are not assigned to this ticket.'
        };
      }

      const currentStatus = ticket.status as TicketStatus;
      const allowedStatuses: TicketStatus[] = [
        TicketStatus.APPROVED,
        TicketStatus.IN_PROGRESS,
        TicketStatus.REJECTED
      ];
      if (!allowedStatuses.includes(currentStatus)) {
        return {
          success: false,
          error: 'invalid status',
          message: `Cannot submit revised quote — ticket status is '${currentStatus}'. Expected approved, in_progress, or rejected.`
        };
      }

      const currency = input.currency || ticket.quote?.currency || 'EUR';
      const threshold = Number(env('APPROVAL_THRESHOLD')) || DEFAULT_APPROVAL_THRESHOLD;
      const now = new Date().toISOString();
      const previouslyApproved: number = ticket.approval?.approvedAmount ?? 0;
      const originalAmount: number = ticket.quote?.amount ?? ticket.estimatedCost ?? 0;

      // Auto-approve only if: previously approved exists, new ≤ approved, and
      // not coming back from a REJECTED status (rejection always re-routes).
      const canAutoApprove =
        currentStatus !== TicketStatus.REJECTED &&
        previouslyApproved > 0 &&
        input.estimatedCost <= previouslyApproved;

      const targetStatus = canAutoApprove ? TicketStatus.APPROVED : TicketStatus.PENDING_APPROVAL;

      if (currentStatus !== targetStatus && !canTransition(currentStatus, targetStatus)) {
        return {
          success: false,
          error: 'invalid transition',
          message: `Cannot go from ${currentStatus} to ${targetStatus}.`
        };
      }

      const revisedQuote = {
        amount: input.estimatedCost,
        currency,
        scopeNotes: input.scopeNotes,
        submittedAt: ticket.quote?.submittedAt ?? now,
        revisedAt: now,
        revisionReason: input.revisionReason
      };

      const approval = canAutoApprove
        ? {
            required: false,
            requestedAt: ticket.approval?.requestedAt ?? now,
            approvedBy: 'auto',
            approvedAt: now,
            approvedAmount: input.estimatedCost,
            comments: `Auto-approved revised quote: ${currency}${input.estimatedCost.toFixed(2)} ≤ previously approved ${currency}${previouslyApproved.toFixed(2)}`,
            conditions: [],
            externalRequestId: ticket.approval?.externalRequestId ?? null
          }
        : {
            required: true,
            requestedAt: now,
            approvedBy: null,
            approvedAt: null,
            approvedAmount: null,
            comments: null,
            conditions: [],
            externalRequestId: ticket.approval?.externalRequestId ?? null
          };

      await Tickets.update(ticket.id, {
        status: targetStatus,
        estimatedCost: input.estimatedCost,
        quote: revisedQuote,
        approval,
        updatedAt: now
      });

      await logEvent({
        ticketId: ticket.ticketId,
        ticketDataId: ticket.id,
        eventType: EventType.REVISED_QUOTE_SUBMITTED,
        actorType: ActorType.VENDOR,
        actorId: vendorId,
        actorName: ticket.assignedVendorName,
        payload: {
          revisedAmount: input.estimatedCost,
          previouslyApproved,
          originalAmount,
          currency,
          scopeNotes: input.scopeNotes,
          revisionReason: input.revisionReason,
          autoApproved: canAutoApprove,
          requiresReapproval: !canAutoApprove,
          previousStatus: currentStatus
        }
      });

      if (currentStatus !== targetStatus) {
        await logStatusChange({
          ticketId: ticket.ticketId,
          ticketDataId: ticket.id,
          fromStatus: currentStatus,
          toStatus: targetStatus,
          actorType: ActorType.VENDOR,
          actorId: vendorId,
          actorName: ticket.assignedVendorName,
          reason: canAutoApprove
            ? `Revised quote ${currency}${input.estimatedCost} ≤ approved ${currency}${previouslyApproved} — auto-approved`
            : `Revised quote ${currency}${input.estimatedCost} (reason: ${input.revisionReason})`
        });
      }

      // Approval request email if re-routing
      if (!canAutoApprove) {
        const approverEmail = env('APPROVER_EMAIL');
        if (approverEmail) {
          try {
            const tpl = approvalRequestEmail({
              ticketId: ticket.ticketId,
              vendorName: ticket.assignedVendorName || 'Vendor',
              amount: input.estimatedCost,
              currency,
              scopeNotes: `${input.scopeNotes} — REVISION: ${input.revisionReason}`,
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

      // unused but referenced earlier — keeps threshold imported for env consistency.
      void threshold;

      return {
        success: true,
        ticketId: ticket.ticketId,
        autoApproved: canAutoApprove,
        requiresReapproval: !canAutoApprove,
        message: canAutoApprove
          ? `Revised quote ${currency}${input.estimatedCost} auto-approved (within previously approved ${currency}${previouslyApproved}). You can continue work.`
          : `Revised quote ${currency}${input.estimatedCost} submitted (was ${currency}${originalAmount}). Awaiting finance re-approval.`
      };
    } catch (err: any) {
      console.error('submit_revised_quote error:', err);
      return {
        success: false,
        error: 'unexpected',
        message: `Could not submit revised quote: ${err?.message ?? 'unknown error'}`
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

export default SubmitRevisedQuoteTool;
