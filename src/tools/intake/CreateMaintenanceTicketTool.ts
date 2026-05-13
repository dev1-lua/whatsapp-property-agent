/**
 * create_maintenance_ticket — central intake.
 *
 * Auto-classifies issue type and urgency from the description (if not provided),
 * runs a duplicate-detection pass (same property + issue type, status not in
 * a terminal/cancelled set), generates a display ticketId, persists the ticket,
 * tries to auto-assign the first active vendor whose specialties include the
 * issue type, and fires notification emails to the vendor + tenant.
 *
 * Spec: docs/info/03-TOOLS.md (Intake section)
 */

import { LuaTool, User } from 'lua-cli';
import { z } from 'zod';
import { Tickets, Vendors } from '../../services/data.js';
import {
  TicketStatus,
  IssueType,
  Urgency,
  ActorType,
  EventType
} from '../../utils/constants.js';
import {
  classifyIssueType,
  assessUrgency,
  nextStepsByUrgency
} from '../../utils/ticket-helpers.js';
import { logEvent, logStatusChange } from '../../utils/audit-log.js';
import { generateTicketId } from '../../utils/ticket-id.js';
import { sendEmail } from '../../utils/email-notifications.js';
import {
  vendorJobAssignedEmail,
  tenantTicketCreatedEmail
} from '../../utils/email-templates.js';
import { logCommunication } from '../../utils/communication-log.js';

const ACTIVE_TICKET_STATUSES: string[] = [
  TicketStatus.REPORTED,
  TicketStatus.VENDOR_CONTACTED,
  TicketStatus.QUOTED,
  TicketStatus.PENDING_APPROVAL,
  TicketStatus.APPROVED,
  TicketStatus.IN_PROGRESS,
  TicketStatus.ON_HOLD,
  TicketStatus.DISPUTED
];

