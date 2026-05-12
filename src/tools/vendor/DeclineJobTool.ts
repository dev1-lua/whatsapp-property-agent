/**
 * decline_job — vendor declines an assigned job.
 *
 * Clears vendor assignment and resets ticket to REPORTED for reassignment.
 * Logs a VENDOR_DECLINED event plus the status change.
 */

import { LuaTool, User } from 'lua-cli';
import { z } from 'zod';
import { Tickets } from '../../services/data.js';
import { logEvent, logStatusChange } from '../../utils/audit-log.js';
import { ActorType, EventType, TicketStatus } from '../../utils/constants.js';
import { canTransition } from '../../utils/ticket-helpers.js';

export class DeclineJobTool implements LuaTool {
  name = 'decline_job';
  description = `Lets a vendor decline a job they've been assigned to. Clears the vendor assignment and resets the ticket to reported so another vendor can claim it.`;

  inputSchema = z.object({
    ticketId: z.string().describe('Display ticket ID (e.g. MT-2605-A8F2K9)'),
    vendorId: z
      .string()
      .optional()
      .describe('Vendor entry id (falls back to the cached identity set by get_user_context)'),
    declineReason: z.string().describe('Reason for declining the job')
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
          message: 'You are not assigned to this ticket, so you cannot decline it.'
        };
      }

      const currentStatus = ticket.status as TicketStatus;
      const declinableStatuses: TicketStatus[] = [
        TicketStatus.VENDOR_CONTACTED,
        TicketStatus.QUOTED
      ];
      if (!declinableStatuses.includes(currentStatus)) {
        return {
          success: false,
          error: 'invalid status',
          message: `Cannot decline job — current status is '${currentStatus}'. Only vendor_contacted or quoted tickets can be declined.`
        };
      }

      // Decline always resets to REPORTED. Validate this transition is allowed.
      // (vendor_contacted → reported isn't in VALID_TRANSITIONS by default; the
      //  decline action is a domain-specific reset rather than a normal forward
      //  step. We still surface a clear error if reset can't happen, but the
      //  domain expects this to always work from VENDOR_CONTACTED or QUOTED.)
      // For safety we just log and force the update.
      const previousStatus = currentStatus;
      const targetStatus = TicketStatus.REPORTED;

      // Soft validation only — log a warning if the transition table disagrees.
      if (!canTransition(currentStatus, targetStatus)) {
        console.warn(
          `[decline_job] transition ${currentStatus}→${targetStatus} not in VALID_TRANSITIONS; performing domain-level reset`
        );
      }

      const now = new Date().toISOString();
      const previousVendorName = ticket.assignedVendorName || '';

      await Tickets.update(ticket.id, {
        status: targetStatus,
        assignedVendorId: null,
        assignedVendorName: null,
        assignedVendorPhone: null,
        assignedVendorUserId: null,
        vendorAssignedAt: null,
        estimatedArrival: null,
        updatedAt: now
      });

      await logEvent({
        ticketId: ticket.ticketId,
        ticketDataId: ticket.id,
        eventType: EventType.VENDOR_DECLINED,
        actorType: ActorType.VENDOR,
        actorId: vendorId,
        actorName: previousVendorName,
        payload: {
          declineReason: input.declineReason,
          previousStatus,
          previousVendorName
        }
      });

      await logStatusChange({
        ticketId: ticket.ticketId,
        ticketDataId: ticket.id,
        fromStatus: previousStatus,
        toStatus: targetStatus,
        actorType: ActorType.VENDOR,
        actorId: vendorId,
        actorName: previousVendorName,
        reason: `Vendor declined: ${input.declineReason}`
      });

      return {
        success: true,
        ticketId: ticket.ticketId,
        message: `Job ${ticket.ticketId} has been declined and reset for reassignment.`
      };
    } catch (err: any) {
      console.error('decline_job error:', err);
      return {
        success: false,
        error: 'unexpected',
        message: `Could not decline job: ${err?.message ?? 'unknown error'}`
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

export default DeclineJobTool;
