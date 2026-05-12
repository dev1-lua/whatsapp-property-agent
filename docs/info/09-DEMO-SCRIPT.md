# 09 — Demo Script

A rehearsable 8-minute walkthrough. Two screens: admin HTML page (laptop) + a phone running WhatsApp mirrored on screen (QuickTime / scrcpy).

## Setup before the call (5 minutes)

| Step | Action |
|---|---|
| 1 | Open admin HTML page in browser, log into agent dashboard in another tab |
| 2 | Run `clear-data` (full) to start fresh |
| 3 | Click **Seed demo data** — 3 properties, 4 tenants, 4 vendors load |
| 4 | Verify your WhatsApp sandbox number is connected; your phone is whitelisted |
| 5 | Open WhatsApp on your phone, mirror to laptop via QuickTime |
| 6 | Open Email (Gmail in browser) ready to send to the agent's email channel |
| 7 | Position windows: admin HTML left half, mirrored phone right half |
| 8 | Pre-load the persona pill to "Tenant: Laura Murphy" |
| 9 | Engine dock visible bottom-right, expanded |

## Act 1 — The portfolio (1:00)

> *"This is a property management firm with three buildings and four tenants. Let me show you the agent in action."*

- **0:00** Open admin HTML page (already loaded). Walk through Overview tab — counts visible.
- **0:15** Click Properties tab — three rows. Tenants tab — four rows. Vendors tab — four rows.
- **0:30** *"All of this data lives in Lua's Data primitives. No external database, no Business Central. Adding a new property management firm = `lua init` + run a seed webhook with their data."*
- **0:45** Switch to the Chat tab (LuaPop embedded).

## Act 2 — Tenant ticket creation (3:00)

> *"I'll play Laura, a tenant. The persona pill at the top has set her identity. Watch what happens."*

- **1:00** Already on Chat tab with persona = Tenant Laura Murphy. Type into the widget:

  > "Hi, my kitchen sink is leaking, water is everywhere"

- **1:15** Engine dock shows the agent's tool calls flow in real time:
  - `get_user_context` → tenant matched (Laura, Temple Place 3B)
  - Preprocessor: `emergency-triage` — flags "water everywhere"

  Agent replies:

  > "Hi Laura, that sounds urgent! I see you're at No.4 Temple Place, unit 3B. First — is the water spreading to electrical outlets or other rooms? If so, shut off your sink valve. Can you also send me 2–3 photos from different angles so I can size up the issue?"

- **1:45** Drag a photo into the chat (or upload). Tool call: `upload_issue_images`. CDN URL appears.

- **2:00** Agent (after vision processing):

  > "I can see the leak under the trap and water pooling on the floor. That's high urgency. Any access notes for the vendor — pet, gate code, times you'll be home?"

- **2:15** Type:

  > "Working from home all day, no pets, buzz unit 3B"

- **2:30** Engine dock shows:
  - `create_maintenance_ticket` → ticket MT-2605-A8F2K9
  - Auto-assigned: Dublin Plumbing Co.
  - Email sent to vendor + tenant
  - `audit_events` entry: ticket_created

  Agent replies with a ticket card and "Dublin Plumbing has been notified."

- **2:45** Switch to admin Tickets tab → **new row appears, photo visible**.

- **3:00** *"That ticket is now in Lua Data — visible here in the admin, queryable by the agent, and Dublin Plumbing got an email."*

## Act 3 — Vendor flow (2:30)

> *"Now I'll switch hats — same agent, different mode."*

- **3:00** Click persona pill → "Vendor: Dublin Plumbing Co." Click **New thread**.

- **3:15** Type:

  > "Hi, what jobs are available?"

- **3:30** Engine dock:
  - `get_user_context` → vendor matched
  - `list_available_jobs` → 1 job

  Agent shows the job card with photo, description, urgency.

- **3:45** Type:

  > "I'll take it, quote is €280"

- **4:00** Engine dock:
  - `claim_job` → status: vendor_contacted
  - `submit_quote` → €280 ≤ €500 threshold → auto-approve
  - `audit_events`: quote_received, approved

  Agent: "Approved automatically — under €500 threshold. Status: Approved."

- **4:30** Type:

  > "I'm starting now"

  → `start_work` → status: in_progress

- **4:45** Type:

  > "Done — here's a photo and invoice INV-7732 for €265"

  Drag completion photo. Agent: `complete_job` with photos and invoice.

  → status: completed, costVariance: -€15 (under quote, great)

- **5:30** Switch to admin Tickets tab → ticket now shows completed status with vendor's photo.

## Act 4 — Approval workflow (1:00)

