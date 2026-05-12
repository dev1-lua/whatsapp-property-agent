/**
 * Outbound + inbound communication logger — writes to the `communications`
 * collection so every message the agent sends or receives is queryable.
 */

import { Communications } from '../services/data.js';

export type CommDirection = 'Inbound' | 'Outbound';
export type CommChannel = 'Chat' | 'Email' | 'SMS' | 'WhatsApp';
export type CommSenderType = 'Tenant' | 'Vendor' | 'Agent' | 'Finance' | 'Manager';
export type CommContentType = 'Plain Text' | 'HTML' | 'Markdown';
export type CommDelivery = 'queued' | 'sent' | 'failed' | 'received';

export interface CommunicationInput {
  ticketId?: string;
  direction: CommDirection;
  channel: CommChannel;
  senderType: CommSenderType;
  senderName?: string;
  senderId?: string;
  recipient?: string;
  subject?: string;
  body: string;
  contentType?: CommContentType;
  delivery?: CommDelivery;
  deliveryError?: string;
}

export async function logCommunication(input: CommunicationInput): Promise<void> {
  const entry = {
    ticketId: input.ticketId ?? null,
    direction: input.direction,
    channel: input.channel,
    senderType: input.senderType,
    senderName: input.senderName,
    senderId: input.senderId,
    recipient: input.recipient,
    subject: input.subject,
    body: input.body,
    contentType: input.contentType ?? 'Plain Text',
    delivery: input.delivery ?? 'sent',
    deliveryError: input.deliveryError,
    at: new Date().toISOString()
  };

  const searchText = `${input.subject ?? ''} ${input.body}`.slice(0, 500);

  try {
    await Communications.create(entry, searchText);
  } catch (err) {
    console.error('logCommunication failed (non-fatal):', err);
  }
}
