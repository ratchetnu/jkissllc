// Wave C — the last two confirmed races from the July 2026 audit.
//
// WEBHOOK-1  provider-message dedup was GET-then-SET, so two CONCURRENT deliveries
//            of one MessageSid both passed the "seen?" check and both stored a
//            message. Sequential redelivery always deduped — which is exactly why
//            it never surfaced in production.
// CUST-1     upsertCustomer read the identity index and only later wrote it, so two
//            concurrent first-touch upserts for one person both missed and both
//            minted a customer record.
//
// Both are now atomic claims (SET NX) on the very key that carries the uniqueness.
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'

const UPSTASH = 'http://fake-upstash.local'
type Entry = { value: string; expiresAt?: number }
const kv = new Map<string, Entry>()
let failOnce: ((cmd: string, key: string) => boolean) | null = null

function live(key: string): string | null {
  const e = kv.get(key)
  if (!e) return null
  if (e.expiresAt != null && e.expiresAt <= Date.now()) { kv.delete(key); return null }
  return e.value
}

globalThis.fetch = (async (url: string, init: { body?: string }) => {
  if (url !== UPSTASH) return { ok: true, status: 200, json: async () => ({}) }
  // Yield per command so concurrent callers genuinely interleave — without this a
  // check-then-act race cannot be reproduced at all.
  await new Promise(r => setImmediate(r))
  const [cmd, ...args] = JSON.parse(init.body as string) as string[]
  const command = String(cmd).toUpperCase()
  const key = args[0]
  if (failOnce?.(command, key)) { failOnce = null; throw new Error('fake redis: injected failure') }
  let result: unknown = null
  switch (command) {
    case 'GET': result = live(key); break
    case 'SET': {
      const flags = args.slice(2).map(a => String(a).toUpperCase())
      const nx = flags.includes('NX'); const pxAt = flags.indexOf('PX')
      const ttl = pxAt >= 0 ? Number(args[2 + pxAt + 1]) : undefined
      if (nx && live(key) !== null) { result = null; break }
      kv.set(key, { value: args[1], expiresAt: ttl != null ? Date.now() + ttl : undefined })
      result = 'OK'; break
    }
    case 'DEL': result = kv.delete(key) ? 1 : 0; break
    case 'ZADD': case 'ZREM': case 'PEXPIRE': case 'EXPIRE': result = 1; break
    case 'ZREVRANGE': case 'ZRANGE': result = []; break
    case 'EVAL': {
      const n = Number(args[1]); const k = args[2]; const token = args[2 + n]
      const owns = live(k) === token
      if (owns) kv.delete(k)
      result = owns ? 1 : 0
      break
    }
    default: result = null
  }
  return { ok: true, json: async () => ({ result }) }
}) as unknown as typeof fetch

import {
  claimProviderMessage, releaseProviderMessageClaim, seenProviderMessage,
  recordMessage, getMessageByProviderId,
} from '../app/lib/messages'
import { makeCustomers } from '../app/lib/customers'
import { redis } from '../app/lib/redis'

const reset = () => { kv.clear(); failOnce = null }
const storedMessages = () => [...kv.keys()].filter(k => /^msg:m_/.test(k))
const customerRecords = () => [...kv.keys()].filter(k => /^cust:c_/.test(k))

// One inbound delivery, exactly as the webhooks do it: claim, then store.
async function deliver(sid: string, body = 'hello'): Promise<'recorded' | 'deduped'> {
  const token = await claimProviderMessage(sid)
  if (!token) return 'deduped'
  await recordMessage({
    direction: 'inbound', channel: 'sms', provider: 'twilio', body,
    customerPhone: '+15550009', providerMessageId: sid,
  } as never)
  return 'recorded'
}

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK-1
// ─────────────────────────────────────────────────────────────────────────────

test('WEBHOOK-1: concurrent duplicate deliveries store exactly ONE message', async () => {
  reset()
  const sid = 'SM-concurrent-1'
  const results = await Promise.all([deliver(sid), deliver(sid), deliver(sid), deliver(sid), deliver(sid)])
  assert.equal(results.filter(r => r === 'recorded').length, 1, 'exactly one delivery processed')
  assert.equal(results.filter(r => r === 'deduped').length, 4)
  assert.equal(storedMessages().length, 1, 'and exactly one stored message')
})

