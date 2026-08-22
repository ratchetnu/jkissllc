import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ── The wizard must never pass the customer's own guess off as a photo estimate ──
//
// Two numbers live on this screen: the size-based range derived from the load size
// the CUSTOMER picked ("Half load"), and the estimate derived from their PHOTOS.
// The sidebar already suppressed the first one for `decision === 'manual_review'`,
// with a comment saying it "reads as a firm high quote" beside review copy. But a
// FAILED analysis leaves `estimate` null, so that guard never fired and customers
// saw "$630–$740" next to "We'll review your photos" — the exact pairing the rule
// exists to prevent.
//
// /quote is a large client component with no jsdom harness in this repo, so these
// are source-level guards in the style of scripts/quote-confirmation-nav.test.ts.
const SRC = readFileSync(fileURLToPath(new URL('../app/quote/page.tsx', import.meta.url)), 'utf8')

test('a settled photo set with no estimate suppresses the size-based range', () => {
  assert.match(
    SRC,
    /const\s+awaitingPhotoRead\s*=[^\n]*uploadedUrls\.length\s*>\s*0[^\n]*!anyUploading[^\n]*!estimate/,
    'awaitingPhotoRead is true once photos have settled but no estimate exists',
  )
})

test('the suppression flag actually feeds the range gate', () => {
  // Computing awaitingPhotoRead but not USING it would leave the bug intact while a
  // naive test passed, so assert the wiring, not just the declaration.
  assert.match(
    SRC,
    /const\s+photoManualReview\s*=\s*estimate\?\.decision\s*===\s*'manual_review'\s*\|\|\s*awaitingPhotoRead/,
    'photoManualReview covers BOTH an explicit manual_review decision and a missing estimate',
  )
  for (const v of ['showLow', 'showHigh']) {
    const re = new RegExp(`const\\s+${v}\\s*=\\s*!photoManualReview\\s*&&`)
    assert.match(SRC, re, `${v} is gated on !photoManualReview`)
  }
})

test('the range is withheld while a job-based service is awaiting its read', () => {
  // Guards the service-family condition: a non-job service has no photo read to wait
  // on and must keep its ordinary range.
  assert.match(SRC, /const\s+awaitingPhotoRead\s*=\s*!!svc\?\.jobBased\s*&&/, 'scoped to job-based services')
})

test('the unavailable panel promises a forthcoming quote and claims no number', () => {
  const start = SRC.indexOf('function ConfirmUnavailable(')
  assert.ok(start > -1, 'ConfirmUnavailable exists')
  const body = SRC.slice(start, SRC.indexOf('\nfunction ', start + 1))

  // It must say the real number is still COMING...
  assert.match(body, /firm number/i, 'tells the customer a firm number is coming')
  // ...and must not imply the read succeeded or that a price already stands.
  assert.doesNotMatch(body, /your (quote|estimate) is\b/i, 'never asserts a completed quote')
  assert.doesNotMatch(body, /\$\d/, 'the panel itself quotes no figure')
})
