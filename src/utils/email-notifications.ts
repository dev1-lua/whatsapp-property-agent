/**
 * Email sender wrapper — stubbed for the demo.
 *
 * In production, swap the body of `sendEmail` to call Lua's native Email channel
 * via `User.send()` to a user with a known email, OR plug in AgentMail / SMTP.
 *
 * For the demo we log to console and write a `communications` audit row so the
 * admin UI can show that the email "was sent" even when no real SMTP is wired up.
 */

import { logCommunication } from './communication-log.js';

export interface SendEmailInput {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  ticketId?: string;
}

export async function sendEmail(input: SendEmailInput): Promise<{ delivered: boolean; error?: string }> {
  const { to, subject, html, text, ticketId } = input;

  if (!to) return { delivered: false, error: 'no recipient' };

  console.log(`[email] → ${to} | ${subject}`);

  await logCommunication({
    ticketId,
    direction: 'Outbound',
    channel: 'Email',
    senderType: 'Agent',
    senderName: 'Property Maintenance Agent',
    recipient: to,
    subject,
    body: html || text || '',
    contentType: html ? 'HTML' : 'Plain Text',
    delivery: 'sent'
  });

  return { delivered: true };
}
