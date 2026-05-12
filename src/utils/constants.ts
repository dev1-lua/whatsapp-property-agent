/**
 * Constants and enums for the Property Maintenance Management System
 */

// Ticket status enum - follows the state machine defined in PRD
export enum TicketStatus {
  REPORTED = 'reported',
  VENDOR_CONTACTED = 'vendor_contacted',
  QUOTED = 'quoted',
  PENDING_APPROVAL = 'pending_approval',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CLOSED = 'closed',
  CANCELLED = 'cancelled',
  ON_HOLD = 'on_hold',
  DISPUTED = 'disputed'
}

// Issue type categories for maintenance requests
export enum IssueType {
  PLUMBING = 'plumbing',
  ELECTRICAL = 'electrical',
  HVAC = 'hvac',
  APPLIANCE = 'appliance',
  STRUCTURAL = 'structural',
  OTHER = 'other'
}

// Urgency levels for prioritization
export enum Urgency {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  EMERGENCY = 'emergency'
}

// Actor types for audit trail
export enum ActorType {
  TENANT = 'tenant',
  AGENT = 'agent',
  VENDOR = 'vendor',
  MANAGER = 'manager',
  FINANCE = 'finance',
  SYSTEM = 'system'
}

// Event types for audit logging
export enum EventType {
  STATUS_CHANGED = 'status_changed',
  TICKET_CREATED = 'ticket_created',
  TICKET_UPDATED = 'ticket_updated',
  IMAGES_UPLOADED = 'images_uploaded',
  VENDOR_CONTACTED = 'vendor_contacted',
  QUOTE_RECEIVED = 'quote_received',
  APPROVAL_REQUESTED = 'approval_requested',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  WORK_STARTED = 'work_started',
  COMPLETION_DOCS_RECEIVED = 'completion_docs_received',
  INVOICE_RECEIVED = 'invoice_received',
  TENANT_CONFIRMED = 'tenant_confirmed',
  PAYMENT_INITIATED = 'payment_initiated',
  TICKET_CLOSED = 'ticket_closed',
  ESCALATED = 'escalated',
  REVISED_QUOTE_SUBMITTED = 'revised_quote_submitted',
  ESCALATION_CREATED = 'escalation_created',
  ESCALATION_RESOLVED = 'escalation_resolved',
  WORK_PAUSED = 'work_paused',
  WORK_RESUMED = 'work_resumed',
  VENDOR_DECLINED = 'vendor_declined',
  DISPUTE_RAISED = 'dispute_raised',
  TICKET_CANCELLED = 'ticket_cancelled'
}

// Escalation types
export enum EscalationType {
  APPROVAL_DELAY = 'approval_delay',
  VENDOR_NO_RESPONSE = 'vendor_no_response',
  SLA_BREACH = 'sla_breach',
  COST_OVERRUN = 'cost_overrun',
  DISPUTE_RAISED = 'dispute_raised',
  STALE_TICKET = 'stale_ticket',
  VENDOR_DECLINED = 'vendor_declined',
  UNHANDLED_SCENARIO = 'unhandled_scenario'
}

// Escalation statuses
export enum EscalationStatus {
  OPEN = 'open',
  IN_REVIEW = 'in_review',
  RESOLVED = 'resolved',
  CLOSED = 'closed'
}

// Valid status transitions for the state machine
export const VALID_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  [TicketStatus.REPORTED]: [TicketStatus.VENDOR_CONTACTED, TicketStatus.CANCELLED],
  [TicketStatus.VENDOR_CONTACTED]: [TicketStatus.QUOTED, TicketStatus.PENDING_APPROVAL, TicketStatus.CANCELLED],
  [TicketStatus.QUOTED]: [TicketStatus.PENDING_APPROVAL, TicketStatus.APPROVED, TicketStatus.CANCELLED],
  [TicketStatus.PENDING_APPROVAL]: [TicketStatus.APPROVED, TicketStatus.REJECTED, TicketStatus.CANCELLED],
  [TicketStatus.APPROVED]: [TicketStatus.IN_PROGRESS, TicketStatus.PENDING_APPROVAL, TicketStatus.CANCELLED],
  [TicketStatus.REJECTED]: [TicketStatus.PENDING_APPROVAL, TicketStatus.VENDOR_CONTACTED, TicketStatus.CANCELLED],
  [TicketStatus.IN_PROGRESS]: [TicketStatus.COMPLETED, TicketStatus.PENDING_APPROVAL, TicketStatus.ON_HOLD],
  [TicketStatus.COMPLETED]: [TicketStatus.CLOSED, TicketStatus.DISPUTED],
  [TicketStatus.CLOSED]: [],
  [TicketStatus.CANCELLED]: [],
  [TicketStatus.ON_HOLD]: [TicketStatus.IN_PROGRESS, TicketStatus.VENDOR_CONTACTED, TicketStatus.CANCELLED],
  [TicketStatus.DISPUTED]: [TicketStatus.COMPLETED, TicketStatus.CLOSED, TicketStatus.IN_PROGRESS]
};

// Emergency keywords that trigger immediate response
export const EMERGENCY_KEYWORDS = [
  'gas smell',
  'gas leak',
  'active fire',
  'fire',
  'severe flooding',
  'flooding',
  'water everywhere',
  'electrical fire',
  'smoke',
  'carbon monoxide',
  'no heat',
  'frozen pipes',
  'burst pipe',
  'sewage backup',
  'structural collapse'
];

// Lua Data collection names — six collections back the entire system
export const COLLECTIONS = {
  PROPERTIES: 'properties',
  TENANTS: 'tenants',
  VENDORS: 'vendors',
  TICKETS: 'tickets',
  AUDIT_EVENTS: 'audit_events',
  COMMUNICATIONS: 'communications',
  ESCALATIONS: 'escalations'
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

// Default approval threshold in firm's currency (override via env APPROVAL_THRESHOLD)
export const DEFAULT_APPROVAL_THRESHOLD = 500;

// SLA thresholds in hours
export const SLA = {
  EMERGENCY_RESPONSE: 1,
  HIGH_RESPONSE: 4,
  MEDIUM_RESPONSE: 24,
  LOW_RESPONSE: 72,
  APPROVAL_ESCALATION: 24,
  VENDOR_RESPONSE: 48
} as const;
