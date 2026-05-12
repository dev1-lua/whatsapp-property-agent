/**
 * vendors_by_specialty — admin-only.
 *
 * Lists the firm's vendor roster filtered by specialty + active flag. Unlike
 * `lookup_vendors` (tenant-side, requires an issueType), this surfaces the
 * full vendor list when no specialty is given. Sorted by rating desc.
 */

import { LuaTool, User } from 'lua-cli';
import { z } from 'zod';
import { Vendors } from '../../services/data.js';
import { resolveAdminScope } from './_scope.js';

function summarize(v: any) {
  return {
    id: v.id,
    name: v.companyName ?? v.name,
    specialties: v.specialties ?? [],
    rating: v.rating ?? null,
    jobsCompleted: v.jobsCompleted ?? 0,
    hourlyRate: v.hourlyRate ?? null,
    active: v.active === true,
    phones: Array.isArray(v.phones) ? v.phones : [],
    email: v.email ?? null
  };
}

export class VendorsBySpecialtyTool implements LuaTool {
  name = 'vendors_by_specialty';
  description =
    'Admin-only. Returns the vendor roster — full list by default, or filtered by a specialty. Sorted by rating descending. Use this when an admin asks "which vendors handle X" or "show me my vendors".';

  inputSchema = z.object({
    specialty: z
      .string()
      .optional()
      .describe('Optional specialty filter — one of: plumbing, electrical, hvac, appliance, structural, other. Omit to list all vendors.'),
    activeOnly: z
      .boolean()
      .optional()
      .describe('When true (default), only active vendors are returned. Pass false to include inactive.'),
    limit: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .describe('Maximum number of vendors to return (default 25).')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const user: any = await User.get();
      const scopeRes = await resolveAdminScope(user);
      if (!scopeRes.ok) {
        return { success: false, error: 'forbidden', message: scopeRes.message };
      }

      const cap = input.limit ?? 25;
      const activeOnly = input.activeOnly !== false;
      const specialty = input.specialty?.toLowerCase();

      const res: any = await Vendors.get({}, 1, 1000);
      const all: any[] = (res?.data ?? []).map((e: any) => ({ id: e.id, ...(e.data ?? {}) }));

      const filtered = all
        .filter((v: any) => (activeOnly ? v.active === true : true))
        .filter((v: any) => {
          if (!specialty) return true;
          const specs: string[] = Array.isArray(v.specialties) ? v.specialties : [];
          return specs.some((s) => String(s).toLowerCase() === specialty);
        })
        .sort((a: any, b: any) => (b.rating ?? 0) - (a.rating ?? 0))
        .slice(0, cap)
        .map(summarize);

      return {
        success: true,
        vendors: filtered,
        count: filtered.length,
        specialty: specialty ?? null,
        activeOnly,
        generatedAt: new Date().toISOString(),
        message:
          filtered.length === 0
            ? specialty
              ? `No ${activeOnly ? 'active ' : ''}vendors match specialty "${specialty}".`
              : `No ${activeOnly ? 'active ' : ''}vendors on file.`
            : specialty
              ? `${filtered.length} vendor(s) matching ${specialty}.`
              : `${filtered.length} vendor(s) on the roster.`
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message ?? String(err),
        vendors: [],
        count: 0,
        message: 'Failed to list vendors.'
      };
    }
  }
}

export default VendorsBySpecialtyTool;