function searchTextFor(ticket: Record<string, any>): string {
  return [
    ticket.description,
    ticket.propertyName,
    ticket.issueType,
    ticket.location || ''
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
}

async function findActiveVendorFor(issueType: string): Promise<any | null> {
  try {
    const res: any = await Vendors.get({ active: true }, 1, 500);
    const candidates = (res?.data ?? []).filter((entry: any) => {
      const specialties: string[] = entry?.data?.specialties ?? [];
      return specialties.includes(issueType);
    });
    if (candidates.length > 0) return { id: candidates[0].id, ...(candidates[0].data ?? {}) };

    // No specialty match — fall back to any active vendor
    const allActive = (res?.data ?? []);
    if (allActive.length > 0) return { id: allActive[0].id, ...(allActive[0].data ?? {}) };
  } catch (err) {
    console.error('Vendor lookup failed (non-fatal):', err);
  }
  return null;
}

export class CreateMaintenanceTicketTool implements LuaTool {
  name = 'create_maintenance_ticket';
  description =
    'Create a new maintenance ticket. Auto-classifies issue type and urgency from the description when not provided. Performs duplicate detection (same property + open issue of same type). Auto-assigns an active vendor whose specialties match. Returns the display ticketId and assignment details.';

  inputSchema = z.object({
    propertyCode: z
      .string()
      .describe('Property code — usually from get_user_context cache.'),
    propertyName: z.string().describe('Property name for display.'),
    propertyId: z.string().describe('Data id of the property (from get_user_context or tenants record).'),
    tenantId: z.string().describe('Data id of the tenant (tenants.id).'),
    tenantName: z.string().describe('Tenant full name.'),
    tenantPhone: z.string().optional().describe('Tenant phone, optional.'),
    tenantEmail: z.string().optional().describe('Tenant email, optional. If present, a confirmation email is sent.'),
    unit: z.string().optional().describe('Unit/apartment label, optional.'),
    issueType: z
      .enum(['plumbing', 'electrical', 'hvac', 'appliance', 'structural', 'other'])
      .optional()
      .describe('Issue category. If omitted, classified from the description.'),
    description: z.string().describe('Detailed description of the maintenance issue.'),
    location: z.string().optional().describe('Location within the property (e.g., "kitchen", "bathroom").'),
    urgency: z
      .enum(['low', 'medium', 'high', 'emergency'])
      .optional()
      .describe('Urgency level. If omitted, inferred from the description.'),
    tenantAccessNotes: z
      .string()
      .optional()
      .describe('Access instructions / availability windows for the vendor.'),
    imageUrls: z
      .array(z.string())
      .optional()
      .describe('CDN URLs of photos showing the issue (already uploaded).'),
    relatedTicketId: z
      .string()
      .optional()
      .describe('Display ticketId of a related/recurring issue, optional.'),
    skipDuplicateCheck: z
      .boolean()
      .optional()
      .describe('Set true to bypass the open-duplicate check (when user confirms it is a separate issue).')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const user: any = await User.get();
      const tenantUserId: string | undefined =
        user?._luaProfile?.userId ?? user?.id ?? undefined;

      const issueType = (input.issueType ?? classifyIssueType(input.description)) as IssueType;
      const urgency = (input.urgency ?? assessUrgency(input.description)) as Urgency;

      // ============================================================
      // DUPLICATE DETECTION
      // ============================================================
      if (!input.skipDuplicateCheck) {
        try {
          const dupRes: any = await Tickets.get(
            { propertyCode: input.propertyCode, issueType },
            1,
            50
          );
          // Scope duplicates by the SAME UNIT when a unit was provided. Multi-unit
          // buildings (Westgate Court 5C vs 9A) share a propertyCode but the
          // tickets belong to different humans / different sinks. Cross-unit
          // matching produced false-positive duplicate warnings in prod.
          const inputUnit = (input.unit ?? '').trim().toLowerCase();
          const inputTenantId = (input.tenantId ?? '').trim();
          const duplicates = (dupRes?.data ?? []).filter((entry: any) => {
            const d = entry?.data ?? {};
            const status: string = d.status ?? '';
            if (!ACTIVE_TICKET_STATUSES.includes(status)) return false;
            // If we know the unit, only match same-unit tickets.
            if (inputUnit) {
              const storedUnit = String(d.unit ?? '').trim().toLowerCase();
              if (storedUnit && storedUnit !== inputUnit) return false;
            }
            // If we know the tenant, only match same-tenant tickets (defense in
            // depth: catches whole-building leases with no unit).
            if (inputTenantId) {
              const storedTenant = String(d.tenantId ?? '').trim();
              if (storedTenant && storedTenant !== inputTenantId) return false;
            }
            return true;
          });

          if (duplicates.length > 0) {
            const list = duplicates.slice(0, 3).map((e: any) => ({
              ticketId: e.data?.ticketId,
              status: e.data?.status,
              description: (e.data?.description ?? '').slice(0, 140)
            }));
            return {
              success: false,
              warning: 'duplicate_detected',
              duplicateTickets: list,
              message: `An open ${issueType} ticket already exists for ${input.propertyCode}${inputUnit ? ` unit ${input.unit}` : ''}: ${list[0].ticketId}. If this is intentionally a different issue, retry with skipDuplicateCheck=true.`
            };
          }
        } catch (err) {
          // Non-fatal — proceed
          console.error('Duplicate check failed (non-fatal):', err);
        }
      }

      // ============================================================
      // BUILD TICKET ROW
      // ============================================================
      const ticketId = generateTicketId();
      const now = new Date().toISOString();

      const ticket: Record<string, any> = {
        ticketId,
        status: TicketStatus.REPORTED,

        propertyId: input.propertyId,
        propertyCode: input.propertyCode,
        propertyName: input.propertyName,
        unit: input.unit,

        tenantId: input.tenantId,
        tenantUserId,
        tenantName: input.tenantName,
        tenantPhone: input.tenantPhone,
        tenantEmail: input.tenantEmail,
        tenantAccessNotes: input.tenantAccessNotes,

        issueType,
        urgency,
        description: input.description,
        location: input.location,
        images: input.imageUrls ?? [],
        relatedTicketId: input.relatedTicketId,

        approval: {
          required: false,
          requestedAt: null,
          approvedBy: null,
          approvedAt: null,
          approvedAmount: null,
          comments: null,
          conditions: [],
          externalRequestId: null
        },

        completionImages: [],

        createdAt: now,
        updatedAt: now
      };

      const createdEntry: any = await Tickets.create(ticket, searchTextFor(ticket));
      const ticketDataId: string = createdEntry?.id;

      await logEvent({
        ticketId,
        ticketDataId,
        eventType: EventType.TICKET_CREATED,
        actorType: ActorType.TENANT,
        actorId: tenantUserId,
        actorName: input.tenantName,
        payload: {
          propertyCode: input.propertyCode,
          propertyName: input.propertyName,
          issueType,
          urgency,
          description: input.description
        }
      });

      // ============================================================
      // AUTO-ASSIGN VENDOR
      // ============================================================
      let assignedVendor: { id: string; name: string } | null = null;
      try {
        const vendor = await findActiveVendorFor(issueType);
        if (vendor) {
          const assignedAt = new Date().toISOString();
          const updated: Record<string, any> = {
            ...ticket,
            status: TicketStatus.VENDOR_CONTACTED,
            assignedVendorId: vendor.id,
            assignedVendorName: vendor.name ?? vendor.companyName,
            assignedVendorPhone: Array.isArray(vendor.phones) ? vendor.phones[0] : undefined,
            assignedVendorUserId: vendor.userId,
            vendorAssignedAt: assignedAt,
            vendorRequestedAt: assignedAt,
            updatedAt: assignedAt
          };

          await Tickets.update(ticketDataId, updated, searchTextFor(updated));

          assignedVendor = {
            id: vendor.id,
            name: updated.assignedVendorName ?? ''
          };

          await logStatusChange({
            ticketId,
            ticketDataId,
            fromStatus: TicketStatus.REPORTED,
            toStatus: TicketStatus.VENDOR_CONTACTED,
            actorType: ActorType.AGENT,
            actorId: tenantUserId,
            reason: `Auto-assigned vendor: ${assignedVendor.name}`
          });

          await logEvent({
            ticketId,
            ticketDataId,
            eventType: EventType.VENDOR_CONTACTED,
            actorType: ActorType.AGENT,
            actorId: tenantUserId,
            payload: {
              vendorId: vendor.id,
              vendorName: assignedVendor.name,
              autoAssigned: true
            }
          });

          // WhatsApp-ping the vendor (primary channel)
          if (vendor.userId) {
            try {
              const vendorUser: any = await User.get(vendor.userId);
              if (vendorUser) {
                const pingText =
                  `New job assigned: ${ticketId}\n` +
                  `Property: ${input.propertyName}${input.unit ? ` (${input.unit})` : ''}\n` +
                  `Issue: ${issueType} • ${urgency.toUpperCase()}\n` +
                  `${input.description}\n\n` +
                  `Reply "accept ${ticketId}" to take it, or "decline ${ticketId}" if you can't.`;
                const msgs: any[] = [{ type: 'text', text: pingText }];
                const firstImage = (input.imageUrls ?? [])[0];
                if (firstImage) {
                  msgs.push({ type: 'text', text: `Photo: ${firstImage}` });
                }
                await vendorUser.send(msgs);
                await logCommunication({
                  ticketId,
                  direction: 'Outbound',
                  channel: 'WhatsApp',
                  senderType: 'Agent',
                  senderName: 'Property Maintenance Agent',
                  recipient: vendor.userId,
                  subject: `Job assigned: ${ticketId}`,
                  body: pingText,
                  contentType: 'Plain Text',
                  delivery: 'sent'
                });
              }
            } catch (err) {
              console.error('Vendor WhatsApp ping failed (non-fatal):', err);
            }
          }

          // Email the vendor (fallback / audit trail when no WhatsApp userId)
          if (vendor.email) {
            try {
              const tpl = vendorJobAssignedEmail({
                ticketId,
                propertyName: input.propertyName,
                issueType,
                urgency,
                description: input.description,
                location: input.location,
                tenantAccessNotes: input.tenantAccessNotes ?? null,
                images: input.imageUrls ?? []
              });
              await sendEmail({
                to: vendor.email,
                subject: tpl.subject,
                html: tpl.html,
                ticketId
              });
            } catch (err) {
              console.error('Vendor email failed (non-fatal):', err);
            }
          }
        }
      } catch (err) {
        console.error('Auto-assign failed (non-fatal):', err);
      }

      // ============================================================
      // TENANT CONFIRMATION EMAIL
      // ============================================================
      if (input.tenantEmail) {
        try {
          const tpl = tenantTicketCreatedEmail({
            ticketId,
            propertyName: input.propertyName,
            issueType,
            urgency,
            description: input.description,
            vendorName: assignedVendor?.name
          });
          await sendEmail({
            to: input.tenantEmail,
            subject: tpl.subject,
            html: tpl.html,
            ticketId
          });
        } catch (err) {
          console.error('Tenant email failed (non-fatal):', err);
        }
      }

      const finalStatus = assignedVendor
        ? TicketStatus.VENDOR_CONTACTED
        : TicketStatus.REPORTED;
      const nextSteps = nextStepsByUrgency(urgency);

      return {
        success: true,
        ticketId,
        status: finalStatus,
        issueType,
        urgency,
        propertyName: input.propertyName,
        createdAt: now,
        imageCount: (input.imageUrls ?? []).length,
        assignedVendor,
        nextSteps,
        message: assignedVendor
          ? `Ticket ${ticketId} created and assigned to ${assignedVendor.name}. ${nextSteps}`
          : `Ticket ${ticketId} created. ${nextSteps}`
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message ?? String(err),
        message: 'Failed to create maintenance ticket. Please try again.'
      };
    }
  }
}

export default CreateMaintenanceTicketTool;
