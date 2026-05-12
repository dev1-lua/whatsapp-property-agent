/**
 * escalation-check — hourly SLA + activity sweep.
 *
 * For every open ticket we evaluate four conditions and, on match, create a
 * single Escalation entry (deduped against existing open escalations of the
 * same type for the same ticket), stamp `escalatedAt` on the ticket, audit
 * the event, and email the manager.
 *
 * Conditions:
 *   1. Emergency SLA breach    — urgency=emergency, ageHours > SLA.EMERGENCY_RESPONSE,
 *                                ticket not yet past 'vendor_contacted'
 *   2. Vendor no-response      — status=vendor_contacted,
 *                                age since vendor assignment > SLA.VENDOR_RESPONSE
 *   3. Approval delay          — status=pending_approval,
 *                                approval.requestedAt age > SLA.APPROVAL_ESCALATION
 *   4. Stale ticket            — last activity > 30 days
 */

import { LuaJob, env } from 'lua-cli';
import {
  TicketStatus,
  EscalationType,
  EscalationStatus,
  EventType,
  ActorType,
  SLA
} from '../utils/constants.js';
import { Tickets, Escalations } from '../services/data.js';
import { logEvent } from '../utils/audit-log.js';
import { sendEmail } from '../utils/email-notifications.js';
import { escalationNotificationEmail } from '../utils/email-templates.js';

const STALE_DAYS = 30;

const TERMINAL_STATUSES = new Set<string>([
  TicketStatus.CLOSED,
  TicketStatus.CANCELLED,
  TicketStatus.REJECTED
]);

function hoursBetween(now: number, iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return (now - t) / 3_600_000;
}

function daysBetween(now: number, iso: string | null | undefined): number | null {
  const h = hoursBetween(now, iso);
  return h == null ? null : h / 24;
}

async function hasOpenEscalation(
  ticketId: string,
  escalationType: string
): Promise<boolean> {
  try {
    const res: any = await Escalations.get({ ticketId, escalationType });
    const rows: any[] = res?.data ?? [];
    return rows.some((r: any) => {
      const d = r?.data ?? r;
      const s = String(d?.status ?? '');
      return s === EscalationStatus.OPEN || s === EscalationStatus.IN_REVIEW;
    });
  } catch (err) {
    console.error('escalation-check: dedupe lookup failed:', err);
    return false;
  }
}

async function createEscalation(args: {
  ticket: any;
  ticketDataId: string;
  escalationType: EscalationType;
  reason: string;
  nowIso: string;
}): Promise<{ id: string } | null> {
  const entry = {
    ticketId: args.ticket.ticketId,
    ticketDataId: args.ticketDataId,
    escalationType: args.escalationType,
    status: EscalationStatus.OPEN,
    reason: args.reason,
    urgency: args.ticket.urgency ?? 'medium',
    propertyName: args.ticket.propertyName ?? null,
    tenantName: args.ticket.tenantName ?? null,
    assignedVendorName: args.ticket.assignedVendorName ?? null,
    currentStatus: args.ticket.status,
    raisedAt: args.nowIso,
    raisedBy: 'escalation-job',
    updatedAt: args.nowIso
  };
  try {
    const searchText = `${args.escalationType} ${args.ticket.ticketId} ${args.reason}`.slice(0, 500);
    const created: any = await Escalations.create(entry, searchText);
    return { id: created?.id ?? '' };
  } catch (err) {
    console.error(`escalation-check: failed to create escalation for ${args.ticket.ticketId}:`, err);
    return null;
  }
}

