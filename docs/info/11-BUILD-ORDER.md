# 11 — Build Order

Day-by-day sequence with explicit demoable milestones at each step. The order is chosen so every step ends with something visible to test, not a half-built layer.

Assumption: one full-time engineer (Dev), 3 working days.

## Day 0 (afternoon) — Scaffolding (2 hours)

| Step | Action | Demoable? |
|---|---|---|
| 0.1 | Inside this planning folder, run `lua init` → fresh agent ID and skill yaml | New agent visible in Lua dashboard |
| 0.2 | Copy `package.json`, `tsconfig.json`, `.gitignore` shapes from `../` (BC original) | `npm install` succeeds |
| 0.3 | Carry over `src/utils/constants.ts` verbatim (drop only the `TRIBECA_COMPANY_ID` and `BC_DIMENSIONS` exports) | Compiles |
| 0.4 | Create `src/utils/ticket-id.ts` with the new `generateTicketId()` (timestamp + random) | Unit test passes |
| 0.5 | Write `src/services/data.ts` — thin wrappers around `Data.create/get/search/update/delete` for all 6 collections (tenants, vendors, properties, tickets, audit_events, communications, escalations) | Unit test passes |
| 0.6 | Write `src/utils/audit-log.ts` — `logEvent` and `logStatusChange` helpers that write to `audit_events` collection | Unit test passes |
| 0.7 | Copy v1's `property-guy-demo.html` into this folder; update `DEFAULT_AGENT_ID` to the v2 agent | HTML loads but webhooks 404 (expected) |

**End of Day 0:** scaffold compiles, data layer ready, HTML page loads.

## Day 1 (morning) — Admin webhooks + seed (3 hours)

| Step | Action | Demoable? |
|---|---|---|
| 1.1 | Build `webhooks/admin/properties.webhook.ts` — GET/POST/PUT/DELETE on `properties` collection | HTML Properties tab adds/lists/deletes |
| 1.2 | Build `webhooks/admin/tenants.webhook.ts` — same shape, plus phone normalization on write | HTML Tenants tab works |
| 1.3 | Build `webhooks/admin/vendors.webhook.ts` — same shape | HTML Vendors tab works |
| 1.4 | Build `webhooks/admin/tickets.webhook.ts` — GET only (with filters) | HTML Tickets tab shows empty list |
| 1.5 | Build `webhooks/admin/seed-data.webhook.ts` — bulk insert from `seed-data/seed.example.json` | "Seed demo data" button populates everything |
| 1.6 | Build `webhooks/admin/clear-data.webhook.ts` — partial (tickets only) + full (everything) | Clear button works |
| 1.7 | `lua push` and test against deployed agent | HTML page on Netlify works end-to-end for admin CRUD |

**Milestone:** v1-equivalent admin demo working on v2 agent. We could ship this and call it parity with v1.

## Day 1 (afternoon) — Identity + intake (4 hours)

| Step | Action | Demoable? |
|---|---|---|
| 1.8 | Write the persona yaml — adapt `../lua.skill.yaml` lines 4–257 per [06-PERSONA.md](./06-PERSONA.md) edits | Persona loads in Lua dashboard |
| 1.9 | Build `tools/intake/GetUserContextTool.ts` — per [07-IDENTITY-RESOLUTION.md](./07-IDENTITY-RESOLUTION.md) | `lua chat` test: introduce as Laura → matches |
| 1.10 | Build `tools/intake/CreateMaintenanceTicketTool.ts` — auto-classify, auto-assign vendor, log event, send email | `lua chat` test: tenant creates ticket end-to-end |
| 1.11 | Build `tools/intake/MyTicketsTool.ts` — list + cancel | `lua chat` test: "show my tickets" |
| 1.12 | Build `tools/intake/UpdateTicketDetailsTool.ts` | `lua chat` test: update description |
| 1.13 | Build `tools/intake/UploadIssueImagesTool.ts` — uses `CDN.upload` | `lua chat` test: send photo, see CDN URL in ticket |
| 1.14 | Build `tools/intake/SearchMaintenanceHistoryTool.ts` — uses `Data.search` semantic | `lua chat` test: search "leak" → finds past tickets |
| 1.15 | Register tools in `tenant` skill, wire skill to agent | All 6 tools deployed |

**Milestone:** tenant happy path works end-to-end. The centerpiece of the demo.

## Day 2 (morning) — Vendor flow (4 hours)

| Step | Action | Demoable? |
|---|---|---|
| 2.1 | Build `tools/vendor/ListAvailableJobsTool.ts` — filter by specialty + status | `lua chat` as vendor: see jobs |
| 2.2 | Build `tools/vendor/ClaimJobTool.ts` + `DeclineJobTool.ts` | Vendor claims/declines |
| 2.3 | Build `tools/vendor/SubmitQuoteTool.ts` + `SubmitRevisedQuoteTool.ts` — threshold check inline | Quote logic works |
| 2.4 | Build `tools/vendor/StartWorkTool.ts` + `PauseWorkTool.ts` | Status transitions work |
| 2.5 | Build `tools/vendor/CompleteJobTool.ts` — requires photos + invoice | Vendor completes a job |
| 2.6 | Build `tools/vendor/UploadVendorPhotosTool.ts` | Photo upload works |
| 2.7 | Build `tools/vendor/ValidateInvoiceTool.ts` | Invoice validation flow |
| 2.8 | Build `tools/vendor/MyAssignedJobsTool.ts` | "Show my jobs" works |
| 2.9 | Build `tools/vendor/LookupVendorsTool.ts` + `SendVendorRequestTool.ts` + `RecordVendorQuoteTool.ts` + `UpdateVendorMetricsTool.ts` (tenant-side vendor mgmt) | Tenant-side vendor lookups work |
| 2.10 | Register tools in `vendor` skill | Vendor skill deployed |

