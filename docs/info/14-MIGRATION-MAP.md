# 14 — Migration Map (BC → Lua-Native)

Explicit file-by-file mapping showing what to copy, rewrite, drop, or keep as reference from the BC original (`../`).

## Top-level files

| File | Action | Notes |
|---|---|---|
| `../README.md` | Rewrite | New v2 README focused on Lua primitives; reference BC version as historical |
| `../QUICKSTART.md` | Rewrite | New flow: `lua init` → set env → run seed-data |
| `../package.json` | Adapt | Same deps minus BC-specific (`@azure/msal-node` if present) |
| `../tsconfig.json` | Copy as-is | |
| `../lua.skill.yaml` | Adapt | Per [06-PERSONA.md](./06-PERSONA.md) edits + new agent/skill/webhook IDs |
| `../env.example` | Rewrite | Per [12-ENV-CONFIG.md](./12-ENV-CONFIG.md) |
| `../.gitignore` | Copy | |
| `../property-guy-demo.html` | Carry from v1 demo + add persona pill, tool timeline, scenarios per [10-ADMIN-UI.md](./10-ADMIN-UI.md) | |

## `src/index.ts`

| Action | Notes |
|---|---|
| Adapt | Keep the agent setup pattern. Drop BC service imports. Add v2 skills (tenant + vendor). Persona text loads from yaml. |

## `src/skills/`

| File | Action |
|---|---|
| `../src/skills/maintenance.skill.ts` | Rewrite → `src/skills/tenant.skill.ts`. Same tool list, drop `companyId` references in context. |
| `../src/skills/vendor.skill.ts` | Rewrite → `src/skills/vendor.skill.ts`. Same shape, drop BC refs from context. |

## `src/tools/intake/` (6 tools)

| BC file | v2 action | Lua API used |
|---|---|---|
| `GetUserContextTool.ts` | Rewrite | `User.get/update`, `Data.search('tenants'/'vendors')` |
| `CreateMaintenanceTicketTool.ts` | Rewrite | `Data.create('tickets')`, `Data.get('vendors')`, `User.send`, email helper |
| `MyTicketsTool.ts` | Rewrite | `Data.get('tickets', filter)` |
| `UpdateTicketDetailsTool.ts` | Rewrite | `Data.update('tickets')` |
| `UploadIssueImagesTool.ts` | Rewrite | `CDN.upload`, `Data.update` |
| `SearchMaintenanceHistoryTool.ts` | Rewrite | `Data.search('tickets')` |

## `src/tools/vendor/` (15 tools)

All rewrite using `Data.get/update`, `CDN.upload`, `User.send`. Logic carries over verbatim minus `companyId` and minus BC PO/invoice references.

| BC file | v2 status |
|---|---|
| `ListAvailableJobsTool.ts` | Rewrite — filter by status + specialty |
| `ClaimJobTool.ts` | Rewrite |
| `DeclineJobTool.ts` | Rewrite |
| `SubmitQuoteTool.ts` | Rewrite |
| `SubmitRevisedQuoteTool.ts` | Rewrite |
| `MyAssignedJobsTool.ts` | Rewrite |
| `StartWorkTool.ts` | Rewrite |
| `PauseWorkTool.ts` | Rewrite |
| `CompleteJobTool.ts` | Rewrite — drop BC PO update |
| `UploadVendorPhotosTool.ts` | Rewrite |
| `ValidateInvoiceTool.ts` | Rewrite — validate against `ticket.quote.amount`, not BC PO |
| `LookupVendorsTool.ts` | Rewrite |
| `SendVendorRequestTool.ts` | Rewrite |
| `RecordVendorQuoteTool.ts` | Rewrite |
| `UpdateVendorMetricsTool.ts` | Rewrite |

## `src/tools/approval/` (4 tools)

| BC file | v2 action |
|---|---|
| `CheckApprovalThresholdTool.ts` | Carry mostly — pure logic, swap env source |
| `SendForApprovalTool.ts` | Rewrite — email to `APPROVER_EMAIL`, `Data.update` |
| `RecordFinanceDecisionTool.ts` | Rewrite — `Data.update` only |
| `InitiatePaymentTool.ts` | Simplify — drop BC PO posting, Stripe-only |

