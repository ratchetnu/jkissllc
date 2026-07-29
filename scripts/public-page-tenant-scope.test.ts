// ── WAVE 6D-C: server-component public-token scope ───────────────────────────
//
// The P1 from the #124 review. `/booking/[token]/page.tsx` is a React Server
// Component, so it cannot use withPublicTokenRoute, and a customer following an
// emailed link has no session — it read `bk:*` with NO tenant context.
//
// The failure was QUIET: the page already wrapped its read in try/catch, so under
// TENANCY_ENABLED=true it rendered "Booking not found" for every valid link rather
// than erroring. These tests use VALID-format tokens throughout, because the original
// probe used an invalid one, hit the `/^[a-f0-9]{16,}$/` guard, returned null before
// reaching Redis, and produced a false negative.
process.env.ADMIN_SESSION_SECRET ||= 'test-secret-at-least-16-chars-long'

import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const PORT = 8100 + (process.pid % 300)
process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT}`
process.env.KV_REST_API_TOKEN = 'emulator-accepts-anything'

import { bindToken, revokeTokenBinding } from '../app/lib/platform/tenancy/token-binding'
import { resolvePublicToken, withPublicTokenScope } from '../app/lib/platform/tenancy/public-token-scope'
import { currentTenantId, runWithTenant } from '../app/lib/platform/tenancy/context'
import { getCurrentPolicy } from '../app/lib/policy'
import { getBookingByToken } from '../app/lib/bookings'

// Valid booking-token shape: /^[a-f0-9]{16,}$/
const TOK_A = 'aaaa1111bbbb2222'
const TOK_B = 'cccc3333dddd4444'
const TOK_UNBOUND = 'eeee5555ffff6666'
const TOK_MALFORMED = 'not-a-valid-token!!'
const A = 'pagea'
const B = 'pageb'

let kv: ChildProcess | null = null
before(async () => {
  kv = spawn(process.execPath, ['scripts/local-audit/kv-emulator.mjs', '--port', String(PORT)], { stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/__admin/health`)).ok) break } catch { /* not up */ }
    await sleep(50)
  }
  await bindToken(TOK_A, { tenantId: A, resourceType: 'booking', resourceId: TOK_A })
  await bindToken(TOK_B, { tenantId: B, resourceType: 'booking', resourceId: TOK_B })
})
after(() => { kv?.kill('SIGKILL') })

const withTenancy = async <T>(on: boolean, fn: () => Promise<T> | T): Promise<T> => {
  const prev = process.env.TENANCY_ENABLED
  process.env.TENANCY_ENABLED = on ? 'true' : 'false'
  try { return await fn() } finally {
    if (prev === undefined) delete process.env.TENANCY_ENABLED; else process.env.TENANCY_ENABLED = prev
  }
}

const scope = (tok: string | undefined) =>
  withPublicTokenScope(tok, 'booking', async () => currentTenantId() ?? 'NO-TENANT', () => 'REFUSED')

// ── The regression itself ────────────────────────────────────────────────────

test('REGRESSION: the unscoped read that broke every booking link still throws', async () => {
  // This is what the page used to do. With a VALID-format token it reaches Redis and
  // fails closed — the page's try/catch then turned it into "Booking not found".
  await withTenancy(true, async () => {
    await assert.rejects(() => getBookingByToken(TOK_A), /tenant context required/)
  })
})

test('FALSE NEGATIVE GUARD: an invalid-format token short-circuits before Redis', async () => {
  // The original probe used a token like this and saw no throw — concluding wrongly
  // that the page was fine. It returns null at the format guard, never reaching the
  // chokepoint. Any future probe MUST use a valid-format token.
  await withTenancy(true, async () => {
    assert.equal(await getBookingByToken('sometoken'), null, 'no throw, but also no read')
  })
})

test('FIXED: the scoped read runs inside the token’s owning tenant', async () => {
  assert.equal(await withTenancy(true, () => scope(TOK_A)), A)
  assert.equal(await withTenancy(true, () => scope(TOK_B)), B)
})

// ── Substitution + hostile input ─────────────────────────────────────────────

test("tenant A's token never enters tenant B", async () => {
  const got = await withTenancy(true, () => scope(TOK_A))
  assert.equal(got, A)
  assert.notEqual(got, B)
})

test('an unbound token is REFUSED under tenancy (no reference-tenant guess)', async () => {
  assert.equal(await withTenancy(true, () => scope(TOK_UNBOUND)), 'REFUSED')
})

test('a malformed token is refused before any lookup', async () => {
  assert.equal(await withTenancy(true, () => scope(TOK_MALFORMED)), 'REFUSED')
  assert.equal(await withTenancy(true, () => scope(undefined)), 'REFUSED')
  assert.equal(await withTenancy(true, () => scope('')), 'REFUSED')
})

