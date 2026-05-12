/**
 * vendor-response webhook — inbound from vendor partner systems / email.
 *
 * Routes to internal logic per action — logic is duplicated inline here rather
 * than calling the tool classes, because this is a server-side webhook (no LLM
 * in the loop) and the tool layer is shaped around inputSchema validation +
 * agent return-shape.
 *
 * Body:
 *   {
 *     ticketId: string,
 *     action: 'accept' | 'decline' | 'quote' | 'complete',
 *     vendorId: string,
 *     // quote:
 *     amount?: number,
 *     scopeNotes?: string,
 *     // complete:
 *     completionNotes?: string,
 *     invoiceNumber?: string,
 *     actualCost?: number,
 *     photoUrls?: string[]
 *   }
 *
 * Response:
 *   { success: true, ticketId, status, action, message }
 *   { success: false, error, message }
 */

import { LuaWebhook } from 'lua-cli';
import { Tickets, Vendors } from '../services/data.js';
import {
  TicketStatus,
  ActorType,
  EventType
} from '../utils/constants.js';
import { canTransition } from '../utils/ticket-helpers.js';
import { logEvent, logStatusChange } from '../utils/audit-log.js';

const TICKET_ID_RE = /^MT-\d{4}-[A-Z0-9]{6}$/i;

type Action = 'accept' | 'decline' | 'quote' | 'complete';
const VALID_ACTIONS = new Set<Action>(['accept', 'decline', 'quote', 'complete']);

async function loadTicket(ticketId: string) {
  const res: any = await Tickets.get({ ticketId });
  const entry: any = res?.data?.[0];
  const ticket: any = entry?.data;
  if (!entry || !ticket) return null;
  return { entry, ticket };
}

async function loadVendor(vendorId: string): Promise<{ id: string; data: any } | null> {
  try {
    const v: any = await Vendors.getEntry(vendorId);
    if (v) return { id: v.id, data: v.data ?? v };
  } catch {
    /* ignore */
  }
  return null;
}

