# Build Progress — Property Maintenance Demo (v2, Lua-native)

> Living document. Updated as we go. Source of truth = `docs/info/*.md` (spec).

## Snapshot

- **Agent:** `baseAgent_agent_1778570087307_uu37q4v0m`
- **Org:** `7e7093fb-54c0-42a7-8dc7-f51e2ab738ee`
- **Persona:** Alex Carter — Property Maintenance Coordinator
- **Started:** 2026-05-12
- **Mode:** Single-shot — build everything in one session, no day-by-day pacing

## Decisions defaulted (single-shot mode)

| Question | Default chosen | Override later by |
|---|---|---|
| Persona name (Q4) | "Alex Carter" | edit `lua.skill.yaml` |
| Seed region (Q6) | Dublin/IE | edit `seed-data/seed.example.json` |
| Email channel (Q1) | Lua native | swap `src/utils/email-notifications.ts` |
| HTML hosting (Q2) | Netlify (deferred) | wherever we point the static deploy |

## Phases

| # | Phase | Status | Files |
|---|---|---|---|
| 0 | Scaffolding | ✅ done | `package.json`, `tsconfig.json`, `.gitignore`, `src/utils/constants.ts`, `src/utils/ticket-id.ts`, `src/utils/audit-log.ts`, `src/services/data.ts`, `property-guy-demo.html` |
| 1 | Foundation (persona yaml, agent index, skill stubs, seed JSON) | ✅ done | `lua.skill.yaml` persona, `seed-data/seed.example.json`, `src/utils/{identity,communication-log,email-notifications,email-templates,ticket-helpers,domain-types}.ts`, `BUILD-PATTERNS.md` |
| 2 | Admin webhooks (6) | ✅ done | `src/webhooks/admin/*.webhook.ts` — 924 lines |
| 3 | Identity + intake tools (6) | ✅ done | `src/tools/intake/*.ts` — 1232 lines |
| 4 | Vendor flow tools (11) | ✅ done | `src/tools/vendor/{vendor-flow}.ts` — 1886 lines |
| 5 | Approval + completion + escalation + tenant-side vendor (13) | ✅ done | `src/tools/{approval,completion,escalation,vendor}/*.ts` — 1565 lines |
| 6+7+8 | External webhooks + preprocessor + postprocessors + jobs (10) | ✅ done | 1821 lines across `src/webhooks/`, `src/{pre,post}processors/`, `src/jobs/` |
| 9 | HTML enhancements | ✅ done | persona pill, tool-call timeline, scenario buttons in `property-guy-demo.html` (+339 lines) |
| 10 | Assembly + compile + push + smoke | ✅ done | `src/skills/{tenant,vendor}.skill.ts`, `src/index.ts`. Compile: 50 primitives. Push: all staged. Sandbox smoke: ✅ unregistered + ✅ emergency preprocessor blocks |

Legend: ⬜ pending · 🟡 in progress · ✅ done · ❌ blocked

## Open questions still requiring user input (non-blocking for now)

- Q3 — retire v1 agent? (post-deploy decision)
- Q5 — pricing for prospects (out of code scope)
- All four "defaulted" rows above — user can override anytime, single-file change each

## Notes / surprises as we go

- `docs/info/*` says "six collections" in a few places but actually defines seven (audit_events is separate from tickets). Built all seven.
- `Data.get(name, filter, page, limit)` is positional in the actual lua-cli API, not the options-object shown in some doc examples — using positional in `src/services/data.ts`.
- LuaAgent's `persona` field is required AND duplicated in `lua.skill.yaml`. Synced both; updates must touch both.
- Six parallel subagents (A–F) wrote ~7,766 lines of TS in roughly the time of one. Worked clean — only one Gemini-incompatibility fix needed afterwards.
- **Gemini gotcha:** Zod `enum` / `nativeEnum` / `union` types serialize to JSON-Schema `anyOf` with siblings, which Gemini rejects ("schema specified other fields alongside any_of"). Fix: use `z.string().describe('one of: ...')` for any tool-input enum that the LLM will fill. Refactored 6 tools.
- **Skill name conflict:** the skills are named `tenant` and `vendor` — the runtime prefixes tool names with the skill name (`tenant__lookup_vendors`, `vendor__claim_job`). No code change needed; just be aware in logs/UIs.
- One transient `fetch failed` during the first `lua push all` — only the tenant skill failed and a retry (`lua push skill --name tenant --force`) succeeded immediately.

## Sandbox smoke-test results (2026-05-12)

| Scenario | Tool path | Result |
|---|---|---|
| `"Hello, I'm new here"` | get_user_context → unregistered | ✅ Persona-correct deflection ("Please contact your landlord…") |
| `"There's a gas leak"` | emergency-triage preprocessor | ✅ Blocked with full safety instructions |
| `"How many vendors do we have?"` | (no identity, no seed yet) | ✅ Defers to lookup_vendors by issueType — sensible fallback |

Tenant/vendor identity matching + full ticket lifecycle E2E require seed data in the live environment.

## Hand-off — what's left for the user

1. **Deploy to production** — primitives are pushed but staged. Run `/lua-deploy` (the harness requires that slash for production deploys; not auto-triggered from this thread).
2. **Set env vars in the Lua dashboard:** `APPROVAL_THRESHOLD=500`, `APPROVER_EMAIL=...`, `FIRM_NAME="Demo Property Management"`, `MANAGER_EMAIL=...`, optionally `ADMIN_EMAILS=...,...` and `ADMIN_PHONES=...,...`. Optionally `TEST_USER_PHONE=353861000001` if you want `lua chat` to identify as Laura locally.
3. **Seed data:** `curl -X POST https://webhook.heylua.ai/baseAgent_agent_1778570087307_uu37q4v0m/seed-data -H 'Content-Type: application/json' -d '{"method":"POST"}'` (the webhook reads `seed-data/seed.example.json` from disk when no `custom` body is passed).
4. **Wire channels:** WhatsApp via `+1 (302) 377-8932` → message `link-me-to:baseAgent_agent_1778570087307_uu37q4v0m`. Email channel via `lua channels`.
5. **Host the admin HTML** — Netlify, or whatever you prefer.
