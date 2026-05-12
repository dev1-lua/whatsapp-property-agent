# 10 — Admin UI (`property-guy-demo.html`)

The admin HTML page that drives the demo. Evolved from the v1 page (already in `../property-guy-demo.html`). Carries over the v1 structure verbatim and adds three v2-specific affordances: **persona pill**, **tool-call timeline**, **scenario buttons**.

## What carries over from v1 unchanged

All of this works as-is:

- Dark theme + color palette + typography
- Header with title, agent ID display, seed/refresh/clear buttons
- Config bar for webhook base URL
- Tabs: Overview, Properties, Tenants, Vendors, Tickets, Chat
- Stats cards on Overview
- Add-row forms + delete actions for properties, tenants, vendors
- Read-only tickets table
- Embedded LuaPop widget on Chat tab
- Engine dock (live API stream) bottom-right
- Toast notifications
- `api()` wrapper that POSTs `{method: 'GET'|'POST'|...}` to webhook base
- `getBase()` / `setBase()` for switching agent IDs

The only change to the existing scaffolding is the `DEFAULT_AGENT_ID` constant points at the new v2 agent.

## NEW for v2 — Persona pill

Sits in the header, between agent-id and the right-side button group.

```html
<div class="persona-pill" id="persona-pill">
  <span class="persona-label">Demo as:</span>
  <select id="persona-select">
    <option value="">— anonymous —</option>
    <optgroup label="Tenants">
      <option value="tenant:laura">Laura Murphy (Temple Place 3B)</option>
      <option value="tenant:james">James O'Brien (Westgate 7)</option>
      <!-- populated dynamically from /tenants -->
    </optgroup>
    <optgroup label="Vendors">
      <option value="vendor:dublin-plumbing">Dublin Plumbing Co.</option>
      <option value="vendor:elec-pro">ElecPro Ireland</option>
      <!-- populated dynamically from /vendors -->
    </optgroup>
    <optgroup label="Admin">
      <option value="admin:manager">Property Manager</option>
    </optgroup>
  </select>
</div>
```

On change:

```js
document.getElementById('persona-select').addEventListener('change', e => {
  const val = e.target.value
  if (!val) {
    window.__demoPersona = null
  } else {
    const [type, id] = val.split(':')
    const record = (type === 'tenant' ? tenantsCache : vendorsCache).find(x => x.id === id)
    window.__demoPersona = {
      phone: record.phones?.[0] || record.phone,
      email: record.email,
      name: record.name,
      __personaType: type   // hint for the agent
    }
  }
  // Re-init the widget to pick up new userContext
  initLuaPop({ force: true })
  toast(`Persona: ${val || 'anonymous'}`)
})
```

The widget on `init` reads `window.__demoPersona` and passes it as `userContext` so the agent's `get_user_context` matches immediately without the user typing identity info.

## NEW for v2 — Tool-call timeline

The existing Engine dock shows HTTP requests. Add a **filtered Tools view** that shows just the agent's tool executions in real time, more readable to non-engineers.

Option A: parse `tool_invoked` events from the LuaPop widget's event callbacks (LuaPop emits these via `onToolInvoked`).

```js
window.LuaPop.init({
  ...
  onToolInvoked: (event) => {
    appendToolCall({
      tool: event.toolName,
      params: event.params,
      result: event.result,
      durationMs: event.duration
    })
  }
})
```

Render in a side-by-side panel beside the chat:

```
┌─────────────────┬───────────────────┐
│  Chat widget    │  Tools timeline   │
│                 │                   │
│  Hi Laura...    │  ▶ get_user_ctx   │
│                 │    ↳ tenant Laura │
│  Sink leaking   │  ▶ upload_images  │
│                 │    ↳ 2 URLs       │
│  [photo]        │  ▶ create_ticket  │
│                 │    ↳ MT-2605-A8F2 │
└─────────────────┴───────────────────┘
```

This is the demo's secret weapon — viewers SEE the agent thinking.

## NEW for v2 — Scenario buttons

Above the chat widget, four pre-filled scenarios to make demo flow snappy and consistent:

```html
<div class="scenarios">
  <button data-scenario="leak">Kitchen sink leak (tenant)</button>
  <button data-scenario="emergency">Gas smell (emergency)</button>
  <button data-scenario="vendor-claim">Vendor: what jobs?</button>
  <button data-scenario="admin-q">Admin: open tickets in Dublin?</button>
</div>
```

