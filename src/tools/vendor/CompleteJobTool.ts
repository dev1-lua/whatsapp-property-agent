/**
 * complete_job — vendor records completion details.
 *
 * Requires status = IN_PROGRESS and at least one completion photo URL.
 * Writes completion fields, computes cost variance, transitions to COMPLETED,
 * and logs COMPLETION_DOCS_RECEIVED + status change.
 */

import { LuaTool, User } from 'lua-cli';
import { z } from 'zod';
import { Tickets } from '../../services/data.js';
import { logEvent, logStatusChange } from '../../utils/audit-log.js';
import { ActorType, EventType, TicketStatus } from '../../utils/constants.js';
import { canTransition } from '../../utils/ticket-helpers.js';

export class CompleteJobTool implements LuaTool {
  name = 'complete_job';
  description = `Marks a maintenance job as completed. Requires at least one completion photo URL and an invoice number. Computes cost variance vs the quote and transitions the ticket to 'completed'.`;

  inputSchema = z.object({
    ticketId: z.string().describe('Display ticket ID (e.g. MT-2605-A8F2K9)'),
    vendorId: z
      .string()
      .optional()
      .describe('Vendor entry id (falls back to the cached identity set by get_user_context)'),
    completionNotes: z.string().describe('Description of the work completed'),
    actualCost: z.number().describe('Final actual cost in the quote currency'),
    completionPhotoUrls: z
      .array(z.string())
      .min(1)
      .describe('CDN URLs of photos showing the completed work (at least one)'),
    invoiceNumber: z.string().describe('Invoice number / reference from the vendor'),
    invoiceUrl: z
      .string()
      .optional()
      .describe('CDN URL of the uploaded invoice PDF / image')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      // Belt-and-braces: schema enforces .min(1), but filter blanks too.
      const validPhotos = (input.completionPhotoUrls || []).filter(
        (u) => typeof u === 'string' && u.trim().length > 0
      );
      if (validPhotos.length === 0) {
        return {
          success: false,
          error: 'no completion photos',
          message: 'At least one completion photo URL is required.'
        };
      }

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
      if (currentStatus !== TicketStatus.IN_PROGRESS) {
        return {
          success: false,
          error: 'invalid status',
          message: `Cannot complete job — ticket status is '${currentStatus}'. Expected 'in_progress'.`
        };
      }

      const targetStatus = TicketStatus.COMPLETED;
      if (!canTransition(currentStatus, targetStatus)) {
        return {
          success: false,
          error: 'invalid transition',
          message: `Cannot go from ${currentStatus} to ${targetStatus}.`
        };
      }

      const quoteAmount: number = ticket.quote?.amount ?? 0;
      const costVariance = input.actualCost - quoteAmount;
      const costVariancePercent = quoteAmount > 0
        ? Math.round((costVariance / quoteAmount) * 100)
        : 0;

      const now = new Date().toISOString();
      const existingCompletionImages: string[] = Array.isArray(ticket.completionImages)
        ? ticket.completionImages
        : [];

      await Tickets.update(ticket.id, {
        status: targetStatus,
        completedAt: now,
        completionNotes: input.completionNotes,
        completionImages: [...existingCompletionImages, ...validPhotos],
        invoiceNumber: input.invoiceNumber,
        invoiceUrl: input.invoiceUrl ?? null,
        actualCost: input.actualCost,
        costVariance,
        costVariancePercent,
        updatedAt: now
      });

      await logEvent({
        ticketId: ticket.ticketId,
        ticketDataId: ticket.id,
        eventType: EventType.COMPLETION_DOCS_RECEIVED,
        actorType: ActorType.VENDOR,
        actorId: vendorId,
        actorName: ticket.assignedVendorName,
        payload: {
          completionNotes: input.completionNotes,
          actualCost: input.actualCost,
          quoteAmount,
          costVariance,
          costVariancePercent,
          photoCount: validPhotos.length,
          invoiceNumber: input.invoiceNumber,
          invoiceUrl: input.invoiceUrl ?? null
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
        reason: `Work completed. Final cost: ${ticket.quote?.currency ?? 'EUR'}${input.actualCost}`
      });

      return {
        success: true,
        ticketId: ticket.ticketId,
        status: targetStatus,
        costVariance,
        costVariancePercent,
        message: `Job ${ticket.ticketId} marked complete. Cost variance: ${costVariance >= 0 ? '+' : ''}${costVariance} (${costVariancePercent}%).`
      };
    } catch (err: any) {
      console.error('complete_job error:', err);
      return {
        success: false,
        error: 'unexpected',
        message: `Could not complete job: ${err?.message ?? 'unknown error'}`
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

export default CompleteJobTool;