## `src/tools/completion/` (4 tools)

| BC file | v2 action |
|---|---|
| `RecordCompletionDocsTool.ts` | Rewrite |
| `RequestTenantConfirmationTool.ts` | Rewrite — `User.send` if `tenantUserId`, else email |
| `RecordTenantDisputeTool.ts` | Rewrite — creates escalation |
| `CloseTicketTool.ts` | Rewrite |

## `src/tools/escalation/` (1 tool)

| BC file | v2 action |
|---|---|
| `EscalateTicketTool.ts` | Rewrite — `Data.create('escalations')`, email manager |

## `src/webhooks/` (10 webhooks)

| BC file | v2 action |
|---|---|
| `inbound-email.webhook.ts` | Optional rewrite — prefer Lua native email channel; keep webhook as fallback |
| `vendor-response.webhook.ts` | Rewrite — `Data.update`, routes to internal tools |
| `finance-approval.webhook.ts` | Rewrite — same |
| `escalation-response.webhook.ts` | Rewrite |
| `open-tickets.webhook.ts` | Rewrite — `Data.get('tickets', filter)` |
| `vendor-management.webhook.ts` | Split into 3 admin webhooks (vendors GET/POST/DELETE) — see below |
| `seed-data.webhook.ts` | Rewrite — bulk `Data.create` calls |
| `clear-data.webhook.ts` | Rewrite — bulk `Data.delete` calls |

Plus admin webhooks NEW in v2 (from [04-WEBHOOKS.md](./04-WEBHOOKS.md)):

| New file | Purpose |
|---|---|
| `webhooks/admin/properties.webhook.ts` | Admin CRUD for properties |
| `webhooks/admin/tenants.webhook.ts` | Admin CRUD for tenants |
| `webhooks/admin/vendors.webhook.ts` | Admin CRUD for vendors (replaces `vendor-management.webhook.ts`) |
| `webhooks/admin/tickets.webhook.ts` | Admin GET tickets |

## `src/jobs/` (2 jobs)

| BC file | v2 action |
|---|---|
| `escalation.job.ts` | Rewrite — `Data.get('tickets')` for open tickets, write to `escalations` |
| `daily-report.job.ts` | Rewrite — aggregate from `Data.get`, email manager |

## `src/preprocessors/`

| BC file | v2 action |
|---|---|
| `emergency-triage.preprocessor.ts` | **Carry as-is** — no DB dependency |

## `src/postprocessors/`

| BC file | v2 action |
|---|---|
| `ticket-summary.postprocessor.ts` | Adapt — read from `Data.search('tickets')` instead of BC |
| `communication-log.postprocessor.ts` | Rewrite — write to `Data.create('communications')` |

## `src/services/` (heavy reduction)

| BC file | v2 action |
|---|---|
| `bc-auth.ts` | **Delete** |
| `bc-client.ts` | **Delete** |
| `bc-custom-api.ts` | **Delete** |
| `bc-data-adapter.ts` | **Replace** with `src/services/data.ts` (~150 lines) |
| `bc-entities.ts` | **Delete** |
| `bc-types.ts` | **Reduce** — keep only `TicketAttachmentData`, `VendorAttachmentData`, etc. (the JSON shapes); rename to `domain-types.ts` |
| `bc-discover-users.ts` | **Delete** |
| `bc-setup-projects.ts` | **Delete** |
| `bc-test-claim.ts` | **Delete** |
| `bc-check-attachments.ts` | **Delete** |
| `bc-api-check.ts` | **Delete** |
| `agentmail.ts` | **Keep if using AgentMail**, else delete and use Lua email channel |

## `src/utils/`

