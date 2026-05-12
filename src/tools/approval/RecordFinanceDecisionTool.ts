/**
 * Record finance team's approval or rejection. Sets ticket.approval fields,
 * transitions status to APPROVED or REJECTED, and audits the decision.
 */

import { LuaTool } from 'lua-cli';
import { z } from 'zod';
import { Tickets } from '../../services/data.js';
import {
  TicketStatus,
  ActorType,
  EventType
} from '../../utils/constants.js';
import { canTransition } from '../../utils/ticket-helpers.js';
import { logEvent, logStatusChange } from '../../utils/audit-log.js';

export class RecordFinanceDecisionTool implements LuaTool {
  name = 'record_finance_decision';
  description = "Record the finance team's approve/reject decision on a pending_approval ticket. Sets approval fields and transitions status accordingly.";

  inputSchema = z.object({
    ticketId: z.string().describe('Display ticket ID, e.g. MT-2605-A8F2K9'),
    decision: z.string().describe('The finance decision — must be either "approved" or "rejected"'),
    approvedAmount: z.number().optional().describe('Approved amount in firm currency (defaults to quote amount when approving)'),
    approverName: z.string().describe('Name of the person who made the decision'),
    comments: z.string().optional().describe('Optional decision comments / reason'),
    conditions: z.array(z.string()).optional().describe('Optional conditions attached to approval')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const { ticketId, decision, approvedAmount, approverName, comments, conditions } = input;

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
      const newStatus = decision === 'approved' ? TicketStatus.APPROVED : TicketStatus.REJECTED;

      if (!canTransition(currentStatus, newStatus)) {
        return {
          success: false,
          error: 'invalid_transition',
          message: `Cannot transition ticket from '${currentStatus}' to '${newStatus}'. Ticket must be in pending_approval.`
        };
      }

      const now = new Date().toISOString();
      const finalApprovedAmount = decision === 'approved'
        ? (approvedAmount ?? ticket.estimatedCost ?? ticket.quote?.amount ?? null)
        : null;

      const updatedApproval = {
        ...(ticket.approval ?? {}),
        required: ticket.approval?.required ?? true,
        requestedAt: ticket.approval?.requestedAt ?? now,
        approvedBy: approverName,
        approvedAt: now,
        approvedAmount: finalApprovedAmount,
        comments: comments ?? null,
        conditions: conditions ?? [],
        externalRequestId: ticket.approval?.externalRequestId ?? null
      };

      await Tickets.update(entry.id, {
        ...ticket,
        status: newStatus,
        approval: updatedApproval,
        updatedAt: now
      });

      await logStatusChange({
        ticketId,
        ticketDataId: entry.id,
        fromStatus: currentStatus,
        toStatus: newStatus,
        actorType: ActorType.FINANCE,
        actorName: approverName,
        reason: decision === 'approved'
          ? `Approved by ${approverName}${finalApprovedAmount !== null ? ` for ${finalApprovedAmount}` : ''}`
          : `Rejected by ${approverName}${comments ? `: ${comments}` : ''}`
      });

      await logEvent({
        ticketId,
        ticketDataId: entry.id,
        eventType: decision === 'approved' ? EventType.APPROVED : EventType.REJECTED,
        actorType: ActorType.FINANCE,
        actorName: approverName,
        payload: {
          decision,
          approvedAmount: finalApprovedAmount,
          comments: comments ?? null,
          conditions: conditions ?? []
        }
      });

      return {
        success: true,
        ticketId,
        newStatus,
        message: decision === 'approved'
          ? `Ticket ${ticketId} approved by ${approverName}${finalApprovedAmount !== null ? ` for ${finalApprovedAmount}` : ''}. Vendor can proceed.`
          : `Ticket ${ticketId} rejected by ${approverName}.${comments ? ` Reason: ${comments}` : ''}`
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message ?? String(err),
        message: 'Failed to record finance decision.'
      };
    }
  }
}

export default RecordFinanceDecisionTool;
