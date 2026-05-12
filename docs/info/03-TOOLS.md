# 03 — Tools

30+ tools across two skills. Below: every tool with purpose, inputs, outputs, and what specifically changes from the BC version.

Inputs/outputs shown as TypeScript-ish for brevity. All input schemas live in Zod on the actual tool class.

## Skill: `tenant` (formerly `property-maintenance`)

### Identity

#### `get_user_context` — CALL FIRST, ALWAYS

Identifies whether the caller is a tenant, vendor, or unknown — based on phone, email, or already-cached identity. Persists resolution to `User` so subsequent turns skip the lookup. See [07-IDENTITY-RESOLUTION.md](./07-IDENTITY-RESOLUTION.md).

```
Input: { phone?, email?, name? }   // any combination; falls back to user._luaProfile
Output: {
  userType: 'tenant' | 'vendor' | 'unregistered',
  identity: {
    id: string,                    // tenants.id or vendors.id
    name: string,
    propertyId?: string,           // tenants only
    propertyName?: string,
    unit?: string,
    specialties?: string[],        // vendors only
    rating?: number
  } | null,
  message: string                  // user-facing greeting hint
}
```

**Changes from BC:** drops `companyId` resolution loop. No more 17-company search. Lookup hits two collections in parallel.

### Intake

#### `create_maintenance_ticket`
Creates a ticket. Auto-classifies issue type from description if not provided. Assesses urgency from keywords if not provided. Performs duplicate detection (open ticket, same property + issue type). Auto-assigns first active vendor matching specialty.

```
Input: {
  propertyCode, propertyName, propertyId,
  tenantId, tenantName, tenantPhone?, tenantEmail?,
  unit?, issueType?, description, location?, urgency?,
  tenantAccessNotes?, imageUrls?, relatedTicketId?, skipDuplicateCheck?
}
Output: {
  success, ticketId, status, issueType, urgency, propertyName,
  createdAt, imageCount, assignedVendor: {id, name} | null, nextSteps, message
}
```

**Changes:** uses `Data.create` instead of BC adapter; ticket ID generation is local (no BC counter); no BC dimension lookup for property — properties are passed by id; auto-assign reads `vendors` collection directly.

#### `upload_issue_images`
Uploads photos to CDN, appends URLs to ticket.images. Validates ≤10 images.

```
Input: { ticketId, images: File[] | base64[] }
Output: { success, addedUrls: string[], totalImages, message }
```

**Changes:** uses `CDN.upload` (Lua native) instead of BC document attachment.

#### `update_ticket_details`
Updates description, location, urgency, or access notes on a ticket. Status must be open.

```
Input: { ticketId, description?, location?, urgency?, tenantAccessNotes? }
Output: { success, ticketId, updatedFields, message }
```

#### `search_maintenance_history`
Semantic search over historical tickets. Uses `Data.search` (embedding-based) — actual win over BC.

```
Input: { query: string, status?, propertyCode?, limit? }
Output: { tickets: [{ ticketId, description, status, urgency, score, createdAt }], total }
```

**Changes:** semantic search via `Data.search` with `searchText` field. BC version did keyword filter on attachment JSON — much weaker.

#### `my_tickets`
Lists tickets for the current tenant (scoped by `user.tenantId`). Read + cancel.

```
Input: { action: 'list' | 'cancel', ticketId?, cancelReason? }
Output: list: { tickets: [...], count } | cancel: { success, ticketId, status, message }
```

### Vendor lookup (tenant-side, for vendor selection)

#### `lookup_vendors`
Finds vendors by issue type. Returns active vendors sorted by rating.

```
Input: { issueType: IssueType, propertyId?, limit? }
Output: { vendors: [{ id, name, specialties, rating, jobsCompleted, hourlyRate }] }
```

#### `send_vendor_request`
Sends a job offer to a specific vendor (override of auto-assignment). Updates ticket.assignedVendorId, sends notification email + in-app message.

```
Input: { ticketId, vendorId }
Output: { success, ticketId, vendorId, vendorName, sentAt, message }
```

#### `record_vendor_quote`
Records a quote (used when quote comes in via email or out-of-band, not via the vendor skill).

```
Input: { ticketId, vendorId, amount, currency?, scopeNotes }
Output: { success, ticketId, quote, requiresApproval, message }
```

#### `update_vendor_metrics`
After job completion, updates vendor rating + jobs count + revenue total.

```
Input: { vendorId, ticketId, rating?, costActual? }
Output: { success, vendorId, newRating, jobsCompleted, totalRevenue }
```

### Approval

#### `check_approval_threshold`
Pure logic. Compares quote amount against `env.APPROVAL_THRESHOLD`. No DB call.

```
Input: { quoteAmount, ticketId? }
Output: { requiresApproval, threshold, amount, autoApproved }
```

#### `send_for_approval`
Moves ticket to `pending_approval`, emails the approver (`env.APPROVER_EMAIL`) with a deep link to the approve/reject action.

```
Input: { ticketId, justification? }
Output: { success, ticketId, sentAt, approverEmail, message }
```

#### `record_finance_decision`
Records approve/reject from the finance webhook. Called by `finance-approval` webhook handler too.

```
Input: { ticketId, decision: 'approved' | 'rejected', approvedAmount?, approverName, comments?, conditions? }
Output: { success, ticketId, newStatus, message }
```

#### `initiate_payment`
Triggers Stripe payment (stubbed for demo). Updates ticket.payment.

```
Input: { ticketId, amount, currency? }
Output: { success, ticketId, paymentStatus, paymentIntentId?, message }
```

**Changes:** removes BC PO posting. Stripe-only.

### Completion

#### `record_completion_docs`
Records vendor's completion artifacts (photos, invoice, notes). Updates ticket status to `completed`.

