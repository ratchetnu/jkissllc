// Speculative pre-analysis controller — unit tests for the PURE controller logic.
// Fake timers, fake runner, no React, no network. These tests exist because
// speculation is only safe if a result can never be attributed to the wrong inputs:
// every hazard the controller claims to handle is reproduced here.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createPreAnalysisController, preAnalysisKey,
  type PreAnalysisRequest,
} from '../app/lib/ai/pre-analysis'

// ── A deterministic timer queue ──────────────────────────────────────────────
function fakeTimers() {
  let seq = 0
  const queue = new Map<number, () => void>()
  return {
    setTimer: (fn: () => void) => { const id = ++seq; queue.set(id, fn); return id },
    clearTimer: (h: unknown) => { queue.delete(h as number) },
    /** Fire every pending timer (in insertion order). */
    flush() {
      const entries = [...queue.entries()]
      queue.clear()
      for (const [, fn] of entries) fn()
    },
    pending: () => queue.size,
  }
}

// A runner whose promises are resolved BY THE TEST, so completion order is exact.
function controlledRunner() {
  const calls: Array<{
    key: string; req: PreAnalysisRequest; signal: AbortSignal; speculative: boolean
    resolve: (v: string) => void; reject: (e: unknown) => void
  }> = []
  const run = (req: PreAnalysisRequest, ctx: { key: string; signal: AbortSignal; speculative: boolean }) =>
    new Promise<string>((resolve, reject) => {
      calls.push({ key: ctx.key, req, signal: ctx.signal, speculative: ctx.speculative, resolve, reject })
    })
  return { run, calls }
}

const req = (photoUrls: string[], service = 'junk-removal', debris?: string): PreAnalysisRequest =>
  ({ photoUrls, service, debris })

// ── Identity ─────────────────────────────────────────────────────────────────

test('key is order-insensitive on photos but exact on service and debris', () => {
  assert.equal(preAnalysisKey(req(['a', 'b'])), preAnalysisKey(req(['b', 'a'])))
  assert.notEqual(preAnalysisKey(req(['a'])), preAnalysisKey(req(['a', 'b'])))
  assert.notEqual(preAnalysisKey(req(['a'], 'junk-removal')), preAnalysisKey(req(['a'], 'estate-cleanout')))
  assert.notEqual(preAnalysisKey(req(['a'], 'junk-removal')), preAnalysisKey(req(['a'], 'junk-removal', 'concrete')))
})

// ── Hazard 1: unsettled uploads ──────────────────────────────────────────────

test('never analyzes while an upload is still in flight', () => {
  const t = fakeTimers(); const r = controlledRunner()
  const c = createPreAnalysisController({ run: r.run, setTimer: t.setTimer, clearTimer: t.clearTimer })

  c.schedule(req(['a']), { settled: false })
  t.flush()
  assert.equal(r.calls.length, 0, 'an incomplete photo set must never be priced')

  c.schedule(req(['a', 'b']), { settled: true })
  t.flush()
  assert.equal(r.calls.length, 1)
  assert.deepEqual(r.calls[0].req.photoUrls, ['a', 'b'])
})

test('an empty photo set never starts a run', () => {
  const t = fakeTimers(); const r = controlledRunner()
  const c = createPreAnalysisController({ run: r.run, setTimer: t.setTimer, clearTimer: t.clearTimer })
  c.schedule(req([]), { settled: true })
  t.flush()
  assert.equal(r.calls.length, 0)
})

// ── Hazard 2: rapid additions ────────────────────────────────────────────────

