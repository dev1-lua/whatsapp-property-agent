# 02 — Data Model

Six Lua Data collections back the entire system. Schemas are JSON-shaped, validated with Zod on write paths.

## Collection: `properties`

Property/building directory. Read-mostly. Managed by admin UI.

```ts
{
  id: string                  // Data entry id (auto)
  propertyCode: string        // "1303", "TEMPLE-04" — human label
  name: string                // "No.4 Temple Place"
  address: string             // "4 Temple Place"
  city: string                // "Dublin"
  country?: string            // "IE"
  postalCode?: string
  type: 'RES' | 'COM' | 'DEV' // Residential, Commercial, Development
  units: number               // 12
  notes?: string
  createdAt: string           // ISO-8601
  updatedAt: string
}
```

`searchText`: `name + ' ' + address + ' ' + city + ' ' + propertyCode`

## Collection: `tenants`

Tenant directory. Identity lookup hits this collection first.

```ts
{
  id: string
  name: string                // "Laura Murphy"
  phones: string[]            // normalized digits-only: ["353861234567"]
  email?: string              // lowercased
  propertyId: string          // foreign key → properties.id
  propertyCode: string        // denormalized for fast lookup
  propertyName: string        // denormalized for display
  unit?: string               // "3B"
  userId?: string             // Lua user id if known (set on first interaction)
  active: boolean             // soft delete
  createdAt: string
  updatedAt: string
}
```

`searchText`: `name + ' ' + propertyName + ' ' + (unit || '') + ' ' + (email || '')`

**Phone normalization rules:**
- Strip whitespace, dashes, parens, dots
- Drop leading `+`
- Store as digits only
- WhatsApp Cloud API and SMS both deliver the sender's number this way after normalization

## Collection: `vendors`

Vendor directory. Identity lookup falls through here if tenant search misses.

```ts
{
  id: string
  name: string                // "Dublin Plumbing Co."
  companyName: string         // for display
  contactName?: string        // primary contact
  phones: string[]            // normalized
  email?: string              // lowercased
  specialties: string[]       // ['plumbing', 'heating']
  hourlyRate?: number
  rating?: number             // 1-5, updated by UpdateVendorMetricsTool
  jobsCompleted?: number
  totalRevenue?: number
  notes?: string
  active: boolean
  userId?: string             // set on first interaction
  createdAt: string
  updatedAt: string
}
```

`searchText`: `companyName + ' ' + specialties.join(' ') + ' ' + (contactName || '')`

## Collection: `tickets`

Core entity. The ticket *is* the state machine.

```ts
{
  id: string                           // Data entry id
  ticketId: string                     // "MT-2605-A8F2" — display ID
  status: TicketStatus                 // see enums below

  // Property
  propertyId: string
  propertyCode: string
  propertyName: string
  unit?: string

  // Tenant
  tenantId: string                     // → tenants.id
  tenantUserId?: string                // Lua user id, if known
  tenantName: string
  tenantPhone?: string
  tenantEmail?: string
  tenantAccessNotes?: string

  // Issue
  issueType: IssueType                 // plumbing | electrical | hvac | appliance | structural | other
  urgency: Urgency                     // low | medium | high | emergency
  description: string
  location?: string
  images: string[]                     // CDN URLs
  relatedTicketId?: string             // for recurring issues

  // Vendor (set on auto-assign or claim)
  assignedVendorId?: string            // → vendors.id
  assignedVendorName?: string
  assignedVendorPhone?: string
  assignedVendorUserId?: string
  vendorAssignedAt?: string
  vendorRequestedAt?: string

  // Quote (nested, not separate collection — simpler queries)
  quote?: {
    amount: number
    currency: string                   // "EUR"
    scopeNotes: string
    submittedAt: string
    revisedAt?: string
    revisionReason?: string
  }
  estimatedCost?: number               // mirror of quote.amount for fast filtering

  // Approval (nested)
  approval: {
    required: boolean
    requestedAt: string | null
    approvedBy: string | null
    approvedAt: string | null
    approvedAmount: number | null
    comments: string | null
    conditions: string[]
    externalRequestId: string | null
  }

  // Work
  workStartedAt?: string
  workPausedAt?: string
  estimatedArrival?: string
  arrivalNotes?: string

  // Completion
  completedAt?: string
  completionNotes?: string
  completionImages: string[]           // CDN URLs
  invoiceNumber?: string
  invoiceUrl?: string                  // CDN URL of invoice PDF
  actualCost?: number
  costVariance?: number                // actualCost - approvedAmount
  costVariancePercent?: number

  // Tenant confirmation
  confirmationRequested?: string
  tenantSatisfied?: boolean
  tenantRating?: number
  tenantFeedback?: string

  // Payment (Stripe stub for demo)
  payment?: {
    status: 'pending' | 'processing' | 'succeeded' | 'failed'
    stripePaymentIntentId?: string
    amount: number
    initiatedAt: string
    completedAt?: string
  }

  // Closure
  closure?: {
    closedBy: string
    closedAt: string
    closeReason: string
  }

  // Cancellation
  cancelledBy?: string
  cancelledAt?: string
  cancelReason?: string

  createdAt: string
  updatedAt: string
}
```

