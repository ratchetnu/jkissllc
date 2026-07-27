// LOCK-1 — every write lock in the OS must be ownership-safe.
//
// The July 2026 race audit reproduced the defect against the real booking write
// lease: a holder whose lease had EXPIRED still deleted the key on its way out,
// removing the NEXT holder's lock while that holder was still working. The lease
// stored a constant '1', so there was no way to tell holders apart. The Release
// Center's publish / rollback / approval mutexes had the same unconditional DEL
// (approval's lease stored the actor name — indistinguishable between two approvals
// by the same admin).
//
// These tests pin the shared primitive (app/lib/kv-lock.ts) and the real
// withBookingWriteLock against an in-memory Upstash fake. No Production data.
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'

const UPSTASH = 'http://fake-upstash.local'
type Entry = { value: string; expiresAt?: number }
const kv = new Map<string, Entry>()
let failOnce: ((cmd: string, key: string) => boolean) | null = null
const cmdLog: string[] = []

function live(key: string): string | null {
  const e = kv.get(key)
  if (!e) return null
  if (e.expiresAt != null && e.expiresAt <= Date.now()) { kv.delete(key); return null }
  return e.value
}

globalThis.fetch = (async (url: string, init: { body?: string }) => {
  if (url !== UPSTASH) return { ok: true, status: 200, json: async () => ({}) }
  await new Promise(r => setImmediate(r))
  const [cmd, ...args] = JSON.parse(init.body as string) as string[]
  const command = String(cmd).toUpperCase()
  const key = args[0]
  cmdLog.push(command)
  if (failOnce?.(command, key)) { failOnce = null; throw new Error('fake redis: injected failure') }
  let result: unknown = null
  switch (command) {
    case 'GET': result = live(key); break
    case 'SET': {
      const flags = args.slice(2).map(a => String(a).toUpperCase())
      const nx = flags.includes('NX')
      const pxAt = flags.indexOf('PX')
      const ttl = pxAt >= 0 ? Number(args[2 + pxAt + 1]) : undefined
      if (nx && live(key) !== null) { result = null; break }
      kv.set(key, { value: args[1], expiresAt: ttl != null ? Date.now() + ttl : undefined })
      result = 'OK'; break
    }
    case 'DEL': result = kv.delete(key) ? 1 : 0; break
    case 'INCR': { const n = Number(live(key) ?? 0) + 1; kv.set(key, { value: String(n) }); result = n; break }
    case 'ZADD': case 'ZREM': case 'PEXPIRE': case 'EXPIRE': result = 1; break
    case 'ZREVRANGE': case 'ZRANGE': result = []; break
    case 'EVAL': {
      const script = String(args[0]); const n = Number(args[1]); const k = args[2]; const token = args[2 + n]
      const owns = live(k) === token
      if (/pexpire/i.test(script)) {
        if (owns) { kv.set(k, { value: token, expiresAt: Date.now() + Number(args[3 + n]) }); result = 1 } else result = 0
      } else {
        if (owns) { kv.delete(k); result = 1 } else result = 0
      }
      break
    }
    default: result = null
  }
  return { ok: true, json: async () => ({ result }) }
}) as unknown as typeof fetch

import { acquireLock, withLock, newLockToken, LockLostError } from '../app/lib/kv-lock'
import { withBookingWriteLock } from '../app/lib/bookings'

const reset = () => { kv.clear(); failOnce = null; cmdLog.length = 0 }
const KEY = 'test:lock:alpha'

// ── Ownership ────────────────────────────────────────────────────────────────

test('tokens are unique per ACQUISITION, not per actor', async () => {
  reset()
  const a = newLockToken('owner')
  const b = newLockToken('owner')
  assert.notEqual(a, b, 'the same admin acting twice must not produce the same token')
  assert.match(a, /^owner-/, 'the holder tag is kept for debugging')
  assert.equal(newLockToken().includes('-'), true)
})

test('the owner can release its own lock', async () => {
  reset()
  const lock = (await acquireLock(KEY, { ttlMs: 5_000 }))!
  assert.ok(lock, 'acquired')
  assert.equal(live(KEY), lock.token)
  assert.equal(await lock.release(), true, 'the owner released it')
  assert.equal(live(KEY), null)
})

