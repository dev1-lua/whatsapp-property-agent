/**
 * daily-workload-report — weekday 09:00 manager summary.
 *
 * Aggregates the full ticket portfolio by status, urgency, and property,
 * counts open escalations, computes "overdue" buckets (high > 4h since
 * report, emergency > 1h since report and not yet past vendor_contacted),
 * then emails the manager a plain-text + HTML summary. If MANAGER_USER_ID
 * is set we also send an in-app message via Lua's User API.
 */

import { LuaJob, User, env } from 'lua-cli';
import {
  TicketStatus,
  Urgency,
  SLA
} from '../utils/constants.js';
import { Tickets, Escalations } from '../services/data.js';

const OPEN_FOR_OVERDUE_EMERGENCY = new Set<string>([
  TicketStatus.REPORTED,
  TicketStatus.VENDOR_CONTACTED
]);
const OPEN_FOR_OVERDUE_HIGH = new Set<string>([TicketStatus.REPORTED]);
const TERMINAL_STATUSES = new Set<string>([
  TicketStatus.CLOSED,
  TicketStatus.CANCELLED,
  TicketStatus.REJECTED
]);

function hoursSince(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return (now - t) / 3_600_000;
}

function flat(entry: any): any {
  return { id: entry.id, ...(entry.data ?? entry) };
}

function renderText(args: {
  reportDate: string;
  totalOpen: number;
  byStatus: Record<string, number>;
  byUrgency: Record<string, number>;
  byProperty: Array<{ name: string; count: number }>;
  openEscalations: number;
  overdueEmergency: number;
  overdueHigh: number;
}): string {
  const lines: string[] = [];
  lines.push(`Daily Maintenance Report — ${args.reportDate}`);
  lines.push('');
  lines.push(`Total open tickets: ${args.totalOpen}`);
  lines.push(`Open escalations:   ${args.openEscalations}`);
  lines.push('');
  lines.push('By status:');
  for (const [s, n] of Object.entries(args.byStatus)) lines.push(`  - ${s}: ${n}`);
  lines.push('');
  lines.push('By urgency:');
  for (const u of [Urgency.EMERGENCY, Urgency.HIGH, Urgency.MEDIUM, Urgency.LOW]) {
    lines.push(`  - ${u}: ${args.byUrgency[u] ?? 0}`);
  }
  lines.push('');
  lines.push('Top properties:');
  if (args.byProperty.length === 0) lines.push('  (none)');
  for (const p of args.byProperty.slice(0, 10)) {
    lines.push(`  - ${p.name}: ${p.count}`);
  }
  lines.push('');
  lines.push(`Overdue:`);
  lines.push(`  - Emergency > ${SLA.EMERGENCY_RESPONSE}h: ${args.overdueEmergency}`);
  lines.push(`  - High > ${SLA.HIGH_RESPONSE}h: ${args.overdueHigh}`);
  lines.push('');
  lines.push('— Property Maintenance Agent');
  return lines.join('\n');
}

