// ─────────────────────────────────────────────────────────────────────────────
// M1: a dropped connection must never be reported as a dead link.
//
// The page previously guarded its "Link not found · This confirmation link isn't
// valid. It may have been mistyped." card on `notFound || !route`. `notFound` was
// correctly reserved for a 404, but ANY failure left `route` null, so the `!route`
// half produced the identical card for a dropped read. On a surface where the token
// is the only way that contractor can work, that is the worst available outcome.
//
// These run the real loader against an injected fetcher — no source-text assertions
// for the classification rules themselves.
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import {
  loadPublicRoute, applyLoadOutcome, INITIAL_VIEW_STATE,
  CONNECTION_ERROR, SERVICE_ERROR, type PublicRoute, type RouteViewState,
} from '../app/route/[token]/load'

const ROUTE = { token: 'aaaa0000bbbb1111', routeNumber: 'JK-R-9001', status: 'assigned' } as unknown as PublicRoute
const ok = (body: unknown = { route: ROUTE, disclaimer: 'terms' }) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const status = (s: number) => new Response(JSON.stringify({ error: 'x' }), { status: s })
const noSleep = async () => {}

// ── 1. dropped connection followed by success ────────────────────────────────

test('a dropped connection that then succeeds loads the route normally', async () => {
  let calls = 0
  const notices: string[] = []
  const out = await loadPublicRoute('tok', {
    fetcher: async () => { if (++calls === 1) throw new TypeError('network dropped'); return ok() },
    sleep: noSleep,
    onRetry: () => notices.push('retry'),
  })
  assert.equal(calls, 2, 'the read was retried')
  assert.equal(notices.length, 1, 'the crew member was told it was retrying')
  assert.equal(out.kind, 'ok')
  assert.equal(out.kind === 'ok' && out.route.routeNumber, 'JK-R-9001')
})

// ── 2. exhausted network retries ─────────────────────────────────────────────

test('EXHAUSTED retries are a connection error — never not_found', async () => {
  let calls = 0
  const out = await loadPublicRoute('tok', {
    fetcher: async () => { calls++; throw new TypeError('offline') },
    sleep: noSleep,
  })
  assert.equal(calls, 3, 'the bounded retry budget was spent')
  assert.equal(out.kind, 'error', 'a link is NOT declared missing because the network failed')
  assert.equal(out.kind === 'error' && out.message, CONNECTION_ERROR)
})

// ── 3. transient server failure ──────────────────────────────────────────────

test('a transient 5xx that recovers loads normally', async () => {
  let calls = 0
  const out = await loadPublicRoute('tok', {
    fetcher: async () => (++calls === 1 ? status(503) : ok()),
    sleep: noSleep,
  })
  assert.equal(calls, 2)
  assert.equal(out.kind, 'ok')
})

test('every retryable status that never recovers is a SERVICE error, not not_found', async () => {
  for (const s of [408, 425, 429, 500, 502, 503, 504]) {
    const out = await loadPublicRoute('tok', { fetcher: async () => status(s), sleep: noSleep })
    assert.equal(out.kind, 'error', `${s} must not be a missing link`)
    assert.equal(out.kind === 'error' && out.message, SERVICE_ERROR, `${s}`)
  }
})

test('a non-retryable non-404 (403, 400) is also a service error, not not_found', async () => {
  for (const s of [400, 401, 403, 409, 410]) {
    const out = await loadPublicRoute('tok', { fetcher: async () => status(s), sleep: noSleep })
    assert.equal(out.kind, 'error', `${s} must not be a missing link`)
  }
})

test('a 200 with an unreadable or route-less body is a service error', async () => {
  const bad = await loadPublicRoute('tok', {
    fetcher: async () => new Response('<html>not json</html>', { status: 200 }), sleep: noSleep,
  })
  assert.equal(bad.kind, 'error')
  const empty = await loadPublicRoute('tok', { fetcher: async () => ok({ disclaimer: 'x' }), sleep: noSleep })
  assert.equal(empty.kind, 'error', 'a 200 without a route is not a valid load')
})

// ── 4. genuine 404 ───────────────────────────────────────────────────────────

test('ONLY a literal 404 is not_found — and it is not retried', async () => {
  let calls = 0
  const out = await loadPublicRoute('tok', {
    fetcher: async () => { calls++; return status(404) }, sleep: noSleep,
  })
  assert.equal(out.kind, 'not_found')
  assert.equal(calls, 1, '404 is not in the retryable set')
})

test('invalid, malformed, revoked, unknown and foreign-tenant tokens share ONE treatment', async () => {
  // The API answers all five with the same 404 body, so the client cannot — and must
  // not — tell them apart. Each maps to the same not_found outcome.
  for (const _ of ['malformed', 'unknown', 'revoked', 'foreign-tenant', 'expired-binding']) {
    const out = await loadPublicRoute('tok', { fetcher: async () => status(404), sleep: noSleep })
    assert.deepEqual(out, { kind: 'not_found' })
  }
})

