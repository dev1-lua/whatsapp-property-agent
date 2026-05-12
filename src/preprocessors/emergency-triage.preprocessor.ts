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

import { PreProcessor } from 'lua-cli';
import { EMERGENCY_KEYWORDS } from '../utils/constants.js';

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
