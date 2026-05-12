# Build Progress — Property Maintenance Demo (v2, Lua-native)

> Living document. Updated as we go. Source of truth = `docs/info/*.md` (spec).
> Last major update: 2026-05-12 (day 2 — architectural pivot to unified contacts).

## Day 2 plan — phone-first unified contacts + WhatsApp role routing

### What changed in the requirements

The demo target has two surfaces, both must work:

1. **WhatsApp**
   - Phone-first DB. Each row has `roles[]` covering any of: tenant / vendor / admin (manager). Multi-role allowed (one person can be admin + tenant).
   - Tenant raises a ticket → assigned vendor gets a **WhatsApp ping** (agent-initiated outbound, not just an email-stub).
   - Vendor replies "accept" on WhatsApp → tenant gets a **WhatsApp ack** ("your ticket is acknowledged, someone's coming").
   - Manager (admin role) can ask "what tickets are in progress?" on WhatsApp and get a live answer.
   - Unknown phone messaging in → agent infers tenant vs vendor from intent ("my sink is leaking" → tenant; "I'm available for the plumbing job" → vendor), confirms, registers.

2. **HTML admin dashboard**
   - Dropdown picks an identity (manager / tenant / vendor) → agent immediately behaves as that role, no "who are you?" loop.
   - Role changes in the DB (CRUD-able) propagate to the next message — cache invalidates on role flip.

### Architectural decision: unified `contacts` collection (Option B)

Replaces separate `tenants` / `vendors` collections with one phone-first identity directory.

```typescript
// New COLLECTIONS map
{ PROPERTIES, CONTACTS, TICKETS, AUDIT_EVENTS, COMMUNICATIONS, ESCALATIONS }

// Contact row
{
  _id, name, phones[], email?,
  userId?,                          // Lua User.id, captured on first inbound — enables User.get(id).send()
  roles: ('tenant'|'vendor'|'admin')[],
  // tenant-shaped (when role includes 'tenant')
  units?: [{ propertyCode, unit, label? }],   // multi-apartment supported
  // vendor-shaped
  specialties?, hourlyRate?, rating?, jobsCompleted?, active?,
  // admin-shaped
  adminScope?: 'all' | propertyCode[],
  createdAt, updatedAt
}
```

**Why unified over separate `admins` collection (Option A):** the user confirmed multi-role is real ("admin + tenant"). Option A's drift problem (two rows per person) compounds the HTML dropdown bug. Unified gives one canonical row, one `roles[]` edit to flip, atomic cache invalidation.

**Backward-compat trick:** keep `Tenants` and `Vendors` wrappers in `src/services/data.ts` as **filtered views** over `Contacts` (read-only delegates that inject `{roles: {$in: ['tenant'|'vendor']}}` into filters). Most existing tools keep working without changes. Only `GetUserContext`, register tools, and admin webhooks need real surgery.

