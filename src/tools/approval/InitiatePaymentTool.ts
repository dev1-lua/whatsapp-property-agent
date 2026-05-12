/**
 * Initiate vendor payment — stubbed Stripe call for the demo. Sets
 * `ticket.payment` to a `processing` state with a fake PaymentIntent ID.
 * No real Stripe call is made.
 */

import { LuaTool, User } from 'lua-cli';
import { z } from 'zod';
import { Tickets } from '../../services/data.js';
import { ActorType, EventType } from '../../utils/constants.js';
import { logEvent } from '../../utils/audit-log.js';

export class InitiatePaymentTool implements LuaTool {
  name = 'initiate_payment';
  description = 'Initiate vendor payment for a ticket (Stripe is stubbed for the demo). Marks ticket.payment as processing with a fake payment intent ID.';

  inputSchema = z.object({
    ticketId: z.string().describe('Display ticket ID, e.g. MT-2605-A8F2K9'),
    amount: z.number().positive().describe('Payment amount in firm currency (e.g. 250.00)'),
    currency: z.string().optional().describe('Three-letter ISO currency code (default EUR)')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const { ticketId, amount, currency } = input;

      const result = await Tickets.get({ ticketId });
      const entry = result?.data?.[0];
      const ticket: any = entry?.data;

      if (!entry || !ticket) {
        return {
          success: false,
          error: 'ticket_not_found',
          message: `Ticket ${ticketId} not found.`
        };
      }

      const now = new Date().toISOString();
      const stripePaymentIntentId = `pi_demo_${Math.random().toString(36).slice(2, 12)}`;

      const payment = {
        status: 'processing' as const,
        stripePaymentIntentId,
        amount,
        currency: currency ?? 'EUR',
        initiatedAt: now
      };

      await Tickets.update(entry.id, {
        ...ticket,
        payment,
        updatedAt: now
      });

      const user = await User.get();
      const userId = user?._luaProfile?.userId ?? user?.id;

      await logEvent({
        ticketId,
        ticketDataId: entry.id,
        eventType: EventType.PAYMENT_INITIATED,
        actorType: ActorType.AGENT,
        actorId: userId,
        payload: {
          amount,
          currency: payment.currency,
          stripePaymentIntentId
        }
      });

      return {
        success: true,
        ticketId,
        paymentStatus: 'processing' as const,
        paymentIntentId: stripePaymentIntentId,
        message: `Payment of ${payment.currency}${amount.toFixed(2)} initiated for ticket ${ticketId}. Stripe intent: ${stripePaymentIntentId} (demo stub).`
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message ?? String(err),
        message: 'Failed to initiate payment.'
      };
    }
  }
}

export default InitiatePaymentTool;