export default new LuaJob({
  name: 'escalation-check',
  description:
    'Hourly: sweep open tickets for SLA breaches, vendor no-response, approval delay, and staleness; create Escalations and notify the manager.',
  schedule: { type: 'cron', expression: '0 * * * *' },

  execute: async (_job) => {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    try {
      const res: any = await Tickets.get({}, 1, 500);
      const raw: any[] = res?.data ?? [];
      const openTickets = raw
        .map((r: any) => ({ id: r.id, data: r.data ?? r }))
        .filter(({ data }) => !TERMINAL_STATUSES.has(String(data?.status ?? '')));

      console.log(
        `[escalation-check] Scanning ${openTickets.length} open ticket(s) at ${nowIso}`
      );

      const managerEmail = env('MANAGER_EMAIL');
      let createdCount = 0;

      for (const { id: ticketDataId, data: ticket } of openTickets) {
        const ticketId = String(ticket?.ticketId ?? '');
        if (!ticketId) continue;

        const ageHours = hoursBetween(now, ticket?.createdAt);
        const lastActivity = ticket?.updatedAt ?? ticket?.createdAt;
        const staleDays = daysBetween(now, lastActivity);

        const matches: Array<{ type: EscalationType; reason: string }> = [];

        // 1. Emergency SLA breach — created > SLA.EMERGENCY_RESPONSE h ago and still
        //    not past vendor contact.
        if (
          ticket.urgency === 'emergency' &&
          ageHours !== null &&
          ageHours > SLA.EMERGENCY_RESPONSE &&
          (ticket.status === TicketStatus.REPORTED ||
            ticket.status === TicketStatus.VENDOR_CONTACTED)
        ) {
          matches.push({
            type: EscalationType.SLA_BREACH,
            reason: `Emergency ticket aged ${ageHours.toFixed(1)}h without resolution (threshold ${SLA.EMERGENCY_RESPONSE}h).`
          });
        }

        // 2. Vendor no-response
        if (ticket.status === TicketStatus.VENDOR_CONTACTED) {
          const contactedAt = ticket.vendorAssignedAt ?? ticket.updatedAt ?? ticket.createdAt;
          const since = hoursBetween(now, contactedAt);
          if (since !== null && since > SLA.VENDOR_RESPONSE) {
            matches.push({
              type: EscalationType.VENDOR_NO_RESPONSE,
              reason: `Vendor silent ${Math.floor(since)}h since assignment (threshold ${SLA.VENDOR_RESPONSE}h).`
            });
          }
        }

        // 3. Approval delay
        if (ticket.status === TicketStatus.PENDING_APPROVAL && ticket.approval?.requestedAt) {
          const approvalAge = hoursBetween(now, ticket.approval.requestedAt);
          if (approvalAge !== null && approvalAge > SLA.APPROVAL_ESCALATION) {
            matches.push({
              type: EscalationType.APPROVAL_DELAY,
              reason: `Approval pending ${Math.floor(approvalAge)}h (threshold ${SLA.APPROVAL_ESCALATION}h).`
            });
          }
        }

        // 4. Stale ticket
        if (staleDays !== null && staleDays > STALE_DAYS) {
          matches.push({
            type: EscalationType.STALE_TICKET,
            reason: `No activity for ${Math.floor(staleDays)} day(s) (threshold ${STALE_DAYS} days). Current status: ${ticket.status}.`
          });
        }

        if (matches.length === 0) continue;

        let firstCreated = false;
        for (const m of matches) {
          if (await hasOpenEscalation(ticketId, m.type)) continue;

          const created = await createEscalation({
            ticket,
            ticketDataId,
            escalationType: m.type,
            reason: m.reason,
            nowIso
          });
          if (!created) continue;

          createdCount++;
          firstCreated = true;

          await logEvent({
            ticketId,
            ticketDataId,
            eventType: EventType.ESCALATION_CREATED,
            actorType: ActorType.SYSTEM,
            actorId: 'escalation-job',
            payload: {
              escalationId: created.id,
              escalationType: m.type,
              reason: m.reason
            }
          });

          if (managerEmail) {
            try {
              const tpl = escalationNotificationEmail({
                ticketId,
                escalationType: m.type,
                reason: m.reason,
                urgency: ticket.urgency ?? 'medium',
                propertyName: ticket.propertyName ?? undefined,
                vendorName: ticket.assignedVendorName ?? undefined,
                currentStatus: ticket.status,
                tenantName: ticket.tenantName ?? undefined
              });
              await sendEmail({
                to: managerEmail,
                subject: tpl.subject,
                html: tpl.html,
                text: tpl.body,
                ticketId
              });
            } catch (mailErr) {
              console.error(
                `[escalation-check] manager email failed for ${ticketId}:`,
                mailErr
              );
            }
          }
        }

        if (firstCreated) {
          try {
            await Tickets.update(ticketDataId, {
              ...ticket,
              escalatedAt: nowIso,
              updatedAt: nowIso
            });
          } catch (updErr) {
            console.error(
              `[escalation-check] failed to stamp escalatedAt on ${ticketId}:`,
              updErr
            );
          }
        }
      }

      console.log(
        `[escalation-check] Completed. Created ${createdCount} escalation(s).`
      );
    } catch (err) {
      console.error('[escalation-check] job failed:', err);
    }
  }
});
