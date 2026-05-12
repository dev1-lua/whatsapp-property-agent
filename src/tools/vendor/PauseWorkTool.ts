/**
 * pause_work — vendor pauses in-progress work.
 *
 * Requires status = IN_PROGRESS. Moves to ON_HOLD. Records workPausedAt and
 * stores pauseReason in the event payload. Logs WORK_PAUSED + status change.
 */

import { LuaTool, User } from 'lua-cli';
import { z } from 'zod';
import { Tickets } from '../../services/data.js';
import { logEvent, logStatusChange } from '../../utils/audit-log.js';
import { ActorType, EventType, TicketStatus } from '../../utils/constants.js';
import { canTransition } from '../../utils/ticket-helpers.js';

export class PauseWorkTool implements LuaTool {
  name = 'pause_work';
  description = `Pauses an in-progress maintenance job. Moves the ticket to on_hold and records the reason (e.g. waiting on parts, tenant unavailable, weather delay).`;

  inputSchema = z.object({
    ticketId: z.string().describe('Display ticket ID (e.g. MT-2605-A8F2K9)'),
    vendorId: z
      .string()
      .optional()
      .describe('Vendor entry id (falls back to the cached identity set by get_user_context)'),
    pauseReason: z.string().describe('Reason for pausing the work')
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
      if (currentStatus !== TicketStatus.IN_PROGRESS) {
        return {
          success: false,
          error: 'invalid status',
          message: `Cannot pause work — ticket status is '${currentStatus}'. Expected 'in_progress'.`
        };
      }

      const targetStatus = TicketStatus.ON_HOLD;
      if (!canTransition(currentStatus, targetStatus)) {
        return {
          success: false,
          error: 'invalid transition',
          message: `Cannot go from ${currentStatus} to ${targetStatus}.`
        };
      }

      const now = new Date().toISOString();
      await Tickets.update(ticket.id, {
        status: targetStatus,
        workPausedAt: now,
        updatedAt: now
      });

      await logEvent({
        ticketId: ticket.ticketId,
        ticketDataId: ticket.id,
        eventType: EventType.WORK_PAUSED,
        actorType: ActorType.VENDOR,
        actorId: vendorId,
        actorName: ticket.assignedVendorName,
        payload: {
          pauseReason: input.pauseReason,
          workPausedAt: now
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
        reason: `Work paused: ${input.pauseReason}`
      });

      return {
        success: true,
        ticketId: ticket.ticketId,
        pausedAt: now,
        message: `Work paused on ${ticket.ticketId}. Reason: ${input.pauseReason}`
      };
    } catch (err: any) {
      console.error('pause_work error:', err);
      return {
        success: false,
        error: 'unexpected',
        message: `Could not pause work: ${err?.message ?? 'unknown error'}`
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

export default PauseWorkTool;
