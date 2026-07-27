import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyCheck,
  isInfrastructureError,
  summarize,
  validateAuditTarget,
} from './mobile-audit-classify.mjs'
import { MOBILE_AUDIT_ROUTES, readinessFor } from './mobile-audit-config.mjs'

const ready = {
  environmentAllowed: true,
  authRequired: true,
  authReady: true,
  httpStatus: 200,
  finalUrlMatches: true,
  hydrated: true,
  blank: false,
  loading: false,
  readinessConfigured: true,
  readinessMet: true,
  scrollWidth: 390,
  clientWidth: 390,
  offenders: [],
  clipped: [],
}

test('authenticated populated admin content passes', () => {
  assert.equal(classifyCheck(ready).outcome, 'PASS')
})

test('blank client shell never passes', () => {
  assert.equal(classifyCheck({ ...ready, blank: true, readinessMet: false }).outcome, 'FAIL')
})

test('login and unauthorized admin states are blocked auth, never pass', () => {
  assert.equal(classifyCheck({ ...ready, loginDetected: true }).outcome, 'BLOCKED_AUTH')
  assert.equal(classifyCheck({ ...ready, authReady: false }).outcome, 'BLOCKED_AUTH')
  assert.equal(classifyCheck({ ...ready, httpStatus: 401 }).outcome, 'BLOCKED_AUTH')
  assert.equal(classifyCheck({ ...ready, httpStatus: 403 }).outcome, 'BLOCKED_AUTH')
})

test('redirect loop and wrong final URL are route errors', () => {
  assert.equal(classifyCheck({ ...ready, redirectLoop: true }).outcome, 'ROUTE_ERROR')
  assert.equal(classifyCheck({ ...ready, finalUrlMatches: false }).outcome, 'ROUTE_ERROR')
})

test('HTTP-200 error boundary and client-render failure are route errors', () => {
  assert.equal(classifyCheck({ ...ready, errorBoundary: true }).outcome, 'ROUTE_ERROR')
  assert.equal(classifyCheck({ ...ready, clientError: 'ReferenceError' }).outcome, 'ROUTE_ERROR')
})

test('permanent loading and unproven hydration are inconclusive', () => {
  assert.equal(classifyCheck({ ...ready, loading: true }).outcome, 'INCONCLUSIVE')
  assert.equal(classifyCheck({ ...ready, hydrated: false }).outcome, 'INCONCLUSIVE')
})

test('missing readiness configuration or content cannot pass', () => {
  assert.equal(classifyCheck({ ...ready, readinessConfigured: false }).outcome, 'INCONCLUSIVE')
  assert.equal(classifyCheck({ ...ready, readinessMet: false }).outcome, 'FAIL')
})

test('internal table scroll can pass while page-level overflow fails', () => {
  assert.equal(classifyCheck(ready).outcome, 'PASS')
  const overflow = classifyCheck({
    ...ready,
    scrollWidth: 520,
    offenders: ['table.wide L=0 R=520 w=520'],
  })
  assert.equal(overflow.outcome, 'FAIL')
  assert.match(overflow.detail, /scrollW=520/)
})

test('hidden configured primary action fails', () => {
  assert.equal(classifyCheck({
    ...ready,
    primaryActionRequired: true,
    primaryActionVisible: false,
  }).outcome, 'FAIL')
})

test('failure evidence path is retained', () => {
  const result = classifyCheck({
    ...ready,
    blank: true,
    evidencePath: '.local-audit/mobile-evidence/blank.png',
  })
  assert.equal(result.outcome, 'FAIL')
  assert.equal(result.evidencePath, '.local-audit/mobile-evidence/blank.png')
})

test('connection failures are blocked environment, not UI findings', () => {
  const error = 'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3111/'
  assert.equal(isInfrastructureError(error), true)
  assert.equal(classifyCheck({ ...ready, error }).outcome, 'BLOCKED_ENV')
})

test('public route can pass without authentication', () => {
  assert.equal(classifyCheck({ ...ready, authRequired: false, authReady: false }).outcome, 'PASS')
})

test('blocked and inconclusive results never enter the pass total', () => {
  const summary = summarize([
    classifyCheck(ready),
    classifyCheck({ ...ready, authReady: false }),
    classifyCheck({ ...ready, loading: true }),
  ])
  assert.equal(summary.passed, 1)
  assert.equal(summary.blocked, 1)
  assert.equal(summary.inconclusive, 1)
  assert.equal(summary.exitCode, 2)
})

test('real findings determine exit 1 even when another route is blocked', () => {
  const summary = summarize([
    classifyCheck({ ...ready, blank: true }),
    classifyCheck({ ...ready, authReady: false }),
  ])
  assert.equal(summary.findings, 1)
  assert.equal(summary.exitCode, 1)
})

test('production targets are rejected before browser execution', () => {
  assert.equal(validateAuditTarget('https://www.jkissllc.com', 'production').ok, false)
  assert.equal(validateAuditTarget('https://jkissllc.vercel.app', 'preview').ok, true)
  assert.equal(validateAuditTarget('http://127.0.0.1:3111').ok, true)
})

test('every configured route has its own readiness contract', () => {
  assert.equal(new Set(MOBILE_AUDIT_ROUTES.map((route) => route.path)).size, MOBILE_AUDIT_ROUTES.length)
  for (const route of MOBILE_AUDIT_ROUTES) {
    assert.equal(readinessFor(route.path), route)
    assert.ok(route.readiness?.selector, route.path)
    assert.ok(route.readiness.minimumText > 0, route.path)
  }
  assert.equal(readinessFor('/not-configured'), null)
})
