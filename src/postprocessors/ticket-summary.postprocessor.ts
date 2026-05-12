/**
 * ticket-summary postprocessor
 *
 * Scans the agent's outbound response for display-format ticket IDs
 * (`MT-YYMM-XXXXXX`). For each one found, fetches the ticket and appends a
 * compact summary footer plus a `::: actions :::` block of status-appropriate
 * next-step suggestions.
 *
 * Failure modes are non-fatal: on any error we return the original response
 * unchanged so the user still gets a reply.
 */

import { PostProcessor } from 'lua-cli';
import { Tickets } from '../services/data.js';
import { TicketStatus } from '../utils/constants.js';

const TICKET_ID_RE = /MT-\d{4}-[A-Z0-9]{6}/g;

const STATUS_ACTIONS: Record<string, string[]> = {
  [TicketStatus.REPORTED]: ['Upload photos', 'Check status', 'Update details'],
  [TicketStatus.VENDOR_CONTACTED]: ['Check status', 'Update availability'],
  [TicketStatus.QUOTED]: ['View quote details', 'Check approval status'],
  [TicketStatus.PENDING_APPROVAL]: ['Check approval status', 'Add justification'],
  [TicketStatus.APPROVED]: ['Check work schedule', 'Contact vendor'],
  [TicketStatus.REJECTED]: ['Submit revised quote', 'Discuss alternatives'],
  [TicketStatus.IN_PROGRESS]: ['Check progress', 'Report issue'],
  [TicketStatus.COMPLETED]: ['Confirm completion', 'Report problem', 'Rate service'],
  [TicketStatus.CLOSED]: ['View summary', 'New request', 'Search history'],
  [TicketStatus.CANCELLED]: ['New request', 'Search history'],
  [TicketStatus.ON_HOLD]: ['Resume work', 'Reassign vendor'],
  [TicketStatus.DISPUTED]: ['Resolve dispute', 'Contact manager']
};

function formatStatus(status: string): string {
  return status
    .split('_')
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

async function fetchTicket(ticketId: string): Promise<any | null> {
  try {
    const res: any = await Tickets.get({ ticketId });
    const entry: any = res?.data?.[0];
    if (!entry) return null;
    return { id: entry.id, ...(entry.data ?? entry) };
  } catch {
    return null;
  }
}

function renderCard(t: any): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('---');
  lines.push(`**Ticket ${t.ticketId}**`);
  lines.push(`- Status: ${formatStatus(String(t.status ?? 'unknown'))}`);
  if (t.issueType) lines.push(`- Type: ${t.issueType}`);
  if (t.assignedVendorName) lines.push(`- Vendor: ${t.assignedVendorName}`);
  if (typeof t.estimatedCost === 'number') {
    lines.push(`- Estimated cost: ${t.estimatedCost.toFixed(2)}`);
  }

  const actions = STATUS_ACTIONS[String(t.status)] ?? ['Check status', 'Get help'];
  lines.push('');
  lines.push('::: actions');
  for (const a of actions) lines.push(`- ${a}`);
  lines.push(':::');

  return lines.join('\n');
}

export default new PostProcessor({
  name: 'ticket-summary',
  description:
    'Append a compact ticket-summary footer + actions block for every MT-YYMM-XXXXXX referenced in the agent response.',

  execute: async (user, message, response, channel) => {
    try {
      const text = String(response ?? '');
      const matches = text.match(TICKET_ID_RE);
      if (!matches || matches.length === 0) {
        return { modifiedResponse: response };
      }

      const ticketIds = uniq(matches.map(m => m.toUpperCase()));

      const cards: string[] = [];
      for (const tid of ticketIds) {
        const ticket = await fetchTicket(tid);
        if (ticket) cards.push(renderCard(ticket));
      }

      if (cards.length === 0) {
        return { modifiedResponse: response };
      }

      return { modifiedResponse: `${text}\n${cards.join('\n')}` };
    } catch (err) {
      console.error('ticket-summary postprocessor error:', err);
      return { modifiedResponse: response };
    }
  }
});
