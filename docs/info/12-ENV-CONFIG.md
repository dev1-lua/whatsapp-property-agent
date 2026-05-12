# 12 — Environment Variables

What v2 keeps, drops, and adds compared to the BC original's env.

## Drop (BC-specific — not needed)

```
BC_TENANT_ID
BC_CLIENT_ID
BC_CLIENT_SECRET
BC_ENVIRONMENT
```

These configured Azure AD OAuth2 for the Business Central API. Gone with BC.

## Keep (still useful)

```
# Approval threshold for finance routing
APPROVAL_THRESHOLD=500             # in firm's currency

# Lua send-message API for outbound notifications via user.send
LUA_AGENT_ID=baseAgent_…           # the v2 agent's own ID
LUA_API_KEY=api_…                  # set via `lua env`, not committed

# Manager identity for daily reports
MANAGER_USER_ID=user_…             # Lua user id (in-app notify)
MANAGER_EMAIL=manager@firm.com     # email fallback

# Stripe (payment stub — keep for InitiatePaymentTool)
STRIPE_SECRET_KEY=sk_test_…
STRIPE_WEBHOOK_SECRET=whsec_…

# OpenAI (optional, for any AI-assisted features outside the agent's main loop)
OPENAI_API_KEY=sk-…
```

## Add (v2-new)

```
# Firm identity (drives persona variables + email branding)
FIRM_NAME="Acme Property Management"
FIRM_LOGO_URL=https://cdn.example.com/logo.png      # used in email templates
FIRM_TIMEZONE=Europe/Dublin                          # for ticket time formatting

# Approver routing
APPROVER_EMAIL=finance@firm.com                      # over-threshold quotes go here
APPROVER_NAME="Finance Team"

# Admin allowlist for ADMIN-mode identity
ADMIN_EMAILS=manager@firm.com,ops@firm.com           # comma-separated
ADMIN_PHONES=353861234567,353871234567               # comma-separated, normalized

# Currency
CURRENCY=EUR                                          # ISO 4217

# WhatsApp channel — only set if NOT using `lua channels` UI to manage
# (preferred: use `lua channels`, leave these unset)
# WA_PHONE_NUMBER_ID=…
# WA_WABA_ID=…
# WA_ACCESS_TOKEN=…

# Demo overrides
TEST_USER_EMAIL=                                     # only set during local dev
TEST_USER_PHONE=
SEED_AUTO=false                                      # if true, agent auto-seeds on first deploy

# Feature flags
ENABLE_AUTO_ASSIGN_VENDOR=true                       # auto-assign on ticket create
ENABLE_DUPLICATE_DETECTION=true                      # check for similar open tickets
ENABLE_PHOTO_VALIDATION=true                         # require multi-angle photos
```

## How env reaches the agent

Two paths in Lua:

1. **`lua env`** — preferred. Sets vars in Lua's secure store; the agent reads via `Environment.get('VARNAME')` at runtime. Per-environment (sandbox vs production).
2. **`.env` file** — fallback for local dev. Not deployed.

Recommended pattern:

```bash
# Set production secrets via lua env (one-time)
lua env --env production set APPROVAL_THRESHOLD 500
lua env --env production set FIRM_NAME "Acme Property Management"
lua env --env production set APPROVER_EMAIL finance@acme.com
lua env --env production set STRIPE_SECRET_KEY sk_live_xxx
# ... etc

# Local .env for sandbox testing
# (mirrors prod with sk_test keys + sandbox values)
```

## Per-firm overrides (the demo replication pattern)

When standing up the demo for a new firm, the only things that change are env vars:

```bash
# For Mahmoud's customer 1: "Sunshine Property Group"
lua env set FIRM_NAME "Sunshine Property Group"
lua env set APPROVER_EMAIL approvals@sunshinepg.com
lua env set APPROVAL_THRESHOLD 1000        # bigger firm, higher threshold
lua env set CURRENCY USD
lua env set FIRM_TIMEZONE America/Chicago
lua env set ADMIN_EMAILS jane@sunshinepg.com,paul@sunshinepg.com
```

Plus a different `seed-data` payload. Plus a new `lua init` for agent isolation. That's the full replication recipe.

## env.example for v2

When scaffolding the v2 codebase, ship this `env.example`:

```
# =============================================================================
# LUA CLI
# =============================================================================
# LUA_API_KEY=api_your-lua-api-key-here

# =============================================================================
# AGENT IDENTITY
# =============================================================================
LUA_AGENT_ID=baseAgent_agent_xxxx          # set by `lua init`
LUA_API_KEY=api_your-lua-api-key-here

# =============================================================================
# FIRM CONFIGURATION
# =============================================================================
FIRM_NAME="Demo Property Management"
FIRM_LOGO_URL=
FIRM_TIMEZONE=Europe/Dublin
CURRENCY=EUR

# =============================================================================
# APPROVAL WORKFLOW
# =============================================================================
APPROVAL_THRESHOLD=500
APPROVER_EMAIL=approver@example.com
APPROVER_NAME="Finance Approver"

# =============================================================================
# ADMIN ALLOWLIST
# =============================================================================
ADMIN_EMAILS=manager@example.com
ADMIN_PHONES=

# =============================================================================
# NOTIFICATIONS
# =============================================================================
MANAGER_EMAIL=manager@example.com
MANAGER_USER_ID=

# =============================================================================
# THIRD-PARTY
# =============================================================================
# STRIPE_SECRET_KEY=sk_test_your-stripe-key-here
# OPENAI_API_KEY=sk-your-openai-key-here

# =============================================================================
# FEATURE FLAGS
# =============================================================================
ENABLE_AUTO_ASSIGN_VENDOR=true
ENABLE_DUPLICATE_DETECTION=true
ENABLE_PHOTO_VALIDATION=true

# =============================================================================
# LOCAL TESTING
# =============================================================================
# TEST_USER_PHONE=+353861234567
# TEST_USER_EMAIL=laura@example.com
```

## Reading env in code

```ts
import { Environment } from 'lua-cli'

const threshold = Number(await Environment.get('APPROVAL_THRESHOLD')) || 500
const approverEmail = await Environment.get('APPROVER_EMAIL')
const firmName = await Environment.get('FIRM_NAME') || 'Property Management'
```

Or use the simple `process.env.X` for local development (Lua's runtime injects them into process env at boot).

## Persona templating from env

The persona body can reference `{{FIRM_NAME}}`, `{{APPROVAL_THRESHOLD}}`, `{{CURRENCY}}` and they get substituted at deploy time. Edit `lua.skill.yaml`:

```yaml
agent:
  persona: |-
    You are Alex Carter, a Property Maintenance Coordinator for {{FIRM_NAME}}.
    
    The approval threshold is {{CURRENCY}}{{APPROVAL_THRESHOLD}}.
    Quotes above this amount require finance approval.
    ...
```

This makes the persona itself firm-aware without rewriting prose.
