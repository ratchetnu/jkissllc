// ── WAVE 6D-B: financial public surfaces ─────────────────────────────────────
//
// Route invoices and pay-statement verification. Separate from 6D-A on purpose: a
// wiring mistake here shows one customer another customer's money, so the trust
// boundary around Stripe gets its own explicit assertions rather than being assumed.
process.env.ADMIN_SESSION_SECRET ||= 'test-secret-at-least-16-chars-long'

import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { readFileSync } from 'node:fs'

const PORT = 7700 + (process.pid % 250)
process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT}`
process.env.KV_REST_API_TOKEN = 'emulator-accepts-anything'

import { resolveTokenBinding } from '../app/lib/platform/tenancy/token-binding'
import { runWithTenant } from '../app/lib/platform/tenancy/context'
import { scopeKey, isPlatformGlobal, PLATFORM_GLOBAL_PREFIXES } from '../app/lib/platform/tenancy/keys'
import { saveInvoice, deleteInvoice, type RouteInvoice } from '../app/lib/route-invoices'
import { saveStatement, getStatement, type PayStatement } from '../app/lib/pay-statements'
import { publicStatement } from '../app/lib/pay-statement-view'
import { backfillTokenBindings } from '../app/lib/platform/tenancy/token-backfill'

const A = 'fina'
const B = 'finb'
let kv: ChildProcess | null = null

before(async () => {
  kv = spawn(process.execPath, ['scripts/local-audit/kv-emulator.mjs', '--port', String(PORT)], { stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/__admin/health`)).ok) return } catch { /* not up */ }
    await sleep(50)
  }
  throw new Error('kv emulator did not start')
})
after(() => { kv?.kill('SIGKILL') })

const invoice = (token: string, over: Partial<RouteInvoice> = {}): RouteInvoice => ({
  token, invoiceNumber: `INV-${token.slice(0, 6)}`, status: 'sent', lines: [],
  totalCents: 10000, amountPaidCents: 0, createdAt: 1, updatedAt: 1, ...over,
} as unknown as RouteInvoice)

const statement = (id: string, over: Partial<PayStatement> = {}): PayStatement => ({
  id, statementNumber: `PS-${id.slice(3, 9)}`, staffId: 's1', staffName: 'Dana Rivera',
  periodStart: '2026-07-01', periodEnd: '2026-07-15', issuedAt: 1, updatedAt: 1,
  status: 'issued', lines: [], deductions: [], grossCents: 50000, deductionCents: 0,
  netCents: 50000, ...over,
} as unknown as PayStatement)

// ── Route invoice ────────────────────────────────────────────────────────────

test('INVOICE: saving binds the token to the acting tenant and exact invoice', async () => {
  await runWithTenant({ tenantId: A }, () => saveInvoice(invoice('inv-token-aaa')))
  const b = await resolveTokenBinding('inv-token-aaa')
  assert.equal(b?.tenantId, A)
  assert.equal(b?.resourceType, 'route-invoice')
  assert.equal(b?.resourceId, 'inv-token-aaa')
})

test('INVOICE: tenant A token can never be bound into tenant B', async () => {
  await runWithTenant({ tenantId: B }, () => saveInvoice(invoice('inv-token-aaa')))
  assert.equal((await resolveTokenBinding('inv-token-aaa'))?.tenantId, A, 'first owner keeps it; never overwritten')
})

test('INVOICE: the same invoice token in two tenants stays in separate namespaces', () => {
  const pa = runWithTenant({ tenantId: A }, () => scopeKey('rt:inv:shared', { enabled: true }))
  const pb = runWithTenant({ tenantId: B }, () => scopeKey('rt:inv:shared', { enabled: true }))
  assert.notEqual(pa, pb)
})

test('INVOICE: a token for invoice A does not resolve invoice B (same tenant)', async () => {
  await runWithTenant({ tenantId: A }, () => saveInvoice(invoice('inv-token-bbb')))
  const [a, b] = [await resolveTokenBinding('inv-token-aaa'), await resolveTokenBinding('inv-token-bbb')]
  assert.notEqual(a?.resourceId, b?.resourceId, 'each token names exactly one invoice')
  assert.equal(b?.resourceId, 'inv-token-bbb')
})

test('INVOICE: delete revokes the binding — no dangling platform record', async () => {
  await runWithTenant({ tenantId: A }, () => saveInvoice(invoice('inv-token-del')))
  assert.ok(await resolveTokenBinding('inv-token-del'))
  await runWithTenant({ tenantId: A }, () => deleteInvoice('inv-token-del'))
  assert.equal(await resolveTokenBinding('inv-token-del'), null)
})

test('INVOICE: a VOID invoice keeps its binding (the link must say "voided", not break)', async () => {
  await runWithTenant({ tenantId: A }, () => saveInvoice(invoice('inv-token-void', { status: 'void' } as Partial<RouteInvoice>)))
  assert.ok(await resolveTokenBinding('inv-token-void'), 'binding survives void; the route itself 404s')
})

