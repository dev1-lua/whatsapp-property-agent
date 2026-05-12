# 13 — Risks & Open Questions

Things that could go wrong, things we don't know yet, and what to do about each.

## Technical risks

### R1 — Lua Data API limits on entry size

**Risk:** A fully-populated ticket entry could be 5–20 KB (nested approval, payment, completion sub-objects, plus 10 CDN image URLs and audit refs). The Data API docs don't state an explicit per-entry size cap.

**Impact:** Hit a limit mid-demo when a ticket grows too large.

**Mitigation:**
- Keep image data out of the ticket — only URLs (already planned)
- Move audit_events out of the ticket into its own collection (already planned)
- Move communications out of the ticket (already planned)
- Test a ticket with 10 photos, 5 quotes (revisions), 20 audit events, 30 comm-log entries — verify it fits

**Action:** Build a smoke test that creates a maxed-out ticket on Day 0 to confirm.

### R2 — `Data.search` semantic mode vs. exact-match filters

**Risk:** Some queries are exact match (`status = 'pending_approval'`), others semantic (`description ~ 'leak'`). Mixing in one call may not work as expected. The docs distinguish `Data.get` (filter only) from `Data.search` (semantic only).

**Impact:** `list_available_jobs` may return wrong results if we use the wrong API.

**Mitigation:**
- Use `Data.get` with `$eq` / `$in` for status/specialty filters (exact)
- Use `Data.search` only for `search_maintenance_history` (semantic)
- Never mix in the same call

**Action:** Code review checkpoint before Day 2.

### R3 — Auto-incrementing ticket counters

**Risk:** The BC original uses a per-company counter (`MT-2026-001`, `002`, etc.). On Lua Data, two concurrent `create_maintenance_ticket` calls would race on a counter entry.

**Impact:** Two tickets get same ID, second write fails.

**Mitigation (chosen):** Use timestamp + random format (`MT-2605-A8F2K9`) — no counter, no race.

**Trade-off:** Less human-friendly, but the demo audience doesn't care about ticket number sequence.

### R4 — Lua WhatsApp sandbox availability

**Risk:** Lua's shared sandbox number (+1 302 377-8932) is down or rate-limited at demo time.

**Impact:** WhatsApp beat in Act 5 fails.

**Mitigation:**
- Pre-link your agent to the sandbox the day before, verify round-trip
- Keep the agent linked overnight — re-linking takes seconds anyway
- Backup: drop Act 5 entirely; emphasize email channel + web instead. The story still works.

### R5 — Each demo participant must opt in by sending the link command

**Risk:** Mahmoud / Stefan haven't sent `link-me-to:<agentId>` before the call, so they can't message the bot themselves during the demo.

**Impact:** If you want them to try it live, there's an awkward 30 seconds of "now send this command".

**Mitigation:**
- Email them the link command and the sandbox number 1 hour before the call so they can pre-link
- Or just have the operator do all WhatsApp messaging on a mirrored phone — viewers watch, don't participate

### R6 — Email deliverability

**Risk:** Lua's email channel goes to spam, or rate-limits. Vendor doesn't see the assignment email during the demo.

**Impact:** Act 2's "Dublin Plumbing has been notified" looks fake when the inbox is empty.

**Mitigation:**
- Use a real Gmail address for the vendor in seed data, whitelist Lua's sender domain in Gmail filters
- Pre-deliver one test email Day 3 to confirm working
- Have a backup screenshot of the email ready

### R7 — Identity ambiguity (same phone for tenant + vendor)

**Risk:** During the demo, the operator's own phone might be both the tenant Laura and the vendor Dublin Plumbing if seed data wasn't careful.

**Impact:** Persona pill switches, but the agent still matches the operator's underlying phone to whichever match it finds first.

**Mitigation:**
- Seed Laura's phone = `+353861000001`, Dublin Plumbing's phone = `+353112000001` — distinct synthetic numbers
- LuaPop's `userContext` overrides `_luaProfile.phone` per session, decoupling from the operator's actual number

### R8 — LuaPop `userContext` may not exist or work differently

**Risk:** LuaPop init may not accept a `userContext` field, or may not propagate it to `user._luaProfile.phone` as expected.

**Impact:** Persona pill doesn't drive identity. Operator has to type "Hi I'm Laura at +353…" every time.

