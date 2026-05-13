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
| Single-unit tenant | (Laura) | userType=tenant, unitCount=1 | ✅ |
| Multi-unit tenant | (James) | userType=tenant, unitCount=2, ask which unit | ✅ |
| Admin-only | (Niamh) | userType=admin, adminScope=all | ✅ |
| Multi-role default | (Conor) | userType=admin (precedence) | ✅ |
| Multi-role viewAs=tenant | (Conor + viewAs:tenant) | userType=tenant | ✅ |
| Unknown phone | random | userType=unregistered, intent-inference | ✅ |
| Register new tenant | new phone + property/unit | contact row written, lookup succeeds | ✅ |

Seed populates 3 properties + 10 contacts (4 tenants, 4 vendors, 2 admins one of whom is multi-role).

### M1 polish round — discovered + fixed live (2026-05-13)

After the first production deploy of M1, browser-side testing surfaced four additional bugs that the sandbox tool tests couldn't have caught:

1. **HTML tenants table showed empty Property/Unit** — fixed: `/tenants` webhook `flatten()` synthesizes flat `propertyName`/`propertyCode`/`unit`/`unitCount` from `units[0]` for HTML compat.
2. **"Property Manager" dropdown entry had `phone: ''`** (hardcoded) — fixed: new `/admins` webhook + HTML `loadAdmins()` populates dropdown from real admin contacts with real phones.
3. **`LuaPop.init({userContext})` is silently dropped** — the docs imply it's not a real init option. Identity never reached `_luaProfile.mobileNumbers`. Fixed: HTML auto-sends an identity intro into the chat textarea via React-compatible value setter (LuaPop's actual UI path) on every persona change. Intro bubble is then hidden from view via MutationObserver so the dropdown looks like a silent auth switch.
4. **`sessionId` not rotated → LuaPop reloaded the prior thread on every "Clear chat"** — fixed: `genSessionId()` called on persona-change / New thread / Clear chat. Fresh thread every reset.

