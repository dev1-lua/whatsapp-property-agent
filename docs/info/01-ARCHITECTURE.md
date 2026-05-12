# 01 — Architecture

## High-level shape

One Lua agent. Two skills. Three channels. Six Data collections. No external database.

```
                  ┌─────────────────────────────────┐
                  │  Tenants & Vendors              │
                  │  (WhatsApp · Email · Web Chat)  │
                  └─────────────┬───────────────────┘
                                │
                    ┌───────────▼───────────┐
                    │   Lua Agent           │
                    │   "Alex Carter"       │
                    │                       │
                    │  ┌─────────────────┐  │
                    │  │ Skills          │  │
                    │  │ • tenant        │  │
                    │  │ • vendor        │  │
                    │  └────────┬────────┘  │
                    │  ┌────────▼────────┐  │
                    │  │ Pre/Post-       │  │
                    │  │ processors      │  │
                    │  └────────┬────────┘  │
                    │  ┌────────▼────────┐  │
                    │  │ Lua Primitives  │  │
                    │  │ • Data API      │  │
                    │  │ • User API      │  │
                    │  │ • CDN API       │  │
                    │  │ • Channels      │  │
                    │  └─────────────────┘  │
                    └───┬───────────────┬───┘
                        │               │
              ┌─────────▼──┐    ┌───────▼──────────┐
              │  Webhooks  │    │  Scheduled Jobs  │
              │  (admin)   │    │  (escalation,    │
              │  (vendor)  │    │   daily report)  │
              │  (finance) │    │                  │
              │  (email)   │    │                  │
              └────────────┘    └──────────────────┘
                    ▲
                    │
          ┌─────────┴──────────┐
          │  Admin HTML page   │
          │  (CRUD UI)         │
          └────────────────────┘
```

## Component map: Lua primitive → property-mgmt concept

| Lua primitive | Used for |
|---|---|
| `Data.create/get/search/update/delete` | All persistent state: tickets, tenants, vendors, properties, audit events, communications, escalations |
| `User.get/update/save` | Per-conversation identity cache (which tenant/vendor is the caller), in-progress draft state |
| `CDN.upload` | Issue photos, completion photos, invoice PDFs |
| `LuaSkill` | `tenant` skill (intake/approval/completion/escalation) and `vendor` skill (claim/quote/work/complete) |
| `LuaTool` | 30+ individual operations |
| `LuaWebhook` | Admin CRUD endpoints (HTML page) + external integration receivers (vendor-response, finance-approval, escalation-response, inbound-email) |
| `LuaJob` | Escalation SLA monitor, daily workload report |
| `PreProcessor` | Emergency triage — injects safety instructions before agent responds to "fire/gas/flood" |
| `PostProcessor` | Ticket-summary card formatter, communication-log auditing |
| `Channels` | WhatsApp (sandbox test number for demo), Email (Lua native channel), Website widget (LuaPop) |
| `Agents API` | Optional: outbound notifications via `user.send` for vendor-assigned messages |
| `Environment` | Firm config: `FIRM_NAME`, `APPROVER_EMAIL`, `APPROVAL_THRESHOLD`, Stripe keys |

## Identity flow

```
inbound message
    │
    ▼
Channel adapter (WhatsApp/Email/Web)
    │  attaches: user._luaProfile.phone | .email
    ▼
Preprocessor: emergency-triage
    │  if EMERGENCY keywords → inject safety instructions
    ▼
Agent: get_user_context (always first per persona)
    │  1. Read User.get() — already-resolved identity?
    │  2. Search tenants collection by phone/email
    │  3. Search vendors collection by phone/email
    │  4. User.update with resolution → cache for rest of conversation
    ▼
Mode switch (persona-driven)
    │  tenant → intake tools enabled in conversation
    │  vendor → vendor flow tools enabled
    │  unregistered → polite reject
    ▼
Tool execution → Data.* calls
    ▼
Postprocessors: ticket-summary, communication-log
    │  format response, write audit entry to communications collection
    ▼
Channel adapter → outbound message
```

## Tenant flow (happy path)

```
Tenant: "Kitchen sink leaking" + photos
    │
    ▼  get_user_context → tenant matched (Laura, Temple Place 3B)
    │
    ▼  upload_issue_images → CDN URLs
    │
    ▼  create_maintenance_ticket → Data.create({collection:'tickets'})
    │                              → auto-assigns first active vendor
    │                              → audit_events entry
    │                              → email to vendor + tenant
    │
    ▼  Agent: "Ticket MT-2605-A8F2 created. Dublin Plumbing notified."
```

## Vendor flow (happy path)

```
Vendor: "What jobs are available?"
    │
    ▼  get_user_context → vendor matched (Dublin Plumbing)
    │
    ▼  list_available_jobs → Data.get({collection:'tickets',
    │                                  filter:{status:vendor_contacted,
    │                                          assignedVendorId:vendorId}})
    │
    ▼  Agent: shows job card with photos
    │
    ▼  Vendor: "I'll take it, €280"
    │
    ▼  claim_job → Data.update
    │
    ▼  submit_quote → if amount ≤ APPROVAL_THRESHOLD: auto-approve
    │                else: send_for_approval → email APPROVER_EMAIL
    │
    ▼  start_work → status: in_progress
    │
    ▼  complete_job (with photos + invoice) → status: completed
    │
    ▼  request_tenant_confirmation (parallel agent call to tenant)
    │
    ▼  close_ticket
    │
    ▼  initiate_payment (Stripe stub)
```

## Cross-cutting concerns

**Tenancy.** One agent = one firm. No `companyId` on records. To support a new firm, clone the repo, `lua init` a new agent, `lua env` for firm config, POST seed-data with their portfolio.

**Caching.** User identity cached on `user.tenantId` / `user.vendorId` after first resolution — subsequent turns skip the Data.search. Listings (e.g., `list_available_jobs`) hit Data fresh each call so admin edits propagate immediately.

**Audit.** Every state change writes a row to `audit_events` collection. Every outbound message writes to `communications` collection (via communication-log postprocessor).

**Idempotency.** Ticket IDs use `MT-{yymm}-{6char}` from random — not a global counter, so concurrent creations don't race. See [02-DATA-MODEL.md](./02-DATA-MODEL.md).

**Failure modes.**
- Channel down → message queued by Lua; agent reads on reconnect
- Data API hiccup → tool returns `{success: false, error}`; agent surfaces friendly retry
- Email delivery fail → tool logs to console + `communications` entry marks `delivery: failed`; non-fatal
- Stripe fails → ticket stays at `completed` but `payment.status: failed`; daily report flags

## Why single-agent (not separate tenant/vendor agents)

- Matches the BC original's design
- Same persona handles both — instant mode switch is impressive in the demo
- One channel set, one Data namespace, one cost meter
- Identity resolution decides mode at run time

## Why six collections (not one)

- Different lookup patterns — tenants/vendors search by phone (exact), tickets search by description (semantic), audit_events filter by ticketId (exact)
- Different sizes — audit_events grows fastest; isolating it keeps `Data.search` on tickets snappy
- Clear ownership — admin webhooks touch tenants/vendors/properties; agent touches tickets/audit_events/communications