test('a burst of rapid additions collapses into a single run for the final set', () => {
  const t = fakeTimers(); const r = controlledRunner()
  const c = createPreAnalysisController({ run: r.run, setTimer: t.setTimer, clearTimer: t.clearTimer })

  c.schedule(req(['a']), { settled: true })
  c.schedule(req(['a', 'b']), { settled: true })
  c.schedule(req(['a', 'b', 'c']), { settled: true })
  c.schedule(req(['a', 'b', 'c', 'd']), { settled: true })
  assert.equal(r.calls.length, 0, 'nothing dispatches during the debounce window')

  t.flush()
  assert.equal(r.calls.length, 1, 'four additions, one analysis')
  assert.deepEqual(r.calls[0].req.photoUrls, ['a', 'b', 'c', 'd'])
  assert.equal(c.stats().coalesced, 3)
})

test('repeated schedules for identical inputs do not restart the debounce', () => {
  const t = fakeTimers(); const r = controlledRunner()
  const c = createPreAnalysisController({ run: r.run, setTimer: t.setTimer, clearTimer: t.clearTimer })
  c.schedule(req(['a']), { settled: true })
  c.schedule(req(['a']), { settled: true })
  c.schedule(req(['a']), { settled: true })
  assert.equal(t.pending(), 1)
  assert.equal(c.stats().coalesced, 0)
  t.flush()
  assert.equal(r.calls.length, 1)
})

// ── Hazard 3: stale results ──────────────────────────────────────────────────

test('a photo removed DURING analysis discards the in-flight result and aborts it', async () => {
  const t = fakeTimers(); const r = controlledRunner()
  const adopted: string[] = []
  const c = createPreAnalysisController({
    run: r.run, setTimer: t.setTimer, clearTimer: t.clearTimer,
    onResult: v => adopted.push(v),
  })

  c.schedule(req(['a', 'b']), { settled: true })
  t.flush()
  assert.equal(r.calls.length, 1)
  const stale = r.calls[0]

  // The customer removes a photo while the model is still working.
  c.schedule(req(['a']), { settled: true })
  assert.equal(stale.signal.aborted, true, 'a superseded run is aborted, not left burning')

  stale.resolve('ESTIMATE-FOR-TWO-PHOTOS')
  await Promise.resolve(); await Promise.resolve()

  assert.deepEqual(adopted, [], 'a result for the old photo set must never be adopted')
  assert.equal(c.stats().discarded, 1)
  assert.equal(c.stats().aborted, 1)
  assert.equal(c.result(preAnalysisKey(req(['a', 'b']))), undefined)
})

test('a late response from a superseded SERVICE is discarded', async () => {
  const t = fakeTimers(); const r = controlledRunner()
  const c = createPreAnalysisController({ run: r.run, setTimer: t.setTimer, clearTimer: t.clearTimer })

  c.schedule(req(['a'], 'junk-removal'), { settled: true })
  t.flush()
  c.schedule(req(['a'], 'estate-cleanout'), { settled: true })
  t.flush()
  assert.equal(r.calls.length, 2)

  // The FIRST (junk-removal) run answers last — classic stale response.
  r.calls[1].resolve('ESTATE')
  r.calls[0].resolve('JUNK')
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

  assert.equal(c.result(preAnalysisKey(req(['a'], 'estate-cleanout'))), 'ESTATE')
  assert.equal(c.result(preAnalysisKey(req(['a'], 'junk-removal'))), undefined)
})

// ── Hazard 4: duplicate runs ─────────────────────────────────────────────────

test('only one run per fingerprint is ever in flight', () => {
  const t = fakeTimers(); const r = controlledRunner()
  const c = createPreAnalysisController({ run: r.run, setTimer: t.setTimer, clearTimer: t.clearTimer })

  c.schedule(req(['a']), { settled: true })
  t.flush()
  assert.equal(r.calls.length, 1)

  // Same set scheduled again while the first run is still in flight.
  c.schedule(req(['a']), { settled: true })
  t.flush()
  assert.equal(r.calls.length, 1, 'a duplicate fingerprint must not double-spend on the provider')
})

