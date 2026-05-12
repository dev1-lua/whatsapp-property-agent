/**
 * inbound-email webhook — receives an inbound email payload from an SMTP /
 * AgentMail gateway, logs the inbound communication, and attempts to identify
 * the sender against Tenants / Vendors.
 *
 * v2 keeps this lean: we persist the communication row and resolve identity
 * so other primitives (escalation, daily report, communication-log) can
 * stitch it together. Cross-channel dispatch (re-injecting the email as a
 * chat turn) is intentionally out of scope here — it's wired separately.
 *
 * Body:
 *   {
 *     from: string,                     // "Name <addr>" or plain "addr"
 *     to: string,
 *     subject: string,
 *     body: string,
 *     attachments?: [{ url, filename, contentType }]
 *   }
 *
 * Response:
 *   { success: true, identified: boolean, senderType?, senderId?, senderName?, ticketId? | null, message }
 *   { success: false, error, message }
 */

import { LuaWebhook } from 'lua-cli';
import { Tenants, Vendors } from '../services/data.js';
import { logCommunication } from '../utils/communication-log.js';
import { normalizeEmail } from '../utils/identity.js';

const TICKET_ID_RE = /MT-\d{4}-[A-Z0-9]{6}/i;

function parseFromHeader(from: any): { email: string; name: string } {
  if (!from) return { email: '', name: '' };
  const raw = String(from).trim();
  const m = raw.match(/<([^>]+)>/);
  if (m) {
    return {
      email: normalizeEmail(m[1]),
      name: raw.replace(/<[^>]+>/, '').trim().replace(/^"|"$/g, '') || m[1]
    };
  }
  return { email: normalizeEmail(raw), name: raw };
}

async function findByEmail(
  collection: typeof Tenants,
  email: string
): Promise<{ id: string; data: any } | null> {
  if (!email) return null;
  try {
    const res: any = await collection.get({ email }, 1, 5);
    const hit = (res?.data ?? [])[0];
    if (hit) return { id: hit.id, data: hit.data ?? hit };
  } catch {
    // ignore — fall through to search
  }
  return null;
}

export default new LuaWebhook({
  name: 'inbound-email',
  description:
    'Receives inbound emails (AgentMail / SMTP gateway). Logs the communication and resolves sender to tenant or vendor.',
  execute: async (event) => {
    const body: any = event?.body ?? {};
    const { from, to, subject, body: messageBody, attachments } = body;

    if (!from) {
      return {
        success: false,
        error: 'validation',
        message: 'Missing "from" field'
      };
    }
    if (!messageBody && !subject) {
      return {
        success: false,
        error: 'validation',
        message: 'Email has no subject or body'
      };
    }

    try {
      const parsed = parseFromHeader(from);
      const text = String(messageBody ?? '');
      const subj = String(subject ?? '');

      // Try to resolve identity against tenants then vendors
      let senderType: 'Tenant' | 'Vendor' | null = null;
      let senderId: string | undefined;
      let senderName: string = parsed.name || parsed.email || 'unknown';

      if (parsed.email) {
        const tenant = await findByEmail(Tenants as any, parsed.email);
        if (tenant) {
          senderType = 'Tenant';
          senderId = tenant.id;
          senderName = tenant.data?.name || senderName;
        } else {
          const vendor = await findByEmail(Vendors as any, parsed.email);
          if (vendor) {
            senderType = 'Vendor';
            senderId = vendor.id;
            senderName = vendor.data?.name || senderName;
          }
        }
      }

      // Look for a ticket id in subject or body
      const ticketMatch =
        subj.match(TICKET_ID_RE) || text.match(TICKET_ID_RE);
      const ticketId = ticketMatch ? ticketMatch[0].toUpperCase() : undefined;

      const attachmentCount = Array.isArray(attachments) ? attachments.length : 0;
      const persistedBody = attachmentCount
        ? `${text}\n\n[${attachmentCount} attachment(s)]`
        : text;

      await logCommunication({
        ticketId,
        direction: 'Inbound',
        channel: 'Email',
        senderType: senderType ?? 'Tenant',
        senderName,
        senderId,
        recipient: typeof to === 'string' ? normalizeEmail(to) : undefined,
        subject: subj,
        body: persistedBody,
        contentType: 'Plain Text',
        delivery: 'received'
      });

      return {
        success: true,
        identified: senderType !== null,
        senderType,
        senderId,
        senderName,
        senderEmail: parsed.email,
        ticketId: ticketId ?? null,
        message: senderType
          ? `Inbound email logged from ${senderType.toLowerCase()} ${senderName}${ticketId ? ` re ${ticketId}` : ''}.`
          : `Inbound email logged from unknown sender ${parsed.email || parsed.name}${ticketId ? ` re ${ticketId}` : ''}.`
      };
    } catch (err: any) {
      console.error('inbound-email webhook error:', err);
      return {
        success: false,
        error: 'unexpected',
        message: err?.message || 'Failed to process inbound email'
      };
    }
  }
});
