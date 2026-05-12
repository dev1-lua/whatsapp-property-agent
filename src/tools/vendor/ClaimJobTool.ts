/**
 * claim_job — vendor self-assigns to an open ticket.
 *
 * Sets assignedVendorId/Name/Phone and transitions to VENDOR_CONTACTED
 * (no-op transition if already there). Logs a VENDOR_CONTACTED event.
 */

import { LuaTool, User } from 'lua-cli';
import { z } from 'zod';
import { Tickets, Vendors } from '../../services/data.js';
import { logEvent, logStatusChange } from '../../utils/audit-log.js';
import { ActorType, EventType, TicketStatus } from '../../utils/constants.js';
import { canTransition } from '../../utils/ticket-helpers.js';

export class ClaimJobTool implements LuaTool {
  name = 'claim_job';
  description = `Vendor self-assigns to a maintenance job. Updates the ticket's assigned vendor fields and moves it to vendor_contacted (if not already there). Other vendors are locked out once claimed.`;

  inputSchema = z.object({
    ticketId: z.string().describe('Display ticket ID (e.g. MT-2605-A8F2K9)'),
    vendorId: z
      .string()
      .optional()
      .describe('Vendor entry id (falls back to the cached identity set by get_user_context)')
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

      // Already-claimed-by-someone-else guard
      if (ticket.assignedVendorId && ticket.assignedVendorId !== vendorId) {
        return {
          success: false,
          error: 'already claimed',
          message: `Ticket ${input.ticketId} is already assigned to another vendor.`
        };
      }

      // Status must be REPORTED or already VENDOR_CONTACTED (re-claim by self)
      const currentStatus = ticket.status as TicketStatus;
      const claimableStatuses: TicketStatus[] = [
        TicketStatus.REPORTED,
        TicketStatus.VENDOR_CONTACTED
      ];
      if (!claimableStatuses.includes(currentStatus)) {
        return {
          success: false,
          error: 'invalid status',
          message: `Cannot claim ticket — current status is '${currentStatus}'. Only reported or vendor_contacted tickets can be claimed.`
        };
      }

      // Load vendor record for denormalized fields
      const vendorEntry = await Vendors.getEntry(vendorId).catch(() => null);
      if (!vendorEntry) {
        return {
          success: false,
          error: 'vendor not found',
          message: `Vendor ${vendorId} not found.`
        };
      }
      const vendor: any = vendorEntry.data ?? vendorEntry;
      const vendorName = vendor.companyName || vendor.name || 'Vendor';
      const vendorPhone = Array.isArray(vendor.phones) && vendor.phones.length ? vendor.phones[0] : '';

      const now = new Date().toISOString();
      const willTransition = currentStatus === TicketStatus.REPORTED;
      const targetStatus = TicketStatus.VENDOR_CONTACTED;

      if (willTransition && !canTransition(currentStatus, targetStatus)) {
        return {
          success: false,
          error: 'invalid transition',
          message: `Cannot go from ${currentStatus} to ${targetStatus}.`
        };
      }

      // Resolve current user's lua userId for vendor-side notifications
      let vendorUserId: string | undefined;
      try {
        const u: any = await User.get();
        vendorUserId = u?._luaProfile?.userId || u?.id;
      } catch {
        /* non-fatal */
      }

      const patch: Record<string, any> = {
        assignedVendorId: vendorId,
        assignedVendorName: vendorName,
        assignedVendorPhone: vendorPhone,
        assignedVendorUserId: vendorUserId ?? ticket.assignedVendorUserId ?? null,
        vendorAssignedAt: now,
        updatedAt: now
      };
      if (willTransition) patch.status = targetStatus;

      await Tickets.update(ticket.id, patch);

      if (willTransition) {
        await logStatusChange({
          ticketId: ticket.ticketId,
          ticketDataId: ticket.id,
          fromStatus: currentStatus,
          toStatus: targetStatus,
          actorType: ActorType.VENDOR,
          actorId: vendorId,
          actorName: vendorName,
          reason: `Vendor ${vendorName} self-assigned`
        });
      }

      await logEvent({
        ticketId: ticket.ticketId,
        ticketDataId: ticket.id,
        eventType: EventType.VENDOR_CONTACTED,
        actorType: ActorType.VENDOR,
        actorId: vendorId,
        actorName: vendorName,
        payload: { selfAssigned: true, vendorName }
      });

      return {
        success: true,
        ticketId: ticket.ticketId,
        claimedAt: now,
        message: `Job ${ticket.ticketId} has been assigned to ${vendorName}. Next: submit a quote.`
      };
    } catch (err: any) {
      console.error('claim_job error:', err);
      return {
        success: false,
        error: 'unexpected',
        message: `Could not claim job: ${err?.message ?? 'unknown error'}`
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

export default ClaimJobTool;
