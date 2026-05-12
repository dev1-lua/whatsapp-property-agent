/**
 * search_maintenance_history — semantic search over the tickets collection.
 *
 * Wraps `Tickets.search` (embedding-based) and post-filters by status and
 * propertyCode if supplied. Returns concise ticket summaries with the
 * similarity score for the LLM to reason over recurring issues.
 */

import { LuaTool } from 'lua-cli';
import { z } from 'zod';
import { Tickets } from '../../services/data.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export class SearchMaintenanceHistoryTool implements LuaTool {
  name = 'search_maintenance_history';
  description =
    'Semantic search over historical maintenance tickets. Use natural-language queries (e.g., "leak in unit 4B", "recurring HVAC issues"). Optionally filter by status or property code. Returns matching tickets with similarity scores.';

  inputSchema = z.object({
    query: z
      .string()
      .describe('Natural-language search query (e.g., "leak under kitchen sink").'),
    status: z
      .enum([
        'reported',
        'vendor_contacted',
        'quoted',
        'pending_approval',
        'approved',
        'rejected',
        'in_progress',
        'completed',
        'closed',
        'cancelled',
        'on_hold',
        'disputed'
      ])
      .optional()
      .describe('Optional status filter applied after the semantic search.'),
    propertyCode: z
      .string()
      .optional()
      .describe('Optional propertyCode filter applied after the semantic search.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .optional()
      .describe(`Max results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`)
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const { query, status, propertyCode } = input;
      const limit = input.limit ?? DEFAULT_LIMIT;

      const raw: any = await Tickets.search(query, limit);
      // Result shape can vary: { data: [...] } or [...]
      const rows: any[] = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.data)
          ? raw.data
          : [];

      let filtered = rows;
      if (status) {
        filtered = filtered.filter((r) => (r?.data?.status ?? r?.status) === status);
      }
      if (propertyCode) {
        filtered = filtered.filter((r) => (r?.data?.propertyCode ?? r?.propertyCode) === propertyCode);
      }

      const tickets = filtered.slice(0, limit).map((r) => {
        const d = r?.data ?? r ?? {};
        const score = r?.score ?? r?._score ?? r?.data?.score;
        return {
          ticketId: d.ticketId,
          description: typeof d.description === 'string' ? d.description.slice(0, 200) : '',
          status: d.status,
          urgency: d.urgency,
          score: typeof score === 'number' ? score : undefined,
          createdAt: d.createdAt
        };
      });

      return {
        success: true,
        tickets,
        total: tickets.length,
        message:
          tickets.length > 0
            ? `Found ${tickets.length} matching ticket(s).`
            : 'No matching tickets found.'
      };
    } catch (err: any) {
      return {
        success: false,
        tickets: [],
        total: 0,
        error: err?.message ?? String(err),
        message: 'Search failed.'
      };
    }
  }
}

export default SearchMaintenanceHistoryTool;
