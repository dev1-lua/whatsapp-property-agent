/**
 * update_ticket_details — patch tenant-visible fields on an open ticket.
 *
 * Allowed fields: description, location, urgency, tenantAccessNotes. Refuses to
 * update tickets in a terminal status (closed/cancelled). Status transitions
 * happen through their own dedicated tools, never here.
 */

import { LuaTool, User } from 'lua-cli';
import { z } from 'zod';
import { Tickets } from '../../services/data.js';
import { ActorType, EventType, TicketStatus } from '../../utils/constants.js';
import { logEvent } from '../../utils/audit-log.js';

const TERMINAL_STATUSES: string[] = [
  TicketStatus.CLOSED,
  TicketStatus.CANCELLED
];

export class UpdateTicketDetailsTool implements LuaTool {
  name = 'update_ticket_details';
  description =
    'Update tenant-editable details on an existing maintenance ticket — description, location, urgency, or access notes. Only allowed while the ticket is still open (not closed/cancelled). Use the dedicated workflow tools for status transitions.';

  inputSchema = z.object({
    ticketId: z.string().describe('Display ticket ID (e.g., "MT-2605-A8F2K9").'),
    description: z.string().optional().describe('Updated description of the issue.'),
    location: z.string().optional().describe('Updated location within the property.'),
    urgency: z
      .enum(['low', 'medium', 'high', 'emergency'])
      .optional()
      .describe('Updated urgency level.'),
    tenantAccessNotes: z
      .string()
      .optional()
      .describe('Updated access instructions / availability windows for the vendor.')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const { ticketId, description, location, urgency, tenantAccessNotes } = input;

      const lookup: any = await Tickets.get({ ticketId }, 1, 1);
      const entry: any = lookup?.data?.[0];
      if (!entry) {
        return {
          success: false,
          error: 'ticket_not_found',
          message: `Ticket ${ticketId} not found.`
        };
      }

      const current = entry.data ?? {};
      if (TERMINAL_STATUSES.includes(current.status)) {
        return {
          success: false,
          error: 'ticket_not_editable',
          message: `Ticket ${ticketId} is ${current.status} and can no longer be edited.`
        };
      }

      const updatedFields: string[] = [];
      const merged: Record<string, any> = { ...current };

      if (description !== undefined && description !== current.description) {
        merged.description = description;
        updatedFields.push('description');
      }
      if (location !== undefined && location !== current.location) {
        merged.location = location;
        updatedFields.push('location');
      }
      if (urgency !== undefined && urgency !== current.urgency) {
        merged.urgency = urgency;
        updatedFields.push('urgency');
      }
      if (tenantAccessNotes !== undefined && tenantAccessNotes !== current.tenantAccessNotes) {
        merged.tenantAccessNotes = tenantAccessNotes;
        updatedFields.push('tenantAccessNotes');
      }

      if (updatedFields.length === 0) {
        return {
          success: false,
          error: 'no_changes',
          ticketId,
          message: 'No fields provided to update.'
        };
      }

      merged.updatedAt = new Date().toISOString();
      await Tickets.update(entry.id, merged);

      const user: any = await User.get();
      const userId: string | undefined = user?._luaProfile?.userId ?? user?.id;

      await logEvent({
        ticketId,
        ticketDataId: entry.id,
        eventType: EventType.TICKET_UPDATED,
        actorType: ActorType.TENANT,
        actorId: userId,
        payload: { updatedFields }
      });

      return {
        success: true,
        ticketId,
        updatedFields,
        message: `Ticket ${ticketId} updated. Changed: ${updatedFields.join(', ')}.`
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message ?? String(err),
        message: 'Failed to update ticket details.'
      };
    }
  }
}

export default UpdateTicketDetailsTool;