test('a revoked token is refused, indistinguishably from an unknown one', async () => {
  const tok = '1111aaaa2222bbbb'
  await bindToken(tok, { tenantId: A, resourceType: 'booking', resourceId: tok })
  await revokeTokenBinding(tok)
  assert.equal(await withTenancy(true, () => scope(tok)), await withTenancy(true, () => scope(TOK_UNBOUND)))
})

test('a token minted for another surface is refused (wrong resourceType)', async () => {
  const tok = '9999aaaa8888bbbb'
  await bindToken(tok, { tenantId: A, resourceType: 'route-invoice', resourceId: tok })
  assert.equal(await withTenancy(true, () => scope(tok)), 'REFUSED')
})

test('exact resourceId is enforced — a token naming a different resource is refused', async () => {
  const tok = '7777aaaa6666bbbb'
  await bindToken(tok, { tenantId: A, resourceType: 'booking', resourceId: 'some-other-booking' })
  assert.equal(await withTenancy(true, () => scope(tok)), 'REFUSED', 'resourceId mismatch must not be honoured')
})

test('the loader is NEVER invoked for a refused token', async () => {
  let ran = false
  const out = await withTenancy(true, () =>
    withPublicTokenScope(TOK_UNBOUND, 'booking', async () => { ran = true; return 'LOADED' }, () => 'REFUSED'))
  assert.equal(out, 'REFUSED')
  assert.equal(ran, false, 'no tenant-owned read may happen without a tenant')
})

test('headers, query and body cannot influence the resolution', async () => {
  // The signature is the control: resolvePublicToken takes a token and an expected
  // type — there is no parameter a request value could travel through.
  assert.equal(resolvePublicToken.length, 3, 'token, expect, opts — nothing request-shaped')
  const r = await withTenancy(true, () => resolvePublicToken(TOK_A, 'booking'))
  assert.equal(r.kind, 'bound')
  if (r.kind === 'bound') assert.equal(r.binding.tenantId, A)
})

// ── Compatibility ────────────────────────────────────────────────────────────

test('COMPAT: with tenancy OFF an unbound legacy token still resolves (reference tenant)', async () => {
  assert.equal(await withTenancy(false, () => scope(TOK_UNBOUND)), 'jkiss')
})

test('COMPAT: with tenancy OFF a bound token behaves normally', async () => {
  assert.equal(await withTenancy(false, () => scope(TOK_A)), A)
})

test('the scope does not leak, and restores an outer tenant on the way out', async () => {
  await withTenancy(true, () => scope(TOK_A))
  assert.equal(currentTenantId(), undefined)
  const after = await runWithTenant({ tenantId: 'outer' }, async () => {
    await withTenancy(true, () => scope(TOK_A))
    return currentTenantId()
  })
  assert.equal(after, 'outer')
})

// ── Policy must not silently substitute the default ──────────────────────────

test('POLICY: a missing tenant context throws instead of serving DEFAULT_POLICY', async () => {
  // Showing a customer the built-in default agreement text — on a page they are about
  // to accept — because we could not tell whose policy to load is worse than failing.
  await withTenancy(true, async () => {
    await assert.rejects(() => getCurrentPolicy(), /tenant context required/)
  })
})

test('POLICY: a genuinely absent record still falls back to the default', async () => {
  // The distinction that matters: "nothing stored" is a real answer; "no tenant" is not.
  const p = await withTenancy(true, () => runWithTenant({ tenantId: A }, () => getCurrentPolicy()))
  assert.equal(p.version, 1, 'built-in default applies when no policy is stored for the tenant')
})

test('POLICY: with tenancy OFF behaviour is unchanged', async () => {
  const p = await withTenancy(false, () => getCurrentPolicy())
  assert.ok(p.version >= 1)
})

// ── Sweep: no other session-less server component has the same pattern ───────

test('SWEEP: every public server component that reads tenant data is scoped', () => {
  const pages = execFileSync('bash', ['-c',
    "find app -name 'page.tsx' -not -path '*/admin/*' -not -path '*/portal/*'"],
    { encoding: 'utf8' }).split('\n').filter(Boolean)

  const unscoped: string[] = []
  for (const f of pages) {
    const src = readFileSync(f, 'utf8')
    const isClient = /^['"]use client['"]/m.test(src.split('\n').slice(0, 3).join('\n'))
    const isAsyncServer = /export default async function|export async function generateMetadata/.test(src)
    const reads = /await (get|list)[A-Za-z]+\(/.test(src)
    if (isClient || !isAsyncServer || !reads) continue
    const scoped = /withPublicTokenScope|withReferenceTenantScope|runWithTenant/.test(src)
    if (!scoped) unscoped.push(f)
  }
  assert.deepEqual(unscoped, [],
    `these server components read tenant-owned data with no tenant scope:\n${unscoped.join('\n')}`)
})
