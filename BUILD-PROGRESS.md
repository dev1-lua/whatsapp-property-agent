# Build Progress — Property Maintenance Demo (v2, Lua-native)

> Living document. Updated as we go. Source of truth = `docs/info/*.md` (spec).
> Last major update: 2026-06-08 (WhatsApp phone recovery + vendor-ping routing).

## Day 5 — WhatsApp phone recovery + vendor notification routing (2026-06-08)

Live demo prep with Mahmoud as a real vendor (WhatsApp user.id `25b1875c-…`, +201144444361) surfaced two issues. Both trace to the "Lua AI (US)" WhatsApp channel **not populating `_luaProfile.mobileNumbers`** for some senders — his is empty, the tenant's (+91…) is populated.

### 1. Inbound recognition — FIXED & VERIFIED ✅
**Symptom:** admin adds vendor by phone, but on WhatsApp he gets "I can't find you on file."
**Cause:** channel gives only `user.id` (no phone); IDENTITY-LOCK-v2 won't match a chat-typed phone; the admin-created row has no `userId` → nothing links them.
**Fix `[WA-PHONE-RECOVERY-2026-06-08]`:**
- `src/preprocessors/emergency-triage.preprocessor.ts` — on WhatsApp, recover the sender number from the raw webhook payload (`Lua.request.webhook.payload` → Meta `messages[].from` / `contacts[].wa_id`) and stash it on the user record as `_waChannelPhone`. Channel-derived, not user-typed → trust boundary intact.
- `src/tools/intake/GetUserContextTool.ts` — read `_waChannelPhone` into `profilePhones` so the resolver phone-matches seeded contacts.
- Verified in prod logs (`[WA-PHONE-RECOVERY] payloadPresent:true, recovered:[…]`); Mahmoud is recognized as a vendor and can pull his jobs.
**Data fix:** stamped his WhatsApp `user.id` onto his vendor contact row via vendors webhook `PUT {id, userId}` (the admin form can't capture user.id). Note: deleting + re-adding the vendor drops the stamp → must re-stamp the new row.

### 2. Outbound vendor ping — FIX IMPLEMENTED, NOT YET VERIFIED ⏳
**Symptom:** ticket assigned to Mahmoud → he never receives the "New job assigned" push; only sees jobs when he pulls ("check assignments").
**Root cause (NOT the profile phone — in-thread replies to him deliver fine):** the SDK's `User.get(vendorUserId).send()` → `sendMessage()` → `getAdminUser()` → POSTs to the **agent owner's** conversation, ignoring the target userId. Proactive cross-user pings land on the admin, never the vendor. (Explains "it used to work" — when the owner tested the vendor side, the ping arrived in the owner's own chat.)
**Fix `[VENDOR-PING-FIX2-2026-06-08]`** in `src/tools/intake/CreateMaintenanceTicketTool.ts`: bypass `send()`; POST directly to the vendor's conversation — `POST {LUA_API_URL}/admin/agents/{AGENT_ID}/conversations/{vendorUserId}` with `{messages}` via `fetch` + `env('LUA_API_KEY')` (proven pattern from `ResetMyIdentityTool`; the SDK's internal `httpPost` is NOT reachable at runtime — first attempt died with `u.httpPost is not a function`).
**Status:** pushed as tenant **v1.0.42**, **NOT deployed** — production still runs **v1.0.40** (the failed httpPost attempt). TODO: deploy v1.0.42 → one test ticket (heating/plumbing/structural, fresh unit) → confirm `[VENDOR-PING] direct POST {ok:true}` AND Mahmoud receives it. Same bug affects all cross-user sends (`RequestTenantConfirmation`, `ClaimJob`, `daily-report`).

### Open / escalated to platform eng
- Why does WhatsApp capture `mobileNumbers` for some senders (+91…) but not others (Mahmoud +20…)? Suspect the `link-me-to:<agentId>` sandbox quick-test flow skips number capture.
- SDK: `User.get(userId).send()` should target that user (per docs) but routes to the agent owner — reported.
- Temporary `[VENDOR-PING]` / `[WA-PHONE-RECOVERY]` console diagnostics still in place — strip once the push is confirmed.

## Day 4 — IDENTITY-LOCK-v2 (2026-05-14)

### The bug Mahmoud reported

On production WhatsApp, a registered tenant could be impersonated by anyone who typed their phone number in chat. Exact scenario from his screenshots:

1. Caller sends "My name is Karim Hassan" → agent acknowledges
2. Caller sends "That's my number 353861000001" (which is Laura Murphy's stored number) → **agent flipped identity and started serving them as Laura Murphy at Temple Place 3B**
3. Caller sends "Laura" → agent confirmed switch

Root cause: `get_user_context` was looking up by the chat-typed phone with no guard. When the typed phone matched an existing contact, the agent identified the caller as that contact — even though the actual channel-verified identity was different.

Additional discovery: the "Lua AI (US)" WhatsApp demo channel **does not propagate `_luaProfile.phone` or `_luaProfile.email`** to the agent runtime. Only the platform's `user.id` is reliably available. So a v1 fix gated on `channelVerified = hasRealProfilePhone || hasRealProfileEmail` would not have engaged for this channel.

### The fix — `[IDENTITY-LOCK-v2]`

Every change is tagged with the literal string `[IDENTITY-LOCK-v2]` in a code comment. To revert: `grep -rn "IDENTITY-LOCK-v2" src/` and remove each marked block.

**File-by-file:**

| File | What changed |
|---|---|
| `src/tools/intake/GetUserContextTool.ts` | (1) `findContact()` takes `userId` and looks it up **first**, returning `matchedBy: 'userId' \| 'phone' \| 'email'`. (2) Mismatch guard: if phone/email matched a contact whose stored `userId` differs from caller's `user.id`, return `unregistered` with a strong note. (3) `cacheStillMatches()` treats `userId` equality as sufficient validity; invalidates cache when no positive signal exists. (4) `inputPhoneForLookup = undefined` always — chat-typed phone/email are **never** used for identity lookup. (5) Backfill of `userId` onto a matched contact only happens when the contact has no existing `userId` (no overwriting). (6) Identity-lock-note in tool result fires whenever typed phone/email differs from the channel-verified one. |
| `src/tools/intake/RegisterSelfAsTenantTool.ts` | (1) Allow `user.id`-only registration when channel doesn't propagate phone/email. (2) Dedupe by `userId` first (post-reset retry merges into original row instead of duplicating). |
| `src/tools/intake/RegisterSelfAsVendorTool.ts` | Same two changes as tenant. |
| `src/webhooks/admin/clear-userid.webhook.ts` | **NEW FILE.** One-shot cleanup webhook to clear the `userId` field on seeded contact rows that were contaminated by the old auto-backfill. Matches by (name, phone) against the seed list — only touches Laura/Aoife/James/Karim/Sean/Maria/Tom/Padraig/Niamh/Conor. Real registrations (Mahmoud Saleh / mayank / Firdosh / etc.) are left untouched. Supports `{dryRun: true}` preview mode. |
| `src/index.ts` | Imports + registers `clear-userid` webhook in the agent's webhooks array. |

**Persona changes (v27):**
- New paragraph in section 0: "CHANNEL IDENTITY IS LOCKED" — instructs the LLM to refuse identity switches when the tool result contains the identity-lock note, and to never call register tools with a typed identifier.
- New paragraph: "NAME-ONLY CLAIMS NEVER SWITCH IDENTITY" — when GUC has already resolved an identity this thread, a name-only claim must not fork into "would you like to register as X?".

### Architectural shift

The identity hierarchy is now explicit:

```
Strongest → weakest:
  1. user.id            (always present — Lua platform's stable channel session ID)
  2. _luaProfile.phone  (when channel propagates it — real WhatsApp/SMS)
  3. _luaProfile.email  (when channel propagates it)
  4. TEST_PROFILE_PHONE / TEST_USER_PHONE  (test-only overrides)

Chat-typed phone/email are NOT identifiers. They are passed to GUC ONLY for
the mismatch-note messaging — never for cross-account lookup.
```

The only way to "release" a registered identity is admin deletion of the contact row from the HTML UI.

### Sandbox QA — 9/9 pass

| # | Test | Result |
|---|---|---|
| T1 | Verified caller types another tenant's name + phone (4 turns) | ✅ Held identity |
| T2 | Fresh `user.id`, no channel phone, types "I'm Laura Murphy 353861000001" | ✅ Returned `unregistered` — typed phone ignored |
| T3 | T2 caller registers as "Test Spoofer", then types Laura's phone | ✅ `userId` lock held |
| T4 | Verified caller happy path (Aoife → leak intake) | ✅ Photos + access notes requested |
| T5 | Multi-unit tenant (James) | ✅ Asks which of unit 7 / 12 |
| T6 | Admin routing (Niamh: open count + vendors by specialty) | ✅ Both tools fired |
| T7 | Vendor flow (Sean Kelly, list jobs) | ✅ Identified |
| T8 | Emergency triage ("I smell gas") | ✅ Preprocessor blocks, safety script returned |
| T9 | `reset_my_identity` + re-resolve | ✅ Channel re-identifies same user via `user.id` |

### Production state after deploy

- **Deployed:** tenant v1.0.33, vendor v1.0.26, persona v27, `clear-userid` v1.0.4
- **Webhook deploys that showed "Version is already active":** not failures — the latest pushed version was already deployed. All current code is live.
- **Production data:** dry-ran `clear-userid` against prod — all 10 seeded contacts already had `userId: null`. No cleanup needed. (The contamination I worried about turned out to be sandbox-only.)
- **No other code or systems touched** — ticket creation, vendor claim/quote/start/complete, admin routing, emergency triage, escalation jobs, daily report job, all postprocessors all unchanged.

### Cleanup webhook usage (for reference)

```bash
# Preview (no writes)
curl -s -X POST "https://webhook.heylua.ai/baseAgent_agent_1778570087307_uu37q4v0m/clear-userid" \
  -H "Content-Type: application/json" \
  -d '{"method":"POST","dryRun":true}'

# Apply
curl -s -X POST "https://webhook.heylua.ai/baseAgent_agent_1778570087307_uu37q4v0m/clear-userid" \
  -H "Content-Type: application/json" \
  -d '{"method":"POST","confirm":true}'
```

### How to revert if needed

1. `grep -rn "IDENTITY-LOCK-v2" src/` — lists every changed location across 5 files
2. Remove each tagged block. The header at the top of `GetUserContextTool.ts` documents the previous behavior in detail.
3. Delete `src/webhooks/admin/clear-userid.webhook.ts`
4. Remove its import + array entry from `src/index.ts`
5. `lua push all --force && /lua-deploy`

---

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

### 2026-05-13 EOD — M5 shipped + hardening pass

**M5 shipped to prod:**
- `src/tools/intake/ResetMyIdentityTool.ts` — clears cached identity fields on the user record AND calls `DELETE /chat/history/{agentId}?targetIdentifier=<userId|mobile|email>` to wipe the transcript on Lua's side. Needs `LUA_API_KEY` + `AGENT_ID` env vars (both set on prod + sandbox).
- Persona v19 — strict allowlist of trigger phrases (rewritten after a production incident — see below).
- Tenant skill v1.0.24 deployed.

**Hardening pass forced by production usage (2026-05-13 afternoon):**

1. **Suffix-tolerant phone matching across all 6 lookup sites.** `src/utils/identity.ts` added `phonesMatch(a, b)` + `anyPhoneMatch(stored, candidates)` that compare the last 10 digits when full-string equality fails. Reconciles operator-typed local-only rows (`9675151149`) with WhatsApp-channel full-E.164 inbound (`919675151149`). Sites updated: GetUserContext findContact, GetUserContext cacheStillMatches, envAdminMatch, RegisterSelfAsTenant dedupe, RegisterSelfAsVendor dedupe, admins.webhook dedupe.

2. **Country-code dropdown on HTML "Add tenant" / "Add vendor".** `property-guy-demo.html` — `composePhoneE164(ccSelectId, phoneInputId)` smart-prepends the selected CC (or accepts as-is if user typed the full international). 15 countries, defaults to India (`+91`), persists last selection in localStorage `demo.cc`. New rows land in E.164 from day one; suffix-match is the safety net for legacy rows.

3. **Cross-unit duplicate-detection bug fixed.** `CreateMaintenanceTicketTool.ts` was scoping duplicates by `propertyCode + issueType` only — so Mahmoud's plumbing tickets at Westgate 5C surfaced as "duplicates" when Devashish tried to file a plumbing ticket at Westgate 9A. Fix: scope by `propertyCode + unit + tenantId + issueType` when those are present.

4. **🚨 Critical: `reset_my_identity` was being called by the LLM mid-conversation.** Production log (10:30:16 UTC for Shlok) showed the agent invoking `reset_my_identity` with `{}` after a 4th photo upload, then re-running `get_user_context`, then re-greeting "Hi shlok!" — because the LLM interpreted Shlok's photo confusion as "wrong identity". **Fix:** persona v18 → v19 with strict allowlist of trigger phrases ("forget me", "reset me", "start over", "I'm a different person", "I'm new" only when paired with denial) plus explicit DO-NOT-CALL list: never on photos, never on questions, never mid-flow, never on agent's own confusion.

**Open issues going into next session:**
- Platform-side message loss: production log showed Shlok's text "Bathroom has water issues." at 10:24:57 hit the preprocessor but produced no tool call and no agent_response. Lua's chat/queue layer, not our code. Demo workaround: keep conversations active, don't leave text-only messages dangling.
- Photo processing latency 5–15s (Gemini vision) — known issue from M0.

**Production env vars (Lua dashboard, current):**
```
APPROVAL_THRESHOLD=500
APPROVER_EMAIL=dev@luaimplementation.ai
MANAGER_EMAIL=dev@luaimplementation.ai
FIRM_NAME="Demo Property Management"
CURRENCY=EUR
ADMIN_EMAILS=dev@luaimplementation.ai
LUA_API_KEY=api_*** (set 2026-05-13 — required for reset_my_identity chat-history DELETE)
AGENT_ID=baseAgent_agent_1778570087307_uu37q4v0m (set 2026-05-13)
```

**Production DB state (2026-05-13 EOD, after wipe+seed):**
- 0 tickets, 0 escalations, 0 communications, 0 audit_events
- 3 properties (TEMPLE-04, WESTGATE-07, QUAY-12)
- 10 contacts (seed): Laura Murphy, Aoife Walsh, Conor Daly (multi-role admin+tenant), James O'Brien (multi-unit), Niamh Quinn, Karim Hassan, Mahmoud Tester, Sean Kelly (vendor), Patrick O'Sullivan (vendor), one more vendor.
- Devashish + shlok rows (operator-typed / self-registered) were wiped with the rest. They'll re-register on first message.

---

### Next session — M4 revised: email-first vendor notification + WhatsApp tenant ack

**Goal flip from the original M4 plan.** Vendors won't get WhatsApp pings — they'll get **real email** via Lua's native email channel. Tenant ack stays on WhatsApp via `User.get(userId).send()`. Reason: emails are a cold channel (no handshake required, no Meta template), which makes the demo work for any vendor email address the user pastes in.

**Build steps:**

1. **Wire Lua's native email channel.** Replace the stub in `src/utils/email-notifications.ts` with a real send via Lua's email channel (research first — possibly `Channels.email.send()` / `Templates.email.send()` / a channel SDK call). The existing `sendEmail({ to, subject, html, text, ticketId })` signature should stay the same so all existing callsites (`CreateMaintenanceTicketTool`, `RequestTenantConfirmationTool`, `SendForApprovalTool`, etc.) keep compiling.

2. **Vendor outbound on ticket creation.** `CreateMaintenanceTicketTool.ts` already calls `sendEmail` to the assigned vendor (~line 280-300) using the template from `src/utils/email-templates.ts → vendorJobAssignedEmail`. Once `sendEmail` is real (step 1), this beat works automatically. Verify the template content is fit for vendor-facing (ticket details + ACCEPT/DECLINE call to action with a unique reply token / webhook URL).

3. **Vendor accept → tenant WhatsApp ack.** Two paths to ACCEPT:
   - **Inbound email reply** → `inbound-email.webhook.ts` parses the reply, extracts ticketId + decision, hits the same internal logic as `vendor-response.webhook.ts`.
   - **Unique link in the email** → vendor clicks → hits `vendor-response` webhook with `{ ticketId, action: 'accept', vendorId }`.

   In either case, after the webhook updates the ticket to `vendor_contacted`, **send the tenant a WhatsApp ack** via `User.get(ticket.tenantUserId).send([{type:'text', text:'Update on MT-X: <vendor> accepted; they'll be in touch to schedule.'}])`. Pattern proven in `RequestTenantConfirmationTool.ts:49-51`.

4. **Persona update.** Tell the agent that vendor outbound is handled by the email beat (and the tenant ack arrives automatically) so it doesn't say "I'll let the vendor know" in chat. Add to TENANT MODE step 7.

5. **HTML "Vendor email" affordance.** The "Add vendor" form already has an email field. Make sure it's mandatory (or at least flagged) and visible in the vendor table. User will paste real email addresses for demo vendors.

**Prerequisites already in place:**
- `User.get(userId).send([{type:'text'}])` pattern proven and live in prod (`RequestTenantConfirmationTool`, `ResetMyIdentityTool` does NOT use User.send but the same SDK).
- `ticket.tenantUserId` is captured at ticket creation (`CreateMaintenanceTicketTool.ts:124-125` reads `user?._luaProfile?.userId`).
- `vendor.userId` backfill on first inbound, and now `vendor.email` is the primary contact channel.
- Audit + communication-log helpers in place.
- API key already in env (used by reset tool — same auth surface likely works for email).

**Constraints carried forward:**
- Never `z.enum` / `z.nativeEnum` / `z.union` in LuaTool inputSchema — Gemini function calls break. Use `z.string().describe('one of: ...')`.
- Never hardcode seed data (names/phones/property codes/cities) in persona text or LLM-facing strings.
- Channel identifiers always win — never let `TEST_USER_PHONE/EMAIL` env vars replace `_luaProfile.phone`.
- Don't deploy without explicit go-ahead from the user — they run `lua deploy` by hand.
- **Reset trigger is now a strict allowlist** (persona v19) — don't loosen it without a real reason.

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

### ✅ RESOLVED — Identity impersonation via typed phone (2026-05-14)
Fixed under `[IDENTITY-LOCK-v2]` — see Day 4 section. Chat-typed phone/email no longer match existing contacts; identity comes from `user.id` + channel profile only. Mismatch guard returns `unregistered` if phone matches a contact owned by a different `user.id`. Sandbox QA 9/9 green; deployed to production tenant v1.0.33 / vendor v1.0.26 / persona v27.

### ✅ RESOLVED — Chat-history bleed across WhatsApp sessions
`reset_my_identity` tool shipped earlier; with IDENTITY-LOCK-v2, post-reset the channel re-identifies the same user via `user.id` (their contact row persists), so reset wipes the conversational state but not their identity. To fully release a contact identity, admin must delete the row from the HTML UI.

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

1. **Optional:** "Clear tickets only" button in HTML (currently the only clear path is full nuke).
2. **Optional:** Wire real email so the approval-flow email beat works for the demo.
3. **Optional:** Surface the `clear-userid` cleanup as a button in the HTML admin UI (currently curl-only). Useful if seeded contacts ever get re-contaminated by a regression.
4. **Optional:** Add a `lua channels` integration for the demo WhatsApp number so `_luaProfile.phone` actually propagates — would give belt-and-suspenders identity verification beyond `user.id`-only.
