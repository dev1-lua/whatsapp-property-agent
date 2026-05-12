/**
 * list_available_jobs — vendor browse
 *
 * Lists tickets matching the calling vendor's specialties that are still open
 * (status `reported` or `vendor_contacted`) and either unassigned or already
 * assigned to this vendor. Returns full details including images so the
 * vendor can decide before claiming.
 */

import { LuaTool, User } from 'lua-cli';
import { z } from 'zod';
import { Tickets, Vendors } from '../../services/data.js';
import { TicketStatus } from '../../utils/constants.js';

export class ListAvailableJobsTool implements LuaTool {
  name = 'list_available_jobs';
  description = `Lists maintenance jobs available for the calling vendor to claim. Returns full details (description, location, urgency, images, tenant access notes) for jobs matching the vendor's specialties that are unassigned or already pending claim by this vendor.`;

  inputSchema = z.object({
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
          message: 'Could not resolve vendor identity. Call get_user_context first or pass vendorId.',
          jobs: [],
          count: 0
        };
      }

      const vendorEntry = await Vendors.getEntry(vendorId).catch(() => null);
      if (!vendorEntry) {
        return {
          success: false,
          error: 'vendor not found',
          message: `No vendor found for id ${vendorId}.`,
          jobs: [],
          count: 0
        };
      }
      const vendor: any = vendorEntry.data ?? vendorEntry;
      const specialties: string[] = Array.isArray(vendor.specialties)
        ? vendor.specialties.map((s: string) => String(s).toLowerCase())
        : [];

      // Pull both statuses worth of tickets in parallel; merge.
      const [reportedRes, contactedRes] = await Promise.all([
        Tickets.get({ status: TicketStatus.REPORTED }).catch(() => ({ data: [] })),
        Tickets.get({ status: TicketStatus.VENDOR_CONTACTED }).catch(() => ({ data: [] }))
      ]);

      const candidates: any[] = [
        ...((reportedRes as any)?.data ?? []),
        ...((contactedRes as any)?.data ?? [])
      ];

      const jobs = candidates
        .map((entry: any) => ({ id: entry.id, ...(entry.data ?? entry) }))
        .filter((t: any) => {
          const issueType = String(t.issueType ?? '').toLowerCase();
          const matchesSpecialty = specialties.length === 0 || specialties.includes(issueType);
          const claimable =
            !t.assignedVendorId || t.assignedVendorId === vendorId;
          return matchesSpecialty && claimable;
        })
        .map((t: any) => ({
          id: t.id,
          ticketId: t.ticketId,
          status: t.status,
          issueType: t.issueType,
          urgency: t.urgency,
          description: t.description,
          location: t.location ?? null,
          propertyId: t.propertyId,
          propertyCode: t.propertyCode,
          propertyName: t.propertyName,
          unit: t.unit ?? null,
          images: Array.isArray(t.images) ? t.images : [],
          tenantAccessNotes: t.tenantAccessNotes ?? null,
          assignedVendorId: t.assignedVendorId ?? null,
          createdAt: t.createdAt
        }));

      return {
        success: true,
        message:
          jobs.length > 0
            ? `Found ${jobs.length} job(s) matching your specialties (${specialties.join(', ') || 'all'}).`
            : 'No jobs matching your specialties right now. Check back later.',
        jobs,
        count: jobs.length,
        vendorSpecialties: specialties
      };
    } catch (err: any) {
      console.error('list_available_jobs error:', err);
      return {
        success: false,
        error: 'unexpected',
        message: `Could not list available jobs: ${err?.message ?? 'unknown error'}`,
        jobs: [],
        count: 0
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

export default ListAvailableJobsTool;
