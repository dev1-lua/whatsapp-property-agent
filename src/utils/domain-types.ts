/**
 * Domain shapes — TS interfaces matching the Data collection rows.
 * Mirror docs/info/02-DATA-MODEL.md.
 */

import type {
  TicketStatus,
  IssueType,
  Urgency,
  ActorType,
  EventType,
  EscalationType,
  EscalationStatus
} from './constants.js';

export interface Property {
  id?: string;
  propertyCode: string;
  name: string;
  address: string;
  city: string;
  country?: string;
  postalCode?: string;
  type: 'RES' | 'COM' | 'DEV';
  units: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Tenant {
  id?: string;
  name: string;
  phones: string[];
  email?: string;
  propertyId: string;
  propertyCode: string;
  propertyName: string;
  unit?: string;
  userId?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Vendor {
  id?: string;
  name: string;
  companyName: string;
  contactName?: string;
  phones: string[];
  email?: string;
  specialties: string[];
  hourlyRate?: number;
  rating?: number;
  jobsCompleted?: number;
  totalRevenue?: number;
  notes?: string;
  active: boolean;
  userId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TicketQuote {
  amount: number;
  currency: string;
  scopeNotes: string;
  submittedAt: string;
  revisedAt?: string;
  revisionReason?: string;
}

export interface TicketApproval {
  required: boolean;
  requestedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  approvedAmount: number | null;
  comments: string | null;
  conditions: string[];
  externalRequestId: string | null;
}

export interface TicketPayment {
  status: 'pending' | 'processing' | 'succeeded' | 'failed';
  stripePaymentIntentId?: string;
  amount: number;
  initiatedAt: string;
  completedAt?: string;
}

export interface TicketClosure {
  closedBy: string;
  closedAt: string;
  closeReason: string;
}

export interface Ticket {
  id?: string;
  ticketId: string;
  status: TicketStatus;

  propertyId: string;
  propertyCode: string;
  propertyName: string;
  unit?: string;

  tenantId: string;
  tenantUserId?: string;
  tenantName: string;
  tenantPhone?: string;
  tenantEmail?: string;
  tenantAccessNotes?: string;

  issueType: IssueType;
  urgency: Urgency;
  description: string;
  location?: string;
  images: string[];
  relatedTicketId?: string;

  assignedVendorId?: string;
  assignedVendorName?: string;
  assignedVendorPhone?: string;
  assignedVendorUserId?: string;
  vendorAssignedAt?: string;
  vendorRequestedAt?: string;

  quote?: TicketQuote;
  estimatedCost?: number;

  approval: TicketApproval;

  workStartedAt?: string;
  workPausedAt?: string;
  estimatedArrival?: string;
  arrivalNotes?: string;

  completedAt?: string;
  completionNotes?: string;
  completionImages: string[];
  invoiceNumber?: string;
  invoiceUrl?: string;
  actualCost?: number;
  costVariance?: number;
  costVariancePercent?: number;

  confirmationRequested?: string;
  tenantSatisfied?: boolean;
  tenantRating?: number;
  tenantFeedback?: string;

  payment?: TicketPayment;
  closure?: TicketClosure;

  cancelledBy?: string;
  cancelledAt?: string;
  cancelReason?: string;

  escalatedAt?: string;

  createdAt: string;
  updatedAt: string;
}

export interface AuditEventRow {
  id?: string;
  ticketId: string;
  ticketDataId?: string;
  eventType: EventType;
  actorType: ActorType;
  actorId?: string;
  actorName?: string;
  payload: Record<string, any>;
  fromStatus?: TicketStatus;
  toStatus?: TicketStatus;
  at: string;
}

export interface CommunicationRow {
  id?: string;
  ticketId?: string | null;
  direction: 'Inbound' | 'Outbound';
  channel: 'Chat' | 'Email' | 'SMS' | 'WhatsApp';
  senderType: 'Tenant' | 'Vendor' | 'Agent' | 'Finance' | 'Manager';
  senderName?: string;
  senderId?: string;
  recipient?: string;
  subject?: string;
  body: string;
  contentType: 'Plain Text' | 'HTML' | 'Markdown';
  delivery: 'queued' | 'sent' | 'failed' | 'received';
  deliveryError?: string;
  at: string;
}

export interface Escalation {
  id?: string;
  ticketId: string;
  escalationType: EscalationType;
  status: EscalationStatus;
  reason: string;
  createdBy: ActorType;
  assignedTo?: string;
  createdAt: string;
  resolvedAt?: string;
  resolution?: string;
  resolutionBy?: string;
}

export type SeedPayload = {
  properties?: Array<Omit<Property, 'id' | 'createdAt' | 'updatedAt'>>;
  tenants?: Array<Omit<Tenant, 'id' | 'propertyId' | 'propertyName' | 'active' | 'createdAt' | 'updatedAt'> & { propertyCode: string }>;
  vendors?: Array<Omit<Vendor, 'id' | 'companyName' | 'active' | 'createdAt' | 'updatedAt'> & { companyName?: string }>;
};