export default new LuaWebhook({
  name: 'vendor-response',
  description:
    'Vendor partner endpoint: accept/decline a job, submit a quote, or report completion. Validates vendor ownership + state transitions.',
  execute: async (event) => {
    const body: any = event?.body ?? {};
    const {
      ticketId,
      action,
      vendorId,
      amount,
      scopeNotes,
      completionNotes,
      invoiceNumber,
      actualCost,
      photoUrls
    } = body;

    if (!ticketId) return { success: false, error: 'validation', message: 'Missing ticketId' };
    if (!TICKET_ID_RE.test(String(ticketId))) {
      return { success: false, error: 'validation', message: `Invalid ticketId format: ${ticketId}` };
    }
    if (!action || !VALID_ACTIONS.has(action)) {
      return {
        success: false,
        error: 'validation',
        message: `action must be one of: accept, decline, quote, complete`
      };
    }
    if (!vendorId) return { success: false, error: 'validation', message: 'Missing vendorId' };

    try {
      const loaded = await loadTicket(String(ticketId));
      if (!loaded) {
        return { success: false, error: 'ticket_not_found', message: `Ticket ${ticketId} not found.` };
      }
      const { entry, ticket } = loaded;
      const currentStatus = ticket.status as TicketStatus;
      const now = new Date().toISOString();

      // Decline (and quote/complete after assignment) require vendor ownership.
      // For accept the ticket may still be unassigned.
      const vendorEntry = await loadVendor(String(vendorId));
      const vendorName = vendorEntry?.data?.name ?? null;

      if (action !== 'accept') {
        const assigned = ticket.assignedVendorId ?? ticket.vendorId ?? null;
        if (assigned && assigned !== vendorId) {
          return {
            success: false,
            error: 'wrong_vendor',
            message: `Ticket ${ticketId} is assigned to a different vendor.`
          };
        }
      }

      switch (action as Action) {
        case 'accept': {
          // Allowed only when ticket is REPORTED (unassigned) or VENDOR_CONTACTED for this vendor.
          if (
            currentStatus !== TicketStatus.REPORTED &&
            currentStatus !== TicketStatus.VENDOR_CONTACTED
          ) {
            return {
              success: false,
              error: 'invalid_state',
              message: `Cannot accept job in '${currentStatus}' — expected reported or vendor_contacted.`
            };
          }
          const target = TicketStatus.VENDOR_CONTACTED;
          if (currentStatus !== target && !canTransition(currentStatus, target)) {
            return {
              success: false,
              error: 'invalid_transition',
              message: `Cannot transition from '${currentStatus}' to '${target}'.`
            };
          }

          await Tickets.update(entry.id, {
            ...ticket,
            status: target,
            assignedVendorId: vendorId,
            assignedVendorName: vendorName ?? ticket.assignedVendorName ?? null,
            vendorAssignedAt: ticket.vendorAssignedAt ?? now,
            updatedAt: now
          });

          if (currentStatus !== target) {
            await logStatusChange({
              ticketId: ticket.ticketId,
              ticketDataId: entry.id,
              fromStatus: currentStatus,
              toStatus: target,
              actorType: ActorType.VENDOR,
              actorId: vendorId,
              actorName: vendorName ?? undefined,
              reason: `Vendor ${vendorName ?? vendorId} accepted the job`
            });
          }
          await logEvent({
            ticketId: ticket.ticketId,
            ticketDataId: entry.id,
            eventType: EventType.VENDOR_CONTACTED,
            actorType: ActorType.VENDOR,
            actorId: vendorId,
            actorName: vendorName ?? undefined,
            payload: { action: 'accept' }
          });

          return {
            success: true,
            ticketId: ticket.ticketId,
            status: target,
            action,
            message: `Vendor ${vendorName ?? vendorId} accepted ticket ${ticket.ticketId}.`
          };
        }

        case 'decline': {
          // Allowed if currently REPORTED or VENDOR_CONTACTED. We clear assignment
          // and bring the ticket back to REPORTED so another vendor can pick it up.
          if (
            currentStatus !== TicketStatus.REPORTED &&
            currentStatus !== TicketStatus.VENDOR_CONTACTED
          ) {
            return {
              success: false,
              error: 'invalid_state',
              message: `Cannot decline job in '${currentStatus}'.`
            };
          }

          await Tickets.update(entry.id, {
            ...ticket,
            status: TicketStatus.REPORTED,
            assignedVendorId: null,
            assignedVendorName: null,
            vendorAssignedAt: null,
            updatedAt: now
          });

          await logEvent({
            ticketId: ticket.ticketId,
            ticketDataId: entry.id,
            eventType: EventType.VENDOR_DECLINED,
            actorType: ActorType.VENDOR,
            actorId: vendorId,
            actorName: vendorName ?? undefined,
            payload: {
              action: 'decline',
              previousStatus: currentStatus,
              reason: scopeNotes ?? null
            }
          });

          if (currentStatus === TicketStatus.VENDOR_CONTACTED) {
            // No formal status_changed event for the synthetic revert — keep
            // VENDOR_DECLINED as the canonical record.
          }

          return {
            success: true,
            ticketId: ticket.ticketId,
            status: TicketStatus.REPORTED,
            action,
            message: `Vendor ${vendorName ?? vendorId} declined ticket ${ticket.ticketId}; awaiting reassignment.`
          };
        }

        case 'quote': {
          if (amount === undefined || amount === null || Number.isNaN(Number(amount))) {
            return { success: false, error: 'validation', message: 'Missing or invalid amount' };
          }
          if (!scopeNotes) {
            return { success: false, error: 'validation', message: 'Missing scopeNotes' };
          }

          // From VENDOR_CONTACTED we go straight to PENDING_APPROVAL
          // (matches BC/main behaviour of skipping QUOTED).
          if (currentStatus !== TicketStatus.VENDOR_CONTACTED) {
            return {
              success: false,
              error: 'invalid_state',
              message: `Cannot submit quote for ticket in '${currentStatus}' — expected vendor_contacted.`
            };
          }
          const target = TicketStatus.PENDING_APPROVAL;
          if (!canTransition(currentStatus, target)) {
            return {
              success: false,
              error: 'invalid_transition',
              message: `Cannot transition from '${currentStatus}' to '${target}'.`
            };
          }

          const quoteAmount = Number(amount);
          const quoteData = {
            amount: quoteAmount,
            currency: ticket.quote?.currency ?? 'USD',
            scopeNotes,
            submittedAt: now,
            vendorId,
            vendorName: vendorName ?? null
          };

          await Tickets.update(entry.id, {
            ...ticket,
            status: target,
            estimatedCost: quoteAmount,
            quote: quoteData,
            approval: {
              required: true,
              requestedAt: now,
              approvedBy: '',
              approvedAt: '',
              comments: '',
              approvedAmount: null,
              conditions: [],
              externalRequestId: null
            },
            updatedAt: now
          });

          await logStatusChange({
            ticketId: ticket.ticketId,
            ticketDataId: entry.id,
            fromStatus: currentStatus,
            toStatus: target,
            actorType: ActorType.VENDOR,
            actorId: vendorId,
            actorName: vendorName ?? undefined,
            reason: `Quote submitted: ${quoteAmount}`
          });
          await logEvent({
            ticketId: ticket.ticketId,
            ticketDataId: entry.id,
            eventType: EventType.QUOTE_RECEIVED,
            actorType: ActorType.VENDOR,
            actorId: vendorId,
            actorName: vendorName ?? undefined,
            payload: { amount: quoteAmount, scopeNotes }
          });

          return {
            success: true,
            ticketId: ticket.ticketId,
            status: target,
            action,
            message: `Quote ${quoteAmount} recorded for ${ticket.ticketId}; sent to finance for approval.`
          };
        }

        case 'complete': {
          if (!completionNotes) {
            return { success: false, error: 'validation', message: 'Missing completionNotes' };
          }
          if (currentStatus !== TicketStatus.IN_PROGRESS && currentStatus !== TicketStatus.APPROVED) {
            return {
              success: false,
              error: 'invalid_state',
              message: `Cannot complete ticket in '${currentStatus}' — expected in_progress or approved.`
            };
          }
          const target = TicketStatus.COMPLETED;
          // If on APPROVED, we transition via IN_PROGRESS implicitly — bump to in_progress first.
          if (currentStatus === TicketStatus.APPROVED) {
            if (!canTransition(currentStatus, TicketStatus.IN_PROGRESS)) {
              return {
                success: false,
                error: 'invalid_transition',
                message: `Cannot transition from '${currentStatus}' to 'in_progress'.`
              };
            }
          } else if (!canTransition(currentStatus, target)) {
            return {
              success: false,
              error: 'invalid_transition',
              message: `Cannot transition from '${currentStatus}' to '${target}'.`
            };
          }

          const finalCost =
            actualCost !== undefined && actualCost !== null
              ? Number(actualCost)
              : ticket.actualCost ?? ticket.estimatedCost ?? null;

          await Tickets.update(entry.id, {
            ...ticket,
            status: target,
            completionNotes,
            invoiceNumber: invoiceNumber ?? ticket.invoiceNumber ?? null,
            actualCost: finalCost,
            completionPhotos: Array.isArray(photoUrls)
              ? photoUrls
              : ticket.completionPhotos ?? [],
            completedAt: now,
            updatedAt: now
          });

          await logStatusChange({
            ticketId: ticket.ticketId,
            ticketDataId: entry.id,
            fromStatus: currentStatus,
            toStatus: target,
            actorType: ActorType.VENDOR,
            actorId: vendorId,
            actorName: vendorName ?? undefined,
            reason: `Work completed by ${vendorName ?? vendorId}`
          });
          await logEvent({
            ticketId: ticket.ticketId,
            ticketDataId: entry.id,
            eventType: EventType.COMPLETION_DOCS_RECEIVED,
            actorType: ActorType.VENDOR,
            actorId: vendorId,
            actorName: vendorName ?? undefined,
            payload: {
              completionNotes,
              invoiceNumber: invoiceNumber ?? null,
              actualCost: finalCost,
              photoCount: Array.isArray(photoUrls) ? photoUrls.length : 0
            }
          });

          return {
            success: true,
            ticketId: ticket.ticketId,
            status: target,
            action,
            actualCost: finalCost,
            message: `Ticket ${ticket.ticketId} marked completed by ${vendorName ?? vendorId}.`
          };
        }

        default:
          return { success: false, error: 'unknown_action', message: `Unknown action: ${action}` };
      }
    } catch (err: any) {
      console.error('vendor-response webhook error:', err);
      return {
        success: false,
        error: 'unexpected',
        message: err?.message || 'Failed to process vendor response'
      };
    }
  }
});