> *"Now let me show what happens when a quote is OVER the threshold."*

- **5:30** Same vendor chat, type:

  > "Actually I have another job — the boiler at Westgate Court, my quote is €1200"

  (Or use a prepared seeded ticket assigned to this vendor at Westgate.)

- **5:45** Engine dock:
  - `submit_quote` → €1200 > €500 → `send_for_approval`
  - Email sent to `APPROVER_EMAIL`

  Agent: "Sent for finance approval — over €500. You'll hear back soon."

- **6:00** Switch to Gmail (the approver's inbox). Open the email. Click **Approve €1200**. The link calls the `finance-approval` webhook.

- **6:15** Refresh admin Tickets tab → status: approved.

- **6:30** *"Approval thresholds are configurable per firm via env vars. Different firms, different rules."*

## Act 5 — WhatsApp moment (1:30)

> *"Same agent, different channel. Watch."*

- **6:30** Pick up your phone (mirrored on screen). Open WhatsApp. Message the sandbox number:

  > "Hi I'm Laura, the dishwasher just started flooding"

- **6:45** Engine dock on laptop shows:
  - Channel: WhatsApp
  - `get_user_context` → tenant matched by phone
  - Preprocessor flags "flooding"

  Agent replies on WhatsApp:

  > "Hi Laura — shut off the water valve under the sink and unplug the dishwasher if safely possible. Send me a photo when you can."

- **7:00** Take a quick photo with phone, send via WhatsApp. Agent receives it. Creates ticket. Sends confirmation.

- **7:15** Switch to admin Tickets tab → new ticket appears with WhatsApp photo.

- **7:30** *"Same agent. Same data. The channel is just a configuration toggle in Lua's dashboard. Email works the same way — let me show you a follow-up email."*

## Act 6 — Email closer + portfolio Q&A (1:00)

- **7:30** *Optional:* send an email from Gmail to the agent's email channel — "Status update on Temple Place sink?" → agent replies with ticket status.

- **7:45** Persona pill → **Admin**. Click New thread. Type:

  > "Show me all open tickets in Dublin"

- **8:00** Agent answers with a list-item rendering of all open tickets, grouped by status.

- **8:15** Type: "Which vendors handle plumbing?" → list of plumbing vendors with rating.

- **8:30** *"Read-only portfolio Q&A — the manager can ask anything about the live state. This is what the v1 read-only demo did, and it's still here, just one of many modes."*

## Act 7 — Wrap (30s)

> *"To recap: one agent, three channels, full lifecycle from intake to close — backed by Lua's Data primitives. For a new firm, I run `lua init`, hit seed-data with their portfolio, configure their approval threshold and approver email, and they're live in under an hour. No database to provision, no integration sprint."*

> *"Questions?"*

## Backup scenarios (if something breaks)

| Failure | Recovery |
|---|---|
| WhatsApp sandbox not delivering | Skip Act 5, do email Act 6 instead |
| Photo vision misclassifies | Manually describe ("imagine this shows a leak"); agent should still proceed |
| LuaPop widget doesn't load | Pre-warm in another tab; if dead, use terminal `lua chat` |
| Email send fails | Note "email is configured but uses production credentials — for demo, you can see the audit entry in the Communications collection" |
| Engine dock cluttered | Click Clear at the top of the dock between acts |

## Practice runs

Do at least 3 full dry runs before the live demo:
1. Solo with no audience — time every act
2. With one Lua colleague playing devil's advocate ("what if the tenant is hostile?")
3. With Mayank/Stefan watching, looking for transition awkwardness

## Pre-demo checklist (5 min before)

- [ ] Internet stable (test agent responsiveness)
- [ ] Phone charged + connected to laptop, mirroring works
- [ ] WhatsApp sandbox tested ("hi" round-trip in <2s)
- [ ] Engine dock clear, dock expanded
- [ ] Persona pill present in admin HTML
- [ ] All 4 seeded tenants + 4 vendors visible
- [ ] No leftover tickets from prior runs
- [ ] APPROVAL_THRESHOLD set to €500 in env (so €280 auto-approves, €1200 routes)
- [ ] Approver email inbox open in browser tab
- [ ] Notes plus this script printed/visible on second monitor

## Talking points for the Q&A after

- "How long would porting our existing maintenance flow take?" → 1–2 weeks given existing data export
- "Can we use our own WhatsApp number?" → Yes, with business verification (Path B)
- "What about integrations to our finance system?" → Webhook in/out; we have a finance-approval pattern shown above
- "Multi-language?" → Yes, persona supports per-language variants
- "Cost?" → Defer to Stefan/Mayank
