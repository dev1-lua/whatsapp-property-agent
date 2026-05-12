/**
 * start_work — vendor marks an approved job as in progress.
 *
 * Requires status = APPROVED. Sets workStartedAt + estimatedArrival +
 * arrivalNotes. Logs WORK_STARTED + status change to IN_PROGRESS.
 */

import { LuaTool, User } from 'lua-cli';
import { z } from 'zod';
import { Tickets } from '../../services/data.js';
import { logEvent, logStatusChange } from '../../utils/audit-log.js';
import { ActorType, EventType, TicketStatus } from '../../utils/constants.js';
import { canTransition } from '../../utils/ticket-helpers.js';

export class StartWorkTool implements LuaTool {
  name = 'start_work';
  description = `Marks a maintenance job as in-progress. Requires the ticket to be in 'approved' status. Records arrival time and optional notes.`;

  inputSchema = z.object({
    ticketId: z.string().describe('Display ticket ID (e.g. MT-2605-A8F2K9)'),
    vendorId: z
      .string()
      .optional()
      .describe('Vendor entry id (falls back to the cached identity set by get_user_context)'),
    estimatedArrival: z
      .string()
      .optional()
      .describe('Estimated arrival time / window (e.g. "tomorrow morning")'),
    arrivalNotes: z
      .string()
      .optional()
      .describe('Notes about arrival or initial on-site assessment')
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
      if (currentStatus !== TicketStatus.APPROVED) {
        return {
          success: false,
          error: 'invalid status',
          message: `Cannot start work — ticket status is '${currentStatus}'. Expected 'approved'.`
        };
      }

      const targetStatus = TicketStatus.IN_PROGRESS;
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
        workStartedAt: now,
        estimatedArrival: input.estimatedArrival ?? ticket.estimatedArrival ?? null,
        arrivalNotes: input.arrivalNotes ?? null,
        updatedAt: now
      });

      await logStatusChange({
        ticketId: ticket.ticketId,
        ticketDataId: ticket.id,
        fromStatus: currentStatus,
        toStatus: targetStatus,
        actorType: ActorType.VENDOR,
        actorId: vendorId,
        actorName: ticket.assignedVendorName,
        reason: input.arrivalNotes || 'Work started'
      });

      await logEvent({
        ticketId: ticket.ticketId,
        ticketDataId: ticket.id,
        eventType: EventType.WORK_STARTED,
        actorType: ActorType.VENDOR,
        actorId: vendorId,
        actorName: ticket.assignedVendorName,
        payload: {
          workStartedAt: now,
          estimatedArrival: input.estimatedArrival ?? null,
          arrivalNotes: input.arrivalNotes ?? null
        }
      });

      return {
        success: true,
        ticketId: ticket.ticketId,
        status: targetStatus,
        message: 'Work started.'
      };
    } catch (err: any) {
      console.error('start_work error:', err);
      return {
        success: false,
        error: 'unexpected',
        message: `Could not start work: ${err?.message ?? 'unknown error'}`
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

export default StartWorkTool;