```js
const SCENARIOS = {
  leak: { persona: 'tenant:laura', message: "Hi, my kitchen sink is leaking, water is everywhere" },
  emergency: { persona: 'tenant:laura', message: "There's a gas smell in my apartment" },
  'vendor-claim': { persona: 'vendor:dublin-plumbing', message: "Hi, what jobs are available?" },
  'admin-q': { persona: 'admin:manager', message: "Show me all open tickets in Dublin" }
}

document.querySelectorAll('.scenarios button').forEach(btn => {
  btn.addEventListener('click', () => {
    const s = SCENARIOS[btn.dataset.scenario]
    document.getElementById('persona-select').value = s.persona
    document.getElementById('persona-select').dispatchEvent(new Event('change'))
    setTimeout(() => {
      window.LuaPop.sendMessage(s.message)
    }, 300)   // give widget time to re-init
  })
})
```

During the live demo, just click → magic happens. No typos.

## Optional NEW — Communications inspector

Add a fifth tab: **Communications**. Shows the `communications` collection, filterable by ticketId, channel, direction. Lets the operator say "look — every outbound message is audited."

```
| At              | Direction | Channel | To           | Subject               | Body preview     |
| 13:42:00 UTC    | Outbound  | Email   | dublin@plumb | New job MT-2605-A8F2  | Hi Dublin, ...   |
| 13:42:00 UTC    | Outbound  | Email   | laura@temple | Your ticket MT-2605…  | Hi Laura, ...    |
```

Backed by a `communications` webhook (GET-only).

## Optional NEW — Escalations tab

Sixth tab if time allows: **Escalations**. Same shape as tickets but for the `escalations` collection. Useful only if Act 5 of the demo shows an SLA breach (probably not in the 8-min cut).

## Carryover preserved exactly

The webhook routing pattern from v1:

```js
async function api(path, method = 'GET', body = null) {
  const url = getBase() + path
  const payload = { method, ...(body || {}) }
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }
  const r = await fetch(url, init)
  // ...
}
```

Stays. The v2 webhook handlers route on `body.method` exactly as v1 expects.

## File location

When v2 is scaffolded, this HTML lives at the agent project root: `property-guy-demo.html`. The agent dashboard deploys can include it as a static asset, or host it on Netlify like v1.

For the demo, **host it on Netlify** (same pattern as v1 — quick, free, gives a URL Mahmoud can poke at after the call).

## Wireframe (mental model)

```
┌─────────────────────────────────────────────────────────┐
│ 🏠 Property Guy — Demo Admin                            │
│ agent: baseAgent_…  [Tenant: Laura ▾] [Seed][Refresh]   │
├─────────────────────────────────────────────────────────┤
│ Webhook base: https://webhook.heylua.ai/...   [Edit]    │
├─────────────────────────────────────────────────────────┤
│ Overview | Properties | Tenants | Vendors | Tickets |Chat│
├─────────────────────────────────────────────────────────┤
│  [Scenario buttons row]                                  │
│  Leak  |  Emergency  |  Vendor jobs  |  Admin: open?     │
├─────────────────────────────────────────────────────────┤
│  ┌──────────────────┬──────────────────────────────────┐│
│  │                  │  Tools timeline                  ││
│  │   Chat widget    │  ▶ get_user_context              ││
│  │   (LuaPop)       │    ↳ tenant: Laura               ││
│  │                  │  ▶ create_maintenance_ticket     ││
│  │                  │    ↳ MT-2605-A8F2K9              ││
│  │                  │  ▶ ...                           ││
│  └──────────────────┴──────────────────────────────────┘│
├─────────────────────────────────────────────────────────┤
│                                  [Engine dock — bottom] │
└─────────────────────────────────────────────────────────┘
```

## Implementation notes

- Persona select options populate from `/tenants` GET + `/vendors` GET on page load (already cached via `loadTenants()` / `loadVendors()`)
- When admin clicks delete tenant, also clear persona pill if it was that tenant
- Tools timeline auto-scrolls and limits to last 50 entries
- "New thread" button (already in v1) clears tools timeline too
- Mobile-responsive nice-to-have but not blocking for demo (we'll show on a 13"+ screen)