| BC file | v2 action |
|---|---|
| `constants.ts` | **Carry mostly** — drop `TRIBECA_COMPANY_ID` and `BC_DIMENSIONS` exports |
| `ticket-id.ts` | **Rewrite** — new timestamp+random format |
| `audit-log.ts` | **Rewrite** — `Data.create('audit_events')` |
| `communication-log.ts` | **Rewrite** — `Data.create('communications')` |
| `email-notifications.ts` | **Keep** — sender layer, Lua email or AgentMail |
| `email-templates.ts` | **Carry as-is** — HTML templates are vendor-agnostic |
| `vendor-identity.ts` | **Adapt** — replace BC vendor lookup with `Data.get('vendors')` |

## `src/scripts/`

Most are BC-specific test scripts. Cut everything; v2 doesn't need them.

| BC file | v2 action |
|---|---|
| `migrate-tickets-to-extension.ts` | **Delete** — BC-specific migration |
| `setup-agentmail.ts` | **Keep if using AgentMail** |
| `setup-test-emails.ts` | **Carry, adapt** |
| `test-po-release.ts` | **Delete** — no BC PO |
| `approve-ticket.ts` | **Carry, adapt** — useful for testing finance flow |
| `send-vendor-email.ts` | **Adapt** |
| `verify-ticket.ts` | **Adapt** |
| `test-agentmail-sdk.ts` | **Keep if using AgentMail** |
| `check-previous-quotes.ts` | **Delete** |
| `submit-vendor-quote.ts` | **Carry, adapt** |
| `rename-for-demo.ts` | **Delete** |
| `test-full-email-flow.ts` | **Adapt** |
| `clear-custom-tables.ts` | **Delete** — BC-specific |
| `send-test-email.ts` | **Carry** |
| `seed-vendor-data.ts` | **Rewrite** — use seed-data webhook payload format |
| `check-ticket.ts` | **Adapt** |
| `test-revised-quote-flow.ts` | **Adapt** |

## `bc-extension/`

| Action |
|---|
| **Do not carry** to v2. Keep `../bc-extension/` in the original folder as reference. Per your call. |

## `scripts/`

| BC file | v2 action |
|---|---|
| `bc-deploy.sh` | **Delete** |
| `bc-download-symbols.sh` | **Delete** |
| `migrate-contacts.ts` | **Delete** |
| `cleanup-single-contacts.ts` | **Delete** |

## `.github/workflows/`

| BC file | v2 action |
|---|---|
| `bc-extension-ci.yml` | **Delete** |
| `bc-extension-deploy.yml` | **Delete** |

Replace with a single workflow for v2 (optional):
- `agent-deploy.yml` — runs `lua compile` + `lua test` on PR, `lua push --auto-deploy` on main

## `docs/`

| BC file | v2 action |
|---|---|
| `docs/BUSINESS-CENTRAL-INTEGRATION.md` | **Keep at `../docs/`** as reference |
| `docs/BC-PARTNER-EMAIL-DRAFT.md` | **Keep at `../docs/`** as reference |
| `docs/WEBHOOKS.md` | **Adapt** for v2 webhook contracts |
| `docs/design-property-maintenance-extension.md` | **Keep at `../docs/`** as reference |
| `docs/guides/` | **Carry** — tenant/vendor/admin PDF user guides |

## Summary table

| Category | Files in BC | v2 fate |
|---|---|---|
| BC services | 11 | Delete (1 → new `data.ts`) |
| Tools | 30 | All rewrite (drop companyId, swap adapter→Data) |
| Webhooks | 10 | All rewrite + 4 new admin webhooks |
| Jobs | 2 | Both rewrite |
| Pre/postprocessors | 3 | 1 carry, 2 rewrite |
| Utils | 7 | 3 carry, 4 rewrite |
| Scripts (src/) | 17 | ~10 carry/adapt, ~7 delete |
| Scripts (root) | 4 | All delete |
| bc-extension/ | ~50 AL files | Do not carry; reference in original |
| `.github/workflows/` | 2 | Both delete; optional 1 new |
| Top-level | 6 | Adapt |

## Approximate code volume

- BC original: ~12,000 lines TS + ~3,000 lines AL
- v2 target: ~6,000 lines TS, no AL
- Reduction: ~50% — most savings from dropping BC client + adapter layer
