# 01 — Redis Key Inventory

Every key family, classified. Target tenant format: **`t:{tenantId}:{existingKey}`**.
Not every key is prefixed — the platform-global allowlist is explicit.

## Platform-global (NEVER prefixed — allowlist in `keys.ts`)
| Prefix | Why global | Referenced by |
|---|---|---|
| `opspilot:` | Early-access waitlist — platform, not a tenant | waitlist API |
| `platform:` | Tenant records + platform billing/analytics (future) | platform |
| `ai:` | AI telemetry/cost/prompts — platform-managed; **cost key already embeds the tenant** (`ai:cost:{tid}:{day}`) | AI subsystem |
| `rl:` | Rate limits — **pre-auth, per-IP** infra (no tenant context at login time) | rate-limit, auth |

## Tenant-owned (prefixed when `TENANCY_ENABLED=true`)
| Family | Entity | Producer | Notable consumers | Name-derived? | Migration risk | New format |
|---|---|---|---|---|---|---|
| `bk:*` | Bookings (+ idempotency, counters) | bookings.ts | book API, cron, webhooks, UI | no | low | `t:{tid}:bk:*` |
| `rt:*` `rt:tpl:*` `rt:inv:*` `rt:client:*` | Routes/templates/invoices/portals | routes.ts, … | cron, admin, public token | no | low | `t:{tid}:rt:*` |
| `clm:*` | Claims | claims.ts | admin, cron (accrual) | no | low | `t:{tid}:clm:*` |
| `app:*` | Applicants | applicants.ts | careers, admin | no | low | `t:{tid}:app:*` |
| `msg:*` | Messages (+ `msg:phone:{e164}`) | messages.ts | webhooks, inbox | **phone** | medium | `t:{tid}:msg:*` |
| `staff:*` | Staff (`payByBusiness` keyed by bizKey) | staff.ts | pay, routes | via bizKey | medium | `t:{tid}:staff:*` |
| `biz:*` | Contract clients | businesses.ts | routes, finance | **name** | **high** | `t:{tid}:biz:*` (+ id remap) |
| `promo:*` | Promo codes | promo.ts | bookings | **code** | medium | `t:{tid}:promo:*` |
| `ship:*` | Shipments | shipments.ts | tracking | **BOL** | medium | `t:{tid}:ship:*` |
| `rv:*` | Site reviews | site-reviews.ts | reviews | no | low | `t:{tid}:rv:*` |
| `policy:*` | Versioned policy | policy.ts | booking UI | no | low | `t:{tid}:policy:*` |
| `cfg:*` | Config (disposal/blackout/capacity/deposit) | disposal/availability | pricing, scheduling | no | low | `t:{tid}:cfg:*` |
| `settings:*` | Owner alerts / finance settings | owner-alerts/finance | notify, finance | no | low | `t:{tid}:settings:*` |
| `learn:*` | AI pricing calibration (**global today — cross-tenant leak**) | job-learning.ts | quote/estimate | no | medium | `t:{tid}:learn:*` |
| `crewavail:*` `timeoff:*` `uniform:*` | Workforce self-service | respective | portal, admin | no | low | `t:{tid}:…` |
| `rsend:*` `rem:*` | Reminder engine (+ occurrence idempotency, ack tokens) | reminders.ts | cron, ack | no | low | `t:{tid}:…` |
| `paystmt:*` | Pay statements (immutable) | pay-statements.ts | portal, admin | no | low | `t:{tid}:paystmt:*` |
| `audit:*` | Central attributed audit | audit.ts | admin | no | low | `t:{tid}:audit:*` |
| `pv:*` `uv:*` | Analytics (pageviews/visitors) | **track (bypass)** | **admin/analytics (bypass)** | no | low | `t:{tid}:pv:*` |
| `sms:optout:{e164}` | SMS opt-out | sms.ts / webhook | notify | **phone** | medium | `t:{tid}:sms:optout:*` |

## Classification buckets (per the sprint's required taxonomy)
- **platform-global:** `opspilot: platform: ai: rl:`
- **tenant-owned:** everything above in the second table
- **ephemeral/operational:** `rt:lock:*` / mutex keys (via `EVAL`, tenant-scoped)
- **idempotency:** `msg:pid:*`, `rsend:occ:*`, booking idempotency (tenant-owned)
- **rate-limit:** `rl:*` → **global**
- **session:** none in Redis (stateless HMAC cookie)
- **audit:** `audit:*` → tenant-owned
- **analytics:** `pv:*`/`uv:*` → tenant-owned (via remediated bypass)
- **webhook:** `sms:optout:*` → tenant-owned
- **AI-cost:** `ai:cost:*` → global (already tenant-embedded)
- **cache:** none distinct
