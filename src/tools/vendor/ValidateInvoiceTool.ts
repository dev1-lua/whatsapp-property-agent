/**
 * validate_invoice — pure-logic cross-check of extracted invoice fields
 * against a ticket's expected vendor + approved amount.
 *
 * Used after the agent visually inspects an invoice image and extracts the
 * key fields. Returns a recommendation the LLM can act on.
 */

import { LuaTool, User } from 'lua-cli';
import { z } from 'zod';
import { Tickets, Vendors } from '../../services/data.js';

const TOLERANCE_PCT = 10; // ±10% considered within tolerance

export class ValidateInvoiceTool implements LuaTool {
  name = 'validate_invoice';
  description = `Validates extracted invoice fields against the ticket's expected vendor and approved amount. Returns a recommendation (proceed / revise_quote / override / reject) plus a list of issues. Call this after visually reading an invoice image and extracting the fields.`;

  inputSchema = z.object({
    ticketId: z.string().describe('Display ticket ID (e.g. MT-2605-A8F2K9)'),
    vendorId: z
      .string()
      .optional()
      .describe('Vendor entry id (falls back to the cached identity set by get_user_context)'),
    extractedAmount: z.number().describe('Total amount extracted from the invoice'),
    extractedInvoiceNumber: z.string().describe('Invoice number / reference on the document'),
    extractedVendorName: z.string().describe('Vendor / company name shown on the invoice'),
    extractedDate: z.string().optional().describe('Invoice date as extracted'),
    extractedWorkDescription: z
      .string()
      .optional()
      .describe('Description of the work performed, as shown on the invoice')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const vendorId = await resolveVendorId(input.vendorId);

      const ticket = await findTicketByDisplayId(input.ticketId);
      if (!ticket) {
        return {
          success: false,
          valid: false,
          withinTolerance: false,
          percentVariance: 0,
          issues: [`Ticket ${input.ticketId} not found`],
          recommendation: 'reject' as const,
          message: `No ticket found with id ${input.ticketId}.`
        };
      }

      // Optional vendor lookup for stricter name validation
      let vendorEntry: any = null;
      if (vendorId) {
        vendorEntry = await Vendors.getEntry(vendorId).catch(() => null);
      }
      const vendorRecord: any = vendorEntry?.data ?? vendorEntry ?? null;
      const expectedVendorName: string =
        vendorRecord?.companyName ||
        vendorRecord?.name ||
        ticket.assignedVendorName ||
        '';

      const approvedAmount: number = ticket.approval?.approvedAmount ?? 0;
      const quoteAmount: number = ticket.quote?.amount ?? 0;
      const referenceAmount = approvedAmount > 0 ? approvedAmount : quoteAmount;

      const issues: string[] = [];
      const warnings: string[] = [];

      // --- Amount check
      let percentVariance = 0;
      if (referenceAmount > 0) {
        percentVariance = Math.round(((input.extractedAmount - referenceAmount) / referenceAmount) * 100);
      }
      const withinTolerance = referenceAmount === 0 || Math.abs(percentVariance) <= TOLERANCE_PCT;

      if (referenceAmount === 0) {
        warnings.push('No approved amount or quote on file to compare against.');
      } else if (!withinTolerance) {
        if (percentVariance > 0) {
          issues.push(
            `Invoice amount (${input.extractedAmount}) is ${percentVariance}% over the approved amount (${referenceAmount}); exceeds ±${TOLERANCE_PCT}% tolerance.`
          );
        } else {
          warnings.push(
            `Invoice amount (${input.extractedAmount}) is ${Math.abs(percentVariance)}% under the approved amount (${referenceAmount}); outside ±${TOLERANCE_PCT}% tolerance.`
          );
        }
      }

      // --- Vendor-name check (fuzzy)
      const expectedVendorNorm = String(expectedVendorName).toLowerCase().trim();
      const extractedVendorNorm = input.extractedVendorName.toLowerCase().trim();
      const vendorMatchExact = expectedVendorNorm.length > 0 && expectedVendorNorm === extractedVendorNorm;
      const vendorWords = expectedVendorNorm.split(/\s+/).filter((w) => w.length > 2);
      const vendorOverlap = vendorWords.some((w) => extractedVendorNorm.includes(w));
      const vendorMatches = vendorMatchExact || vendorOverlap || expectedVendorName === '';

      if (!vendorMatches) {
        issues.push(
          `Invoice vendor name "${input.extractedVendorName}" doesn't match expected "${expectedVendorName}".`
        );
      }

      // --- Required-field checks
      if (!input.extractedInvoiceNumber || input.extractedInvoiceNumber.trim() === '') {
        issues.push('Missing invoice number on the document.');
      }
      if (!input.extractedDate) {
        warnings.push('No invoice date extracted.');
      }
      if (!input.extractedWorkDescription) {
        warnings.push('No work description extracted from the invoice.');
      }

      // --- Recommendation
      let recommendation: 'proceed' | 'revise_quote' | 'override' | 'reject';
      if (issues.length === 0 && withinTolerance) {
        recommendation = 'proceed';
      } else if (!vendorMatches) {
        recommendation = 'reject';
      } else if (referenceAmount > 0 && percentVariance > TOLERANCE_PCT) {
        // Amount is over the approved amount by more than tolerance — require revised quote
        recommendation = 'revise_quote';
      } else if (Math.abs(percentVariance) > TOLERANCE_PCT) {
        // Under by a lot — caller can override but a sanity check is wise
        recommendation = 'override';
      } else if (issues.length > 0) {
        recommendation = 'override';
      } else {
        recommendation = 'proceed';
      }

      const valid = issues.length === 0;
      const allIssues = [...issues, ...warnings];

      return {
        success: true,
        valid,
        withinTolerance,
        percentVariance,
        issues: allIssues,
        recommendation,
        ticketId: ticket.ticketId,
        extractedAmount: input.extractedAmount,
        referenceAmount,
        expectedVendorName,
        vendorMatches,
        message: valid && withinTolerance
          ? `Invoice validated. ${recommendation === 'proceed' ? 'Proceed with complete_job.' : `Recommended action: ${recommendation}.`}`
          : `Invoice has ${allIssues.length} issue(s). Recommendation: ${recommendation}.`
      };
    } catch (err: any) {
      console.error('validate_invoice error:', err);
      return {
        success: false,
        valid: false,
        withinTolerance: false,
        percentVariance: 0,
        issues: [err?.message ?? 'unknown error'],
        recommendation: 'reject' as const,
        message: `Could not validate invoice: ${err?.message ?? 'unknown error'}`
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

export default ValidateInvoiceTool;