function renderHtml(args: {
  reportDate: string;
  totalOpen: number;
  byStatus: Record<string, number>;
  byUrgency: Record<string, number>;
  byProperty: Array<{ name: string; count: number }>;
  openEscalations: number;
  overdueEmergency: number;
  overdueHigh: number;
}): string {
  const statusRows = Object.entries(args.byStatus)
    .map(([s, n]) => `<tr><td>${s}</td><td style="text-align:right">${n}</td></tr>`)
    .join('');
  const urgencyRows = [Urgency.EMERGENCY, Urgency.HIGH, Urgency.MEDIUM, Urgency.LOW]
    .map(u => `<tr><td>${u}</td><td style="text-align:right">${args.byUrgency[u] ?? 0}</td></tr>`)
    .join('');
  const propRows = args.byProperty
    .slice(0, 10)
    .map(p => `<tr><td>${escapeHtml(p.name)}</td><td style="text-align:right">${p.count}</td></tr>`)
    .join('');

  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<table width="640" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;max-width:640px;margin:0 auto;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
  <tr><td style="background:#1a73e8;padding:24px 32px;color:#fff;font-size:18px;font-weight:600;">Daily Maintenance Report — ${args.reportDate}</td></tr>
  <tr><td style="padding:24px 32px;color:#1f2937;font-size:14px;line-height:1.6;">
    <p><strong>Total open tickets:</strong> ${args.totalOpen}<br/>
       <strong>Open escalations:</strong> ${args.openEscalations}<br/>
       <strong>Overdue (emergency &gt; ${SLA.EMERGENCY_RESPONSE}h):</strong> ${args.overdueEmergency}<br/>
       <strong>Overdue (high &gt; ${SLA.HIGH_RESPONSE}h):</strong> ${args.overdueHigh}</p>
    <h4 style="margin:18px 0 6px;">By status</h4>
    <table cellpadding="4" cellspacing="0" style="width:100%;border-collapse:collapse;">${statusRows}</table>
    <h4 style="margin:18px 0 6px;">By urgency</h4>
    <table cellpadding="4" cellspacing="0" style="width:100%;border-collapse:collapse;">${urgencyRows}</table>
    <h4 style="margin:18px 0 6px;">Top properties</h4>
    <table cellpadding="4" cellspacing="0" style="width:100%;border-collapse:collapse;">${propRows || '<tr><td>(none)</td></tr>'}</table>
  </td></tr>
  <tr><td style="padding:16px 32px;background:#f9fafb;color:#6b7280;font-size:12px;">— Property Maintenance Agent</td></tr>
</table></body></html>`;
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default new LuaJob({
  name: 'daily-workload-report',
  description:
    'Weekday 09:00: aggregate open tickets + escalations + overdue counts and send to the manager via email + in-app.',
  schedule: { type: 'cron', expression: '0 9 * * 1-5' },

  execute: async (_job) => {
    const now = Date.now();

    try {
      const [ticketsRes, escalationsRes] = await Promise.all([
        Tickets.get({}, 1, 1000),
        Escalations.get({}, 1, 500)
      ]);

      const tickets = ((ticketsRes as any)?.data ?? []).map(flat);
      const escalations = ((escalationsRes as any)?.data ?? []).map(flat);

      const byStatus: Record<string, number> = {};
      const byUrgency: Record<string, number> = {};
      const byProperty: Record<string, number> = {};

      let totalOpen = 0;
      let overdueEmergency = 0;
      let overdueHigh = 0;

      for (const t of tickets) {
        const status = String(t.status ?? 'unknown');
        if (TERMINAL_STATUSES.has(status)) continue;
        totalOpen++;

        byStatus[status] = (byStatus[status] ?? 0) + 1;

        const urgency = String(t.urgency ?? 'low');
        byUrgency[urgency] = (byUrgency[urgency] ?? 0) + 1;

        const propName = String(t.propertyName ?? '(unassigned)');
        byProperty[propName] = (byProperty[propName] ?? 0) + 1;

        const age = hoursSince(t.createdAt, now);
        if (
          urgency === Urgency.EMERGENCY &&
          age !== null &&
          age > SLA.EMERGENCY_RESPONSE &&
          OPEN_FOR_OVERDUE_EMERGENCY.has(status)
        ) {
          overdueEmergency++;
        }
        if (
          urgency === Urgency.HIGH &&
          age !== null &&
          age > SLA.HIGH_RESPONSE &&
          OPEN_FOR_OVERDUE_HIGH.has(status)
        ) {
          overdueHigh++;
        }
      }

      const propertyList = Object.entries(byProperty)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

      const openEscalations = escalations.filter(
        (e: any) => e.status === 'open' || e.status === 'in_review'
      ).length;

      const reportDate = new Date(now).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });

      const summaryArgs = {
        reportDate,
        totalOpen,
        byStatus,
        byUrgency,
        byProperty: propertyList,
        openEscalations,
        overdueEmergency,
        overdueHigh
      };

      const textSummary = renderText(summaryArgs);
      const htmlSummary = renderHtml(summaryArgs);

      const managerEmail = env('MANAGER_EMAIL');
      const managerUserId = env('MANAGER_USER_ID');

      if (managerEmail) {
        try {
          const { sendEmail } = await import('../utils/email-notifications.js');
          await sendEmail({
            to: managerEmail,
            subject: `Daily maintenance report — ${reportDate}`,
            html: htmlSummary,
            text: textSummary
          });
        } catch (mailErr) {
          console.error('[daily-report] manager email failed:', mailErr);
        }
      } else {
        console.log('[daily-report] MANAGER_EMAIL not set — skipping email');
      }

      if (managerUserId) {
        try {
          const u: any = await User.get(managerUserId);
          if (u?.send) {
            await u.send([{ type: 'text', text: textSummary }]);
          }
        } catch (sendErr) {
          console.error('[daily-report] in-app send failed:', sendErr);
        }
      }

      console.log(
        `[daily-report] ${reportDate}: ${totalOpen} open, ${openEscalations} escalations, ${overdueEmergency}+${overdueHigh} overdue`
      );
    } catch (err) {
      console.error('[daily-report] job failed:', err);
    }
  }
});