test('INVOICE: a PAID invoice keeps its binding (reopening a receipt is allowed)', async () => {
  await runWithTenant({ tenantId: A }, () => saveInvoice(invoice('inv-token-paid', { status: 'paid', amountPaidCents: 10000 } as Partial<RouteInvoice>)))
  assert.ok(await resolveTokenBinding('inv-token-paid'))
})

test('INVOICE: re-saving is idempotent — the binding is unchanged', async () => {
  const before = await resolveTokenBinding('inv-token-aaa')
  await runWithTenant({ tenantId: A }, () => saveInvoice(invoice('inv-token-aaa', { totalCents: 99999 } as Partial<RouteInvoice>)))
  assert.deepEqual(await resolveTokenBinding('inv-token-aaa'), before)
})

// ── Stripe trust boundary ────────────────────────────────────────────────────

test('STRIPE: the public token alone authorizes NO financial mutation', () => {
  // Read the route source and assert the guards are structurally present. A test that
  // only exercised the happy path would not notice a guard being deleted.
  const src = readFileSync('app/api/invoice/[token]/stripe-return/route.ts', 'utf8')
  assert.match(src, /stripe\.checkout\.sessions\.retrieve\(sessionId\)/,
    'the session is fetched FROM Stripe with our secret key, never taken from the caller')
  assert.match(src, /session\.metadata\?\.invoiceToken === token/,
    'the Stripe session must NAME this invoice')
  assert.match(src, /recordStripeInvoicePayment\(session\)/,
    'the idempotent shared transition is what applies payment')
  // The handler must not write payment fields itself.
  assert.ok(!/amountPaidCents\s*=/.test(src), 'the public route never assigns amountPaidCents')
  assert.ok(!/status\s*=\s*['"]paid['"]/.test(src), 'the public route never sets status = paid')
})

test('STRIPE: the public invoice route performs no payment writes of its own', () => {
  const src = readFileSync('app/api/invoice/[token]/route.ts', 'utf8')
  assert.ok(!/saveInvoice\(/.test(src), 'the customer-facing invoice route never persists an invoice')
  assert.ok(!/amountPaidCents\s*=/.test(src))
  assert.ok(!/refund/i.test(src), 'no refund path on a public route')
})

test('STRIPE: tenant no longer comes from the record (which has no tenantId)', () => {
  // Strip comments first: the explanatory note in that file NAMES the old function,
  // and matching prose would make this test pass or fail on wording rather than code.
  const src = readFileSync('app/api/invoice/[token]/stripe-return/route.ts', 'utf8')
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.ok(!/resolveTenantFromResource/.test(code),
    'resolving from an invoice record returned null under tenancy and silently skipped mark-paid')
  assert.match(code, /withPublicTokenRoute/, 'the binding supplies the tenant before the handler runs')
})

// ── Pay statement ────────────────────────────────────────────────────────────

test('PAYSTMT: an issued statement binds its existing ps_ id — links keep working', async () => {
  await runWithTenant({ tenantId: A }, () => saveStatement(statement('ps_aaaaaaaaaaaaaaaaaa')))
  const b = await resolveTokenBinding('ps_aaaaaaaaaaaaaaaaaa')
  assert.equal(b?.tenantId, A)
  assert.equal(b?.resourceType, 'pay-statement')
  assert.equal(b?.resourceId, 'ps_aaaaaaaaaaaaaaaaaa')
})

test('PAYSTMT: tenant A id cannot be claimed by tenant B', async () => {
  await runWithTenant({ tenantId: B }, () => saveStatement(statement('ps_aaaaaaaaaaaaaaaaaa')))
  assert.equal((await resolveTokenBinding('ps_aaaaaaaaaaaaaaaaaa'))?.tenantId, A)
})

test('PAYSTMT: one id does not resolve another statement in the same tenant', async () => {
  await runWithTenant({ tenantId: A }, () => saveStatement(statement('ps_bbbbbbbbbbbbbbbbbb')))
  const [x, y] = [await resolveTokenBinding('ps_aaaaaaaaaaaaaaaaaa'), await resolveTokenBinding('ps_bbbbbbbbbbbbbbbbbb')]
  assert.notEqual(x?.resourceId, y?.resourceId)
})

test('PAYSTMT: a VOID statement KEEPS its binding so verify can answer "voided"', async () => {
  // /api/verify/[id] returns `verified: false` plus the same non-sensitive fields for
  // a voided statement — telling a lender the document is real but was voided.
  // Revoking the binding would collapse that into a bare 404 ("no such statement"),
  // which is less true and less useful. The reader decides disclosure, not the binding.
  await runWithTenant({ tenantId: A }, () => saveStatement(statement('ps_cccccccccccccccccc')))
  await runWithTenant({ tenantId: A }, () => saveStatement(statement('ps_cccccccccccccccccc', { status: 'void' } as Partial<PayStatement>)))
  assert.ok(await resolveTokenBinding('ps_cccccccccccccccccc'), 'binding survives the void')
  const s = await runWithTenant({ tenantId: A }, () => getStatement('ps_cccccccccccccccccc'))
  assert.equal(s?.status, 'void', 'the reader still finds it and reports void')
})

test('PAYSTMT: an unknown id resolves to nothing', async () => {
  assert.equal(await resolveTokenBinding('ps_zzzzzzzzzzzzzzzzzz'), null)
})

// ── Public field-sensitivity review ──────────────────────────────────────────

test('PAYSTMT: the public view exposes ONLY the approved non-sensitive fields', () => {
  const s = statement('ps_dddddddddddddddddd', {
    contractorAddress: { line1: '2901 E Mayfield Rd', line2: '#2103', city: 'Grand Prairie', state: 'TX', postalCode: '75052' },
  })
  const pub = publicStatement(s, 'J Kiss LLC') as unknown as Record<string, unknown>
  assert.deepEqual(Object.keys(pub).sort(),
    ['business', 'contractorInitials', 'issuedAt', 'periodEnd', 'periodStart', 'statementNumber', 'status'])
  assert.doesNotMatch(JSON.stringify(pub), /2901 E Mayfield|75052/, 'mailing address must not enter public verification')
})

test('PAYSTMT: no money, no ids, no crew full name, no route detail leaves the public view', () => {
  const s = statement('ps_eeeeeeeeeeeeeeeeee')
  const pub = JSON.stringify(publicStatement(s, 'J Kiss LLC'))
  for (const forbidden of ['grossCents', 'netCents', 'deductionCents', 'deductions', 'lines', 'staffId', 'tenantId', 'notes', 'bank', 'routeToken']) {
    assert.ok(!pub.includes(forbidden), `${forbidden} must not appear in the public verification payload`)
  }
  assert.ok(!pub.includes('Dana Rivera'), 'the full crew name is reduced to initials')
  assert.ok(!pub.includes(s.id), 'the internal id is not echoed back')
  assert.ok(pub.includes('DR'), 'initials only')
})

// ── Key-family invariants ────────────────────────────────────────────────────

test('no financial prefix was made platform-global', () => {
  assert.deepEqual([...PLATFORM_GLOBAL_PREFIXES], ['opspilot:', 'platform:', 'ai:', 'rl:', 'health:'])
  for (const k of ['rt:inv:x', 'rt:inv:num:1', 'paystmt:x', 'paystmt:period:a:b:c']) {
    assert.ok(!isPlatformGlobal(k), `${k} must stay tenant-owned`)
  }
})

test('financial records stay namespaced per tenant', () => {
  for (const k of ['rt:inv:t', 'paystmt:t']) {
    const pa = runWithTenant({ tenantId: A }, () => scopeKey(k, { enabled: true }))
    const pb = runWithTenant({ tenantId: B }, () => scopeKey(k, { enabled: true }))
    assert.notEqual(pa, pb, k)
  }
})

// ── Backfill ─────────────────────────────────────────────────────────────────

test('BACKFILL: covers invoices and issued pay statements', async () => {
  const report = await backfillTokenBindings(A)
  assert.ok(report.scanned.invoices >= 1)
  assert.ok(report.scanned.payStatements >= 1)
  assert.equal((await resolveTokenBinding('inv-token-bbb'))?.resourceType, 'route-invoice')
  assert.equal((await resolveTokenBinding('ps_bbbbbbbbbbbbbbbbbb'))?.resourceType, 'pay-statement')
})

test('BACKFILL: a voided statement IS bound, so its link still reports "voided"', async () => {
  const { redis } = await import('../app/lib/redis')
  await redis.del('platform:token:ps_cccccccccccccccccc')
  await backfillTokenBindings(A)
  assert.ok(await resolveTokenBinding('ps_cccccccccccccccccc'), 'historical voided links keep answering')
})

test('BACKFILL: dry run writes nothing for financial families', async () => {
  const { redis } = await import('../app/lib/redis')
  await redis.del('platform:token:inv-token-bbb')
  const report = await backfillTokenBindings(A, { dryRun: true })
  assert.equal(report.dryRun, true)
  assert.equal(await resolveTokenBinding('inv-token-bbb'), null)
})

test('BACKFILL: repeat apply is idempotent and never touches the other tenant', async () => {
  await backfillTokenBindings(A)
  const before = await resolveTokenBinding('inv-token-bbb')
  const second = await backfillTokenBindings(A)
  assert.equal(second.bound, 0)
  assert.deepEqual(await resolveTokenBinding('inv-token-bbb'), before)
  assert.equal((await resolveTokenBinding('ps_aaaaaaaaaaaaaaaaaa'))?.tenantId, A, "B never acquired A's binding")
})
