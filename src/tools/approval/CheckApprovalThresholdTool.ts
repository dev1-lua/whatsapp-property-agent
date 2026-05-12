/**
 * Pure threshold check — compares a quote amount against `APPROVAL_THRESHOLD`
 * (env, default 500). No DB lookups. Returns whether finance approval is
 * required or the amount qualifies for auto-approval.
 */

import { LuaTool, env } from 'lua-cli';
import { z } from 'zod';
import { DEFAULT_APPROVAL_THRESHOLD } from '../../utils/constants.js';

export class CheckApprovalThresholdTool implements LuaTool {
  name = 'check_approval_threshold';
  description = 'Pure logic check — compares a quote amount against the configured approval threshold. Returns whether finance approval is required and whether the amount auto-approves. No DB calls.';

  inputSchema = z.object({
    quoteAmount: z.number().describe('The vendor quote amount to evaluate (in firm currency)'),
    ticketId: z.string().optional().describe('Optional display ticket ID for context — not used in calculation')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const { quoteAmount } = input;
      const threshold = Number(env('APPROVAL_THRESHOLD')) || DEFAULT_APPROVAL_THRESHOLD;

      const requiresApproval = quoteAmount > threshold;
      const autoApproved = !requiresApproval;

      return {
        success: true,
        requiresApproval,
        threshold,
        amount: quoteAmount,
        autoApproved,
        message: autoApproved
          ? `Quote of ${quoteAmount} is within the auto-approval threshold of ${threshold}. No finance review needed.`
          : `Quote of ${quoteAmount} exceeds the ${threshold} threshold. Finance approval required.`
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message ?? String(err),
        message: 'Failed to evaluate approval threshold.'
      };
    }
  }
}

export default CheckApprovalThresholdTool;