Plus persona-side fix: tightened `get_user_context` tool description + persona Section 0 to instruct the LLM to **re-call** `get_user_context` whenever a later message provides identity (was previously locked to "first-turn only" behavior, causing James's intro after the leak message to be ignored).

### M3 — admin/manager stats tools (2026-05-13)

The demo-blocking gap from M1: the admin persona branch greeted correctly but
had no tools to actually answer "how many tickets are open?" / "what's pending?"
M3 closes it.

**Tools added (all in `src/tools/admin/`):**

| Tool | Purpose |
|---|---|
| `get_open_ticket_count` | Total of non-closed tickets. Optional `groupBy` (status / urgency / issueType / propertyCode) and `propertyCode` filter. |
| `list_tickets_in_progress` | Tickets in {vendor_contacted, quoted, pending_approval, approved, in_progress, on_hold} sorted urgency-first, then most-recent. |
| `list_pending_approvals` | Tickets at `pending_approval` with quoteAmount, vendor, waiting-time, threshold context. |
| `list_recent_activity` | Most-recent audit events newest-first. Optional `eventType`. Scope-aware via ticketId → propertyCode join. |
| `vendors_by_specialty` | Full vendor roster, optional specialty + activeOnly filters. Sorted by rating desc. |

Shared `_scope.ts` helper enforces `userType==='admin'` and resolves `adminScope` (`'all' | propertyCode[]`) from the contact row. `intersectRequestedProperty` rejects out-of-scope `propertyCode` overrides with `error: 'out_of_scope'`. Env-allowlisted admins (no contacts row) get `'all'`.

**Wired into:** `tenantSkill` (manager uses the same skill — persona routes by `userType`). 5 new tools = 37 total.

**Persona v15 — ADMIN MODE rewrite:** explicit question → tool routing table. No raw-data queries; each intent is mapped to the specific stats tool. No seed-data names in the routing examples (uses `<propertyCode>` placeholders per `feedback_no_hardcoded_seed_in_persona.md`).

**Push result (sandbox staged 2026-05-13):**
- tenant skill v1.0.20, vendor skill v1.0.13 (unchanged code, version bump from push)
- 12 webhooks at v1.0.12, admins at v1.0.6
- 2 jobs at v1.0.11, preprocessor v1.0.11, 2 postprocessors v1.0.11
- persona v15 staged (not active in prod until `lua deploy`)

**Sandbox smoke:** compile passed (57 primitives), runtime alive via tenant-onboarding path. Admin-path data tests deferred to live prod (sandbox Data collections are empty — no Niamh, no seed). Tools follow the same patterns as `LookupVendorsTool` / `MyTicketsTool` / `open-tickets` webhook, which all work in prod.

### M3 verification — 16/16 pass on v1.0.22 (2026-05-13, live Playwright on Netlify)

Test data seeded via the UI itself (Mahmoud reports plumbing at WESTGATE-07 5C → 2 tickets auto-assigned to Sean Kelly → vendor submits €650 quote on one → status → pending_approval). Final live state: 3 open tickets (1 TEMPLE + 2 WESTGATE), 1 pending_approval, spans 2 properties.

| # | Persona | Test | Result |
|---|---|---|---|
| 1 | Niamh (scope=all) | open count | 3 ✓ |
| 2 | Niamh | in_progress | 3 tickets w/ tenantName ✓ |
| 3 | Niamh | pending_approvals | €650 / over-threshold-by €150 / Sean Kelly / Mahmoud Tester ✓ |
| 4 | Niamh | groupBy status | Pending Approval:1, Vendor Contacted:2 ✓ |
| 5 | Niamh | groupBy urgency | Emergency:2, Medium:1 ✓ |
| 6 | Niamh | recent_activity | 8 newest events covering both WESTGATE tickets ✓ |
| 7 | Conor (TEMPLE-04 only) | open count | **1 (not 3)** — discriminating ✓ |
| 8 | Conor | in_progress | only MT-2605-EU9BY4 — WESTGATE hidden ✓ |
| 9 | Conor | pending_approvals | 0 — €650 ticket properly invisible ✓ |
| 10 | Conor | recent_activity | **0 WESTGATE events leak** — critical cross-property audit guard ✓ |
| 11 | Conor | out_of_scope WESTGATE-07 query | Graceful refusal ✓ |
| 12 | Conor | lowercase `temple-04` | Matched as TEMPLE-04 (case normalization) ✓ |
| 13 | Stefan (scope=all) | open count | 3 (matches Niamh) ✓ |
| 14 | Laura (tenant) asks admin question | "actions only available to property managers" — persona refuses ✓ |
| 15 | Laura forces `Run get_open_ticket_count` | Persona still refuses; logs confirm tool never invoked ✓ |
| 16 | Console errors classified | All 100% LuaPop widget internals (`/webchat/config` 404, `/chat/welcome` 401, WS reinit race) — zero from M3 ✓ |

### M3 bug fix + hardenings shipped in v1.0.22

**Bug fix:** `ListTicketsInProgress` + `ListPendingApprovals` were reading non-existent `t.quoteAmount`. `SubmitQuoteTool` writes nested `t.quote.amount` + flat `t.estimatedCost`. Fixed: `t.quote?.amount ?? t.estimatedCost ?? null`. Re-verified live: €650 + €150-over-threshold surfaces.

**Hardenings:**
- `_scope.ts` propertyCode comparison is now case + whitespace insensitive (`normCode` helper). Adds defensive matching when scope is written as `['temple-04']` vs ticket `propertyCode: 'TEMPLE-04'`.
- `tenantName` added to admin list outputs (`list_tickets_in_progress`, `list_pending_approvals`). Finance review needs to know whose ticket is queued.
- `recordInScope` excludes records *without* propertyCode for scoped admins (was previously falling back to include-everything which would leak ambient/system rows).
- `ListRecentActivityTool` joins audit_events → tickets → propertyCode and excludes events from out-of-scope tickets. Audit events lacking a ticketId are excluded from scoped views entirely (no ambient leak).

### Defense-in-depth verified live

1. **Persona layer** — refuses admin questions from tenant/vendor users (T-14, T-15)
2. **Tool layer** — `_scope.ts` returns `forbidden` if `userType !== 'admin'` (verified indirectly via T-11 out_of_scope)
3. **Scope filter** — `recordInScope` rejects records outside admin's `adminScope[]` (T-7, T-8, T-9, T-10)
4. **Cross-resource audit join** — `list_recent_activity` joins event.ticketId → ticket.propertyCode and excludes out-of-scope events (T-10 — the critical cross-resource leak guard)

### M3 final live versions (2026-05-13)

- persona v16
- tenant skill v1.0.22 (admin tools + quote-field bug fix + RegisterSelfAsVendor)
- vendor skill v1.0.15
- 12 webhooks v1.0.12 (admins v1.0.6)
- 2 jobs v1.0.11, preprocessor v1.0.11, postprocessors v1.0.11
- HTML unchanged (`fastidious-malasada-285366.netlify.app`)

### M2.1 RegisterSelfAsVendor (shipped with M3 batch)

Mirror of `RegisterSelfAsTenant` for vendor onboarding. Wired into tenant skill. Persona Section 0 teaches the LLM the vendor-intent branch: "I'm a contractor / I do plumbing / I'm a vendor" → infer + register. Multi-role merge: appends `vendor` to `roles[]` and unions `specialties[]` without breaking existing tenant/admin rows. Channel-only identifier capture (no env override risk). Code path verified by compile + parity with the proven tenant register tool; live data verification deferred to actual WhatsApp from a fresh number (CLI sandbox has no `_luaProfile.phone`).

### Known minor UX (deferred)

- `waitingHours: 0` for sub-hour pending approvals reads odd but is mathematically correct. Future: render `minutesWaiting` when waiting < 1h.
- LuaPop tools-timeline panel stays empty — the widget doesn't emit `onToolInvoked` in current version. HTML wires the callback defensively; gracefully degrades. Engine panel (right side of HTML) gives request-level proof instead.

### Next session — M4 (vendor WhatsApp outbound ping)

The pieces needed for M4 are already in place:
- vendor row stores `userId` (captured on first inbound WhatsApp message via `get_user_context` backfill — see `findContact()` line ~365 in GetUserContextTool)
- `User.get(userId).send([{type:'text', text:'...'}])` pattern proven in `src/tools/completion/RequestTenantConfirmationTool.ts:49-51`
- Audit + communication logging helpers in place

To do in M4:
1. On `create_maintenance_ticket` auto-assignment → if assigned vendor has `userId` on file → `User.get(userId).send(...)` with ticket details + "reply ACCEPT or DECLINE"
2. On vendor-response webhook → if tenant has `userId` → ping tenant "your ticket was acknowledged"
3. Persona update — explain the new outbound flow so the agent doesn't double-message
4. Handshake fallback: if vendor has no `userId` yet (never messaged the agent), surface a one-time link

### M1 production E2E test (2026-05-13, via Playwright on live Netlify)

All six dropdown personas verified end-to-end on `fastidious-malasada-285366.netlify.app`:

| # | Test | Result |
|---|---|---|
| 1 | Multi-unit tenant — auto-intro sent, agent identified by phone, asked "which unit?" before ticket creation | ✅ |
| 2 | 🧹 Clear chat — chat emptied, persona reset to anonymous, sessionId rotated | ✅ |
| 3 | Admin-only (all properties) — recognized as admin, skipped onboarding, offered to surface stats | ✅ |
| 4 | Multi-role contact selected via Admin optgroup — admin mode with correct scope | ✅ |
| 5 | Same multi-role contact via Tenant optgroup — viewAs flipped to tenant, single unit | ✅ |
| 6 | Vendor — vendor mode with specialties, offered available jobs / assignments | ✅ |
| 7 | New tenant created via HTML form → appears in dropdown immediately → agent recognizes them | ✅ |
| 8 | New admin created via /admins webhook curl → appears in admin dropdown after refresh | ✅ |

### Anti-patterns recorded (2026-05-13)

- **No seed-data hard-coding in LLM-facing strings.** Persona text + Zod `.describe()` strings + tool `description` fields must use placeholders (`<name>`, `<propertyCode>`, etc.) not real seed names/phones/cities. Drove `propertyCity` default through `env('DEFAULT_CITY')` instead of literal `'Dublin'`. Memory: `feedback_no_hardcoded_seed_in_persona.md`.

### M1 live state (post-deploy 2026-05-13)

- **Lua agent:** persona v14, all skills/webhooks/jobs at v1.0.11 (admins webhook at v1.0.5).
- **HTML:** Netlify `fastidious-malasada-285366.netlify.app` — silent auto-intro, `genSessionId` rotation, `/admins` integration, multi-unit badge in dropdown, 🧹 Clear chat button.
- **Data shape:** unified `contacts` collection only — `Tenants`/`Vendors`/`Admins` data wrappers are role-filtered views over it. Ticket FKs (`tenantId`/`vendorId`) reference contact ids.

---


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
