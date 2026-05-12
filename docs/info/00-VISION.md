# 00 — Vision

## What we're building

A single Lua agent that runs the full property-maintenance lifecycle for one property management firm: tenants report issues, the agent triages and creates tickets, vendors claim and quote jobs, finance approves over-threshold work, vendors complete with documentation, and the system closes tickets — all backed by Lua's Data primitives, accessible across web chat, email, and WhatsApp.

It is a faithful port of the existing BC-backed agent (`../`), minus Business Central.

## Audience for the demo

1. **Mahmoud** (immediate) — building a facilities management demo for prospects in the development/property space.
2. **Stefan's pipeline** — "quite a few customers in the development space looking for facilities management agents like this."
3. **Sales-led calls** — 30–45 minute walkthroughs with property management firms.

## Why we're doing this

- The BC-backed original requires a Dynamics 365 tenant, Azure AD app registration, AL extension publish, and 17-company seed data. Impossible to demo cold.
- The Lua-native v2 replicates 100% of the workflow with zero external provisioning — `lua init` + run seed webhook = working demo for a new firm.
- Different firms have different vendor lists, properties, tenant rosters, approval thresholds. Per-agent Data isolation makes each demo a clean clone.

## Success criteria

The demo succeeds when, in 8 minutes, a non-technical viewer sees:

1. **A tenant message creates a real ticket** (web chat or WhatsApp) — including photo upload, automatic vendor assignment, and email notification
2. **A vendor responds in the same agent** — claims a job, submits a quote, completes work with photo evidence and invoice
3. **The approval workflow gates over-threshold spend** — under-threshold auto-approves, over-threshold routes to an approver inbox
4. **Multi-channel works** — same agent answers on web chat, email, WhatsApp (or at least two of the three demonstrated live)
5. **Admin UI shows live data** — tickets, properties, tenants, vendors are all viewable, editable, and add/remove without restarts
6. **Replication is one command** — "for Mahmoud's customer, I just `lua init` a new agent and POST their data to seed-data"

## Non-goals (explicitly out of scope)

- Real WhatsApp Business verification (use Meta's sandbox/test number — Path A in [08-CHANNELS.md](./08-CHANNELS.md))
- Real Stripe payment — keep in code but stub for the demo
- Multi-tenancy within one agent — one agent serves one firm
- Migrating data from the BC original — the demo starts fresh from seed
- Native mobile app — web widget + WhatsApp covers tenant-facing channels

## What's different from v1 (the netlify read-only demo)

| | v1 (read-only) | v2 (this) |
|---|---|---|
| Skills | 1 (admin Q&A) | 2 (tenant + vendor) |
| Tools | 1 (`query_data`) | 30+ (full original parity) |
| Identity resolution | None | Phone/email/WhatsApp → tenant/vendor |
| Ticket creation | No | Yes |
| Vendor flow | No | Yes |
| Approval workflow | No | Yes |
| Completion + payment | No | Yes (Stripe stub) |
| Channels | Web widget only | Web + Email + WhatsApp |
| Webhooks | Admin CRUD + Q&A | Admin CRUD + external integration |
| Jobs | None | Escalation + daily report |
| Pre/postprocessors | None | Emergency triage + summary + comm log |

## What's the same as v1

- Admin HTML page shape — sidebar tabs (Overview, Properties, Tenants, Vendors, Tickets, Chat)
- Engine dock for live API stream
- Seed-data button + clear-data
- Embedded LuaPop widget
- Webhook contract for `/properties`, `/tenants`, `/vendors`, `/tickets`, `/seed-data`, `/clear-data`