test('WEBHOOK-1: sequential redelivery is still deduped', async () => {
  reset()
  const sid = 'SM-sequential-1'
  assert.equal(await deliver(sid), 'recorded')
  assert.equal(await deliver(sid), 'deduped')
  assert.equal(await deliver(sid), 'deduped')
  assert.equal(storedMessages().length, 1)
})

test('WEBHOOK-1: different provider messages process independently', async () => {
  reset()
  const results = await Promise.all([deliver('SM-a'), deliver('SM-b'), deliver('SM-c')])
  assert.deepEqual(results, ['recorded', 'recorded', 'recorded'], 'distinct ids never block each other')
  assert.equal(storedMessages().length, 3)
})

test('WEBHOOK-1: the claim resolves to the real message id, so lookups still work', async () => {
  reset()
  const sid = 'SM-mapping-1'
  await deliver(sid, 'the body')
  const m = await getMessageByProviderId(sid)
  assert.ok(m, 'the provider id still resolves to its message')
  assert.equal(m!.body, 'the body')
  assert.equal(await seenProviderMessage(sid), true)
  // The permanent mapping replaced the TTL'd claim — no expiry left behind.
  const raw = kv.get(`msg:pid:${sid}`)
  assert.equal(raw?.expiresAt, undefined, 'the stored mapping is permanent, as before')
  assert.ok(!raw!.value.startsWith('claim:'), 'and holds the message id, not the claim token')
})

test('WEBHOOK-1: a failed store releases the claim so the provider retry succeeds', async () => {
  reset()
  const sid = 'SM-failed-store'
  const token = await claimProviderMessage(sid)
  assert.ok(token)
  // The webhook swallows a store failure; it must then free the id.
  await releaseProviderMessageClaim(sid, token!)
  assert.equal(await seenProviderMessage(sid), false, 'the id is free again')
  assert.equal(await deliver(sid), 'recorded', 'so the retry is processed')
  assert.equal(storedMessages().length, 1)
})

test('WEBHOOK-1: a straggler cannot release a claim it no longer owns', async () => {
  reset()
  const sid = 'SM-straggler'
  const first = await claimProviderMessage(sid)
  await redis.del(`msg:pid:${sid}`)                 // first claim lapses
  const second = await claimProviderMessage(sid)    // a retry takes over
  assert.ok(second && second !== first)
  await releaseProviderMessageClaim(sid, first!)    // the straggler tries to clean up
  assert.equal(await seenProviderMessage(sid), true, 'the live claim survives')
})

test('WEBHOOK-1: a stale claim expires so a lost delivery is never wedged forever', async () => {
  reset()
  const sid = 'SM-stale'
  const token = await claimProviderMessage(sid)
  assert.ok(token)
  const entry = kv.get(`msg:pid:${sid}`)!
  assert.ok(entry.expiresAt && entry.expiresAt > Date.now(), 'the claim is time-bounded')
  entry.expiresAt = Date.now() - 1                  // simulate the window elapsing
  assert.equal(await seenProviderMessage(sid), false)
  assert.equal(await deliver(sid), 'recorded', 'a later retry can still be stored')
})

// ─────────────────────────────────────────────────────────────────────────────
// CUST-1
// ─────────────────────────────────────────────────────────────────────────────

const customers = () => makeCustomers(redis)

test('CUST-1: concurrent first-touch upserts create ONE customer', async () => {
  reset()
  const c = customers()
  const input = { name: 'Dup Customer', email: 'Dup@Example.com', phone: '+1 555 000 7777' }
  const results = await Promise.all([
    c.upsertCustomer({ ...input, bookingToken: 'bk_1' }),
    c.upsertCustomer({ ...input, bookingToken: 'bk_2' }),
    c.upsertCustomer({ ...input, bookingToken: 'bk_3' }),
  ])
  const ids = new Set(results.map(r => r.customer.id))
  assert.equal(ids.size, 1, `all callers converged on one id, got ${[...ids].join(', ')}`)
  assert.equal(results.filter(r => r.isNew).length, 1, 'exactly one caller created it')
  assert.equal(customerRecords().length, 1, 'and there is exactly one stored record')
})

