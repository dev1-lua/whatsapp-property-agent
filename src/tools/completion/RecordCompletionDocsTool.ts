/**
 * Record completion documentation from the operator/agent side. Mirrors the
 * vendor-skill CompleteJobTool but is used when ops staff need to record a
 * completion. Transitions ticket to COMPLETED.
 */

import { LuaTool, User } from 'lua-cli';
import { z } from 'zod';
import { Tickets } from '../../services/data.js';
import {
  TicketStatus,
  ActorType,
  EventType
} from '../../utils/constants.js';
import { canTransition } from '../../utils/ticket-helpers.js';
import { logEvent, logStatusChange } from '../../utils/audit-log.js';

export class RecordCompletionDocsTool implements LuaTool {
  name = 'record_completion_docs';
  description = "Record a vendor's completion artifacts (photos, invoice number/URL, notes, actual cost) from the operator side. Transitions ticket to completed.";

  inputSchema = z.object({
    ticketId: z.string().describe('Display ticket ID, e.g. MT-2605-A8F2K9'),
    completionNotes: z.string().describe('Notes describing the work performed'),
    completionImages: z.array(z.string()).min(1).describe('CDN URLs of completion photos showing the finished work'),
    invoiceNumber: z.string().describe('Vendor invoice number / reference'),
    invoiceUrl: z.string().optional().describe('Optional CDN URL of the invoice PDF or image'),
    actualCost: z.number().min(0).describe('Actual cost of the completed work in firm currency')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const { ticketId, completionNotes, completionImages, invoiceNumber, invoiceUrl, actualCost } = input;

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
      if (!canTransition(currentStatus, TicketStatus.COMPLETED)) {
        return {
          success: false,
          error: 'invalid_transition',
          message: `Cannot mark ticket as completed from '${currentStatus}'. Ticket must be in_progress.`
        };
      }

      const approvedAmount = ticket.approval?.approvedAmount ?? ticket.estimatedCost ?? null;
      const costVariance = approvedAmount !== null ? actualCost - approvedAmount : null;
      const costVariancePercent = approvedAmount !== null && approvedAmount !== 0
        ? Math.round((costVariance! / approvedAmount) * 100)
        : null;

      const now = new Date().toISOString();

      await Tickets.update(entry.id, {
        ...ticket,
        status: TicketStatus.COMPLETED,
        completionNotes,
        completionImages,
        invoiceNumber,
        invoiceUrl: invoiceUrl ?? ticket.invoiceUrl ?? null,
        actualCost,
        costVariance: costVariance ?? undefined,
        costVariancePercent: costVariancePercent ?? undefined,
        completedAt: now,
        updatedAt: now
      });

      const user = await User.get();
      const userId = user?._luaProfile?.userId ?? user?.id;

      await logStatusChange({
        ticketId,
        ticketDataId: entry.id,
        fromStatus: currentStatus,
        toStatus: TicketStatus.COMPLETED,
        actorType: ActorType.AGENT,
        actorId: userId,
        reason: completionNotes
      });

      await logEvent({
        ticketId,
        ticketDataId: entry.id,
        eventType: EventType.COMPLETION_DOCS_RECEIVED,
        actorType: ActorType.AGENT,
        actorId: userId,
        payload: {
          invoiceNumber,
          invoiceUrl: invoiceUrl ?? null,
          actualCost,
          costVariance,
          costVariancePercent,
          photoCount: completionImages.length
        }
      });

      return {
        success: true,
        ticketId,
        status: TicketStatus.COMPLETED,
        costVariance,
        message: `Completion docs recorded for ticket ${ticketId}. Actual cost: ${actualCost}.${costVariance !== null ? ` Variance: ${costVariance >= 0 ? '+' : ''}${costVariance}.` : ''} Awaiting tenant confirmation.`
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message ?? String(err),
        message: 'Failed to record completion documentation.'
      };
    }
  }
}

export default RecordCompletionDocsTool;
