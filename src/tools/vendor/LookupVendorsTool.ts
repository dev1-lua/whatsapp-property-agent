/**
 * Find active vendors whose specialties match the given issue type.
 * Sorted by rating desc. Pure read-only.
 */

import { LuaTool } from 'lua-cli';
import { z } from 'zod';
import { Vendors } from '../../services/data.js';
import { IssueType } from '../../utils/constants.js';

export class LookupVendorsTool implements LuaTool {
  name = 'lookup_vendors';
  description = 'Find active vendors that match a given issue type. Returns vendors sorted by rating descending.';

  inputSchema = z.object({
    issueType: z.string().describe('The issue type to match against vendor specialties — one of: plumbing, electrical, hvac, appliance, structural, other'),
    propertyId: z.string().optional().describe('Optional property ID (reserved for future locality filtering)'),
    limit: z.number().min(1).max(20).optional().describe('Maximum number of vendors to return (default 5)')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const { issueType, limit } = input;
      const cap = limit ?? 5;

      // Get all vendors — Data filter on array-contains isn't reliable across
      // backends, so we fetch and filter in-memory.
      const result = await Vendors.get();
      const entries = result?.data ?? [];

      const matches = entries
        .map((e: any) => ({ id: e.id, ...(e.data ?? {}) }))
        .filter((v: any) => {
          if (v.active !== true) return false;
          const specs: string[] = v.specialties ?? [];
          return specs.some(s => String(s).toLowerCase() === String(issueType).toLowerCase());
        })
        .sort((a: any, b: any) => (b.rating ?? 0) - (a.rating ?? 0))
        .slice(0, cap)
        .map((v: any) => ({
          id: v.id,
          name: v.companyName ?? v.name,
          specialties: v.specialties ?? [],
          rating: v.rating ?? null,
          jobsCompleted: v.jobsCompleted ?? 0,
          hourlyRate: v.hourlyRate ?? null
        }));

      return {
        success: true,
        vendors: matches,
        count: matches.length,
        message: matches.length === 0
          ? `No active vendors found matching ${issueType}.`
          : `Found ${matches.length} vendor(s) matching ${issueType}.`
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message ?? String(err),
        vendors: [],
        message: 'Failed to look up vendors.'
      };
    }
  }
}

export default LookupVendorsTool;
