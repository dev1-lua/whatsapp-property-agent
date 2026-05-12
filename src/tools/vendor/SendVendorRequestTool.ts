/**
 * Assign a vendor to a ticket and email them the job details. Transitions
 * ticket to VENDOR_CONTACTED, stamps assignment + request timestamps.
 */

import { LuaTool, User } from 'lua-cli';
import { z } from 'zod';
import { Tickets, Vendors } from '../../services/data.js';
import {
  TicketStatus,
  ActorType,
  EventType
} from '../../utils/constants.js';
import { canTransition } from '../../utils/ticket-helpers.js';
import { logEvent, logStatusChange } from '../../utils/audit-log.js';
import { sendEmail } from '../../utils/email-notifications.js';
import { vendorJobAssignedEmail } from '../../utils/email-templates.js';

export class SendVendorRequestTool implements LuaTool {
  name = 'send_vendor_request';
  description = 'Assign a maintenance ticket to a specific vendor and email them the job details. Transitions ticket to vendor_contacted.';

  inputSchema = z.object({
    ticketId: z.string().describe('Display ticket ID, e.g. MT-2605-A8F2K9'),
    vendorId: z.string().describe('Data entry id of the vendor to assign')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const { ticketId, vendorId } = input;

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
      if (!canTransition(currentStatus, TicketStatus.VENDOR_CONTACTED)) {
        return {
          success: false,
          error: 'invalid_transition',
          message: `Cannot contact vendor from '${currentStatus}'.`
        };
      }

      // Load vendor
      const vendorEntry = await Vendors.getEntry(vendorId);
      const vendor: any = vendorEntry?.data;
      if (!vendorEntry || !vendor) {
        return {
          success: false,
          error: 'vendor_not_found',
          message: `Vendor ${vendorId} not found.`
        };
      }

      const now = new Date().toISOString();
      const vendorName = vendor.companyName ?? vendor.name;
      const vendorPhone = (vendor.phones ?? [])[0] ?? '';
      const vendorEmail = vendor.email ?? '';

      // Update ticket
      await Tickets.update(entry.id, {
        ...ticket,
        status: TicketStatus.VENDOR_CONTACTED,
        assignedVendorId: vendorId,
        assignedVendorName: vendorName,
        assignedVendorPhone: vendorPhone,
        assignedVendorUserId: vendor.userId ?? ticket.assignedVendorUserId,
        vendorAssignedAt: now,
        vendorRequestedAt: now,
        updatedAt: now
      });

      const user = await User.get();
      const userId = user?._luaProfile?.userId ?? user?.id;

      await logStatusChange({
        ticketId,
        ticketDataId: entry.id,
        fromStatus: currentStatus,
        toStatus: TicketStatus.VENDOR_CONTACTED,
        actorType: ActorType.AGENT,
        actorId: userId,
        reason: `Assigned to vendor ${vendorName}`
      });

      await logEvent({
        ticketId,
        ticketDataId: entry.id,
        eventType: EventType.VENDOR_CONTACTED,
        actorType: ActorType.AGENT,
        actorId: userId,
        payload: {
          vendorId,
          vendorName,
          vendorPhone,
          vendorEmail
        }
      });

      // Email vendor
      if (vendorEmail) {
        try {
          const emailData = vendorJobAssignedEmail({
            ticketId,
            propertyName: ticket.propertyName ?? ticket.propertyCode ?? '',
            issueType: ticket.issueType ?? 'other',
            urgency: ticket.urgency ?? 'medium',
            description: ticket.description ?? '',
            location: ticket.location,
            tenantAccessNotes: ticket.tenantAccessNotes,
            images: ticket.images ?? []
          });
          await sendEmail({
            to: vendorEmail,
            subject: emailData.subject,
            html: emailData.html,
            ticketId
          });
        } catch (err: any) {
          console.error('send_vendor_request: email send failed (non-fatal):', err?.message);
        }
      }

      return {
        success: true,
        ticketId,
        vendorId,
        vendorName,
        sentAt: now,
        message: `Job ${ticketId} assigned to ${vendorName}${vendorEmail ? ` (${vendorEmail})` : ''}. Awaiting vendor response.`
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message ?? String(err),
        message: 'Failed to send vendor request.'
      };
    }
  }
}

export default SendVendorRequestTool;
