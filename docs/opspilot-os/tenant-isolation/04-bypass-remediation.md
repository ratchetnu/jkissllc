# 04 — Bypass Remediation

Two files reached Upstash directly, bypassing the chokepoint. Both now use the
wrapper, so `pv:*`/`uv:*` analytics keys cross the same boundary as all
tenant-owned data.

## `app/api/track/route.ts`
- **Old:** inline `redis(url, token, 'INCR', 'pv:total')` etc. reading
  `KV_REST_API_*`.
- **New:** `redis.incr('pv:total')`, `redis.hincrby(...)`, `redis.pfadd(...)`,
  `redis.expire(...)` — no direct env access.
- **Compatibility:** identical Redis effects while the flag is off.

## `app/api/admin/analytics/route.ts`
- **Old:** inline fetch for `GET/HGETALL/PFCOUNT`, parsing `{result}`.
- **New:** `redis.get`, `redis.hgetall`, `redis.pfcount` (return values directly;
  `parseHash` adapted). Guard `requireSession` preserved; misconfig now 500s via a
  try/catch.

## Allowlist (documented, no undocumented exceptions)
The ONLY places permitted to touch Upstash directly:
- `app/lib/redis.ts` — the chokepoint.
- `scripts/tenant-migration/` — the migration tool (needs `SCAN`, which the
  wrapper doesn't expose); outside `app/`, guarded, production-refusing.

Enforced by `scripts/bypass-detection.test.ts` (a CI gate): no `app/` file may
reference `KV_REST_API` except `app/lib/redis.ts`, and no `app/` file may build a
`t:{...}:` prefix except `keys.ts`.
