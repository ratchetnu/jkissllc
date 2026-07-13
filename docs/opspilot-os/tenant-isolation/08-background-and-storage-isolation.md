# 08 — Background & Storage Isolation

**File:** `app/lib/platform/tenancy/request-context.ts` + wiring in cron/webhooks.

Background entry points now establish a tenant context so their Redis work crosses
the same boundary. All safe while the flag is off (context = reference tenant →
`scopeKey` no-ops).

## Wired this sprint
| Entry point | Wiring | Fail-closed when tenancy on |
|---|---|---|
| `api/cron/daily` | `withBackgroundTenant('cron', …)` wraps the sweep | no explicit tenant → throws |
| `api/cron/reminders` | same | throws |
| `api/webhooks/twilio/sms` | wraps post-auth work | throws |
| `api/webhooks/email` | wraps post-auth work | throws |

`resolveBackgroundTenant('cron'|'webhook', explicit?)` returns the reference tenant
while tenancy is off, and **fails closed** (throws + telemetry) when on and no
tenant is named.

## Request entry points
`withTenantContextFromRequest(req, fn)` resolves the tenant from the **signed
session only** (headers ignored) and runs the handler in that context. Provided;
applied to admin/portal handlers at cutover (Stage 7) rather than now, to avoid a
broad behavioral change while the flag is off.

## Assertions per system
- **Cron / reminders / webhooks:** tenant context established (above).
- **Audit / AI usage / analytics / approvals / events / insights:** already carry
  `tenantId` in their models/telemetry (platform-foundation); the Redis keys they
  write scope through the chokepoint.
- **Blob paths:** NOT yet tenant-prefixed — deferred (doc 14). Documents remain
  encrypted; path prefixing is a Stage-8 storage task.
- **Notification queues:** the outbox is in-process + tenant-stamped envelopes.

## Deferred (Stage 7–8)
Per-handler `withTenantContextFromRequest` application, public-token → tenant
resolution, and blob path prefixing.
