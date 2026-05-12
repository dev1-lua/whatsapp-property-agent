/**
 * my_assigned_jobs — list jobs assigned to the calling vendor.
 *
 * Reads the `tickets` collection filtered by assignedVendorId == vendorId,
 * optionally filtered by status (single value or array). Returns a summary
 * suitable for the vendor persona.
 */

import { LuaTool, User } from 'lua-cli';
import { z } from 'zod';
import { Tickets } from '../../services/data.js';
import { TicketStatus } from '../../utils/constants.js';

const TICKET_STATUS_VALUES = Object.values(TicketStatus) as [string, ...string[]];

export class MyAssignedJobsTool implements LuaTool {
  name = 'my_assigned_jobs';
  description = `Lists all jobs assigned to the calling vendor. Returns ticket summaries (id, status, urgency, property, costs) with next-action hints. Filter by a single status or an array of statuses.`;

  inputSchema = z.object({
    vendorId: z
      .string()
      .optional()
      .describe('Vendor entry id (falls back to the cached identity set by get_user_context)'),
    status: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(`Optional ticket-status filter — single status string or array. Valid values: ${TICKET_STATUS_VALUES.join(', ')}`)
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const vendorId = await resolveVendorId(input.vendorId);
      if (!vendorId) {
        return {
          success: false,
          error: 'no vendor identity',
          message: 'Could not resolve vendor identity. Call get_user_context first or pass vendorId.',
          jobs: [],
          count: 0
        };
      }

      const res: any = await Tickets.get({ assignedVendorId: vendorId }).catch(() => ({ data: [] }));
      let entries: any[] = (res?.data ?? []).map((e: any) => ({ id: e.id, ...(e.data ?? e) }));

      // Apply optional status filter
      if (input.status) {
        const statuses = Array.isArray(input.status) ? input.status : [input.status];
        entries = entries.filter((t: any) => statuses.includes(t.status));
      }

      // Sort: urgency first (emergency > high > medium > low), then most-recent assignedAt.
      const urgencyOrder: Record<string, number> = { emergency: 0, high: 1, medium: 2, low: 3 };
      entries.sort((a: any, b: any) => {
        const ua = urgencyOrder[a.urgency] ?? 9;
        const ub = urgencyOrder[b.urgency] ?? 9;
        if (ua !== ub) return ua - ub;
        const da = new Date(a.vendorAssignedAt || a.createdAt || 0).getTime();
        const db = new Date(b.vendorAssignedAt || b.createdAt || 0).getTime();
        return db - da;
      });

      const jobs = entries.map((t: any) => ({
        id: t.id,
        ticketId: t.ticketId,
        status: t.status,
        issueType: t.issueType,
        urgency: t.urgency,
        description: t.description,
        propertyName: t.propertyName,
        propertyCode: t.propertyCode,
        unit: t.unit ?? null,
        location: t.location ?? null,
        estimatedCost: t.estimatedCost ?? null,
        actualCost: t.actualCost ?? null,
        approvedAmount: t.approval?.approvedAmount ?? null,
        assignedAt: t.vendorAssignedAt ?? null,
        nextAction: suggestNextAction(t.status)
      }));

      const statusCounts: Record<string, number> = {};
      for (const j of jobs) statusCounts[j.status] = (statusCounts[j.status] ?? 0) + 1;

      return {
        success: true,
        message: jobs.length > 0
          ? `You have ${jobs.length} assigned job(s).`
          : 'You have no assigned jobs matching the filter.',
        jobs,
        count: jobs.length,
        summary: { total: jobs.length, byStatus: statusCounts }
      };
    } catch (err: any) {
      console.error('my_assigned_jobs error:', err);
      return {
        success: false,
        error: 'unexpected',
        message: `Could not list assigned jobs: ${err?.message ?? 'unknown error'}`,
        jobs: [],
        count: 0
      };
    }
  }
}

function suggestNextAction(status: string): string {
  switch (status) {
    case TicketStatus.VENDOR_CONTACTED: return 'Submit a quote (submit_quote).';
    case TicketStatus.QUOTED:
    case TicketStatus.PENDING_APPROVAL: return 'Waiting on finance approval.';
    case TicketStatus.APPROVED: return 'Start work (start_work) when ready.';
    case TicketStatus.IN_PROGRESS: return 'Complete the job (complete_job) when finished.';
    case TicketStatus.ON_HOLD: return 'Resume work via start_work when blockers clear.';
    case TicketStatus.COMPLETED: return 'Awaiting tenant confirmation and payment.';
    case TicketStatus.CLOSED: return 'Closed.';
    case TicketStatus.CANCELLED: return 'Cancelled.';
    case TicketStatus.DISPUTED: return 'Disputed — manager review pending.';
    case TicketStatus.REJECTED: return 'Quote was rejected — submit a revised quote.';
    default: return 'No action required.';
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

export default MyAssignedJobsTool;