`searchText`: `description + ' ' + propertyName + ' ' + issueType + ' ' + (location || '')`

**Notable trims from BC version:**
- No `companyId` (single-firm agent)
- No `bcProjectId`, `bcPurchaseOrderId`, `bcPurchaseInvoiceId`, `bcSalesInvoiceId` — Stripe-only payment
- No `dimensionValueId` — properties are first-class Data entries

## Collection: `audit_events`

Immutable event log. Every status change and material action lands here.

```ts
{
  id: string
  ticketId: string                     // for filtering — display ID, not Data id
  ticketDataId: string                 // → tickets.id (Data id) for joins
  eventType: EventType                 // see enum below
  actorType: ActorType                 // tenant | agent | vendor | manager | finance | system
  actorId?: string                     // userId of actor
  actorName?: string
  payload: Record<string, any>         // event-specific shape
  fromStatus?: TicketStatus            // for status_changed events
  toStatus?: TicketStatus
  at: string                           // ISO-8601
}
```

`searchText`: `eventType + ' ' + (payload.description || '') + ' ' + actorType`

Append-only. Never updated, never deleted (except by `clear-data` for demo reset).

## Collection: `communications`

Outbound + inbound communication log. Written by `communication-log` postprocessor and the email/in-app notification helpers.

```ts
{
  id: string
  ticketId?: string                    // optional — some comms aren't ticket-scoped
  direction: 'Inbound' | 'Outbound'
  channel: 'Chat' | 'Email' | 'SMS' | 'WhatsApp'
  senderType: 'Tenant' | 'Vendor' | 'Agent' | 'Finance' | 'Manager'
  senderName?: string
  senderId?: string
  recipient?: string                   // email/phone/userId
  subject?: string
  body: string
  contentType: 'Plain Text' | 'HTML' | 'Markdown'
  delivery: 'queued' | 'sent' | 'failed' | 'received'
  deliveryError?: string
  at: string
}
```

## Collection: `escalations`

Created when the agent hits a wall (vendor not responding, dispute, cost overrun, SLA breach).

```ts
{
  id: string
  ticketId: string
  escalationType: EscalationType       // approval_delay | vendor_no_response | sla_breach | cost_overrun | dispute_raised | stale_ticket | vendor_declined | unhandled_scenario
  status: EscalationStatus             // open | in_review | resolved | closed
  reason: string
  createdBy: ActorType
  assignedTo?: string                  // manager userId or email
  createdAt: string
  resolvedAt?: string
  resolution?: string
  resolutionBy?: string
}
```

## Enums (carried from BC original — see `../src/utils/constants.ts`)

