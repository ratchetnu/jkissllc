// Portal abuse-control regression tests. Drives the REAL route handlers against an
// in-memory Upstash fake with a genuine signed crew session, proving:
//   1. The portal messages `read` action is ownership-scoped (crew A cannot stamp
//      crew B's message — the one portal mutation that was not self-scoped).
//   2. Owner-alert / storage / brute-force vectors are rate-limited: each throttled
//      route returns 429 BEFORE doing any work once its per-IP bucket is over limit.
//   3. The limiter is not blanket-blocking — a request under the limit passes.
import assert from 'node:assert/strict'
import test from 'node:test'

// Must be set before any handler runs; redis.ts + the session signer read env lazily.
process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret-32byteslong!!'
process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'

const UPSTASH = 'http://fake-upstash.local'
const kv = new Map<string, string>()
const zsets = new Map<string, Map<string, number>>()
const hashes = new Map<string, Map<string, number>>()
const z = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!
const h = (k: string) => hashes.get(k) ?? hashes.set(k, new Map()).get(k)!

globalThis.fetch = (async (url: string, init: { body?: string }) => {
  if (url !== UPSTASH) return { ok: true, status: 200, json: async () => ({}) }
  const [cmd, ...args] = JSON.parse(init.body as string) as string[]
  const key = args[0]
  let result: unknown = null
  switch (String(cmd).toUpperCase()) {
    case 'GET': result = kv.get(key) ?? null; break
    case 'SET': kv.set(key, args[1]); result = 'OK'; break
    case 'DEL': result = kv.delete(key) ? 1 : 0; break
    case 'INCR': { const n = Number(kv.get(key) ?? 0) + 1; kv.set(key, String(n)); result = n; break }
    case 'ZADD': z(key).set(args[2], Number(args[1])); result = 1; break
    case 'ZREM': result = z(key).delete(args[1]) ? 1 : 0; break
    case 'ZREVRANGE': {
      const arr = [...z(key).entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0])
      const stop = Number(args[2])
      result = arr.slice(Number(args[1]), stop === -1 ? arr.length : stop + 1); break
    }
    case 'ZRANGE': {
      const arr = [...z(key).entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0])
      const stop = Number(args[2])
      result = arr.slice(Number(args[1]), stop === -1 ? arr.length : stop + 1); break
    }
    case 'HINCRBY': { const n = (h(key).get(args[1]) ?? 0) + Number(args[2]); h(key).set(args[1], n); result = n; break }
    case 'PFADD': result = 1; break
    case 'PEXPIRE': case 'EXPIRE': result = 1; break
    default: result = null
  }
  return { ok: true, json: async () => ({ result }) }
}) as unknown as typeof fetch

import { NextRequest } from 'next/server'
import { createUserSessionToken } from '../app/api/admin/_lib/session'
import { recordMessage, getMessage } from '../app/lib/messages'
import { POST as messagesPOST } from '../app/api/portal/messages/route'
import { POST as payCorrectionPOST } from '../app/api/portal/pay-correction/route'
import { POST as passwordPOST } from '../app/api/portal/password/route'
import { POST as timeoffPOST } from '../app/api/portal/timeoff/route'
import { POST as uniformPOST } from '../app/api/portal/uniform/route'
import { POST as trackPOST } from '../app/api/track/route'

const crewCookie = (staffId: string) => createUserSessionToken({ id: `u_${staffId}`, role: 'crew', staffId })

function req(url: string, body: unknown, cookie?: string): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cookie) headers.cookie = `jk_admin_session=${cookie}`
  return new NextRequest(url, { method: 'POST', headers, body: JSON.stringify(body) })
}

// Next 16 route handlers take (req, ctx); these routes carry no path params.
const CTX = { params: Promise.resolve({} as Record<string, string>) }
type Route = (r: NextRequest, ctx: typeof CTX) => Response | Promise<Response>

// getIP() with no forwarded headers resolves to 'unknown', so the bucket key is fixed.
async function expect429(handler: Route, url: string, bucket: string, max: number, body: unknown, cookie?: string) {
  kv.set(`rl:${bucket}:unknown`, String(max)) // next INCR → max+1, which is over the limit
  const res = await handler(req(url, body, cookie), CTX)
  assert.equal(res.status, 429, `${bucket} must 429 when the per-IP bucket is over limit`)
}

// ── 1. IDOR: the messages `read` action is ownership-scoped ─────────────────────
test('crew cannot mark ANOTHER crew member’s message read (IDOR write blocked)', async () => {
  const a = await crewCookie('crewA')
  const msgB = await recordMessage({ direction: 'outbound', channel: 'note', provider: 'manual', body: 'for B', staffId: 'crewB' })
  const res = await messagesPOST(req('http://localhost/api/portal/messages', { action: 'read', id: msgB.id }, a), CTX)
  assert.equal(res.status, 404, 'a foreign message id is treated as not found')
  const after = await getMessage(msgB.id)
  assert.equal(after?.crewReadAt ?? null, null, 'B’s message must stay unread')
})

test('crew CAN mark their OWN message read', async () => {
  const a = await crewCookie('crewA')
  const msgA = await recordMessage({ direction: 'outbound', channel: 'note', provider: 'manual', body: 'for A', staffId: 'crewA' })
  const res = await messagesPOST(req('http://localhost/api/portal/messages', { action: 'read', id: msgA.id }, a), CTX)
  assert.equal(res.status, 200)
  const after = await getMessage(msgA.id)
  assert.ok(after?.crewReadAt, 'own message is marked read')
})

// ── 2. Rate limits fail-safe over the limit ─────────────────────────────────────
test('pay-correction is throttled (owner SMS/email spam vector)', async () => {
  await expect429(payCorrectionPOST, 'http://localhost/api/portal/pay-correction', 'paycorrection', 5, { message: 'x' }, await crewCookie('crewA'))
})

test('password change is throttled (current-password brute force)', async () => {
  await expect429(passwordPOST, 'http://localhost/api/portal/password', 'pwchange', 5, { current: 'guess', next: 'Whatever#123' }, await crewCookie('crewA'))
})

test('timeoff is throttled (owner notification spam)', async () => {
  await expect429(timeoffPOST, 'http://localhost/api/portal/timeoff', 'timeoff', 10, { startDate: '2026-09-01' }, await crewCookie('crewA'))
})

test('uniform upload is throttled (blob storage spam)', async () => {
  await expect429(uniformPOST, 'http://localhost/api/portal/uniform', 'uniform', 12, { image: 'data:image/jpeg;base64,AAAA' }, await crewCookie('crewA'))
})

test('public track beacon is throttled (Redis hash bloat)', async () => {
  await expect429(trackPOST, 'http://localhost/api/track', 'track', 60, { path: '/x', referrer: '' })
})

// ── 3. The limiter is not blanket-blocking (under the limit → passes) ────────────
test('track passes under the limit (limiter does not blanket-block)', async () => {
  kv.delete('rl:track:unknown') // fresh bucket → first INCR = 1
  const res = await trackPOST(req('http://localhost/api/track', { path: '/home', referrer: '' }), CTX)
  assert.equal(res.status, 200)
})
