/**
 * Shared admin scope resolution. Admin contacts carry an `adminScope` of either
 * `'all'` (portfolio-wide) or a `string[]` of propertyCodes. Env-allowlisted
 * admins (no contact row) default to 'all'. Anything else is denied.
 */

import { Contacts } from '../../services/data.js';

export type AdminScope = 'all' | string[];

export interface ScopeResolution {
  ok: boolean;
  scope: AdminScope;
  message?: string;
}

export async function resolveAdminScope(user: any): Promise<ScopeResolution> {
  if (user?.userType !== 'admin') {
    return {
      ok: false,
      scope: 'all',
      message:
        'This tool is admin-only. Call get_user_context first; if the caller is not an admin, do not invoke admin stats tools.'
    };
  }

  if (!user?.contactId) {
    // Env-allowlisted admin without a contact row — assume full scope.
    return { ok: true, scope: 'all' };
  }

  try {
    const entry: any = await Contacts.getEntry(user.contactId);
    const stored = entry?.data?.adminScope;
    if (stored === 'all') return { ok: true, scope: 'all' };
    if (Array.isArray(stored)) return { ok: true, scope: stored };
  } catch {
    /* fall through */
  }

  return { ok: true, scope: 'all' };
}

/** Narrow a requested propertyCode against the admin's allowed scope. */
export function intersectRequestedProperty(
  scope: AdminScope,
  requested?: string
): { allowed: boolean; effectiveScope: AdminScope } {
  if (!requested) return { allowed: true, effectiveScope: scope };
  if (scope === 'all') return { allowed: true, effectiveScope: [requested] };
  if (Array.isArray(scope) && scope.includes(requested)) {
    return { allowed: true, effectiveScope: [requested] };
  }
  return { allowed: false, effectiveScope: scope };
}

/** True when a record's propertyCode is allowed by the scope. */
export function recordInScope(record: any, scope: AdminScope): boolean {
  if (scope === 'all') return true;
  if (!Array.isArray(scope)) return true;
  const code = String(record?.propertyCode ?? '');
  return scope.includes(code);
}