**Milestone:** vendor happy path works end-to-end.

## Day 2 (afternoon) — Approval + completion + escalation (3 hours)

| Step | Action | Demoable? |
|---|---|---|
| 2.11 | Build `tools/approval/CheckApprovalThresholdTool.ts` (pure logic) | Threshold check works |
| 2.12 | Build `tools/approval/SendForApprovalTool.ts` — email to APPROVER_EMAIL | Approval email arrives in test inbox |
| 2.13 | Build `tools/approval/RecordFinanceDecisionTool.ts` | Decision recorded |
| 2.14 | Build `tools/approval/InitiatePaymentTool.ts` — Stripe stub | Payment "initiated" |
| 2.15 | Build `tools/completion/*` (4 tools) | Closure flow works |
| 2.16 | Build `tools/escalation/EscalateTicketTool.ts` | Escalation creates entry |
| 2.17 | Build webhooks: `vendor-response`, `finance-approval`, `escalation-response` — route to corresponding tools | Webhook integration tests pass |

**Milestone:** over-threshold approval demo works end-to-end.

## Day 2 (evening, optional) — Jobs + processors (2 hours)

| Step | Action | Demoable? |
|---|---|---|
| 2.18 | Build `preprocessors/emergency-triage.preprocessor.ts` — keyword detection | Tenant says "gas smell" → safety instructions injected |
| 2.19 | Build `postprocessors/ticket-summary.postprocessor.ts` — list-item formatting | Ticket card renders |
| 2.20 | Build `postprocessors/communication-log.postprocessor.ts` — Data.create on communications | Audit entries appear |
| 2.21 | Build `jobs/escalation.job.ts` — hourly cron | Manual trigger creates escalation |
| 2.22 | Build `jobs/daily-report.job.ts` — daily cron | Manual trigger sends report email |

**Milestone:** all primitives operational. Behavior matches BC original 100%.

## Day 3 (morning) — Channels (30 minutes)

| Step | Action | Demoable? |
|---|---|---|
| 3.1 | LuaPop already embedded in the HTML — update `agentId` to v2 | Web chat works |
| 3.2 | `lua channels` → connect Email channel; test inbound from Gmail | Email round-trip works |
| 3.3 | WhatsApp: from your phone, message `+1 (302) 377-8932` with `link-me-to:<v2-agent-id>` | WhatsApp routes to agent |
| 3.4 | Have Mahmoud / Stefan / anyone on the call also send `link-me-to:<v2-agent-id>` from their WhatsApp to join the demo | Multiple senders can message the agent |

**Milestone:** all three channels live in under 10 minutes.

## Day 3 (afternoon) — Admin UI polish + dry run (3 hours)

| Step | Action | Demoable? |
|---|---|---|
| 3.7 | Add persona pill to HTML per [10-ADMIN-UI.md](./10-ADMIN-UI.md) | Pill switches identity |
| 3.8 | Add tool-call timeline panel beside chat widget | Tool calls visible during chat |
| 3.9 | Add scenario buttons row | One-click demo scenarios |
| 3.10 | Add channel-aware persona prompts (yaml `channelPrompts`) | WhatsApp output uses plain text |
| 3.11 | Deploy HTML to Netlify | Public URL for the demo |
| 3.12 | Full dry run (8-minute script) | Practice round 1 |
| 3.13 | Adjust pacing, fix bugs | Practice round 2 |
| 3.14 | Final dry run with Mayank watching | Ready for the call |

**Milestone:** demo-ready.

## Total: ~22 hours of focused engineering work

## Critical path (if compressed to 2 days)

If 3 days isn't available, the must-haves to look credible in the demo:

1. Admin webhooks + seed (Day 1 morning) — **required**
2. Identity + intake tools (Day 1 afternoon) — **required**
3. Vendor flow (Day 2 morning) — **required**
4. Approval (Day 2 afternoon, first half) — **required**
5. WhatsApp sandbox connect (Day 3 morning) — **required**
6. Persona pill + scenarios in HTML (Day 3 afternoon) — **required**

Cuttable for compressed timeline:
- Daily-report job → mention in slide, don't run live
- Escalation job → mention, don't trigger
- Communications collection inspector tab → not needed for 8-min demo
- Channel-aware persona prompts → fall back to one persona across channels (works, just looks slightly off on WhatsApp)
- Email channel → can skip in favor of WhatsApp-only for the "other channels" beat

## When to deploy vs. test in sandbox

- Daily work happens in sandbox via `lua chat -e sandbox`
- `lua push` to production once a primitive is functionally complete
- Final demo runs against production agent — sandbox is dev-only

## Smoke tests at each milestone

Each milestone should have a `lua chat -e production -m "..."` one-shot test that proves it works without launching the HTML page. Capture these as a shell script in `scripts/smoke-tests.sh` for fast regression checks.

```bash
# scripts/smoke-tests.sh
set -e

lua chat -e production -m "Hi, I'm Laura at +353861234567, can you check my tickets?" | grep -i "laura"
lua chat -e production -m "I'm Dublin Plumbing, what jobs are available?" | grep -i "job"
lua chat -e production -m "Show me open tickets in Dublin" | grep -i "ticket"

echo "✓ Smoke tests passed"
```
