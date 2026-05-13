/**
 * reset_my_identity — wipe the caller's cached identity AND the WhatsApp chat
 * transcript so the next turn starts cold.
 *
 * Use case: a user picks up a WhatsApp number whose prior transcript belongs to
 * someone else (test re-use, demo handoff, sold phone, etc.), so the agent has
 * been confabulating "Hi <wrong-name>, your ticket MT-... is still open" from
 * stale turns. This tool clears both:
 *
 *   1. The cached identity fields on the user record (userType, contactId,
 *      tenantId, vendorId, propertyCode, etc.) — so `get_user_context` will
 *      re-resolve from scratch.
 *   2. The server-side chat transcript via `DELETE /chat/history/{agentId}`
 *      with `targetIdentifier = userId | mobile | email`. This is the same
 *      endpoint `lua chat clear --user X --force` hits.
 *
 * Does NOT delete tickets, contacts, communications, or audit events — those
 * are organizational records, not per-user state.
 *
 * Requires `LUA_API_KEY` env var on the agent so the DELETE can authenticate.
 * If missing, the identity cache is still cleared and a clear error is
 * returned for the chat-history step.
 */

import { LuaTool, User, env } from 'lua-cli';
import { z } from 'zod';

const DEFAULT_LUA_API_URL = 'https://api.heylua.ai';

function digitsOnly(input: string): string {
  return String(input ?? '').replace(/\D/g, '');
}

export class ResetMyIdentityTool implements LuaTool {
  name = 'reset_my_identity';
  description =
    "Forget who the current user is and wipe the chat transcript with this agent so the next turn starts cold. Use when the user says things like \"I'm new\", \"forget me\", \"reset me\", \"start over\", \"I'm a different person\", or when the agent is clearly confabulating about a prior identity that doesn't match the current speaker. Clears the cached userType/contactId/tenantId/vendorId on the user record AND deletes the chat history with this agent. Does NOT delete tickets, contacts, or audit records — only the per-user cache and transcript. After this returns, call `get_user_context` again with no args to re-identify the caller from scratch.";

  inputSchema = z.object({});

  async execute() {
    try {
      const user: any = await User.get();
      const profile = user?._luaProfile ?? {};
      const userId: string | undefined = profile?.userId ?? user?.id;

      const phoneCandidates: string[] = [];
      if (profile?.phone) phoneCandidates.push(profile.phone);
      if (Array.isArray(profile?.mobileNumbers)) phoneCandidates.push(...profile.mobileNumbers);
      if (Array.isArray(profile?.phones)) phoneCandidates.push(...profile.phones);
      const mobile = phoneCandidates.map(digitsOnly).find((p) => p.length >= 8) ?? '';

      const email: string =
        profile?.email ||
        (Array.isArray(profile?.emailAddresses) ? profile.emailAddresses[0] : '') ||
        user?.email ||
        '';

      // Prefer userId (UUID) — most reliable. Fall back to mobile, then email.
      const identifier = userId || mobile || email;
      if (!identifier) {
        return {
          success: false,
          error: 'no_identifier',
          message:
            "I don't have a userId, phone, or email on the channel — can't scope a reset against. If you're on webchat without a logged-in identity there's nothing cached to clear."
        };
      }

      // -----------------------------------------------------------
      // Step 1: clear the cached identity fields on the user record
      // -----------------------------------------------------------
      let identityCleared = false;
      try {
        await user.update?.({
          userType: null,
          contactId: null,
          identityId: null,
          tenantId: null,
          vendorId: null,
          tenantName: null,
          vendorName: null,
          propertyCode: null,
          propertyId: null,
          propertyName: null,
          unit: null,
          vendorSpecialties: null,
          vendorRating: null,
          adminScope: null,
          _resetAt: new Date().toISOString()
        });
        identityCleared = true;
      } catch (err: any) {
        console.error('reset_my_identity: user.update failed:', err?.message);
      }

      // -----------------------------------------------------------
      // Step 2: DELETE /chat/history/{agentId}?targetIdentifier=...
      // -----------------------------------------------------------
      const agentId = env('AGENT_ID') ?? '';
      const apiKey = env('LUA_API_KEY') ?? '';
      const apiBase = env('LUA_API_URL') || DEFAULT_LUA_API_URL;

      let chatHistoryCleared = false;
      let chatHistoryError: string | null = null;

      if (!agentId) {
        chatHistoryError = 'missing_env_AGENT_ID';
      } else if (!apiKey) {
        chatHistoryError = 'missing_env_LUA_API_KEY';
      } else {
        try {
          const url = `${apiBase}/chat/history/${encodeURIComponent(agentId)}?targetIdentifier=${encodeURIComponent(identifier)}`;
          const resp = await fetch(url, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${apiKey}` }
          });
          if (resp.ok) {
            chatHistoryCleared = true;
          } else {
            const body = await resp.text().catch(() => '');
            chatHistoryError = `${resp.status} ${resp.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`;
            console.error('reset_my_identity: DELETE failed:', chatHistoryError);
          }
        } catch (err: any) {
          chatHistoryError = err?.message ?? String(err);
          console.error('reset_my_identity: fetch threw:', chatHistoryError);
        }
      }

      const message = chatHistoryCleared
        ? "Done — I've cleared what I knew about you and wiped our chat history. Tell me your name and which property you're at, and I'll start fresh."
        : `Identity cache cleared, but I couldn't wipe the chat transcript${chatHistoryError ? ` (${chatHistoryError})` : ''}. Prior turns may still leak into context — consider continuing in a fresh thread.`;

      return {
        success: true,
        identityCleared,
        chatHistoryCleared,
        chatHistoryError,
        identifierUsed: identifier,
        message
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message ?? String(err),
        message: 'Could not reset identity.'
      };
    }
  }
}

export default ResetMyIdentityTool;
