# 00 — Baseline Verification

**Baseline commit:** `c1c7591` (platform-foundation).
**Branch created:** `opspilot/tenant-isolation` from `c1c7591`.
**Baseline gates (before any change):** `tsc --noEmit` clean · **296/296 tests** ·
existing eslint clean on our scope.

## Re-inspection (confirmed)
- **Redis architecture:** Upstash REST via `app/lib/redis.ts` `call()`; **no
  SCAN** exposed. **38 lib modules** import the wrapper relatively.
- **Bypasses:** exactly **2** files use their own inline Upstash fetch —
  `app/api/track/route.ts`, `app/api/admin/analytics/route.ts` (commands
  `INCR/HINCRBY/PFADD/PFCOUNT/HGETALL/EXPIRE/GET`).
- **tenant-store.ts / keys:** the platform-foundation `tenantKey` contract exists
  (fail-closed) but was **not** wired to `redis.ts`.
- **Session/principal:** `Principal.tenantId` present (defaults `jkiss`); session
  reads the **signed cookie only** — headers are not trusted. `proxy.ts` strips
  inbound `x-tenant-id`.
- **Feature flags:** `TENANCY_ENABLED` (off) plus the platform-foundation set.
- **Key naming:** `family:{id}` + `family:index` zset convention; company-name-
  derived families are `biz:{name}`, `promo:{code}`, `ship:{bol}` (+ `msg:phone`).
- **Scheduled jobs:** `vercel.json` crons (`daily`, `reminders`), both SMS-suppressed.
- **Webhooks:** Stripe (verified), Twilio + email (fail-closed after foundation).
- **Background processing:** cron sweeps + reminder engine.
- **File storage:** Vercel Blob; paths **not** tenant-prefixed (deferred).

## Conclusion
Baseline is green and matches the blueprint. No contradiction requiring approval —
proceeded automatically.