```ts
enum TicketStatus {
  REPORTED, VENDOR_CONTACTED, QUOTED, PENDING_APPROVAL, APPROVED, REJECTED,
  IN_PROGRESS, COMPLETED, CLOSED, CANCELLED, ON_HOLD, DISPUTED
}

enum IssueType {
  PLUMBING, ELECTRICAL, HVAC, APPLIANCE, STRUCTURAL, OTHER
}

enum Urgency {
  LOW, MEDIUM, HIGH, EMERGENCY
}

enum ActorType {
  TENANT, AGENT, VENDOR, MANAGER, FINANCE, SYSTEM
}

enum EscalationType {
  APPROVAL_DELAY, VENDOR_NO_RESPONSE, SLA_BREACH, COST_OVERRUN,
  DISPUTE_RAISED, STALE_TICKET, VENDOR_DECLINED, UNHANDLED_SCENARIO
}

enum EscalationStatus {
  OPEN, IN_REVIEW, RESOLVED, CLOSED
}

enum EventType {
  STATUS_CHANGED, TICKET_CREATED, TICKET_UPDATED, IMAGES_UPLOADED,
  VENDOR_CONTACTED, QUOTE_RECEIVED, APPROVAL_REQUESTED, APPROVED, REJECTED,
  WORK_STARTED, COMPLETION_DOCS_RECEIVED, INVOICE_RECEIVED,
  TENANT_CONFIRMED, PAYMENT_INITIATED, TICKET_CLOSED, ESCALATED,
  REVISED_QUOTE_SUBMITTED, ESCALATION_CREATED, ESCALATION_RESOLVED,
  WORK_PAUSED, WORK_RESUMED, VENDOR_DECLINED, DISPUTE_RAISED,
  TICKET_CANCELLED
}
```

## State machine

| From → | Allowed transitions |
|---|---|
| `reported` | vendor_contacted, cancelled |
| `vendor_contacted` | quoted, pending_approval, cancelled |
| `quoted` | pending_approval, approved, cancelled |
| `pending_approval` | approved, rejected, cancelled |
| `approved` | in_progress, pending_approval (revised quote up), cancelled |
| `rejected` | pending_approval, vendor_contacted, cancelled |
| `in_progress` | completed, pending_approval (revised quote up), on_hold |
| `completed` | closed, disputed |
| `closed` | (terminal) |
| `cancelled` | (terminal) |
| `on_hold` | in_progress, vendor_contacted, cancelled |
| `disputed` | completed, closed, in_progress |

`VALID_TRANSITIONS` lives in the constants module — enforce on every status update.

## Ticket ID generation

```ts
function generateTicketId(): string {
  const d = new Date()
  const yy = String(d.getFullYear()).slice(-2)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase()
  return `MT-${yy}${mm}-${rand}`
  // Example: MT-2605-A8F2K9
}
```

No counter. No race condition. Globally unique enough for demo + production scale.

## CDN URL handling

- All photos/invoices: `await CDN.upload(file)` → returns URL
- Store URL strings only in Data; never base64 blobs
- Original `images: string[]` and `completionImages: string[]` shape preserved

## SLA timing (carried from constants)

```ts
SLA = {
  EMERGENCY_RESPONSE: 1,     // hours
  HIGH_RESPONSE: 4,
  MEDIUM_RESPONSE: 24,
  LOW_RESPONSE: 72,
  APPROVAL_ESCALATION: 24,
  VENDOR_RESPONSE: 48
}
```

Used by the escalation job to detect breaches.

## Emergency keyword list (preprocessor)

```
gas smell, gas leak, active fire, fire, severe flooding, flooding,
water everywhere, electrical fire, smoke, carbon monoxide, no heat,
frozen pipes, burst pipe, sewage backup, structural collapse
```

Match triggers preprocessor injection — see [05-JOBS-PROCESSORS.md](./05-JOBS-PROCESSORS.md).
