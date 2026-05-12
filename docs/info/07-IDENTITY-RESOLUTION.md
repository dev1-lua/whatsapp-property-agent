# 07 — Identity Resolution

The single most important capability for the demo: **the agent recognizes the caller and switches mode instantly**. This is what Stefan and Mahmoud specifically called out — "match email/WhatsApp number to either a tenant or vendor."

This doc is the full spec for `get_user_context`.

## Goal

Given any combination of `phone`, `email`, `name`, and `user._luaProfile` data, resolve the caller to:
- `userType: 'tenant'` + tenant record
- `userType: 'vendor'` + vendor record
- `userType: 'admin'` + admin identity (env-listed)
- `userType: 'unregistered'` + null identity

And cache the result on the `User` record so subsequent turns don't re-resolve.

## Inputs available to the tool

1. **User-provided**: `phone`, `email`, `name` — passed as tool params (the LLM extracts from chat)
2. **`User.get()`**: `user._luaProfile.phone`, `user._luaProfile.email`, plus custom fields like `user.tenantId`, `user.vendorId` set on prior turns
3. **`user._luaProfile.userId`**: Lua's stable user identifier across channels

## Resolution algorithm

```ts
async function getUserContext(input: { phone?: string; email?: string; name?: string }) {
  const user = await User.get()

  // FAST PATH — already resolved in this session
  if (user.userType && user.identityId) {
    const collection = user.userType === 'tenant' ? 'tenants' : 'vendors'
    const cached = await Data.getEntry(collection, user.identityId).catch(() => null)
    if (cached) return formatResult(user.userType, cached)
  }

  // Build candidate identifiers from EVERY source
  const phoneCandidates = collectPhones(input.phone, user._luaProfile?.phone)
  const emailCandidates = collectEmails(input.email, user._luaProfile?.email)

  if (!phoneCandidates.length && !emailCandidates.length) {
    return { userType: 'unregistered', identity: null, message: '...' }
  }

  // SEARCH TENANTS — phone first (preferred), email fallback
  const tenantMatch = await searchCollection('tenants', phoneCandidates, emailCandidates)
  if (tenantMatch) {
    await cacheIdentity(user, 'tenant', tenantMatch)
    return formatResult('tenant', tenantMatch)
  }

  // SEARCH VENDORS
  const vendorMatch = await searchCollection('vendors', phoneCandidates, emailCandidates)
  if (vendorMatch) {
    await cacheIdentity(user, 'vendor', vendorMatch)
    return formatResult('vendor', vendorMatch)
  }

  // ADMIN check (env-listed)
  if (isAdminIdentity(emailCandidates, phoneCandidates)) {
    await cacheIdentity(user, 'admin', null)
    return { userType: 'admin', identity: null, message: 'Admin mode' }
  }

  // No match
  await user.update({ userType: 'unregistered' })
  return { userType: 'unregistered', identity: null, message: '...' }
}
```

## Phone normalization

WhatsApp, SMS, and manual user input all give phones in different shapes. Normalize on **both** write and search.

```ts
function normalizePhone(raw: string): string {
  return raw
    .replace(/[\s\-\(\)\.]/g, '')   // strip whitespace, dashes, parens, dots
    .replace(/^\+/, '')              // drop leading +
    .replace(/^00/, '')              // drop international 00 prefix
}

// Examples:
// "+353 86 123 4567"  → "353861234567"
// "(353) 86-123 4567" → "353861234567"
// "00353861234567"    → "353861234567"
// "353861234567"      → "353861234567"
```

**Why phones are stored as `string[]`**: a tenant may have multiple numbers (mobile + landline, primary + WhatsApp). Store all known numbers normalized.

**Search:**
```ts
await Data.get('tenants', {
  filter: { phones: { $in: phoneCandidates } }
})
```

`$in` on a string array matches if ANY value in the document's array equals ANY value in the candidate list.

## Email normalization

```ts
function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}
```

Always lowercased on write. Search uses `$eq`.

## WhatsApp specifics

When a message arrives via WhatsApp:
- Meta's Cloud API webhook includes `from` field = sender's phone in E.164 (e.g., `353861234567`)
- Lua's WhatsApp channel adapter parses this and surfaces it on `user._luaProfile.phone` for the agent

In other words: **no special code for WhatsApp matching**. The phone is just there in the user profile. Our normalization already handles E.164.

