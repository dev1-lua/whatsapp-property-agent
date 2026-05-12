/**
 * upload_vendor_photos — append vendor-provided photo URLs to a ticket.
 *
 * Appends to ticket.images (type='progress') or ticket.completionImages
 * (type='completion'). Returns the list of added URLs and the new total.
 *
 * Note: photos are expected to be already uploaded to the CDN — this tool
 * just records the resulting URLs against the ticket.
 */

import { LuaTool, User } from 'lua-cli';
import { z } from 'zod';
import { Tickets } from '../../services/data.js';
import { logEvent } from '../../utils/audit-log.js';
import { ActorType, EventType } from '../../utils/constants.js';

export class UploadVendorPhotosTool implements LuaTool {
  name = 'upload_vendor_photos';
  description = `Records vendor-supplied photo URLs against a ticket. Use type='progress' for in-progress shots (appended to ticket.images) or type='completion' for finished-work shots (appended to ticket.completionImages).`;

  inputSchema = z.object({
    ticketId: z.string().describe('Display ticket ID (e.g. MT-2605-A8F2K9)'),
    vendorId: z
      .string()
      .optional()
      .describe('Vendor entry id (falls back to the cached identity set by get_user_context)'),
    type: z
      .enum(['progress', 'completion'])
      .describe("Which collection to append to: 'progress' → ticket.images, 'completion' → ticket.completionImages"),
    imageUrls: z
      .array(z.string())
      .min(1)
      .describe('One or more CDN URLs to append to the ticket')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const vendorId = await resolveVendorId(input.vendorId);
      if (!vendorId) {
        return {
          success: false,
          error: 'no vendor identity',
          message: 'Could not resolve vendor identity. Call get_user_context first or pass vendorId.',
          addedUrls: [],
          totalImages: 0
        };
      }

      const validUrls = (input.imageUrls || []).filter(
        (u) => typeof u === 'string' && u.trim().length > 0
      );
      if (validUrls.length === 0) {
        return {
          success: false,
          error: 'no urls',
          message: 'At least one non-empty image URL is required.',
          addedUrls: [],
          totalImages: 0
        };
      }

      const ticket = await findTicketByDisplayId(input.ticketId);
      if (!ticket) {
        return {
          success: false,
          error: 'ticket not found',
          message: `No ticket found with id ${input.ticketId}.`,
          addedUrls: [],
          totalImages: 0
        };
      }

      if (!ticket.assignedVendorId || ticket.assignedVendorId !== vendorId) {
        return {
          success: false,
          error: 'not assigned to you',
          message: 'You are not assigned to this ticket.',
          addedUrls: [],
          totalImages: 0
        };
      }

      const field = input.type === 'completion' ? 'completionImages' : 'images';
      const existing: string[] = Array.isArray(ticket[field]) ? ticket[field] : [];
      const updated = [...existing, ...validUrls];
      const now = new Date().toISOString();

      await Tickets.update(ticket.id, {
        [field]: updated,
        updatedAt: now
      });

      await logEvent({
        ticketId: ticket.ticketId,
        ticketDataId: ticket.id,
        eventType: EventType.IMAGES_UPLOADED,
        actorType: ActorType.VENDOR,
        actorId: vendorId,
        actorName: ticket.assignedVendorName,
        payload: {
          type: input.type,
          addedCount: validUrls.length,
          totalCount: updated.length,
          field
        }
      });

      return {
        success: true,
        addedUrls: validUrls,
        totalImages: updated.length,
        message: `Added ${validUrls.length} ${input.type} photo(s) to ${ticket.ticketId}. Total ${input.type === 'completion' ? 'completion ' : ''}images: ${updated.length}.`
      };
    } catch (err: any) {
      console.error('upload_vendor_photos error:', err);
      return {
        success: false,
        error: 'unexpected',
        message: `Could not record photos: ${err?.message ?? 'unknown error'}`,
        addedUrls: [],
        totalImages: 0
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

export default UploadVendorPhotosTool;
