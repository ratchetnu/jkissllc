// Per-route mutex — the fix for the "crew = one blob" write race.
//
// The whole crew of a route lives in one Redis document (rt:{token}). Before this,
// every writer did an independent get → mutate → saveRoute, so two actors on the
// SAME route at the SAME time (the driver confirming while the helper declines the
// morning of the route; an admin editing money while a crew member clocks in; the
// daily cron advancing status while someone confirms) both read the same pre-state
// and the second SET clobbered the first — a confirmation or decline could silently
// vanish.
//
// This serializes all read-modify-write on a given route behind a short Redis lock,
// so those operations can no longer interleave. The lock is keyed on the route's
// CANONICAL token, so actions arriving on different per-assignee confirm tokens still
// contend on the same lock. Different routes never block each other.
//
// Why a lock and not per-assignee keys: sharding each assignee into its own key would
// still leave the route-level fields (status rollup, completion, invoiceId) racing,
// and would fragment the money/notify/clock code that reads the whole crew at once.
// A lock fixes every writer uniformly without touching that surface.
import { redis } from './redis'
import { getRouteByToken, getRouteByConfirmToken, saveRoute, type RouteRecord, type Assignee } from './routes'

const LOCK_TTL_MS = 8_000   // generous vs. the few ms a mutation takes; auto-frees a crashed holder
const ATTEMPTS = 40         // ~2s of retries before giving up
const BACKOFF_MS = 50

const lockKeyFor = (routeToken: string) => `rt:lock:${routeToken}`
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// Compare-and-delete: only release the lock if we still own it. Prevents deleting a
// lock that expired mid-operation and was re-acquired by another writer.
const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

export class RouteBusyError extends Error {
  constructor() { super('ROUTE_BUSY'); this.name = 'RouteBusyError' }
}

// Run `fn` while holding the route's lock. Throws RouteBusyError if the lock can't be
// acquired within the retry budget (a caller should surface a "try again" to the user
// rather than risk a clobbering write).
export async function withRouteLock<T>(routeToken: string, fn: () => Promise<T>): Promise<T> {
  const key = lockKeyFor(routeToken)
  const token = `${Date.now()}-${Math.round(Math.random() * 1e9)}`
  let held = false
  for (let i = 0; i < ATTEMPTS; i++) {
    if (await redis.setNxPx(key, token, LOCK_TTL_MS)) { held = true; break }
    await sleep(BACKOFF_MS)
  }
  if (!held) throw new RouteBusyError()
  try {
    return await fn()
  } finally {
    try { await redis.eval(RELEASE, [key], [token]) } catch { /* lock will expire on its own */ }
  }
}

// Load a route fresh under its lock, let `mutator` change it, then persist — the
// safe replacement for getRouteByToken()→mutate→saveRoute. Returns the mutator's
// value, or null if the route no longer exists. `mutator` may return false to skip
// the save (e.g. an idempotent no-op or a validation bail-out).
export async function mutateRoute<T>(
  routeToken: string,
  mutator: (route: RouteRecord) => T | Promise<T>,
): Promise<{ route: RouteRecord; value: T } | null> {
  return withRouteLock(routeToken, async () => {
    const route = await getRouteByToken(routeToken)
    if (!route) return null
    const value = await mutator(route)
    if (value !== false) await saveRoute(route)
    return { route, value }
  })
}

// Same, addressed by a per-assignee confirm token (the public route endpoint). The
// lock is taken on the route's canonical token so every assignee of one route
// serializes together; the route is re-read fresh inside the lock.
export async function mutateByConfirmToken<T>(
  confirmToken: string,
  mutator: (route: RouteRecord, assignee: Assignee) => T | Promise<T>,
): Promise<{ route: RouteRecord; assignee: Assignee; value: T } | null> {
  const first = await getRouteByConfirmToken(confirmToken)
  if (!first) return null
  return withRouteLock(first.route.token, async () => {
    const fresh = await getRouteByConfirmToken(confirmToken)
    if (!fresh) return null
    const value = await mutator(fresh.route, fresh.assignee)
    if (value !== false) await saveRoute(fresh.route)
    return { route: fresh.route, assignee: fresh.assignee, value }
  })
}