```
Input: { ticketId, completionNotes, completionImages: string[], invoiceNumber, invoiceUrl?, actualCost }
Output: { success, ticketId, status, costVariance, message }
```

#### `request_tenant_confirmation`
Sends a satisfaction confirmation message to the tenant via `User.send` (or email fallback).

```
Input: { ticketId, message? }
Output: { success, ticketId, sentAt, message }
```

#### `record_tenant_dispute`
Records a tenant-raised dispute. Moves status to `disputed`. Creates escalation.

```
Input: { ticketId, disputeReason, severity? }
Output: { success, ticketId, escalationId, message }
```

#### `close_ticket`
Closes a `completed` (and confirmed) or `cancelled` ticket. Requires manager override if no tenant confirmation.

```
Input: { ticketId, closeReason, override?: { manager, reason } }
Output: { success, ticketId, closedAt, message }
```

### Escalation

#### `escalate_ticket`
Creates an `escalations` entry. Notifies manager.

```
Input: { ticketId, escalationType: EscalationType, reason, severity?: 'low' | 'medium' | 'high' }
Output: { success, escalationId, ticketId, assignedTo, message }
```

## Skill: `vendor` (formerly `vendor-management`)

### Browse + claim

#### `list_available_jobs`
Lists tickets matching the vendor's specialties that are still open (status `reported` or `vendor_contacted` and either unassigned or assigned to this vendor pending claim acceptance). Returns full details including photos.

```
Input: { vendorId? }                  // optional — falls back to user.vendorId
Output: { jobs: [{ ticketId, issueType, urgency, description, propertyName, unit, location, images, tenantAccessNotes }], count }
```

#### `claim_job`
Vendor self-assigns. Ticket status → `vendor_contacted` (if not already). Other vendors locked out.

```
Input: { ticketId, vendorId? }
Output: { success, ticketId, claimedAt, message }
```

#### `decline_job`
Vendor declines a claimed/auto-assigned job. Ticket resets to `reported` for re-assignment.

```
Input: { ticketId, vendorId?, declineReason }
Output: { success, ticketId, message }
```

#### `my_assigned_jobs`
Lists all jobs assigned to this vendor across all statuses (or filtered).

```
Input: { vendorId?, status?: TicketStatus | TicketStatus[] }
Output: { jobs: [{ ticketId, status, urgency, ...summary }], count }
```

### Quote

#### `submit_quote`
Submits an initial quote. Status → `pending_approval` (or auto-approved if ≤ threshold). Logs `quote_received` event.

```
Input: { ticketId, vendorId?, estimatedCost, scopeNotes, currency? }
Output: { success, ticketId, requiresApproval, autoApproved, message }
```

#### `submit_revised_quote`
Used when scope changes mid-job, OR after a quote was rejected. Auto-approves if revised cost ≤ previously approved amount; otherwise back to `pending_approval`.

```
Input: { ticketId, vendorId?, estimatedCost, scopeNotes, revisionReason }
Output: { success, ticketId, autoApproved, requiresReapproval, message }
```

### Work

#### `start_work`
Marks work in progress. Requires status `approved`.

```
Input: { ticketId, vendorId?, estimatedArrival?, arrivalNotes? }
Output: { success, ticketId, status, message }
```

#### `pause_work`
Pauses in-progress work. Status → `on_hold`. Requires reason.

```
Input: { ticketId, vendorId?, pauseReason }
Output: { success, ticketId, pausedAt, message }
```

#### `complete_job`
Completes a job. Requires completion photos + invoice details. Status → `completed`. Triggers tenant confirmation request.

```
Input: { ticketId, vendorId?, completionNotes, actualCost, completionPhotoUrls: string[], invoiceNumber, invoiceUrl? }
Output: { success, ticketId, status, costVariance, message }
```

#### `upload_vendor_photos`
Uploads photos (progress or completion) to CDN, appends to ticket.

```
Input: { ticketId, vendorId?, type: 'progress' | 'completion', images: File[] }
Output: { success, addedUrls, totalImages, message }
```

#### `validate_invoice`
Validates extracted invoice data against the ticket's expected amount + vendor. Used after agent visually inspects an invoice image.

```
Input: { ticketId, vendorId?, extractedAmount, extractedInvoiceNumber, extractedVendorName, extractedDate, extractedWorkDescription }
Output: { valid, withinTolerance, percentVariance, issues: string[], recommendation: 'proceed' | 'revise_quote' | 'override' | 'reject' }
```

## Tools count

| Skill | Count | Categories |
|---|---|---|
| tenant | 19 | identity (1), intake (5), vendor-side (4), approval (4), completion (4), escalation (1) |
| vendor | 11 | browse/claim (4), quote (2), work (5) |
| **Total** | **30** | |

## Cross-cutting requirements

All tools must:

- Guard against invalid state transitions (use `VALID_TRANSITIONS`)
- Log an `audit_events` entry for every material action (use `logEvent` helper)
- Return a consistent `{ success: boolean, message: string, ... }` shape — agent reads `message` for user-facing response
- Resolve identity from `User.get()` first; only call `Data.search` on miss
- Handle `Data.search` returning empty results gracefully (no throw)

## What changes mechanically across all tools

```ts
// Before (BC version)
const adapter = getBCAdapter()
const ticket = await adapter.getTicket(companyId, ticketId)
await adapter.updateTicket(companyId, ticketId, { status: 'in_progress' })

// After (Lua-native v2)
import { Data } from 'lua-cli'
const entry = await Data.getEntry('tickets', ticketId)
await Data.update('tickets', ticketId, { status: 'in_progress', updatedAt: now })
```

Drop `companyId` from every signature. Replace BC adapter calls 1:1 with Data API. No interface change in tool return shapes (so persona doesn't need rewriting).