test('a foreign token cannot release the lock', async () => {
  reset()
  const holder = (await acquireLock(KEY, { ttlMs: 5_000 }))!
  const intruder = await acquireLock(KEY, { ttlMs: 5_000 })
  assert.equal(intruder, null, 'a second acquire is refused while held')

  // Forge a handle with someone else's token — release must be a no-op.
  kv.set('other', { value: 'x' })
  const forged = (await acquireLock('other', { ttlMs: 5_000 }))
  assert.equal(forged, null)
  assert.equal(live(KEY), holder.token, 'still the original holder')
  await holder.release()
  assert.equal(live(KEY), null)
})

test('LOCK-1: an EXPIRED holder cannot delete its successor\'s lock', async () => {
  reset()
  const a = (await acquireLock(KEY, { ttlMs: 40 }))!          // short lease, no renewal
  await new Promise(r => setTimeout(r, 60))                    // A's lease lapses
  const b = (await acquireLock(KEY, { ttlMs: 5_000 }))!        // B legitimately takes over
  assert.notEqual(a.token, b.token)

  assert.equal(await a.release(), false, 'A no longer owns it, so A releases nothing')
  assert.equal(live(KEY), b.token, 'B still holds its lock — the pre-fix bug is gone')
  assert.equal(await b.release(), true)
})

test('assertHeld / heldNow report the truth', async () => {
  reset()
  const lock = (await acquireLock(KEY, { ttlMs: 5_000 }))!
  assert.equal(await lock.heldNow(), true)
  await lock.assertHeld()
  kv.set(KEY, { value: 'stolen-by-another-instance' })
  assert.equal(await lock.heldNow(), false)
  await assert.rejects(() => lock.assertHeld(), (e: Error) => e instanceof LockLostError)
})

// ── Heartbeat ────────────────────────────────────────────────────────────────

test('the heartbeat keeps a lease alive across work longer than the TTL', async () => {
  reset()
  const lock = (await acquireLock(KEY, { ttlMs: 60, renew: true }))!
  let heldThroughout = true
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 25))
    if (live(KEY) === null) heldThroughout = false
  }
  assert.equal(heldThroughout, true, 'a long operation never loses its lease')
  assert.equal(await lock.release(), true)
  assert.equal(live(KEY), null)
})

test('the heartbeat stops on release and cannot extend a successor\'s lock', async () => {
  reset()
  const a = (await acquireLock(KEY, { ttlMs: 60, renew: true }))!
  await a.release()
  kv.set(KEY, { value: 'successor', expiresAt: Date.now() + 80 })
  await new Promise(r => setTimeout(r, 60))
  assert.equal(live(KEY), 'successor', 'untouched by the finished holder')
  await new Promise(r => setTimeout(r, 60))
  assert.equal(live(KEY), null, 'and it expired on its OWN schedule — nobody extended it')
})

// ── withLock ─────────────────────────────────────────────────────────────────

test('withLock: serializes contenders and releases on success and on throw', async () => {
  reset()
  const order: string[] = []
  const busy = await withLock(KEY, async () => {
    order.push('A')
    const inner = await withLock(KEY, async () => 'ran', { ttlMs: 5_000, onBusy: () => 'busy' })
    order.push(inner)
    return 'done'
  }, { ttlMs: 5_000, onBusy: () => 'busy' })
  assert.equal(busy, 'done')
  assert.deepEqual(order, ['A', 'busy'], 'the contender got onBusy, not the critical section')
  assert.equal(live(KEY), null, 'released on success')

  await assert.rejects(() => withLock(KEY, async () => { throw new Error('boom') }, { ttlMs: 5_000, onBusy: () => null }))
  assert.equal(live(KEY), null, 'a failed operation still releases its lock')
})

test('withLock: a store error runs unlocked and releases NOTHING', async () => {
  reset()
  kv.set(KEY, { value: 'someone-elses-lock', expiresAt: Date.now() + 60_000 })
  failOnce = (cmd) => cmd === 'SET'                       // acquisition blows up
  const out = await withLock(KEY, async (lock) => { assert.equal(lock, null); return 'ran-unlocked' },
    { ttlMs: 5_000, onBusy: () => 'busy' })
  assert.equal(out, 'ran-unlocked', 'availability preserved (pre-existing behaviour)')
  assert.equal(live(KEY), 'someone-elses-lock', 'and it never deleted a lock it did not own')
})

