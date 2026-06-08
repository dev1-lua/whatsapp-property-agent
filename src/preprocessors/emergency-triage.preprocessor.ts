/**
 * emergency-triage preprocessor
 *
 * Runs before every inbound user message. Two outcomes:
 *
 *   1. Life-threatening keyword (gas, fire, carbon monoxide) →
 *      BLOCK the conversation and reply with channel-appropriate safety
 *      instructions. The agent never sees this turn.
 *
 *   2. Non-life-threatening urgent keyword (no heat, burst pipe, sewage,
 *      etc.) → PROCEED but inject a `[SYSTEM: urgent maintenance — prioritize]`
 *      prefix on each text part so the agent treats it as urgency=emergency.
 *
 * No tenant/vendor identity lookup here — that's handled by GetUserContext.
 */

import { PreProcessor, Lua } from 'lua-cli';
import { EMERGENCY_KEYWORDS } from '../utils/constants.js';
import { collectPhones } from '../utils/identity.js';

// [WA-PHONE-RECOVERY-2026-06-08] Recover the WhatsApp sender's phone from the
// raw channel webhook payload. On this agent's WhatsApp channel, User.get()
// ._luaProfile.mobileNumbers is empty, so the resolver has only user.id to match
// on — making admin-seeded contacts (which carry a phone, not a user.id)
// unreachable. Meta delivers the verified sender as messages[].from /
// contacts[].wa_id; some providers use a flat from/wa_id. This is a CHANNEL
// identifier (not user-typed), so it's safe to trust. We stash it on the user
// record as _waChannelPhone; GetUserContextTool reads it into profilePhones.
// To revert: remove this helper, the recovery block in execute(), and the
// matching read in GetUserContextTool.
function recoverWhatsAppPhone(): string[] {
  try {
    const payload: any = (Lua as any)?.request?.webhook?.payload;
    if (!payload) return [];
    const out: string[] = [];
    const consider = (v: any) => {
      if (typeof v === 'string' && v.replace(/\D/g, '').length >= 7) out.push(v);
    };
    for (const e of Array.isArray(payload.entry) ? payload.entry : []) {
      for (const c of Array.isArray(e?.changes) ? e.changes : []) {
        const val = c?.value ?? {};
        for (const m of Array.isArray(val.messages) ? val.messages : []) consider(m?.from);
        for (const ct of Array.isArray(val.contacts) ? val.contacts : []) consider(ct?.wa_id);
      }
    }
    for (const k of ['from', 'wa_id', 'waId', 'author', 'sender', 'msisdn']) consider(payload?.[k]);
    return collectPhones(out);
  } catch {
    return [];
  }
}

// Subset of EMERGENCY_KEYWORDS that require evacuation / 911 first.
const LIFE_THREATENING_KEYWORDS = [
  'gas smell',
  'gas leak',
  'smell gas',
  'active fire',
  'fire',
  'electrical fire',
  'carbon monoxide',
  'smoke alarm',
  'smoke'
];

const SAFETY_INSTRUCTIONS = {
  gas: `**GAS EMERGENCY — TAKE ACTION NOW**

1. **DO NOT** flip any electrical switches or use any appliances.
2. **DO NOT** light flames or anything that could spark.
3. **EVACUATE** the building immediately.
4. **CALL 911** (or your local gas emergency line) from outside.
5. **DO NOT** re-enter until cleared by emergency services.

Once you're safe, message us back and we'll create an emergency maintenance ticket.`,

  fire: `**FIRE EMERGENCY — EVACUATE IMMEDIATELY**

1. **GET OUT** of the building now.
2. **CALL 911** once you are safe.
3. **DO NOT** use elevators.
4. **DO NOT** go back inside for belongings.
5. Meet at your designated assembly point.

Once the fire department has responded and you are safe, contact us to report any property damage.`,

  carbon_monoxide: `**CARBON MONOXIDE ALERT**

1. **EVACUATE** everyone from the building immediately.
2. **CALL 911** from outside.
3. **DO NOT** re-enter the building.
4. Get fresh air right away.
5. Seek medical attention if anyone feels dizzy, nauseous, or short of breath.

Once cleared by emergency services, message us so we can arrange an inspection.`
};

function extractText(messages: any[]): string {
  return (messages ?? [])
    .filter(m => m?.type === 'text')
    .map(m => String(m?.text ?? ''))
    .join(' ')
    .toLowerCase();
}

function pickSafetyText(lower: string): string {
  if (lower.includes('carbon monoxide')) return SAFETY_INSTRUCTIONS.carbon_monoxide;
  if (lower.includes('fire') || lower.includes('smoke')) return SAFETY_INSTRUCTIONS.fire;
  return SAFETY_INSTRUCTIONS.gas;
}

export default new PreProcessor({
  name: 'emergency-triage',
  description:
    'Detect emergencies in inbound messages. Block + reply with safety steps for life-threatening keywords; otherwise prefix the message with an urgency hint for the agent.',
  priority: 10,

  execute: async (user, messages, channel) => {
    // [WA-PHONE-RECOVERY-2026-06-08] Diagnostic + stash. Runs first so the
    // recovered phone is persisted before get_user_context reads the user record.
    try {
      if (channel === 'whatsapp') {
        const payload: any = (Lua as any)?.request?.webhook?.payload;
        const recovered = recoverWhatsAppPhone();
        console.log('[WA-PHONE-RECOVERY]', JSON.stringify({
          channel,
          payloadPresent: !!payload,
          payloadKeys: payload ? Object.keys(payload) : null,
          recovered,
          profileMobileNumbers: (user as any)?._luaProfile?.mobileNumbers ?? null
        }));
        if (recovered.length > 0) {
          try { await user.update({ _waChannelPhone: recovered[0] }); } catch { /* non-fatal */ }
        }
      }
    } catch (e: any) {
      console.log('[WA-PHONE-RECOVERY] error', e?.message ?? String(e));
    }

    try {
      const lower = extractText(messages as any[]);
      if (!lower) return { action: 'proceed' as const };

      const lifeThreatening = LIFE_THREATENING_KEYWORDS.find(k => lower.includes(k));
      if (lifeThreatening) {
        return {
          action: 'block' as const,
          response: pickSafetyText(lower)
        };
      }

      const urgent = EMERGENCY_KEYWORDS.find(k => lower.includes(k));
      if (urgent) {
        const prefix = `[SYSTEM: urgent maintenance — prioritize] `;
        const modifiedMessage = (messages as any[]).map(m => {
          if (m?.type === 'text') {
            return { type: 'text' as const, text: prefix + String(m?.text ?? '') };
          }
          return m;
        });
        return {
          action: 'proceed' as const,
          modifiedMessage
        };
      }

      return { action: 'proceed' as const };
    } catch (err) {
      console.error('emergency-triage preprocessor error:', err);
      return { action: 'proceed' as const };
    }
  }
});
