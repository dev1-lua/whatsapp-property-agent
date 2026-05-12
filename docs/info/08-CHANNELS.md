# 08 — Channels

Three channels for the demo: **WhatsApp** (sandbox/test number), **Email** (Lua native channel), **Website widget** (LuaPop embed in the admin HTML page).

## Channel: WhatsApp

### Lua shared sandbox — the easy path (use this for the demo)

Lua hosts a shared WhatsApp test number that any agent can link to in seconds. No Meta developer account, no credentials, no webhook config.

**Number:** `+1 (302) 377-8932`

**Setup:**

1. Get the v2 agent's ID from `lua.skill.yaml` (the `agentId` field)
2. Open WhatsApp on your phone, message the sandbox number with the body:
   ```
   link-me-to:<your-agent-id>
   ```
   e.g. `link-me-to:baseAgent_agent_1778497141724_dbatldr5h`
3. Lua replies confirming the agent is now connected
4. Send any test message → the agent responds

That's it. Same for everyone on the demo call who wants to message the bot — they each send the link command from their own WhatsApp.

**No Meta account, no credentials, no webhook config, no recipient whitelisting.**

### When the shared sandbox is the right choice

- ✅ Internal demos with Stefan, Mahmoud, prospects watching
- ✅ Anyone with a phone can join during the call (just send the link command)
- ✅ Inbound media (photos) works
- ✅ No setup time
- ❌ Not your firm's branded number — can't ship to end-user tenants in production

### Production path (post-sale, not for the demo)

When a customer is ready to deploy, they bring their own WhatsApp Business number:

1. Customer provisions a number with Meta (Business Verification, ~1–2 weeks)
2. Customer shares Phone Number ID, WABA ID, System User permanent Access Token
3. `lua channels` → Link new channel → WhatsApp → paste the three credentials → done
4. Configure Meta webhook URL (Lua provides it) to point at Lua's events endpoint

This is what the customer's tenants ultimately message. Out of scope for our demo — the sandbox handles every demo use case.

### Limits of the shared sandbox

- The number is shared across all Lua sandbox users — your conversation is isolated to your agent (Lua routes by `link-me-to` association), but the number itself isn't yours
- Customer service window rules still apply (24-hour outbound window after user goes silent — irrelevant during a live demo)
- Inbound media works fine, which is what matters for photo uploads

### What lands in `user._luaProfile`

When a WhatsApp message arrives:
- `user._luaProfile.phone = "353861234567"` (normalized E.164 without +)
- `user._luaProfile.userId` is stable per WhatsApp identity
- The agent's `get_user_context` finds the tenant immediately

## Channel: Email (Lua native)

### Setup

1. `lua channels` → Link new channel → Email
2. Lua provisions an inbound email address (e.g., `agent-xyz@inbound.heylua.ai`)
3. Configure the agent's outbound email identity (display name, optional reply-to)

For production demos with custom domain (e.g., `maintenance@acmeproperties.ie`), MX records point to Lua. For the demo, use the Lua-provided address — fine.

### What lands in `user._luaProfile`

- `user._luaProfile.email = "laura@example.com"` (lowercased)
- Subject and body delivered to the agent as a single conversation turn
- Inline attachments saved to CDN; URLs added to message context

### Demo angle

Most impressive moment: at the end of the demo, send an email from Gmail to the agent's inbound address:

> "Subject: dishwasher flooding
> Body: Hi, this is Laura at Temple Place 3B, the dishwasher is overflowing"

Watch the agent identify Laura by email, classify the urgency, ask for a photo (you reply with one), and create a ticket — all via email. Then refresh the admin UI → ticket appears.

## Channel: Website widget (LuaPop)

### Setup

LuaPop is already embedded in the v1 HTML page (`<script src="https://lua-ai-global.github.io/lua-pop/lua-pop.umd.js" async></script>`). Carries over verbatim with one change: the new agent ID.

```html
<script src="https://lua-ai-global.github.io/lua-pop/lua-pop.umd.js" async></script>
<script>
window.LuaPop.init({
  agentId: 'YOUR_V2_AGENT_ID',
  environment: 'production',
  displayMode: 'embedded',
  embeddedDisplayConfig: { targetContainerId: 'luapop-host' },
  chatTitle: 'Property Maintenance Agent',
  welcomeMessage: '...',
  // NEW: persona override for demo
  userContext: window.__demoPersona || undefined
})
</script>
```

### `userContext` for the persona pill (new in v2)

LuaPop supports passing a `userContext` object on init that flows into the agent's `user._luaProfile` for that session. The admin UI's persona pill writes this into a global, then the widget re-init picks it up. See [10-ADMIN-UI.md](./10-ADMIN-UI.md).

```js
// Persona pill: "Demo as: Tenant Laura Murphy"
window.__demoPersona = {
  phone: '353861234567',
  email: 'laura@temple-place.test',
  name: 'Laura Murphy'
}
```

This makes the demo flow "logged in as" without forcing the operator to type identifying info each turn.

### What lands in `user._luaProfile`

- `user._luaProfile.userId` = LuaPop session ID
- `user._luaProfile.phone` and `.email` populated from `userContext`

## Channel matrix

| Aspect | Web (LuaPop) | Email | WhatsApp |
|---|---|---|---|
| Identifier delivered | `userContext.phone/email` (from persona pill) or anonymous session | `email` from From header | `phone` from sender |
| Media support | Drag-and-drop photo upload | Inline attachments | Native media messages |
| Rich formatting | Full markdown + components | HTML via templates | WhatsApp markdown only |
| Latency | Real-time | 5–30s (email infra) | <1s |
| Best for in demo | Showing the admin UI side-by-side | "It works async too" moment | "Same agent, different surface" closer |

## Channel-aware persona

Use Lua's channel-aware-prompts feature to adjust formatting per channel:

```yaml
agent:
  persona: |-
    # ... main persona ...

  channelPrompts:
    whatsapp: |-
      When responding via WhatsApp, use plain text. WhatsApp supports *bold*
      and _italic_ but not headers, tables, or list-item components.
      Send photos as media, not links.

    email: |-
      When responding via email, the postprocessor will wrap your reply in
      an HTML template. Keep your text plain and conversational; the
      ticket-summary postprocessor adds a structured card.

    website: |-
      Use the full set of components: list-item, actions, images,
      navigate, payment. Be visually rich.
```

## Recommended channel order to enable

1. **Website widget** (already works in v1, just point at the new agent ID — zero setup)
2. **WhatsApp shared sandbox** (~2 minutes: one WhatsApp message with `link-me-to:agentId`)
3. **Email** (~5 minutes via `lua channels`)

All three are demo-ready in under 10 minutes total. No external accounts needed.
