/**
 * diag-profile — DIAGNOSTIC webhook (read-only).
 *
 * Verifies what the Lua platform has captured into a user's immutable
 * `_luaProfile` — specifically whether `mobileNumbers` is populated. This is the
 * single predictor of whether a PROACTIVE outbound message (the vendor job ping)
 * can be delivered: populated → POST /conversations succeeds (201); empty → 400
 * "No last interaction found".
 *
 * Built 2026-06-08 to prove/disprove: "the platform does not capture Egyptian
 * (+20) numbers into the profile, but does capture +91". Run it across the two
 * country codes and compare `captured`.
 *
 * Body (any combination):
 *   { userId: "..." }        → lookup by platform user.id
 *   { phone:  "201144444361" } → lookup by phone (digits, no +)
 *   { phones: ["201144444361","917579045745", ...] } → batch phone lookups
 *
 * Returns, per lookup: found, mobileNumbers, emailAddresses, fullName,
 * captured (mobileNumbers.length > 0), and country if the profile exposes it.
 * Sends NO messages — purely a read.
 */

import { LuaWebhook, User } from 'lua-cli';

function summarizeProfile(u: any) {
  if (!u) return { found: false };
  const p = u?._luaProfile ?? {};
  const mobileNumbers = Array.isArray(p?.mobileNumbers) ? p.mobileNumbers : [];
  return {
    found: true,
    profileUserId: p?.userId ?? null,
    fullName: p?.fullName ?? null,
    mobileNumbers,
    emailAddresses: Array.isArray(p?.emailAddresses) ? p.emailAddresses : [],
    country: p?.country ?? null,
    captured: mobileNumbers.length > 0
  };
}

async function lookupByPhone(phone: string) {
  try {
    const u: any = await User.get({ phone });
    if (!u) {
      return {
        phone,
        found: false,
        note: 'No profile resolved for this phone — the platform has no profile indexed by this number.'
      };
    }
    return { phone, ...summarizeProfile(u) };
  } catch (err: any) {
    return { phone, error: err?.message ?? String(err) };
  }
}

export default new LuaWebhook({
  name: 'diag-profile',
  description:
    'Diagnostic (read-only): report a user\'s _luaProfile capture (mobileNumbers etc.) by userId and/or phone, to verify whether the platform captures a given number. Body: { userId?, phone?, phones?[] }.',
  execute: async (event) => {
    const body: any = event?.body ?? {};
    const out: any = { success: true, checkedAt: 'see server log', input: {} };

    const userId = body.userId ? String(body.userId).trim() : '';
    const phone = body.phone ? String(body.phone).trim() : '';
    const phones: string[] = Array.isArray(body.phones)
      ? body.phones.map((p: any) => String(p).trim()).filter(Boolean)
      : [];

    if (userId) {
      out.input.userId = userId;
      try {
        const u: any = await User.get(userId);
        out.byUserId = { userId, ...summarizeProfile(u) };
      } catch (err: any) {
        out.byUserId = { userId, error: err?.message ?? String(err) };
      }
    }

    if (phone) {
      out.input.phone = phone;
      out.byPhone = await lookupByPhone(phone);
    }

    if (phones.length > 0) {
      out.input.phones = phones;
      out.byPhones = [];
      for (const p of phones) {
        out.byPhones.push(await lookupByPhone(p));
      }
    }

    if (!userId && !phone && phones.length === 0) {
      return { success: false, error: 'provide at least one of: userId, phone, phones[]' };
    }

    return out;
  }
});
