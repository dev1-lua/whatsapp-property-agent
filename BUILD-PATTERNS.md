# Build Patterns — v2 Lua-Native

> Read this before writing any primitive. Conventions are non-negotiable.

## File layout

```
src/
  index.ts                      ← LuaAgent assembly (written last)
  skills/
    tenant.skill.ts             ← imports + registers tenant-facing tools
    vendor.skill.ts             ← imports + registers vendor-facing tools
  tools/
    intake/<ToolName>.ts        ← tenant intake (CreateMaintenanceTicket, etc)
    vendor/<ToolName>.ts        ← vendor flow + tenant-side vendor mgmt
    approval/<ToolName>.ts      ← finance flow
    completion/<ToolName>.ts    ← record/confirm/close
    escalation/<ToolName>.ts    ← escalations
  webhooks/
    admin/<resource>.webhook.ts ← admin CRUD (v1 contract: body.method dispatch)
    <name>.webhook.ts           ← external integration webhooks
  jobs/<name>.job.ts
  preprocessors/<name>.preprocessor.ts
  postprocessors/<name>.postprocessor.ts
  utils/                        ← shared helpers (audit, identity, etc)
  services/data.ts              ← collection wrappers
seed-data/seed.example.json
property-guy-demo.html
lua.skill.yaml
```

Use `.js` import extensions for relative TS imports (`tsconfig` is ESNext + bundler). Example:
```ts
import { Tickets } from '../../services/data.js';
import { logEvent } from '../../utils/audit-log.js';
```

## Primitive shapes

### LuaTool

```ts
import { LuaTool, User } from 'lua-cli';
import { z } from 'zod';

export class CreateMaintenanceTicketTool implements LuaTool {
  name = 'create_maintenance_ticket';
  description = 'Concise 1–2 sentence description shown to the LLM.';

  inputSchema = z.object({
    ticketId: z.string().describe('display ID, MT-YYMM-XXXXXX'),
    ...
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    // ... return { success, message, ...payload }
  }
}
```

All tools must return at least `{ success: boolean, message: string, ... }`. Persona reads `message`.

### LuaSkill

```ts
import { LuaSkill } from 'lua-cli';
import { GetUserContextTool } from '../tools/intake/GetUserContextTool.js';
// ...

export const tenantSkill = new LuaSkill({
  name: 'tenant',
  description: '...',
  context: `Multiline guidance to the LLM about when to use which tool.`,
  tools: [new GetUserContextTool(), /* ... */]
});
export default tenantSkill;
```

### LuaWebhook

```ts
import { LuaWebhook } from 'lua-cli';

export default new LuaWebhook({
  name: 'properties',
  description: 'Admin CRUD for properties — v1 contract: body.method dispatches.',
  execute: async (event) => {
    const body = event?.body ?? {};
    const method = (body.method ?? 'GET').toUpperCase();
    switch (method) {
      case 'GET': /* ... */ return { properties };
      case 'POST': /* ... */ return { success, property };
      case 'PUT': /* ... */ return { success, property };
      case 'DELETE': /* ... */ return { success, deletedId };
      default: return { success: false, error: 'unknown method' };
    }
  }
});
```

For external webhooks (vendor-response, finance-approval, etc), `body` is whatever the partner sends — no `method` dispatch.

### LuaJob

```ts
import { LuaJob } from 'lua-cli';
export default new LuaJob({
  name: 'escalation-check',
  description: '...',
  schedule: { type: 'cron', expression: '0 * * * *' },
  execute: async (job) => { /* ... */ }
});
```

### PreProcessor / PostProcessor

```ts
import { PreProcessor, PostProcessor } from 'lua-cli';

export default new PreProcessor({
  name: 'emergency-triage',
  description: '...',
  priority: 10,
  execute: async (user, messages, channel) => {
    // return { action: 'block', response: 'safety text' }
    // or  { action: 'proceed' }
    // or  { action: 'proceed', modifiedMessage: messages.map(...) }
  }
});

export default new PostProcessor({
  name: 'ticket-summary',
  description: '...',
  execute: async (user, message, response, channel) => {
    return { modifiedResponse: response + footer };
  }
});
```

## Data + storage

- Use `import { Tenants, Vendors, Tickets, AuditEvents, Communications, Escalations, Properties } from '../../services/data.js'`
- `Tenants.get(filter?, page?, limit?)` — returns `{ data: [...] }` with each entry shaped `{ id, data: {...}, ... }`
- `Tenants.getEntry(id)` — returns single DataEntryInstance
- `Tenants.search(text, limit?, score?)` — semantic
- `Tenants.create(data, searchText?)` — searchText optional but encouraged
- `Tenants.update(id, partialData, searchText?)`
- `Tenants.delete(id)`

Phones stored normalized (digits only) — always pass user input through `normalizePhone()` from `utils/identity.js`. Emails always lowercased via `normalizeEmail()`.

For ticket lookups by display ID (`MT-YYMM-XXXXXX`), use `Tickets.get({ ticketId })` and take the first match. The Data id (entry id) is separate from the display ticketId.

## Audit + comms

After every status change:
```ts
import { logStatusChange, logEvent } from '../../utils/audit-log.js';
import { EventType, ActorType } from '../../utils/constants.js';

await logStatusChange({
  ticketId: t.ticketId,
  ticketDataId: t.id,
  fromStatus: TicketStatus.REPORTED,
  toStatus: TicketStatus.VENDOR_CONTACTED,
  actorType: ActorType.AGENT,
  actorId: userId
});
```

After every outbound message (email/SMS/etc.), call `logCommunication` from `utils/communication-log.js`.

## State machine

Before any status change, validate against `VALID_TRANSITIONS` from `utils/constants.js`. Helper:

```ts
function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
```

Return `{ success: false, error: 'invalid transition' }` rather than throwing.

## What to DROP vs KEEP from the BC original

| Drop | Keep |
|---|---|
| `companyId` parameter on every tool/webhook | Tool name, description, intent |
| `getBCAdapter()`, all `adapter.*` calls | Domain logic (urgency assessment, duplicate detection) |
| BC project / PO / invoice refs | Audit-log calls (rewritten to `Data.create('audit_events')`) |
| BC dimension lookups | `User.get()`, `User.send()` |
| `tenantCustomerId` / `bcCustomerNumber` style fields | `tenantId` (our Data id) and denormalized `tenantName` |

When in doubt: read `docs/info/14-MIGRATION-MAP.md`.

## Errors and edge cases

- Never throw to the caller. Return `{ success: false, error, message }` shape.
- Empty `Data.get` results: handle gracefully (no .map on undefined).
- `User.get()` may return null in webhooks/jobs — guard with `?.`.
- For tools called with `user.tenantId` / `user.vendorId` set from prior `get_user_context`, prefer that to re-querying.

## Tests / smoke

Each milestone should produce one `lua chat --ci -m "..."` line that verifies it works. Capture them in `scripts/smoke-tests.sh` as we go.