test('withLock: onStoreError=busy opts into fail-closed instead', async () => {
  reset()
  failOnce = (cmd) => cmd === 'SET'
  const out = await withLock(KEY, async () => 'ran', { ttlMs: 5_000, onBusy: () => 'busy', onStoreError: 'busy' })
  assert.equal(out, 'busy')
})

test('unrelated keys never block one another', async () => {
  reset()
  const a = (await acquireLock('test:lock:one', { ttlMs: 5_000 }))!
  const b = (await acquireLock('test:lock:two', { ttlMs: 5_000 }))!
  assert.ok(a && b, 'different keys acquire concurrently')
  assert.equal(await a.release(), true)
  assert.equal(await b.release(), true)
})

// ── The real booking write lease ─────────────────────────────────────────────

test('booking lease: concurrent writers serialize; the loser gets onBusy', async () => {
  reset()
  const token = 'b'.repeat(32)
  const seen: string[] = []
  const [x, y] = await Promise.all([
    withBookingWriteLock(token, async () => { seen.push('enter'); await new Promise(r => setTimeout(r, 60)); seen.push('exit'); return 'wrote' },
      { onBusy: () => 'busy', ttlMs: 5_000 }),
    (async () => { await new Promise(r => setTimeout(r, 10)); return withBookingWriteLock(token, async () => 'wrote-2', { onBusy: () => 'busy', ttlMs: 5_000 }) })(),
  ])
  assert.equal(x, 'wrote')
  assert.equal(y, 'busy', 'the second writer never entered the critical section')
  assert.deepEqual(seen, ['enter', 'exit'])
  assert.equal(live(`bk:wlock:${token}`), null, 'lease released')
})

test('booking lease: an expired holder cannot delete the successor\'s lease', async () => {
  reset()
  const token = 'c'.repeat(32)
  const key = `bk:wlock:${token}`
  // A's lease is short and NOT renewed here (renewal is proven above); it lapses mid-flight.
  const a = withBookingWriteLock(token, async () => { await new Promise(r => setTimeout(r, 150)); return 'A' },
    { onBusy: () => 'busy', ttlMs: 40 })
  await new Promise(r => setTimeout(r, 80))
  kv.set(key, { value: 'successor-token', expiresAt: Date.now() + 60_000 })   // B takes over
  assert.equal(await a, 'A')
  assert.equal(live(key), 'successor-token', 'B\'s lease survived A\'s exit — the audit defect is fixed')
})

test('booking lease: lockHeld skips re-acquiring (no self-deadlock) and touches no lock', async () => {
  reset()
  const token = 'd'.repeat(32)
  const out = await withBookingWriteLock(token, async () => 'inner', { onBusy: () => 'busy', lockHeld: true })
  assert.equal(out, 'inner')
  assert.equal(live(`bk:wlock:${token}`), null, 'no lease was taken')
})

test('booking lease: a throwing operation still releases the lease', async () => {
  reset()
  const token = 'e'.repeat(32)
  await assert.rejects(async () => {
    await withBookingWriteLock(token, async () => { throw new Error('write failed') }, { onBusy: () => null, ttlMs: 5_000 })
  })
  assert.equal(live(`bk:wlock:${token}`), null)
  // …and the booking is immediately writable again.
  assert.equal(await withBookingWriteLock(token, async () => 'ok', { onBusy: () => 'busy', ttlMs: 5_000 }), 'ok')
})

test('booking lease: different bookings never block each other', async () => {
  reset()
  const [a, b] = await Promise.all([
    withBookingWriteLock('a'.repeat(32), async () => { await new Promise(r => setTimeout(r, 40)); return 'A' }, { onBusy: () => 'busy', ttlMs: 5_000 }),
    withBookingWriteLock('f'.repeat(32), async () => { await new Promise(r => setTimeout(r, 40)); return 'B' }, { onBusy: () => 'busy', ttlMs: 5_000 }),
  ])
  assert.deepEqual([a, b], ['A', 'B'])
})

test('booking lease: the handle exposes ownership verification to the operation', async () => {
  reset()
  const token = 'g'.repeat(32)
  const out = await withBookingWriteLock(token, async (lock) => {
    assert.ok(lock, 'the operation receives its lock handle')
    await lock!.assertHeld()
    kv.set(`bk:wlock:${token}`, { value: 'stolen' })
    assert.equal(await lock!.heldNow(), false, 'a lost lease is detectable before a write')
    return 'checked'
  }, { onBusy: () => 'busy', ttlMs: 5_000 })
  assert.equal(out, 'checked')
})
