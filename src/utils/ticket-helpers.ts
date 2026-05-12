/**
 * Pure helpers shared across tools — issue classification, urgency assessment,
 * state-machine transitions. No DB calls.
 */

import {
  IssueType,
  Urgency,
  TicketStatus,
  VALID_TRANSITIONS
} from './constants.js';

export function classifyIssueType(description: string): IssueType {
  const lower = (description || '').toLowerCase();
  if (/leak|water|drain|toilet|sink|faucet|tap|pipe|plumb|sewage/.test(lower)) return IssueType.PLUMBING;
  if (/electric|outlet|light|switch|power|circuit|wire|breaker|socket/.test(lower)) return IssueType.ELECTRICAL;
  if (/\bac\b|air condition|hvac|furnace|thermostat|ventilation|cooling|heating|heat\b|boiler|radiator/.test(lower)) return IssueType.HVAC;
  if (/appliance|refrigerator|fridge|stove|oven|dishwasher|washer|dryer|microwave|disposal/.test(lower)) return IssueType.APPLIANCE;
  if (/wall|ceiling|floor|door|window|roof|foundation|crack|structural/.test(lower)) return IssueType.STRUCTURAL;
  return IssueType.OTHER;
}

export function assessUrgency(description: string): Urgency {
  const lower = (description || '').toLowerCase();
  if (/gas|fire|flood|sewage|emergency|carbon monoxide|burst pipe|electrical fire|smoke/.test(lower)) return Urgency.EMERGENCY;
  if (/burst|major leak|no water|no power|no heat|security|urgent|broken (door|lock|window)/.test(lower)) return Urgency.HIGH;
  if (/leak|drip|seep|damage|not working|broken|malfunction|issue/.test(lower)) return Urgency.MEDIUM;
  return Urgency.LOW;
}

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function nextStepsByUrgency(urgency: Urgency): string {
  switch (urgency) {
    case Urgency.EMERGENCY: return 'Emergency response — a vendor will be contacted immediately. Update within 1 hour.';
    case Urgency.HIGH: return 'High urgency — vendor contact within 4 hours.';
    case Urgency.MEDIUM: return 'Vendor contact within 24 hours.';
    case Urgency.LOW: return 'Vendor contact within 72 hours.';
    default: return 'Your request has been logged.';
  }
}