test('a completed fingerprint is never re-analyzed', async () => {
  const t = fakeTimers(); const r = controlledRunner()
  const c = createPreAnalysisController({ run: r.run, setTimer: t.setTimer, clearTimer: t.clearTimer })

  c.schedule(req(['a']), { settled: true })
  t.flush()
  r.calls[0].resolve('DONE')
  await Promise.resolve(); await Promise.resolve()

  c.schedule(req(['a']), { settled: true })
  t.flush()
  assert.equal(r.calls.length, 1)
})

// ── Hazard 5: duplicate completions ──────────────────────────────────────────

test('a runner that settles twice applies exactly once', async () => {
  const t = fakeTimers(); const r = controlledRunner()
  const adopted: string[] = []
  const c = createPreAnalysisController({
    run: r.run, setTimer: t.setTimer, clearTimer: t.clearTimer,
    onResult: v => adopted.push(v),
  })

  c.schedule(req(['a']), { settled: true })
  t.flush()
  r.calls[0].resolve('FIRST')
  r.calls[0].resolve('SECOND')      // duplicate completion callback
  r.calls[0].reject(new Error('and a late rejection for good measure'))
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

  assert.deepEqual(adopted, ['FIRST'], 'exactly one adoption')
  assert.equal(c.result(preAnalysisKey(req(['a']))), 'FIRST')
})

// ── Retries ──────────────────────────────────────────────────────────────────

test('a failed run leaves no cached result and the next schedule retries it', async () => {
  const t = fakeTimers(); const r = controlledRunner()
  const c = createPreAnalysisController({ run: r.run, setTimer: t.setTimer, clearTimer: t.clearTimer })

  c.schedule(req(['a']), { settled: true })
  t.flush()
  r.calls[0].reject(new Error('provider blew up'))
  await Promise.resolve(); await Promise.resolve()

  assert.equal(c.result(preAnalysisKey(req(['a']))), undefined)
  assert.equal(c.isRunning(preAnalysisKey(req(['a']))), false)

  c.schedule(req(['a']), { settled: true })
  t.flush()
  assert.equal(r.calls.length, 2, 'a failure is retryable, not sticky')
})

test('a photo retried after an upload error runs once, on the settled set', () => {
  const t = fakeTimers(); const r = controlledRunner()
  const c = createPreAnalysisController({ run: r.run, setTimer: t.setTimer, clearTimer: t.clearTimer })

  c.schedule(req(['a']), { settled: false })          // 'b' failed, user hits retry
  t.flush()
  c.schedule(req(['a']), { settled: false })          // retry uploading
  t.flush()
  assert.equal(r.calls.length, 0)

  c.schedule(req(['a', 'b']), { settled: true })      // retry succeeded, set settles
  t.flush()
  assert.equal(r.calls.length, 1)
  assert.deepEqual(r.calls[0].req.photoUrls, ['a', 'b'])
})

// ── Reuse on Continue — the entire point of speculating ──────────────────────

test('ensure() returns the speculative result with no new run', async () => {
  const t = fakeTimers(); const r = controlledRunner()
  const c = createPreAnalysisController({ run: r.run, setTimer: t.setTimer, clearTimer: t.clearTimer })

  c.schedule(req(['a']), { settled: true })
  t.flush()
  r.calls[0].resolve('SPECULATED')
  await Promise.resolve(); await Promise.resolve()

  const got = await c.ensure(req(['a']))
  assert.equal(got, 'SPECULATED')
  assert.equal(r.calls.length, 1, 'Continue must not re-analyze what we already know')
  assert.equal(c.stats().reused, 1)
})

test('ensure() joins an in-flight speculative run instead of starting a second', async () => {
  const t = fakeTimers(); const r = controlledRunner()
  const c = createPreAnalysisController({ run: r.run, setTimer: t.setTimer, clearTimer: t.clearTimer })

  c.schedule(req(['a']), { settled: true })
  t.flush()
  const pending = c.ensure(req(['a']))       // customer presses Continue mid-run
  assert.equal(r.calls.length, 1)

  r.calls[0].resolve('JOINED')
  assert.equal(await pending, 'JOINED')
  assert.equal(c.stats().reused, 1)
})

