# 05 — Jobs, Preprocessors, Postprocessors

Asynchronous + cross-cutting machinery: scheduled jobs that run on a cron, a preprocessor that hijacks emergency messages, postprocessors that format output and audit communications.

## Scheduled Jobs

### `escalation-check` (LuaJob)

**Cron:** Every hour on the hour (`0 * * * *`)
**Purpose:** SLA monitoring + auto-escalation.

```ts
async function run() {
  const now = Date.now()
  const { data: openTickets } = await Data.get('tickets', {
    filter: { status: { $nin: ['closed', 'cancelled'] } },
    limit: 500
  })

  for (const t of openTickets) {
    const ageHours = (now - new Date(t.createdAt).getTime()) / 3_600_000

    // Emergency SLA breach
    if (t.urgency === 'emergency' && ageHours > SLA.EMERGENCY_RESPONSE && t.status === 'reported') {
      await escalate(t, 'sla_breach', `Emergency ticket not contacted within ${SLA.EMERGENCY_RESPONSE}h`)
    }

    // Vendor no-response
    if (t.status === 'vendor_contacted' && ageHours > SLA.VENDOR_RESPONSE) {
      await escalate(t, 'vendor_no_response', `Vendor silent ${Math.floor(ageHours)}h after assignment`)
    }

    // Approval stuck
    if (t.status === 'pending_approval') {
      const approvalAge = (now - new Date(t.approval.requestedAt).getTime()) / 3_600_000
      if (approvalAge > SLA.APPROVAL_ESCALATION) {
        await escalate(t, 'approval_delay', `Approval pending ${Math.floor(approvalAge)}h`)
      }
    }
  }
}
```

**Output:** Creates `escalations` entries, emails managers, updates `audit_events`.

**Changes from BC:** reads from `Data.get` not BC API; no per-company loop (single-firm agent).

### `daily-workload-report` (LuaJob)

**Cron:** Every weekday at 09:00 (`0 9 * * 1-5`)
**Purpose:** Manager's daily portfolio summary.

```ts
async function run() {
  const buckets = await aggregateBuckets()   // by status, by urgency, by property
  const openEscalations = await Data.get('escalations', { filter: { status: 'open' } })
  const overdueTickets = await aggregateOverdue()

  const html = renderDailyReportEmail({ buckets, openEscalations, overdueTickets })

  if (process.env.MANAGER_EMAIL) {
    await sendEmail(process.env.MANAGER_EMAIL, 'Daily maintenance report', html)
  }
  if (process.env.MANAGER_USER_ID) {
    const u = await User.get(process.env.MANAGER_USER_ID)
    await u.send([{ type: 'text', text: renderTextSummary(buckets) }])
  }
}
```

**Changes from BC:** aggregation uses `Data.get` with filter+count instead of BC pageable list.

## Preprocessor

### `emergency-triage` (PreProcessor)

**Fires:** On every inbound user message, before the agent processes it.
**Purpose:** Detect emergency keywords and inject safety instructions so the agent's first response is always "do this immediately, then we'll file the ticket."

```ts
const EMERGENCY_KEYWORDS = [
  'gas smell', 'gas leak', 'active fire', 'fire',
  'severe flooding', 'flooding', 'water everywhere',
  'electrical fire', 'smoke', 'carbon monoxide',
  'no heat', 'frozen pipes', 'burst pipe',
  'sewage backup', 'structural collapse'
]

async function preprocess(message: string, context) {
  const lower = message.toLowerCase()
  const matched = EMERGENCY_KEYWORDS.find(k => lower.includes(k))
  if (!matched) return { message, instructions: null }

  return {
    message,
    instructions: `🚨 EMERGENCY DETECTED ("${matched}")\n\nBefore anything else, give the tenant these safety instructions:\n${safetyInstructionsFor(matched)}\n\nThen proceed with ticket creation, urgency=emergency.`,
    metadata: { emergency: true, keyword: matched }
  }
}
```

Safety instructions are keyword-specific:
- Gas leak/smell → leave property, no electrical switches, call gas emergency line
- Fire → evacuate, call 999/911
- Severe flooding → shut off water at mains, move valuables, avoid electrics
- Carbon monoxide → evacuate, ventilate, call emergency services
- etc.

**Changes from BC:** zero — preprocessor was already DB-agnostic in the original.

## Postprocessors

### `ticket-summary` (PostProcessor)

**Fires:** After the agent generates a response.
**Purpose:** If the agent's response references a ticket, format a rich card with status, photos, next-steps using Lua's list-item formatting component.

```ts
async function postprocess(response, context) {
  const ticketIds = extractTicketIds(response.text)   // regex MT-\d{4}-[A-Z0-9]{6}
  if (!ticketIds.length) return response

  const cards = await Promise.all(ticketIds.map(async tid => {
    const ticket = await Data.search('tickets', { filter: { ticketId: tid }, limit: 1 })
    return ticket?.[0] ? renderTicketCard(ticket[0]) : null
  }))

  return {
    ...response,
    components: [...(response.components || []), ...cards.filter(Boolean)]
  }
}

function renderTicketCard(t) {
  return {
    type: 'list-item',
    title: t.ticketId,
    subtitle: `${t.issueType} • ${humanStatus(t.status)} • ${t.propertyName}${t.unit ? ' / ' + t.unit : ''}`,
    description: t.description.slice(0, 120),
    images: t.images?.slice(0, 3) || []
  }
}
```

### `communication-log` (PostProcessor)

**Fires:** After every agent response.
**Purpose:** Persistent audit of all outbound communications, queryable by ticketId.

```ts
async function postprocess(response, context) {
  const ticketId = inferTicketId(response, context)
  await Data.create('communications', {
    ticketId: ticketId || null,
    direction: 'Outbound',
    channel: inferChannel(context),
    senderType: 'Agent',
    senderName: 'Property Maintenance Agent',
    recipient: context.user._luaProfile?.phone || context.user._luaProfile?.email || context.userId,
    body: response.text,
    contentType: 'Plain Text',
    delivery: 'sent',
    at: new Date().toISOString()
  })
  return response   // unchanged
}
```

**Changes from BC:** writes to `Data.create({collection:'communications'})` instead of BC `maintenanceMessages` API.

## Why these run in the agent loop

The flow each turn:

```
inbound msg
  ↓
PreProcessor: emergency-triage          ← can inject instructions
  ↓
Tools execute (Data.* calls)
  ↓
Agent response generated
  ↓
PostProcessor: ticket-summary           ← attaches rich card
  ↓
PostProcessor: communication-log        ← writes audit entry
  ↓
Channel adapter → outbound
```

Pre runs before LLM call, posts run after. Jobs run on cron, independent of conversations.
