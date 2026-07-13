// Optimistic per-booking concurrency: prove that two writers touching the same
// booking at nearly the same time never silently lose an update, that stale
// versions are rejected + retried, and that audit events are not duplicated on
// retry. Pure/hermetic — a simulated versioned store, injectable no-op sleep.
import assert from 'node:assert/strict'
import test from 'node:test'

import { optimisticUpdate, type CasResult } from '../app/lib/booking-concurrency'

type Rec = { version: number; events: string[]; status: string; amountPaid: number; photos: number }

// A simulated CAS store. `onBeforeSave` lets a test inject a concurrent write
// between a writer's load and its save (the exact race we're defending against).
function makeStore(init: Partial<Rec> = {}) {
  const rec: Rec = { version: 0, events: [], status: 'new', amountPaid: 0, photos: 0, ...init }
  let onBeforeSave: (() => void) | null = null
  const deps = {
    load: async (): Promise<Rec | null> => JSON.parse(JSON.stringify(rec)) as Rec,
    versionOf: (v: Rec) => v.version,
    save: async (v: Rec, expected: number): Promise<CasResult> => {
      if (onBeforeSave) { const f = onBeforeSave; onBeforeSave = null; f() } // inject concurrent write
      if (rec.version !== expected) return 'conflict'
      Object.assign(rec, v, { version: rec.version + 1 })
      return 'ok'
    },
    sleep: async () => {},
  }
  return { rec, deps, injectBefore: (f: () => void) => { onBeforeSave = f }, applyDirect: (f: (r: Rec) => void) => { f(rec); rec.version++ } }
}

test('two simultaneous updates both persist (no lost update) and converge', async () => {
  const s = makeStore()
  // Writer B lands a status change in the window between writer A's load and save.
  s.injectBefore(() => s.applyDirect(r => { r.status = 'confirmed'; r.events.push('B:status') }))
  // Writer A adds a payment; its first save conflicts, it retries on fresh data.
  const out = await optimisticUpdate(s.deps, r => { r.amountPaid += 5000; r.events.push('A:payment') })
  assert.equal(out.ok, true)
  assert.ok(out.ok && out.attempts === 2, 'A retried once after the conflict')
  // BOTH updates survived.
  assert.equal(s.rec.status, 'confirmed')       // B not clobbered
  assert.equal(s.rec.amountPaid, 5000)          // A preserved
  // A's event appears exactly once (mutate re-ran on fresh load, no duplicate).
  assert.equal(s.rec.events.filter(e => e === 'A:payment').length, 1)
  assert.equal(s.rec.events.filter(e => e === 'B:status').length, 1)
})

test('admin update racing an AI-worker update — neither is silently lost', async () => {
  const s = makeStore()
  s.injectBefore(() => s.applyDirect(r => { r.events.push('worker:ai_analyzed') }))
  const out = await optimisticUpdate(s.deps, r => { r.events.push('admin:note') })
  assert.equal(out.ok, true)
  assert.deepEqual(s.rec.events.sort(), ['admin:note', 'worker:ai_analyzed'])
})

test('payment update racing a status update — both applied to distinct fields', async () => {
  const s = makeStore()
  s.injectBefore(() => s.applyDirect(r => { r.status = 'paid' }))
  const out = await optimisticUpdate(s.deps, r => { r.amountPaid = 20000 })
  assert.equal(out.ok, true)
  assert.equal(s.rec.status, 'paid')
  assert.equal(s.rec.amountPaid, 20000)
})

test('customer confirmation racing a request-more-info photo append — both survive', async () => {
  const s = makeStore()
  s.injectBefore(() => s.applyDirect(r => { r.photos += 2 }))          // info-response photos
  const out = await optimisticUpdate(s.deps, r => { r.events.push('confirmation') }) // confirmation
  assert.equal(out.ok, true)
  assert.equal(s.rec.photos, 2)
  assert.ok(s.rec.events.includes('confirmation'))
})

test('stale version is rejected and the write retries until it wins', async () => {
  const s = makeStore()
  let injected = 0
  // Inject TWO concurrent writes on the first two attempts → two conflicts, then win.
  const inject = () => { if (injected < 2) { injected++; s.applyDirect(r => r.events.push(`other:${injected}`)); s.injectBefore(inject) } }
  s.injectBefore(inject)
  const out = await optimisticUpdate(s.deps, r => { r.events.push('mine') }, { maxAttempts: 5 })
  assert.equal(out.ok, true)
  assert.equal(out.ok && out.attempts, 3)
  assert.equal(s.rec.events.filter(e => e === 'mine').length, 1)   // exactly once despite 2 retries
})

test('unresolved contention returns a controlled conflict (never a silent clobber)', async () => {
  const s = makeStore()
  const inject = () => { s.applyDirect(r => r.version) ; s.injectBefore(inject) }  // always a concurrent write
  s.injectBefore(inject)
  const out = await optimisticUpdate(s.deps, r => { r.events.push('mine') }, { maxAttempts: 3 })
  assert.equal(out.ok, false)
  assert.equal(!out.ok && out.reason, 'conflict')
  assert.equal(!out.ok && out.attempts, 3)
  assert.ok(!s.rec.events.includes('mine'))   // never landed — no clobber
})

test('not_found and controlled abort are distinct non-retry outcomes', async () => {
  const missing = { load: async () => null, versionOf: (_: unknown) => 0, save: async (): Promise<CasResult> => 'ok', sleep: async () => {} }
  const nf = await optimisticUpdate(missing, () => {})
  assert.equal(!nf.ok && nf.reason, 'not_found')

  const s = makeStore()
  const ab = await optimisticUpdate(s.deps, () => ({ abort: 'past quoting' }))
  assert.equal(!ab.ok && ab.reason, 'aborted')
  assert.equal(!ab.ok && ab.error, 'past quoting')
  assert.equal(s.rec.events.length, 0)   // nothing persisted on abort
})

test('two cron workers on the same booking: one wins, the other no-ops via version', async () => {
  const s = makeStore({ status: 'queued' })
  // Worker 1 completes first (direct), worker 2 loaded the queued copy and now saves.
  s.injectBefore(() => s.applyDirect(r => { r.status = 'completed'; r.events.push('w1:done') }))
  // Worker 2's mutate is idempotent: only act if still queued.
  const out = await optimisticUpdate(s.deps, r => {
    if (r.status !== 'queued') return { abort: 'already completed' }
    r.status = 'completed'; r.events.push('w2:done')
  })
  // On retry, worker 2 reloads → sees 'completed' → aborts. No double-completion.
  assert.equal(!out.ok && out.reason, 'aborted')
  assert.equal(s.rec.events.filter(e => e.endsWith(':done')).length, 1)
})