Confirm with `lua channels` output that the WhatsApp adapter populates `user._luaProfile.phone` (it does — same as SMS/in-app).

## Email channel specifics

When a message arrives via email (Lua native channel):
- `user._luaProfile.email` is populated with the From address
- Same lookup path

## User API caching

After successful match, write the resolved identity to the user record so subsequent turns are instant.

```ts
await user.update({
  userType: 'tenant' | 'vendor' | 'admin' | 'unregistered',
  identityId: matched.id,                 // tenants.id or vendors.id
  // denormalized for fast access in tools
  tenantName: matched.name,
  propertyId: matched.propertyId,
  propertyCode: matched.propertyCode,
  propertyName: matched.propertyName,
  unit: matched.unit,
  // OR for vendors:
  vendorName: matched.name,
  vendorSpecialties: matched.specialties,
  vendorRating: matched.rating,
})

// Also update the matched record's userId field
await Data.update('tenants', matched.id, { userId: user._luaProfile.userId })
```

## Re-resolution / cache invalidation

When does cached identity get stale?
- **Admin edits**: admin renames a tenant or changes their phone via the admin UI → `User` cache still has the OLD `identityId` pointing at the OLD record. Solution: when admin webhook updates a tenant/vendor, broadcast nothing — next agent turn re-reads from `Data.getEntry(collection, identityId)` and gets fresh data automatically.
- **Tenant moves to a different property**: same — re-read picks up new property.
- **Tenant is deleted**: `Data.getEntry` returns null → re-run full resolution algorithm.

The fast path always validates by re-fetching the cached entry. Cheap, and the cache stays correct.

## Output shape

```ts
type ResolveResult = {
  userType: 'tenant' | 'vendor' | 'admin' | 'unregistered'
  identity: {
    id: string
    name: string
    // tenant fields
    propertyId?: string
    propertyCode?: string
    propertyName?: string
    unit?: string
    // vendor fields
    specialties?: string[]
    rating?: number
    hourlyRate?: number
  } | null
  message: string                         // user-facing greeting hint for the LLM
  emergency?: boolean                     // pass-through from preprocessor
}
```

The persona uses the `message` field as a hint, not verbatim — agent rephrases for natural flow.

## Edge cases & how we handle them

| Edge case | Handling |
|---|---|
| Tenant calls in but their phone isn't in the tenants collection yet | `userType: 'unregistered'`, agent asks to contact landlord |
| Email matches a tenant AND a vendor (rare but possible) | Tenant wins — search tenants first |
| Vendor calls in but identifies by tenant's number (multi-role user) | Whoever is in tenants collection wins; offer "Are you calling as a vendor or tenant today?" if ambiguous |
| Tenant has both old and new phones — calls from new | Add new phone to tenant's `phones[]` via admin UI; until then, `userType: 'unregistered'` |
| Caller refuses to give phone/email | `userType: 'unregistered'` — minimum identifier needed |
| Caller spoofs a tenant phone (manual chat: "Hi I'm Laura at +353...") | Demo accepts it — production would add a verification step (OTP). Out of scope here. |
| Admin calls from an unknown number but on the WhatsApp admin allowlist | Match against `env.ADMIN_PHONES` (comma-separated) → `userType: 'admin'` |

## Why this matters for the demo

In the live demo, you'll switch between tenant and vendor personas to show the agent's range. The persona pill in the admin UI ([10-ADMIN-UI.md](./10-ADMIN-UI.md)) hands the chat widget a synthetic `user._luaProfile.phone` so the resolution runs against your seeded data. The viewer sees:

1. "Hi Laura..." — instant tenant recognition
2. Switch persona → "Hi Dublin Plumbing..." — instant vendor recognition

That's the magic moment. The whole tool is one `Data.get` call. The persona pill exists purely so you don't have to type "Hi I'm Laura at +353861234567" every time during a live demo.

## Production identity verification (out of scope for demo, but for the slide)

For paying customers, layer one of:
- **WhatsApp OTP** — agent texts a code, tenant confirms before any sensitive action
- **Email magic link** — same idea via email
- **Single Sign-On** — if firm has a tenant portal, JWT-pass the verified identity in

None of these are needed for the demo because the channels (WhatsApp / Email) themselves verify ownership of the inbound identifier.
