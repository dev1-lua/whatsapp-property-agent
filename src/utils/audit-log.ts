/**
 * Audit-event helpers. Every material action and status transition writes one
 * row to the `audit_events` collection.
 *
 * See docs/info/02-DATA-MODEL.md for the entry shape.
 */

import { AuditEvents } from '../services/data.js';
import {
  EventType,
  ActorType,
  type TicketStatus
} from './constants.js';

export interface AuditEventInput {
  ticketId: string;                  // display id (e.g. MT-2605-A8F2K9)
  ticketDataId?: string;             // Data id of the ticket row, for joins
  eventType: EventType;
  actorType: ActorType;
  actorId?: string;
  actorName?: string;
  payload?: Record<string, any>;
  fromStatus?: TicketStatus;
  toStatus?: TicketStatus;
}

export async function logEvent(input: AuditEventInput): Promise<void> {
  const entry = {
    ticketId: input.ticketId,
    ticketDataId: input.ticketDataId,
    eventType: input.eventType,
    actorType: input.actorType,
    actorId: input.actorId,
    actorName: input.actorName,
    payload: input.payload ?? {},
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    at: new Date().toISOString()
  };

  const searchText = `${input.eventType} ${input.payload?.description ?? ''} ${input.actorType}`.trim();
  await AuditEvents.create(entry, searchText);
}

export async function logStatusChange(args: {
  ticketId: string;
  ticketDataId?: string;
  fromStatus: TicketStatus;
  toStatus: TicketStatus;
  actorType: ActorType;
  actorId?: string;
  actorName?: string;
  reason?: string;
}): Promise<void> {
  await logEvent({
    ticketId: args.ticketId,
    ticketDataId: args.ticketDataId,
    eventType: EventType.STATUS_CHANGED,
    actorType: args.actorType,
    actorId: args.actorId,
    actorName: args.actorName,
    fromStatus: args.fromStatus,
    toStatus: args.toStatus,
    payload: { reason: args.reason ?? '' }
  });
}