**Mitigation:**
- Verify with `lua-pop` docs (https://lua-ai-global.github.io/lua-pop) on Day 0
- Fallback: scenario buttons send a verbose identifying message ("Hi this is Laura Murphy at +353861000001, ...") so the agent identifies via message text

### R9 — Photo upload via web widget

**Risk:** LuaPop's photo upload may not be straightforward to invoke programmatically from scenario buttons.

**Impact:** Operator has to drag-drop photos manually, breaking demo flow.

**Mitigation:**
- Pre-stage photos in `seed-data/photos/` as CDN URLs already
- Have the operator drag-drop a single photo as the "tenant sends a photo" beat
- Or, pre-stage a ticket with photos already attached and just "imagine I sent this"

### R10 — Approval email "Approve" link

**Risk:** The approval email contains a deep link to a finance-approval webhook URL. If the webhook URL isn't properly URL-formatted or the action isn't idempotent, clicking it could fail or duplicate.

**Impact:** Act 4's "click Approve in Gmail" looks broken.

**Mitigation:**
- Webhook URL must be GET-friendly (browsers fire GET on link click) — implement a small landing page that POSTs to the webhook
- Or, embed the action token in URL and have the landing page do the POST with confirmation
- Test the flow Day 3, end-to-end from email click to status update

## Product risks

### R11 — Demo viewer asks "what about migration from our existing system?"

**Risk:** Mahmoud's prospect runs on Yardi, MRI, or another property management system. They want to know data migration story.

**Impact:** We don't have a great answer.

**Mitigation:**
- Pre-build a CSV-import script (`scripts/import-from-csv.ts`) that ingests properties/tenants/vendors from spreadsheet export
- Mention: "for production, we build a one-time ETL from your existing system, then incremental sync if needed"

### R12 — Audience wants real verification (OTP)

**Risk:** Sophisticated audience says "anyone could claim to be Laura — how do you prevent fraud?"

**Impact:** We don't demo OTP, look weak on security.

**Mitigation:**
- Slide: "WhatsApp/email = the channel itself verifies ownership of the inbound identifier. For sensitive actions, layer OTP verification — supported via Lua's verification toolkit. Out of scope for this demo."

### R13 — Performance under load

**Risk:** Audience asks "what's the throughput? How many tickets per second?"

**Impact:** We don't know.

**Mitigation:**
- Don't volunteer numbers. If asked: "Lua's infrastructure scales horizontally; we've benchmarked similar agents at thousands of conversations per minute. Specific numbers depend on tool complexity — happy to follow up."

## Open questions to resolve before Day 1

| # | Question | Who decides | When |
|---|---|---|---|
| Q1 | Demo email channel for the approval flow — Gmail with filters, or real APPROVER_EMAIL inbox? | Dev | Day 0 |
| Q2 | Where to host the admin HTML — same Netlify slot as v1, new slot, or replace v1? | Mayank | Day 3 |
| Q3 | Do we keep the v1 agent (`baseAgent_…dbatldr5h`) running or retire it once v2 ships? | Stefan | Day 3 |
| Q4 | Persona name — keep "Alex Carter" or pick a fresh name for the demo brand? | Mayank | Day 1 |
| Q5 | Are we charging Mahmoud's prospects for the demo agent? | Stefan | Outside scope |
| Q6 | Seed data — use Dublin properties (matching v1) or Mahmoud's region (Saudi / UAE)? | Dev / Mahmoud | Day 1 morning |

## Pre-demo checklist (for the day itself)

- [ ] WhatsApp sandbox: test message round-trip <2s
- [ ] Approval email: click-through to webhook works
- [ ] LuaPop widget loads on the deployed HTML page
- [ ] Persona pill switches identity (verified by Engine dock showing different `get_user_context` results)
- [ ] All 4 seeded tenants + 4 vendors visible in admin UI
- [ ] All scenario buttons fire correctly
- [ ] Tool-call timeline panel updates live
- [ ] Engine dock cleared, expanded
- [ ] APPROVAL_THRESHOLD = 500 in production env
- [ ] Phones charged, mirroring tested
- [ ] Internet stable (run `ping heylua.ai` for 30s — no packet loss)
- [ ] Backup plan ready (screenshots of each act, in case live demo fails)

## Post-demo follow-up artifacts

To send Mahmoud / prospects:
- Live URL of the admin HTML
- 2-page PDF summary of the agent capabilities
- A 30-second video clip of the demo highlights (record during dry run)
- Pricing sheet (from Mayank/Stefan)
