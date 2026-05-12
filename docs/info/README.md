# Property Maintenance Agent — Demo (Lua-Native)

This folder is the planning home for **v2 of the property maintenance agent**: a full-capability port of the BC-backed original (`../`) onto Lua's native primitives (Data, User, CDN APIs, channels).

It currently contains **planning documents only**. When we start coding, `src/`, `lua.skill.yaml`, `package.json`, etc. land in this same folder, and the whole directory then gets lifted out as a sibling of the original.

## Why this exists

Stefan asked us to strip Business Central out of the original agent and rebuild on Lua Data primitives so we can demo a facilities-management agent to Mahmoud and other prospects without provisioning BC. The v1 read-only demo at `https://papaya-piroshki-2e8d0e.netlify.app/` proves the admin UI and Q&A pattern. v2 adds back **every capability of the original** — tenant ticket creation, vendor flow, approval, completion, escalation — on Lua Data.

## What's in here

| Doc | Purpose |
|---|---|
| [00-VISION.md](./00-VISION.md) | Demo audience, goals, success criteria |
| [01-ARCHITECTURE.md](./01-ARCHITECTURE.md) | Single-agent shape, Lua primitive map, system diagram |
| [02-DATA-MODEL.md](./02-DATA-MODEL.md) | Collection schemas (tenants, vendors, properties, tickets, audit_events, communications, escalations) |
| [03-TOOLS.md](./03-TOOLS.md) | All 30+ tools — purpose, inputs, outputs, what changes from BC version |
| [04-WEBHOOKS.md](./04-WEBHOOKS.md) | Admin CRUD webhooks (for HTML page) + external integration webhooks |
| [05-JOBS-PROCESSORS.md](./05-JOBS-PROCESSORS.md) | Escalation + daily-report jobs, emergency-triage preprocessor, ticket-summary + comm-log postprocessors |
| [06-PERSONA.md](./06-PERSONA.md) | Alex Carter persona, voice, flows (tenant + vendor + admin modes) |
| [07-IDENTITY-RESOLUTION.md](./07-IDENTITY-RESOLUTION.md) | `get_user_context` spec — phone/email/WhatsApp matching, User API caching |
| [08-CHANNELS.md](./08-CHANNELS.md) | WhatsApp (sandbox + production), Email, Website widget — setup steps |
| [09-DEMO-SCRIPT.md](./09-DEMO-SCRIPT.md) | The 8-minute demo run, beat by beat |
| [10-ADMIN-UI.md](./10-ADMIN-UI.md) | The `property-guy-demo.html` page — what to carry from v1, what to add |
| [11-BUILD-ORDER.md](./11-BUILD-ORDER.md) | Day-by-day implementation sequence with demoable milestones |
| [12-ENV-CONFIG.md](./12-ENV-CONFIG.md) | Env vars — what to keep, drop, add |
| [13-RISKS-OPEN-QUESTIONS.md](./13-RISKS-OPEN-QUESTIONS.md) | Risks, open questions, mitigation strategies |
| [14-MIGRATION-MAP.md](./14-MIGRATION-MAP.md) | Explicit BC entity → Lua Data mapping, file-by-file delete/rewrite/keep list |
| [seed-data/seed.example.json](./seed-data/seed.example.json) | Sample portfolio (3 properties, 4 tenants, 4 vendors) for the demo seed |

## How to use this folder

1. **Read top-to-bottom in order** (00 → 14) if you're new to the project.
2. **Each doc is self-contained** — you don't need the BC original's source to understand v2.
3. When implementation begins, scaffold `lua init` inside this folder. The docs are the spec.
4. When the agent is built, move this folder up one level (out of `agent-property-management-main/`) and rename it `agent-property-management-demo/` at the same level.

## Source of truth

- The BC original lives at `../` and is the functional reference. When in doubt about *what* a tool should do, read the BC version.
- These docs are the source of truth for *how* v2 differs from the BC version (data layer, no companyId, Lua channels, etc.).
- The v1 netlify demo (`https://papaya-piroshki-2e8d0e.netlify.app/`, agent `baseAgent_agent_1778497141724_dbatldr5h`) is the read-only proof of concept — we evolve its HTML page and Q&A pattern, but build a fresh agent.
