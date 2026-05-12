/**
 * upload_issue_images — append already-uploaded CDN URLs to a ticket's images[].
 *
 * CDN.upload is called by the agent/skill harness; this tool just persists the
 * resulting URLs against the ticket and validates the per-ticket max of 10.
 */

import { LuaTool, User } from 'lua-cli';
import { z } from 'zod';
import { Tickets } from '../../services/data.js';
import { ActorType, EventType } from '../../utils/constants.js';
import { logEvent } from '../../utils/audit-log.js';

const MAX_IMAGES = 10;

export class UploadIssueImagesTool implements LuaTool {
  name = 'upload_issue_images';
  description =
    'Attach photo URLs (already uploaded to the CDN) to an existing maintenance ticket. Validates the ticket exists and that the total photo count stays at or below 10. Returns the new total image count.';

  inputSchema = z.object({
    ticketId: z
      .string()
      .describe('Display ticket ID (e.g., "MT-2605-A8F2K9").'),
    imageUrls: z
      .array(z.string())
      .min(1)
      .describe('Array of CDN URLs to append to the ticket. Each URL should already be hosted on the CDN.')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const { ticketId, imageUrls } = input;

      const lookup: any = await Tickets.get({ ticketId }, 1, 1);
      const entry: any = lookup?.data?.[0];
      if (!entry) {
        return {
          success: false,
          error: 'ticket_not_found',
          message: `Ticket ${ticketId} not found.`
        };
      }

      const existing: string[] = Array.isArray(entry.data?.images) ? entry.data.images : [];
      const total = existing.length + imageUrls.length;
      if (total > MAX_IMAGES) {
        return {
          success: false,
          error: 'too_many_images',
          totalImages: existing.length,
          message: `Cannot add ${imageUrls.length} image(s). Ticket already has ${existing.length}; max is ${MAX_IMAGES}.`
        };
      }

      const merged = [...existing, ...imageUrls];
      const updatedAt = new Date().toISOString();

      await Tickets.update(entry.id, {
        ...entry.data,
        images: merged,
        updatedAt
      });

      const user: any = await User.get();
      const userId: string | undefined = user?._luaProfile?.userId ?? user?.id;

      await logEvent({
        ticketId,
        ticketDataId: entry.id,
        eventType: EventType.IMAGES_UPLOADED,
        actorType: ActorType.TENANT,
        actorId: userId,
        payload: {
          addedCount: imageUrls.length,
          totalImages: merged.length,
          addedUrls: imageUrls
        }
      });

      return {
        success: true,
        ticketId,
        addedUrls: imageUrls,
        totalImages: merged.length,
        message: `Added ${imageUrls.length} image(s) to ticket ${ticketId}. Total now ${merged.length}.`
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message ?? String(err),
        message: 'Failed to attach images to the ticket.'
      };
    }
  }
}

export default UploadIssueImagesTool;
