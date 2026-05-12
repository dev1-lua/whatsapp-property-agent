/**
 * communication-log postprocessor
 *
 * Persists every outbound agent reply to the `communications` collection so
 * the admin console + escalation/daily-report jobs can reconstruct the full
 * conversation history per tenant / vendor / ticket.
 *
 * Always returns the response unchanged.
 */

import { PostProcessor } from 'lua-cli';
import { logCommunication, type CommChannel } from '../utils/communication-log.js';

const TICKET_ID_RE = /MT-\d{4}-[A-Z0-9]{6}/i;

function inferChannel(channel: string | undefined): CommChannel {
  switch (String(channel ?? '').toLowerCase()) {
    case 'whatsapp':
      return 'WhatsApp';
    case 'email':
      return 'Email';
    case 'sms':
      return 'SMS';
    default:
      return 'Chat';
  }
}

function pickRecipient(user: any): string | undefined {
  if (!user) return undefined;
  const profile = user._luaProfile ?? {};
  return (
    profile.phone ||
    profile.email ||
    user.phone ||
    user.email ||
    profile.userId ||
    user.id ||
    user.userId ||
    undefined
  );
}

function extractText(val: any): string {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) {
    return val
      .map((item: any) => {
        if (typeof item === 'string') return item;
        if (item?.text) return item.text;
        if (item?.content) return item.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (val?.text) return val.text;
  if (val?.content) return val.content;
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

export default new PostProcessor({
  name: 'communication-log',
  description:
    'Write every outbound agent response as a Communication row (direction=Outbound) for audit + dashboard.',

  execute: async (user, message, response, channel) => {
    try {
      const responseText = extractText(response);
      if (!responseText) {
        return { modifiedResponse: response };
      }

      const ticketMatch = responseText.match(TICKET_ID_RE);
      const ticketId = ticketMatch ? ticketMatch[0].toUpperCase() : undefined;

      await logCommunication({
        ticketId,
        direction: 'Outbound',
        channel: inferChannel(channel as any),
        senderType: 'Agent',
        senderName: 'Property Maintenance Agent',
        recipient: pickRecipient(user),
        body: responseText,
        contentType: 'Plain Text',
        delivery: 'sent'
      });
    } catch (err) {
      console.error('communication-log postprocessor error:', err);
    }

    return { modifiedResponse: response };
  }
});