test('ensure() starts immediately when nothing was speculated (no debounce wait)', async () => {
  const t = fakeTimers(); const r = controlledRunner()
  const c = createPreAnalysisController({ run: r.run, setTimer: t.setTimer, clearTimer: t.clearTimer })

  const pending = c.ensure(req(['a']))
  assert.equal(r.calls.length, 1, 'the customer is waiting — no debounce')
  assert.equal(t.pending(), 0, 'and no stray timer is left behind')
  r.calls[0].resolve('IMMEDIATE')
  assert.equal(await pending, 'IMMEDIATE')
})

test('ensure() on changed inputs never returns the previous set’s answer', async () => {
  const t = fakeTimers(); const r = controlledRunner()
  const c = createPreAnalysisController({ run: r.run, setTimer: t.setTimer, clearTimer: t.clearTimer })

  c.schedule(req(['a']), { settled: true })
  t.flush()
  r.calls[0].resolve('ONE-PHOTO')
  await Promise.resolve(); await Promise.resolve()

  const pending = c.ensure(req(['a', 'b']))
  assert.equal(r.calls.length, 2, 'different inputs demand a different analysis')
  r.calls[1].resolve('TWO-PHOTOS')
  assert.equal(await pending, 'TWO-PHOTOS')
})

test('ensure() returns null when there is nothing to analyze', async () => {
  const t = fakeTimers(); const r = controlledRunner()
  const c = createPreAnalysisController({ run: r.run, setTimer: t.setTimer, clearTimer: t.clearTimer })
  assert.equal(await c.ensure(req([])), null)
  assert.equal(r.calls.length, 0)
})

// ── Cost attribution: speculative vs customer-demanded ───────────────────────

test('scheduled runs are flagged speculative; ensure() runs are not', async () => {
  const t = fakeTimers(); const r = controlledRunner()
  const c = createPreAnalysisController({ run: r.run, setTimer: t.setTimer, clearTimer: t.clearTimer })

  c.schedule(req(['a']), { settled: true })
  t.flush()
  assert.equal(r.calls[0].speculative, true, 'a head start the customer never asked for')
  r.calls[0].resolve('OK')
  await Promise.resolve(); await Promise.resolve()

  await c.ensure(req(['b']))
  assert.equal(r.calls[1].speculative, false, 'the customer is waiting on this one')
})

// ── Lifecycle ────────────────────────────────────────────────────────────────

test('dispose aborts in-flight work and adopts nothing afterwards', async () => {
  const t = fakeTimers(); const r = controlledRunner()
  const adopted: string[] = []
  const c = createPreAnalysisController({
    run: r.run, setTimer: t.setTimer, clearTimer: t.clearTimer,
    onResult: v => adopted.push(v),
  })

  c.schedule(req(['a']), { settled: true })
  t.flush()
  c.dispose()
  assert.equal(r.calls[0].signal.aborted, true)

  r.calls[0].resolve('AFTER-UNMOUNT')
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(adopted, [], 'no setState after unmount')

  c.schedule(req(['a', 'b']), { settled: true })
  t.flush()
  assert.equal(r.calls.length, 1, 'a disposed controller starts no new work')
})

test('running-state callbacks bracket every run exactly once', async () => {
  const t = fakeTimers(); const r = controlledRunner()
  const events: boolean[] = []
  const c = createPreAnalysisController({
    run: r.run, setTimer: t.setTimer, clearTimer: t.clearTimer,
    onRunningChange: running => events.push(running),
  })

  c.schedule(req(['a']), { settled: true })
  t.flush()
  assert.deepEqual(events, [true])
  r.calls[0].resolve('OK')
  r.calls[0].resolve('DUPLICATE')
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(events, [true, false], 'no dangling spinner, no double-clear')
})
