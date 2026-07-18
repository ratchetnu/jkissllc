// Thin wrapper around the Upstash Redis REST API.
// Env: KV_REST_API_URL and KV_REST_API_TOKEN (auto-provisioned by the Vercel/Upstash integration).
//
// OPSPILOT MULTI-TENANT — THE ENFORCEABLE ISOLATION CHOKEPOINT.
// Every key passed to a method below is routed through `scopeKey()`
// (app/lib/platform/tenancy/keys.ts). While TENANCY_ENABLED=false the key is
// returned UNCHANGED (byte-identical to today). While TENANCY_ENABLED=true it is
// namespaced `t:{tenantId}:{key}` for tenant-owned families, left alone for the
// platform-global allowlist, and a missing tenant context throws (fail closed).
//
// Two callers historically bypassed this wrapper with their own inline fetch
// (app/api/track, app/api/admin/analytics); they now use the methods here, so the
// pv:*/uv:* analytics keys go through the same boundary. Direct KV_REST_API use is
// forbidden outside this file + scripts/tenant-migration (enforced by
// scripts/bypass-detection.test.ts).
//
// Dark-launch (TENANCY_DARK_LAUNCH) shadow-reads the tenant copy alongside the
// legacy value and reports mismatches without changing the response. Dual-write
// (TENANCY_DUAL_WRITE) mirrors idempotent SET/DEL to both keys for migration
// validation. Both are off by default. See docs/opspilot-os/tenant-isolation/.

import { isEnabled } from './platform/flags'
import { currentTenantId } from './platform/tenancy/context'
import { scopeKey, compareLegacyAndTenantKey } from './platform/tenancy/keys'
import { recordComparison } from './platform/tenancy/dark-launch'

type RedisValue = string | number | null
type RedisResult<T = RedisValue> = { result: T } | { error: string }

async function call(args: (string | number)[]): Promise<unknown> {
  const url = process.env.KV_REST_API_URL
  const token = process.env.KV_REST_API_TOKEN
  if (!url || !token) throw new Error('UPSTASH_NOT_CONFIGURED')

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args.map(String)),
    cache: 'no-store',
  })
  const json = (await res.json()) as RedisResult
  if ('error' in json) throw new Error(json.error)
  return json.result
}

// The physical target key(s) for a logical WRITE. Normally one (scoped) key; with
// TENANCY_DUAL_WRITE and a resolvable tenant, both legacy + tenant keys — used
// ONLY for idempotent writes (set/del) where mirroring is consistent.
function writeTargets(key: string): string[] {
  const primary = scopeKey(key)
  if (!isEnabled('TENANCY_DUAL_WRITE')) return [primary]
  const pair = compareLegacyAndTenantKey(key)
  if (!pair) return [primary]
  return Array.from(new Set([pair.legacy, pair.tenant]))
}

export const redis = {
  async get(key: string): Promise<string | null> {
    // Dark-launch: read both, compare, return legacy — no response change.
    if (isEnabled('TENANCY_DARK_LAUNCH')) {
      const pair = compareLegacyAndTenantKey(key)
      if (pair) {
        const [legacy, tenant] = (await Promise.all([
          call(['GET', pair.legacy]), call(['GET', pair.tenant]),
        ])) as (string | null)[]
        const tid = currentTenantId()
        if (tid) recordComparison(key, tid, legacy, tenant)
        return legacy
      }
    }
    return (await call(['GET', scopeKey(key)])) as string | null
  },
  async set(key: string, value: string): Promise<void> {
    for (const k of writeTargets(key)) await call(['SET', k, value])
  },
  async del(key: string): Promise<void> {
    for (const k of writeTargets(key)) await call(['DEL', k])
  },
  async zadd(key: string, score: number, member: string): Promise<void> {
    await call(['ZADD', scopeKey(key), score, member])
  },
  async zrevrange(key: string, start: number, stop: number): Promise<string[]> {
    return ((await call(['ZREVRANGE', scopeKey(key), start, stop])) ?? []) as string[]
  },
  async zrem(key: string, member: string): Promise<void> {
    await call(['ZREM', scopeKey(key), member])
  },
  async incr(key: string): Promise<number> {
    return (await call(['INCR', scopeKey(key)])) as number
  },
  async pexpire(key: string, ms: number): Promise<void> {
    await call(['PEXPIRE', scopeKey(key), ms])
  },
  async expire(key: string, seconds: number): Promise<void> {
    await call(['EXPIRE', scopeKey(key), seconds])
  },
  async zcard(key: string): Promise<number> {
    return ((await call(['ZCARD', scopeKey(key)])) ?? 0) as number
  },
  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    return ((await call(['ZRANGE', scopeKey(key), start, stop])) ?? []) as string[]
  },
  // Hash + HyperLogLog commands (used by the analytics surface, now on-chokepoint).
  async hincrby(key: string, field: string, by: number): Promise<number> {
    return (await call(['HINCRBY', scopeKey(key), field, by])) as number
  },
  async hgetall(key: string): Promise<string[]> {
    return ((await call(['HGETALL', scopeKey(key)])) ?? []) as string[]
  },
  async pfadd(key: string, ...members: string[]): Promise<number> {
    return (await call(['PFADD', scopeKey(key), ...members])) as number
  },
  async pfcount(...keys: string[]): Promise<number> {
    return (await call(['PFCOUNT', ...keys.map((k) => scopeKey(k))])) as number
  },
  // Acquire-if-absent with a TTL, in one atomic command — the primitive behind the
  // per-route mutex (lib/route-mutex.ts). Returns true only if THIS caller set it.
  async setNxPx(key: string, value: string, ttlMs: number): Promise<boolean> {
    return (await call(['SET', scopeKey(key), value, 'NX', 'PX', ttlMs])) === 'OK'
  },
  // Run a Lua script atomically. Used for compare-and-delete lock release so a caller
  // never deletes a lock that already expired and was re-acquired by someone else.
  // Lock KEYS are tenant-owned, so they are scoped too.
  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    const scoped = keys.map((k) => scopeKey(k))
    return call(['EVAL', script, scoped.length, ...scoped, ...args])
  },
}

// The configured KV store HOST (non-secret), or '' when unset. Exposed so callers can
// make store-identity decisions (e.g. "is this the production store?") WITHOUT importing
// the raw credential env — the bypass-detection gate forbids KV_REST_API references
// outside this file, so this is the one sanctioned way to learn which store is wired.
export function kvHost(): string {
  const url = process.env.KV_REST_API_URL
  if (!url) return ''
  try { return new URL(url).host } catch { return '' }
}
