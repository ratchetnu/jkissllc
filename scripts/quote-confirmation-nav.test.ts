import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Source-level regression guard for the /quote submitted-confirmation controls.
// The wizard is a large client component with no jsdom harness in this repo (tests
// run via `tsx --test`), so — like scripts/wizard-a11y.test.ts — we assert the
// controls are wired the *reliable* way that fixes the "buttons do nothing" bug:
// reachable (own stacking context), reliably navigable, explicit button semantics,
// and a reset that fully clears the completed request.
const SRC = readFileSync(fileURLToPath(new URL('../app/quote/page.tsx', import.meta.url)), 'utf8')

// Isolate the SuccessView component body so assertions target the confirmation screen.
const successStart = SRC.indexOf('function SuccessView(')
assert.ok(successStart > -1, 'SuccessView component exists')
const successBody = SRC.slice(successStart, SRC.indexOf('\nfunction ', successStart + 1))

test('the confirmation button row AND the card establish a stacking context (clicks always land)', () => {
  // ROOT-CAUSE FIX: both controls were dead because clicks were not reaching them.
  // The button row carries position:relative + a positive zIndex...
  assert.match(successBody, /flex justify-center[^>]*style=\{\{\s*position:\s*'relative',\s*zIndex:\s*\d+\s*\}\}/)
  // ...and so does the card wrapper, so nothing behind/around it can intercept.
  assert.match(successBody, /wiz-reveal"\s+style=\{\{\s*position:\s*'relative',\s*zIndex:\s*\d+\s*\}\}/)
})

test('Back to Home navigates to "/" via Link with pointer-events explicitly enabled', () => {
  assert.match(successBody, /<Link href="\/"[^>]*>Back to Home<\/Link>/, 'Link to "/" (native anchor + client nav)')
  assert.match(successBody, /<Link href="\/"[^>]*pointerEvents:\s*'auto'[^>]*>Back to Home<\/Link>/, 'pointer-events forced on')
})

test('Request Another Quote is an explicit type=button wired to onReset (pointer-events on)', () => {
  assert.match(successBody, /<button\s+type="button"\s+onClick=\{onReset\}[^>]*pointerEvents:\s*'auto'[^>]*>Request Another Quote<\/button>/)
})

test('onReset fully clears the completed request and returns to step 1 at /quote', () => {
  // find the onReset handler passed to SuccessView
  const onResetStart = SRC.indexOf('onReset={() =>')
  assert.ok(onResetStart > -1, 'onReset handler exists')
  const onReset = SRC.slice(onResetStart, SRC.indexOf('}} />', onResetStart))
  // request/success/quote state cleared
  for (const call of ['setSent(null)', 'setFinalState(null)', 'setEstimate(null)', 'setEst(null)']) {
    assert.ok(onReset.includes(call), `onReset clears ${call}`)
  }
  // photos cleared (uploadedUrls is derived from photos)
  assert.ok(onReset.includes('setPhotos([])'), 'onReset clears photos (and thus uploaded URLs)')
  // customer inputs + reserve sub-flow cleared (the fix)
  for (const call of ['setName(\'\')', 'setEmail(\'\')', 'setContactMethod(\'Text message\')', 'setErr(\'\')',
    'setReserveOpen(false)', 'setAvail(null)', 'setBookProof(\'\')']) {
    assert.ok(onReset.includes(call), `onReset clears ${call}`)
  }
  // back to step one + URL normalized to /quote
  assert.ok(onReset.includes('setStep(0)'), 'onReset returns to step 1')
  assert.match(onReset, /replaceState\(null,\s*''\s*,\s*'\/quote'\)/, 'onReset sets the URL to /quote')
})
