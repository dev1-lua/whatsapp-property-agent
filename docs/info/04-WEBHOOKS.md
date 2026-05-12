# 04 — Webhooks

Webhooks split into two groups: **admin CRUD** (driven by the HTML page) and **external integration** (driven by partner systems and channels). The admin group preserves v1's contract exactly so the existing HTML page wires up with zero changes.

## Admin CRUD group — used by `property-guy-demo.html`

All admin webhooks use the v1 pattern: single endpoint per resource, method dispatched by JSON body's `method` field (`GET` / `POST` / `DELETE` / `PUT`).

### `properties` webhook

```
POST {agentBase}/properties
Body: { method: 'GET' | 'POST' | 'DELETE' | 'PUT', ...payload }
```

| method | payload | response |
|---|---|---|
| GET | — | `{ properties: Property[] }` |
| POST | `{ name, address, city, type, units }` | `{ success, property }` |
| PUT | `{ id, ...updates }` | `{ success, property }` |
| DELETE | `{ id }` | `{ success, deletedId }` |

Backed by `Data.get/create/update/delete` on `properties` collection.

### `tenants` webhook

| method | payload | response |
|---|---|---|
| GET | — | `{ tenants: Tenant[] }` |
| POST | `{ name, email?, phone?, propertyId, unit?, propertyName? }` | `{ success, tenant }` |
| PUT | `{ id, ...updates }` | `{ success, tenant }` |
| DELETE | `{ id }` | `{ success, deletedId }` |

Phone normalized on write. Propery name denormalized.

### `vendors` webhook

| method | payload | response |
|---|---|---|
| GET | — | `{ vendors: Vendor[] }` |
| POST | `{ name, email?, phone?, specialties[], hourlyRate? }` | `{ success, vendor }` |
| PUT | `{ id, ...updates }` | `{ success, vendor }` |
| DELETE | `{ id }` | `{ success, deletedId }` |

### `tickets` webhook (admin read)

| method | payload | response |
|---|---|---|
| GET | `{ status?, limit?, propertyId? }` | `{ tickets: Ticket[] }` |

Read-only for the admin UI. Tickets are created by the agent's `create_maintenance_ticket` tool, not via this webhook.

### `seed-data` webhook

```
POST {agentBase}/seed-data
Body: { method: 'POST', overwrite?: boolean, custom?: SeedPayload }
```

Bulk-creates properties, tenants, vendors from the default seed (or `custom`). Skips entries that match an existing record by `email`/`phone`/`propertyCode` unless `overwrite: true`.

Default seed lives in [seed-data/seed.example.json](./seed-data/seed.example.json).

Response: `{ success, created: { properties, tenants, vendors }, skipped: { ... }, message }`

### `clear-data` webhook

```
POST {agentBase}/clear-data
Body: { method: 'DELETE', confirm: true, full?: boolean }
```

| Mode | Effect |
|---|---|
| `{ confirm: true }` | Deletes all `tickets`, `audit_events`, `communications`, `escalations` only |
| `{ confirm: true, full: true }` | Also deletes `tenants`, `vendors`, `properties` |

Response: `{ success, deleted: { tickets, properties, ... } }`

## External integration group

### `vendor-response` webhook

Inbound from vendor partner systems / email. Updates a ticket based on vendor action.

```
POST {agentBase}/vendor-response
Body: {
  ticketId,
  action: 'accept' | 'decline' | 'quote' | 'complete',
  vendorId,
  // for quote:
  amount?, scopeNotes?,
  // for complete:
  completionNotes?, invoiceNumber?, actualCost?, photoUrls?: string[]
}
```

Routes to the appropriate tool internally (`claim_job`, `decline_job`, `submit_quote`, `complete_job`).

### `finance-approval` webhook

Inbound from finance partner (or the approval-email deep-link landing).

```
POST {agentBase}/finance-approval
Body: {
  ticketId,
  decision: 'approved' | 'rejected',
  approvedAmount?, approverName, comments?, conditions?: string[]
}
```

Routes to `record_finance_decision` tool internally.

### `escalation-response` webhook

Inbound when a manager resolves or updates an escalation.

```
POST {agentBase}/escalation-response
Body: {
  escalationId,
  status: 'in_review' | 'resolved' | 'closed',
  resolution?, resolutionBy
}
```

Updates the `escalations` entry. If `resolved`, may also update the linked ticket (e.g., un-dispute it).

### `inbound-email` webhook

Optional — used if not using Lua's native email channel. AgentMail / SMTP gateway POSTs incoming emails here. Looks up sender in `tenants`/`vendors`, creates a conversation turn for the agent.

```
POST {agentBase}/inbound-email
Body: {
  from: string,
  to: string,
  subject: string,
  body: string,
  attachments?: [{ url, filename, contentType }]
}
```

Internally: identity-resolve sender, then enqueue a message to the agent on behalf of that user.

**Recommendation for v2:** start with Lua native email channel; only build this webhook if Lua's channel falls short.

## Open tickets webhook (carryover from v1)

The v1 demo exposes `open-tickets` for external dashboards. Keep it for parity — same as `tickets` GET with `status != closed,cancelled`.

```
POST {agentBase}/open-tickets
Body: { method: 'GET' }
Response: { tickets: [...], count }
```

## Webhook conventions

- All webhooks: `POST` with JSON body
- All webhooks: return `{ success: boolean, ... }` shape
- All webhooks: return HTTP 200 with `{ success: false, error }` on validation failure (not 4xx — easier for the HTML page to handle uniformly)
- All webhooks: respect Lua's webhook signing if enabled at deploy time

## Webhook count

| Group | Count |
|---|---|
| Admin CRUD | 6 (properties, tenants, vendors, tickets, seed-data, clear-data) |
| External | 4 (vendor-response, finance-approval, escalation-response, inbound-email) |
| Carryover | 1 (open-tickets) |
| **Total** | **11** |
