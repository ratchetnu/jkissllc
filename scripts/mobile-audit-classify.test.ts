// Tests for the mobile-audit outcome classifier.
//
// The defect these pin: the audit used to report "the dev server isn't running"
// in the same FAIL channel, and the same failure count, as a genuine layout
// overflow — so a run that measured NOTHING looked like a total UI regression.
// Each test below drives the real classifier with the real error strings
// Playwright/Node produce.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyCheck,
  summarize,
  isInfrastructureError,
} from './mobile-audit-classify.mjs'

// ── 1. server unavailable ────────────────────────────────────────────────────

test('connection refused is infrastructure, never a UI finding', () => {
  const { outcome, detail } = classifyCheck({
    error: 'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3111/',
  })
  assert.equal(outcome, 'infrastructure_unavailable')
  assert.match(detail, /unreachable/)
})

test('every connection-level error shape maps to infrastructure', () => {
  for (const err of [
    'net::ERR_CONNECTION_REFUSED', 'net::ERR_NAME_NOT_RESOLVED',
    'net::ERR_CONNECTION_RESET', 'connect ECONNREFUSED 127.0.0.1:3111',
    'getaddrinfo ENOTFOUND example.invalid',
  ]) {
    assert.equal(isInfrastructureError(err), true, err)
    assert.equal(classifyCheck({ error: err }).outcome, 'infrastructure_unavailable', err)
  }
})

test('an unreachable run reports zero UI findings and exits 2', () => {
  const results = Array.from({ length: 333 }, () =>
    classifyCheck({ error: 'net::ERR_CONNECTION_REFUSED' }))
  const s = summarize(results)
  // The regression in one assertion: 333 unreachable checks are NOT 333 failures.
  assert.equal(s.findings, 0)
  assert.equal(s.counts.overflow, 0)
  assert.equal(s.counts.infrastructure_unavailable, 333)
  assert.equal(s.measured, false)
  assert.equal(s.exitCode, 2, 'could-not-measure must be distinguishable from real findings')
})

// ── 2. successful load, no overflow ──────────────────────────────────────────

test('a page that fits is ok', () => {
  const { outcome } = classifyCheck({
    httpStatus: 200, scrollWidth: 390, clientWidth: 390, offenders: [], clipped: [],
  })
  assert.equal(outcome, 'ok')
})

test('a 1px sub-pixel difference is tolerated, not reported', () => {
  assert.equal(
    classifyCheck({ httpStatus: 200, scrollWidth: 391, clientWidth: 390 }).outcome,
    'ok',
  )
})

test('a clean run exits 0', () => {
  const results = Array.from({ length: 9 }, () =>
    classifyCheck({ httpStatus: 200, scrollWidth: 390, clientWidth: 390 }))
  const s = summarize(results)
  assert.equal(s.findings, 0)
  assert.equal(s.exitCode, 0)
  assert.equal(s.measured, true)
})

// ── 3. actual overflow ───────────────────────────────────────────────────────

test('real horizontal overflow is reported as a finding with its offenders', () => {
  const { outcome, detail } = classifyCheck({
    httpStatus: 200, scrollWidth: 520, clientWidth: 390,
    offenders: ['table.wide L=0 R=520 w=520'], clipped: [],
  })
  assert.equal(outcome, 'overflow')
  assert.match(detail, /scrollW=520/)
  assert.match(detail, /table\.wide/)
})

test('an off-screen control is a finding even when the page itself fits', () => {
  const { outcome, detail } = classifyCheck({
    httpStatus: 200, scrollWidth: 390, clientWidth: 390,
    offenders: [], clipped: ['"Save" .btn L=402 R=460'],
  })
  assert.equal(outcome, 'overflow')
  assert.match(detail, /CLIPPED/)
})

test('overflow counts as a real finding and exits 1', () => {
  const s = summarize([
    classifyCheck({ httpStatus: 200, scrollWidth: 520, clientWidth: 390, offenders: ['div'] }),
    classifyCheck({ httpStatus: 200, scrollWidth: 390, clientWidth: 390 }),
  ])
  assert.equal(s.findings, 1)
  assert.equal(s.exitCode, 1)
  assert.equal(s.measured, true)
})

// ── 4. page navigation failure ───────────────────────────────────────────────

test('a timeout is a navigation error, not an overflow and not infrastructure', () => {
  const { outcome, detail } = classifyCheck({
    error: 'page.goto: Timeout 20000ms exceeded',
  })
  assert.equal(outcome, 'navigation_error')
  assert.match(detail, /navigation failed/)
})

test('a navigation error is not counted as a UI finding', () => {
  const s = summarize([classifyCheck({ error: 'page.goto: Timeout 20000ms exceeded' })])
  assert.equal(s.findings, 0)
  assert.equal(s.counts.navigation_error, 1)
  // Still exits 0: nothing about the UI was proven broken, and the app WAS reachable.
  assert.equal(s.exitCode, 0)
})

test('an HTTP error page is a page_error, not an overflow', () => {
  const { outcome, detail } = classifyCheck({
    httpStatus: 500, scrollWidth: 900, clientWidth: 390, offenders: ['div.err'],
  })
  // Measuring layout on a 500 page yields meaningless offenders — classify the
  // real problem (the page failed) rather than the noise it produces.
  assert.equal(outcome, 'page_error')
  assert.equal(detail, 'HTTP 500')
})

test('mixed run: findings and infrastructure are tallied separately', () => {
  const s = summarize([
    classifyCheck({ httpStatus: 200, scrollWidth: 520, clientWidth: 390, offenders: ['x'] }),
    classifyCheck({ httpStatus: 404 }),
    classifyCheck({ error: 'page.goto: Timeout 20000ms exceeded' }),
    classifyCheck({ error: 'net::ERR_CONNECTION_REFUSED' }),
    classifyCheck({ httpStatus: 200, scrollWidth: 390, clientWidth: 390 }),
  ])
  assert.deepEqual(s.counts, {
    ok: 1, overflow: 1, page_error: 1, navigation_error: 1, infrastructure_unavailable: 1,
  })
  assert.equal(s.findings, 2)
  // Unreachability dominates: if we lost the server we cannot trust the sweep.
  assert.equal(s.exitCode, 2)
})