// ── 5. loaded-data preservation ──────────────────────────────────────────────

test('an error NEVER clears route details that are already on screen', async () => {
  const loaded: RouteViewState = { route: ROUTE, notFound: false, loadError: '' }
  const after = applyLoadOutcome(loaded, { kind: 'error', message: CONNECTION_ERROR })
  assert.equal(after.route, ROUTE, 'the contractor keeps reading their route')
  assert.equal(after.notFound, false, 'and is never told the link is missing')
  assert.equal(after.loadError, CONNECTION_ERROR, 'the error is additive, not replacing')
})

test('a genuine 404 on RELOAD does clear the route — the token really stopped working', () => {
  const loaded: RouteViewState = { route: ROUTE, notFound: false, loadError: '' }
  const after = applyLoadOutcome(loaded, { kind: 'not_found' })
  assert.equal(after.route, null)
  assert.equal(after.notFound, true)
})

test('a successful reload clears a previous error', () => {
  const errored: RouteViewState = { route: ROUTE, notFound: false, loadError: CONNECTION_ERROR }
  const after = applyLoadOutcome(errored, { kind: 'ok', route: ROUTE, disclaimer: 't' })
  assert.equal(after.loadError, '')
  assert.equal(after.notFound, false)
})

// ── 6/7. initial offline, and reconnect reload ───────────────────────────────

test('INITIAL offline: nothing loaded, no 404 — the state says offline, not missing', async () => {
  // Offline surfaces as a thrown fetch. From INITIAL state that must leave route null
  // and notFound FALSE, which is what lets the page render "You're offline" instead of
  // the missing-link card.
  const out = await loadPublicRoute('tok', {
    fetcher: async () => { throw new TypeError('Failed to fetch') }, sleep: noSleep,
  })
  const after = applyLoadOutcome(INITIAL_VIEW_STATE, out)
  assert.equal(after.notFound, false, 'offline must never set notFound')
  assert.equal(after.route, null)
  assert.equal(after.loadError, CONNECTION_ERROR)
})

test('RECONNECT: the same state then loads cleanly with no residue', async () => {
  const offlineState = applyLoadOutcome(INITIAL_VIEW_STATE, { kind: 'error', message: CONNECTION_ERROR })
  const out = await loadPublicRoute('tok', { fetcher: async () => ok(), sleep: noSleep })
  const after = applyLoadOutcome(offlineState, out)
  assert.equal(after.route?.routeNumber, 'JK-R-9001')
  assert.equal(after.loadError, '', 'the offline error is cleared')
  assert.equal(after.notFound, false)
})

// ── 8. busy-state recovery + the render contract ─────────────────────────────

test('BUSY RECOVERY: every action path clears its busy flag on failure', () => {
  const src = readFileSync(new URL('../app/route/[token]/page.tsx', import.meta.url), 'utf8')
  // Each mutation owns a finally that resets its flag, so a failed or refused action
  // can never leave the controls stranded.
  assert.match(src, /finally \{ setNetworkMsg\(''\); setBusy\(''\) \}/, 'confirm/decline resets busy')
  assert.match(src, /finally \{ setNetworkMsg\(''\); setClocking\(''\) \}/, 'punches reset clocking')
  // And every offline refusal returns BEFORE the flag is set.
  for (const [fn, flag] of [['async function act(', 'setBusy(action)'], ['async function clock(', 'setClocking(action)']] as const) {
    const body = src.slice(src.indexOf(fn), src.indexOf(fn) + 900)
    assert.ok(body.indexOf('if (offline)') < body.indexOf(flag), `${fn} refuses offline before setting ${flag}`)
  }
})

test('RENDER: the missing-link card is gated on notFound ALONE', () => {
  const src = readFileSync(new URL('../app/route/[token]/page.tsx', import.meta.url), 'utf8')
  // The exact defect: `notFound || !route` turned every failure into "Link not found".
  assert.doesNotMatch(src, /if \(notFound \|\| !route\)/, 'the || !route half is what caused M1')
  assert.match(src, /if \(notFound\) return wrap\(/, 'only a real 404 shows the missing-link card')
  // A no-data failure gets its own state, with a touch-sized retry.
  assert.match(src, /if \(!route && offline\) return wrap\(/, 'offline has its own state')
  assert.match(src, /Couldn’t load your route/)
  assert.match(src, /Your link is still valid/, 'the copy explicitly denies that the link is dead')
  assert.match(src, /minHeight: 44[\s\S]{0,400}Try again/, 'touch-sized Try again')
  // And a failure WITH data loaded is non-blocking, with its own Retry.
  assert.match(src, /\{loadError && route && \(/, 'preserved-data error is additive')
  assert.match(src, /still the last known version/)
})
