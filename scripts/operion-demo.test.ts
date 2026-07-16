// Contract tests for the /operion demo-request pipeline. Pure functions — no
// Redis, no Resend. These lock the validation semantics the API route
// (app/api/operion/demo/route.ts) relies on, plus the FAQ data invariant that
// keeps the on-page accordion and the FAQPage JSON-LD in sync.
import assert from 'node:assert/strict'
import test from 'node:test'

import { isValidEmail, str, strList } from '../app/lib/validators'
import { OPERION_FAQ } from '../app/lib/operion-faq'

// ── Required-field gate (business name + contact name + valid email) ──────────
test('demo request requires a business name and a contact name', () => {
  // The route treats empty/whitespace as missing via str().
  assert.equal(str('   '), undefined, 'whitespace-only is not a value')
  assert.equal(str('Acme Hauling', 200), 'Acme Hauling')
  assert.equal(str(123 as unknown), undefined, 'non-strings are rejected')
})

test('demo request requires a valid email', () => {
  assert.equal(isValidEmail('you@company.com'), true)
  assert.equal(isValidEmail('not-an-email'), false)
  assert.equal(isValidEmail(''), false)
  assert.equal(isValidEmail(undefined), false)
})

// ── Field caps mirror the route's str()/strList() limits ──────────────────────
test('long free-text fields are capped, not rejected', () => {
  const long = 'x'.repeat(5000)
  assert.equal(str(long, 2000)!.length, 2000, 'challenge/message cap at 2000')
  assert.equal(str(long, 400)!.length, 400, 'currentTools caps at 400')
})

test('interests normalize to a clean, bounded string array', () => {
  assert.deepEqual(strList(['Routes & dispatch', '', '  Pay  ']), ['Routes & dispatch', 'Pay'])
  assert.equal(strList('a,b,c').length, 3, 'comma strings split')
  assert.equal(strList(Array.from({ length: 50 }, (_, i) => `m${i}`)).length <= 60, true)
  assert.deepEqual(strList(undefined), [], 'missing interests → empty array, never throws')
})

// ── FAQ data invariant — feeds both the accordion and the JSON-LD ─────────────
test('OPERION_FAQ is a non-empty array of {q,a} strings', () => {
  assert.ok(Array.isArray(OPERION_FAQ) && OPERION_FAQ.length >= 5, 'has real content to render + serialize')
  for (const f of OPERION_FAQ) {
    assert.equal(typeof f.q, 'string')
    assert.equal(typeof f.a, 'string')
    assert.ok(f.q.length > 0 && f.a.length > 0, 'no blank Q/A leaks into FAQPage schema')
  }
})

test('OPERION_FAQ answers do not overclaim: AI never sets prices', () => {
  const ai = OPERION_FAQ.find(f => /ai/i.test(f.q))!
  assert.match(ai.a, /never sets your final prices|advisory/i, 'AI framing stays advisory / owner-controlled')
})