**Ticket FK rename:** `tenantId → tenantContactId`, `vendorId → vendorContactId`. `tenantUserId` / `vendorUserId` stay (they're cached Lua `User.id` for outbound `User.get(...).send()`).

### Refactor scope (measured)

- ~26 call sites of `Tenants.*` / `Vendors.*` — most keep working through filtered views
- ~161 occurrences of `tenantId|vendorId|tenantUserId|vendorUserId` — most are reads from ticket objects, safe to bulk find/replace
- 1 seed file, 1 seed webhook, 2 admin webhooks, 2 self-register tools — real surgery

### Milestones

| # | Milestone | Sandbox check |
|---|---|---|
| M1 | Schema + seed + GetUserContext + RegisterSelfAsTenant + persona admin branch | ✅ all 6 scenarios pass |
| M2 | `/contacts` CRUD webhook + role-filtered admin views + RegisterSelfAsVendor + HTML dropdown `viewAs` wiring + admin webhook rebuild for units[] | required before M3 |
| M3 | Manager-on-WhatsApp stats tools (get_open_ticket_count, list_tickets_in_progress, list_pending_approvals, recent_activity) | required before M4 |
| M4 | Vendor-ping + tenant-ack flow on WhatsApp (`User.get(userId).send(...)`) | required before M5 |
| M5 | `reset_my_identity` tool + persona rules to neutralize chat-history bleed | final |

Each milestone gates a production deploy. User approves before each `lua push --force` to prod.

### M1 scope refinements

- **Skipped ticket FK rename.** `tenantId`/`vendorId` field names on tickets stay. Semantics change: they now reference `contacts._id` of the role-bearer. Saves ~30 files of churn with no functional cost.
- **`Tenants` and `Vendors` data wrappers kept** as role-filtered views over the new unified `Contacts` collection — so existing tool callsites compile unchanged.
- **Brute-scan filter for role views.** `$in` on the `roles[]` array silently returns 0 results — same well-known platform bug we hit for `phones[]`. The `Tenants`/`Vendors`/`Admins` views fetch all contacts and filter `roles.includes(role)` in memory. Bounded by ~1000-row limit which is fine for the demo.

### M1 sandbox smoke test results (2026-05-13)

All 6 scenarios pass on staged v1.0.6:

| Scenario | Phone | Expected | Got |
|---|---|---|---|
| Single-unit tenant | 353861000001 (Laura) | userType=tenant, unitCount=1 | ✅ "Recognized tenant: Laura at No.4 Temple Place, unit 3B" |
| Multi-unit tenant | 353861000002 (James) | userType=tenant, unitCount=2, ask which unit | ✅ "Recognized tenant: James — has 2 units (WESTGATE-07 7, WESTGATE-07 12). On ticket creation, ASK which unit they're reporting from" |
| Admin-only | 353871000001 (Niamh) | userType=admin, adminScope=all | ✅ "Recognized admin/manager: Niamh (scope: all properties). Skip onboarding." |
| Multi-role default | 353871000002 (Conor) | userType=admin (precedence) | ✅ admin mode, adminScope=['TEMPLE-04'] |
| Multi-role viewAs=tenant | 353871000002 + viewAs:tenant | userType=tenant, unit 2C | ✅ flips to tenant, "unit 2C" |
| Unknown phone | 353999999999 | userType=unregistered, intent-inference guidance | ✅ |
| Register new tenant | new phone + property/unit | contact row written, lookup succeeds | ✅ |

Seed populates 3 properties + 10 contacts (4 tenants, 4 vendors, 2 admins one of whom is multi-role).


### 🚩 FLAGGED — two platform constraints discovered in research

**1. Outbound WhatsApp messaging — works, with a handshake constraint**

Lua exposes two outbound paths:
- **`User.get(userId).send([{type:'text', text:'...'}])`** — free-form, no Meta template needed. Works inside tool `.execute()`, webhooks, and jobs. *Already used in `src/tools/completion/RequestTenantConfirmationTool.ts:49-51`.* **Constraint: requires the recipient's Lua `userId`. They must have messaged the agent at least once so we can capture and persist `userId` on their contact row.**
- **`Templates.whatsapp.send(channelId, templateId, {phoneNumbers, values})`** — cold outreach to any opted-in phone number, but requires pre-approved Meta templates with fixed structure.

**Decision:** for the demo, use the `User.get().send()` path. Each vendor/admin does a one-time WhatsApp handshake ("hi") which captures their `userId`. Ticket pings, tenant acks, manager broadcasts all flow through this path. No Meta template approval needed. Documented in M4.

**2. WhatsApp chat-thread clear — no native API**

Lua exposes:
- `user.clear()` — wipes ALL custom user data (not selective)
- `user.getChatHistory()` — read-only access to last 40 messages
- **No documented `clearChatHistory()` / `resetThread()` / selective clear.**

This is the root cause of the "Hi Devashish" bleed after a clear-data nuke — the Meta-side chat transcript persists, and the agent reads stale turns.

**Mitigation strategy (M5):**
1. `reset_my_identity` tool — agent calls it when user says "I'm new", "reset", "forget me". Clears `userType`, `contactId`, `tenantId`, `vendorId` from the user's custom data and sets `_resetAt` timestamp.
2. Persona rule — when `_resetAt` is recent (within current session), ignore prior turn references that don't match current identity, re-introduce from scratch.
3. Fallback for demos — use a fresh WhatsApp number for each fresh test session (workaround, not a fix).

---

## Snapshot

- **Agent:** `baseAgent_agent_1778570087307_uu37q4v0m`
- **Org:** `7e7093fb-54c0-42a7-8dc7-f51e2ab738ee`
- **Persona:** Alex Carter — Property Maintenance Coordinator
- **Started:** 2026-05-12
- **Production URL pattern:** `https://webhook.heylua.ai/baseAgent_agent_1778570087307_uu37q4v0m/<webhook-name>`
- **Hosted admin HTML:** https://fastidious-malasada-285366.netlify.app
- **WhatsApp link:** https://wa.me/13023778932?text=link-me-to%3AbaseAgent_agent_1778570087307_uu37q4v0m

## Live version inventory (production)

| Primitive | Version | Notes |
|---|---|---|
| tenant skill | v1.0.12 | dedup brute-scan fix |
| vendor skill | v1.0.6 | submit-quote two-hop transition fix |
| 11 webhooks | v1.0.4 | admin CRUD (6) + external (5) |
| 2 jobs | v1.0.3 | escalation-check, daily-workload-report |
| emergency-triage preprocessor | v1.0.3 | gas/fire keyword blocking with safety text |
| ticket-summary postprocessor | v1.0.3 | rich card after MT-* mentions |
| communication-log postprocessor | v1.0.3 | audit row per outbound |
| persona | v7 | welcomes unregistered → onboard via register_self_as_tenant |

## Phases — all DONE

| # | Phase | Status |
|---|---|---|
| 0 | Day 0 scaffolding (constants, ticket-id, audit-log, data wrappers, gitignore) | ✅ done |
| 1 | Foundation (persona yaml, agent index, skill stubs, seed JSON, helpers) | ✅ done |
| 2 | Admin webhooks (6) — properties/tenants/vendors/tickets/seed-data/clear-data | ✅ done |
| 3 | Identity + intake tools (6) | ✅ done |
| 4 | Vendor flow tools (11) | ✅ done |
| 5 | Approval + completion + escalation + tenant-side vendor (13) | ✅ done |
| 6+7+8 | External webhooks + preprocessor + postprocessors + jobs (10) | ✅ done |
| 9 | HTML enhancements (persona pill, scenarios, tool timeline, auto-refresh) | ✅ done |
| 10 | Compile, push, deploy, sandbox smoke + production E2E | ✅ done |
| 11 | Self-registration flow + auto-property-create | ✅ done |

## Phase 1: foundation files written

- `lua.skill.yaml` — full Alex Carter persona text
- `seed-data/seed.example.json` — Dublin portfolio (3 properties, 4 tenants, 4 vendors)
- `src/utils/identity.ts` — `normalizePhone`, `normalizeEmail`, `collectPhones`, `collectEmails`
- `src/utils/communication-log.ts` — writes to `communications` collection
- `src/utils/email-notifications.ts` — **STUB** (logs to console + writes communication row, no real delivery)
- `src/utils/email-templates.ts` — `vendorJobAssignedEmail`, `tenantTicketCreatedEmail`, `approvalRequestEmail`, `escalationNotificationEmail`
- `src/utils/ticket-helpers.ts` — `classifyIssueType`, `assessUrgency`, `canTransition`, `nextStepsByUrgency`
- `src/utils/domain-types.ts` — TS interfaces matching docs/info/02-DATA-MODEL.md
- `BUILD-PATTERNS.md` — conventions used by the parallel subagents

## Phases 2–8: built by 6 parallel subagents (~7,766 lines)

- **Subagent A** — 6 admin webhooks (924 lines): properties / tenants / vendors / tickets / seed-data / clear-data
- **Subagent B** — 6 intake tools (1,232 lines): GetUserContext, CreateMaintenanceTicket, UploadIssueImages, UpdateTicketDetails, SearchMaintenanceHistory, MyTickets
- **Subagent C** — 11 vendor flow tools (1,886 lines): List/Claim/Decline/My/Submit/SubmitRevised/Start/Pause/Complete/Upload/Validate
- **Subagent D** — 13 tenant-side tools (1,565 lines): approval/completion/escalation/tenant-side-vendor-mgmt
- **Subagent E** — external webhooks + jobs + processors (1,821 lines): vendor-response, finance-approval, escalation-response, inbound-email, open-tickets, emergency-triage, ticket-summary, communication-log, escalation, daily-report
- **Subagent F** — HTML enhancements (+339 lines): persona pill, scenario buttons, tool-call timeline

## Phase 11: self-registration (added later, after spec discussion)

- `src/tools/intake/RegisterSelfAsTenantTool.ts` — captures channel phone/email auto, creates tenant + optionally a new property
- Property resolution: exact propertyCode match → substring match → return list (no semantic — caused false positives)
- Auto-create property when `autoCreateIfMissing: true` + `propertyAddress` provided
- Dedupe by phone with **brute-scan fallback** (v1.0.12 — `$in` query was silently missing matches)
- Persona updated: welcomes unregistered, asks name + property, calls `register_self_as_tenant`, retries with auto-create on `property_not_found`
- Unit ask: only for multi-unit buildings; don't pester single-family

## Decisions made / defaulted (2026-05-12)

| Question | Choice | Override path |
|---|---|---|
| Persona name (Q4) | "Alex Carter" | edit `lua.skill.yaml` |
| Seed region (Q6) | Dublin / Ireland | edit `seed-data/seed.example.json` |
| Email channel (Q1) | Stub (logs + communications row) | wire `lua channels` or swap nodemailer/Resend in `email-notifications.ts` |
| HTML hosting (Q2) | Netlify (`fastidious-malasada-285366.netlify.app`) | re-deploy whenever HTML changes |
| Auth barrier (added in Phase 11) | Drop — agent self-registers unknown users | already done |

## Bugs caught + fixed

| Bug | Fix |
|---|---|
| Zod `enum` / `nativeEnum` / `union` schemas break Gemini function calls (`anyOf` with siblings) | Replace with `z.string().describe('one of: ...')` — applied to 6 tools |
| GetUserContext cached identity didn't invalidate when phone changed (persona pill, different sender) | Added `cacheStillMatches(entryData)` — compares cached entity's phones/email against incoming candidates |
| SubmitQuoteTool: invalid transition `vendor_contacted → approved` directly | Validate two-hop: `vendor_contacted → quoted → approved`; intermediate state isn't persisted |
| Seed-data webhook: `fs.readFileSync('seed-data/seed.example.json')` fails on Lua's serverless runtime | Inlined the JSON as a TS constant |
| Property resolver semantic-search false positive (Sycamore → Westgate) | Dropped semantic fallback; only exact + substring |
| **TEST_USER_PHONE in prod env REPLACED channel phones → every WhatsApp user identified as the same person** | Changed code: TEST overrides fall through ONLY when `_luaProfile.phone` is empty; channel identifiers always win. Plus deleted TEST_USER_PHONE from prod env. |
| RegisterSelfAsTenantTool dedup missed duplicate Yash (same phone → 2 tenant rows) | `$in` query unreliable on array fields — added brute-scan fallback (v1.0.12) |

## E2E flows verified live in production

- ✅ Tenant intake: phone match → photos → `create_maintenance_ticket` → auto-classify (issue type + urgency) → auto-assign vendor by specialty → audit_events written → email-stub fired
- ✅ Vendor flow: claim → submit quote (€280, auto-approved under €500 threshold) → start_work → complete with photos + invoice → cost variance computed → status: completed
- ✅ Emergency preprocessor blocks "gas leak" with safety instructions before LLM processes
- ✅ Persona-pill identity switch mid-session (after `cacheStillMatches` fix)
- ✅ Admin Q&A: "which vendors handle plumbing?" → live data from Vendors collection
- ✅ Multi-tester WhatsApp: each phone number gets its own tenant row (after TEST_USER_PHONE bug fixed)

## Production env vars (set on the Lua dashboard)

```
APPROVAL_THRESHOLD=500
APPROVER_EMAIL=dev@luaimplementation.ai
MANAGER_EMAIL=dev@luaimplementation.ai
FIRM_NAME="Demo Property Management"
CURRENCY=EUR
ADMIN_EMAILS=dev@luaimplementation.ai
# DELETED: TEST_USER_PHONE / TEST_USER_EMAIL (caused cross-user bug)
```

## Known issues going into next session

### 🟡 Chat-history bleed across WhatsApp sessions
**Symptom:** Same WhatsApp number → after DB nuke, agent still "remembers" old tickets and names because Lua's chat thread persists across sessions. Reads stale transcript and confabulates.
**Reproduction:** Operator's WhatsApp had old session with `MT-2605-8513AO` and "Devashish" identity. After full clear-data + re-seed, sent "hi my sink is leaking" — agent replied "Hi Devashish, you already have a ticket for MT-2605-8513AO". The ticket doesn't exist in DB.
**Fix options for next session:**
1. **Add `reset_my_identity` tool** — agent calls it when user says "I'm new" / "reset" / "forget me". Tool clears `user.userType`, `user.identityId`, `tenantId`, `vendorId`. Persona updated to recognize the cue.
2. **Programmatic chat-thread clear** — find Lua API to clear `User.getChatHistory()` for a given user.
3. **Use fresh WhatsApp numbers for each tester** — workaround, not a fix.

### 🟡 Email delivery is stubbed
`src/utils/email-notifications.ts` writes a `communications` row but doesn't actually send. The user explicitly chose to defer this. Wire via `lua channels` (native Email) or swap in Resend/SMTP.

### 🟡 Photo-only WhatsApp messages feel slow
Gemini vision pass on 2–3 photos can take 5–15s. The agent appears "frozen". Tried persona-side fix (acknowledge then analyze) — user rejected, reverted. The latency is just Gemini's vision API. Could try preloading a thinking emoji or a shorter ack.

### 🟡 Cosmetic sync drift
- Agent name: local says "Property Maintenance Agent", server says "tenant-vendor" (from `lua init`)
- Model config: local doesn't pin, server pins `google/gemini-2.5-flash`
- Harmless — `lua sync --accept` would clear if anyone cares

### 🟡 Tool-call timeline panel in HTML is untested in real browser
LuaPop must emit `onToolInvoked` for entries to render. If not supported, panel stays empty (graceful degradation). Verify in actual browser.

### 🟡 No browser MCP / Playwright
Tried to install Playwright MCP for visual verification — not connected in current session. User can add to `~/.claude/settings.json` with `@playwright/mcp` if desired.

## File layout reference

```
src/
  index.ts                              # LuaAgent assembly + full persona text
  skills/
    tenant.skill.ts                     # 20 tools (intake + tenant-side vendor mgmt + approval + completion + escalation + register_self_as_tenant)
    vendor.skill.ts                     # 12 tools (vendor-flow + GetUserContext)
  tools/
    intake/                             # 7 tools (Get, Register, Create, Upload, Update, Search, My)
    vendor/                             # 15 tools (vendor-flow 11 + tenant-side mgmt 4)
    approval/                           # 4 tools
    completion/                         # 4 tools
    escalation/                         # 1 tool
  webhooks/
    admin/                              # 6 CRUD webhooks
    *.webhook.ts                        # 5 external (vendor-response, finance-approval, escalation-response, inbound-email, open-tickets)
  jobs/                                 # escalation-check (hourly), daily-workload-report (weekday 9am)
  preprocessors/emergency-triage        # gas/fire keyword block
  postprocessors/                       # ticket-summary, communication-log
  services/data.ts                      # typed wrappers per collection
  utils/                                # constants, identity, ticket-id, ticket-helpers, audit-log, communication-log, email-*, domain-types
seed-data/seed.example.json
property-guy-demo.html                  # Netlify-hosted; auto-refresh poller every 10s
lua.skill.yaml                          # persona + skill/webhook/job/processor IDs
docs/info/                              # 15 planning docs — the spec
BUILD-PATTERNS.md                       # conventions for parallel subagents
BUILD-PROGRESS.md                       # this file
```

## Quick playbook for next session

**Reset to a clean demo state:**
```bash
curl -s -X POST "https://webhook.heylua.ai/baseAgent_agent_1778570087307_uu37q4v0m/clear-data" -H 'Content-Type: application/json' -d '{"method":"DELETE","confirm":true,"full":true}'
curl -s -X POST "https://webhook.heylua.ai/baseAgent_agent_1778570087307_uu37q4v0m/seed-data" -H 'Content-Type: application/json' -d '{"method":"POST"}'
```

**Verify state:**
```bash
curl -s -X POST "https://webhook.heylua.ai/baseAgent_agent_1778570087307_uu37q4v0m/tenants" -H 'Content-Type: application/json' -d '{"method":"GET"}' | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'{len(d[\"tenants\"])} tenants'); [print(' ',t['name'],t['phones'],t.get('propertyName')) for t in d['tenants']]"
```

**Deploy:**
```bash
lua push all --force
# then: /lua-deploy   ← slash command, harness gates production deploys
```

**Inspect logs:**
```bash
npx lua logs --type skill --name tenant --limit 10
npx lua logs --type agent_error --limit 5
```

## What to tackle first in next session

1. **`reset_my_identity` tool** — solves the chat-history bleed. Persona needs to recognize "I'm new", "reset", "forget me", "start over" cues.
2. **Optional:** "Clear tickets only" button in HTML (currently the only clear path is full nuke).
3. **Optional:** Wire real email so the approval-flow email beat works for the demo.
