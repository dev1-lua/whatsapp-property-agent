/**
 * finance-approval webhook — inbound decision from finance partner systems or
 * the approval-email deep-link. Mirrors RecordFinanceDecisionTool but runs
 * server-side without an LLM in the loop.
 *
 * Body:
 *   {
 *     ticketId: string,
 *     decision: 'approved' | 'rejected',
 *     approvedAmount?: number,
 *     approverName: string,
 *     comments?: string,
 *     conditions?: string[]
 *   }
 *
 * Response:
 *   { success: true, ticketId, newStatus, message, approvedAmount }
 *   { success: false, error, message }
 */

import { LuaWebhook } from 'lua-cli';
import { Tickets } from '../services/data.js';
import {
  TicketStatus,
  ActorType,
  EventType
} from '../utils/constants.js';
import { canTransition } from '../utils/ticket-helpers.js';
import { logEvent, logStatusChange } from '../utils/audit-log.js';

const TICKET_ID_RE = /^MT-\d{4}-[A-Z0-9]{6}$/i;

export default new LuaWebhook({
  name: 'finance-approval',
  description:
    'Record a finance approve/reject decision against a pending_approval ticket; transitions status and audits.',
  execute: async (event) => {
    const body: any = event?.body ?? {};
    const { ticketId, decision, approvedAmount, approverName, comments, conditions } = body;

    if (!ticketId) {
      return { success: false, error: 'validation', message: 'Missing ticketId' };
    }
    if (!TICKET_ID_RE.test(String(ticketId))) {
      return { success: false, error: 'validation', message: `Invalid ticketId format: ${ticketId}` };
    }
    if (decision !== 'approved' && decision !== 'rejected') {
      return {
        success: false,
        error: 'validation',
        message: "decision must be 'approved' or 'rejected'"
      };
    }
    if (!approverName) {
      return { success: false, error: 'validation', message: 'Missing approverName' };
    }

    try {
      const res: any = await Tickets.get({ ticketId });
      const entry: any = res?.data?.[0];
      const ticket: any = entry?.data;

      if (!entry || !ticket) {
        return {
          success: false,
          error: 'ticket_not_found',
          message: `Ticket ${ticketId} not found.`
        };
      }

      const currentStatus = ticket.status as TicketStatus;
      const newStatus =
        decision === 'approved' ? TicketStatus.APPROVED : TicketStatus.REJECTED;

      if (!canTransition(currentStatus, newStatus)) {
        return {
          success: false,
          error: 'invalid_transition',
          message: `Cannot transition ticket from '${currentStatus}' to '${newStatus}'. Ticket must be in pending_approval.`
        };
      }

      const now = new Date().toISOString();
      const finalApprovedAmount =
        decision === 'approved'
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
        reason:
          decision === 'approved'
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
        approvedAmount: finalApprovedAmount,
        message:
          decision === 'approved'
            ? `Ticket ${ticketId} approved by ${approverName}${finalApprovedAmount !== null ? ` for ${finalApprovedAmount}` : ''}. Vendor can proceed.`
            : `Ticket ${ticketId} rejected by ${approverName}.${comments ? ` Reason: ${comments}` : ''}`
      };
    } catch (err: any) {
      console.error('finance-approval webhook error:', err);
      return {
        success: false,
        error: 'unexpected',
        message: err?.message || 'Failed to record finance decision'
      };
    }
  }
});
