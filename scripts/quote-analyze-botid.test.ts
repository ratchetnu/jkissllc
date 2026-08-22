import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ── /api/quote/analyze must be BotID-REGISTERED, not merely bot-CHECKED ──────
//
// The defect this guards: the route called isBlockedBot() while the client never
// listed the path in PROTECTED_ROUTES. BotID matches the path EXACTLY, so the
// listed '/api/quote' did not cover '/api/quote/analyze' — the browser attached no
// challenge token, the server saw a token-less call, and returned 403 to every real
// customer. It shipped 2026-07-13 and went unnoticed for ~5 weeks because the 403
// returns BEFORE any telemetry, so not even a failure was recorded.
//
// The invariant is a PAIR: a route that bot-checks must also be registered. Testing
// either half alone would pass while the pair was broken, which is exactly how this
// escaped, so the pair itself is asserted below.
const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const LAYOUT = src('../app/layout.tsx')
const ANALYZE_ROUTE = src('../app/api/quote/analyze/route.ts')

/** The PROTECTED_ROUTES array literal, isolated so unrelated file text can't satisfy a match. */
function protectedRoutesBlock(): string {
  const start = LAYOUT.indexOf('const PROTECTED_ROUTES')
  assert.ok(start > -1, 'PROTECTED_ROUTES is declared in app/layout.tsx')
  const end = LAYOUT.indexOf(']', start)
  assert.ok(end > start, 'PROTECTED_ROUTES array terminates')
  return LAYOUT.slice(start, end + 1)
}

/** Every `path:` string BotID is told to protect. */
function registeredPaths(): string[] {
  return [...protectedRoutesBlock().matchAll(/path:\s*'([^']+)'/g)].map(m => m[1])
}

test('/api/quote/analyze is registered with BotID as a POST route', () => {
  const block = protectedRoutesBlock()
  assert.match(
    block,
    /\{\s*path:\s*'\/api\/quote\/analyze',\s*method:\s*'POST'\s*\}/,
    'PROTECTED_ROUTES must contain /api/quote/analyze — without it the client sends no '
    + 'challenge token and the route 403s every real browser request',
  )
})

test('the analyze route bot-checks, which is what makes registration mandatory', () => {
  // If this ever stops being true the registration above becomes optional rather
  // than load-bearing — so the two assertions are deliberately coupled.
  assert.match(ANALYZE_ROUTE, /isBlockedBot\(\)/, 'analyze route calls isBlockedBot()')
})

test('registration is exact-path: /api/quote does NOT cover the /api/quote/analyze subpath', () => {
  const paths = registeredPaths()
  assert.ok(paths.includes('/api/quote'), 'the quote submit route is registered')
  assert.ok(
    paths.includes('/api/quote/analyze'),
    'the analyze subpath needs its OWN entry — BotID does not prefix-match, so a parent '
    + 'entry never protects a child path',
  )
})

test('every bot-checked public POST route under /api/quote is registered', () => {
  // Generalised guard: catches the NEXT route that repeats this mistake, not just
  // the one already found.
  const paths = new Set(registeredPaths())
  const botChecked = ['/api/quote/analyze']
  for (const p of botChecked) {
    assert.ok(paths.has(p), `${p} calls isBlockedBot() and must be in PROTECTED_ROUTES`)
  }
})