test('CUST-1: the losers converge on the WINNER\'s record, not a rival', async () => {
  reset()
  const c = customers()
  const input = { name: 'Converge', email: 'converge@example.com' }
  const [a, b] = await Promise.all([
    c.upsertCustomer({ ...input, bookingToken: 'bk_1' }),
    c.upsertCustomer({ ...input, phone: '817-555-0000', bookingToken: 'bk_2' }),
  ])
  assert.equal(a.customer.id, b.customer.id)
  // The index points at that same record — no orphan is reachable.
  const indexed = await redis.get('cust:email:converge@example.com')
  assert.equal(indexed, a.customer.id)
  const winner = await c.getCustomer(a.customer.id)
  assert.ok(winner)
  assert.equal(winner!.phone, '817-555-0000', 'the loser\'s contact detail was back-filled')
  // bookingCount is best-effort: the update branch is a read-modify-write with no
  // CAS, so a simultaneous increment can be lost. The guarantee under test is the
  // IDENTITY, not the counter — see the note on upsertCustomer.
  assert.ok((winner!.bookingCount ?? 0) >= 1, 'the record carries at least the winner\'s booking')
})

test('CUST-1: no orphan records are left behind', async () => {
  reset()
  const c = customers()
  await Promise.all(Array.from({ length: 5 }, (_, i) =>
    c.upsertCustomer({ name: 'Orphan Check', email: 'orphan@example.com', bookingToken: `bk_${i}` })))
  const records = customerRecords()
  assert.equal(records.length, 1, `one record only, found ${records.length}`)
  const indexed = await redis.get('cust:email:orphan@example.com')
  assert.equal(`cust:${indexed}`, records[0], 'the index points at the one record that exists')
})

test('CUST-1: phone-only identity is claimed atomically too', async () => {
  reset()
  const c = customers()
  const results = await Promise.all([
    c.upsertCustomer({ name: 'Phone Only', phone: '(817) 555-2222', bookingToken: 'bk_1' }),
    c.upsertCustomer({ name: 'Phone Only', phone: '817-555-2222', bookingToken: 'bk_2' }),
  ])
  assert.equal(new Set(results.map(r => r.customer.id)).size, 1, 'one identity, one record')
  assert.equal(customerRecords().length, 1)
})

test('CUST-1: different customers remain fully independent', async () => {
  reset()
  const c = customers()
  const results = await Promise.all([
    c.upsertCustomer({ name: 'A', email: 'a@example.com', bookingToken: 'bk_a' }),
    c.upsertCustomer({ name: 'B', email: 'b@example.com', bookingToken: 'bk_b' }),
    c.upsertCustomer({ name: 'C', phone: '817-555-3333', bookingToken: 'bk_c' }),
  ])
  assert.equal(new Set(results.map(r => r.customer.id)).size, 3, 'three distinct identities')
  assert.ok(results.every(r => r.isNew))
  assert.equal(customerRecords().length, 3)
})

test('CUST-1: an anonymous upsert (no email, no phone) still works', async () => {
  reset()
  const c = customers()
  // Nothing to claim — these are intentionally NOT deduped, exactly as before.
  const [a, b] = await Promise.all([
    c.upsertCustomer({ name: 'Walk-in', bookingToken: 'bk_1' }),
    c.upsertCustomer({ name: 'Walk-in', bookingToken: 'bk_2' }),
  ])
  assert.notEqual(a.customer.id, b.customer.id, 'no identity to merge on — behaviour unchanged')
  assert.equal(customerRecords().length, 2)
})

test('CUST-1: sequential upserts still dedupe and back-fill (existing behaviour)', async () => {
  reset()
  const c = customers()
  const a = await c.upsertCustomer({ name: 'John', email: 'john@example.com', bookingToken: 'bk_1' })
  assert.equal(a.isNew, true)
  const b = await c.upsertCustomer({ name: 'John Smith', email: 'JOHN@example.com', phone: '817-555-1234', bookingToken: 'bk_2' })
  assert.equal(b.isNew, false)
  assert.equal(b.customer.id, a.customer.id)
  assert.equal(b.customer.bookingCount, 2)
  assert.equal(customerRecords().length, 1)
})

test('CUST-1: a client without atomic claim support still functions (degraded, not broken)', async () => {
  const m = new Map<string, string>()
  const legacy = makeCustomers({
    async get(k: string) { return m.get(k) ?? null },
    async set(k: string, v: string) { m.set(k, v) },
  })
  const a = await legacy.upsertCustomer({ name: 'Legacy', email: 'legacy@example.com', bookingToken: 'bk_1' })
  const b = await legacy.upsertCustomer({ name: 'Legacy', email: 'legacy@example.com', bookingToken: 'bk_2' })
  assert.equal(a.customer.id, b.customer.id, 'sequential dedup still works without setNxPx')
  assert.equal(b.customer.bookingCount, 2)
})
