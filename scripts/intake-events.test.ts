// Durable event log (event-log.ts) + fail-soft publisher (publish.ts).
// Uses an in-memory fake client — never touches real Redis.
import assert from 'node:assert/strict'
import test from 'node:test'

import { createEvent } from '../app/lib/platform/events/envelope'
import { makeEventLog, type EventLogClient } from '../app/lib/platform/events/event-log'
import { publishEvent } from '../app/lib/platform/events/publish'
import type { EventEnvelope } from '../app/lib/platform/events/types'

const actor = { type: 'system' as const, id: 'public-intake' }

function fakeClient(): EventLogClient {
  const strings = new Map<string, string>()
  const idem = new Set<string>()
  const zsets = new Map<string, Array<[number, string]>>()
  return {
    async setNxPx(key) { if (idem.has(key)) return false; idem.add(key); return true },
    async set(key, value) { strings.set(key, value) },
    async get(key) { return strings.get(key) ?? null },
    async zadd(key, score, member) { const a = zsets.get(key) ?? []; a.push([score, member]); zsets.set(key, a) },
    async zrevrange(key, start, stop) {
      const a = (zsets.get(key) ?? []).slice().sort((x, y) => y[0] - x[0])
      return a.slice(start, stop + 1).map((m) => m[1])
    },
    async zcard(key) { return (zsets.get(key) ?? []).length },
  }
}

const lead = (entityId: string, occurredAt: number) =>
  createEvent({ eventType: 'LeadCreated', tenantId: 'jkiss', actor, entityId, occurredAt, payload: { source: 'online' } })

test('append persists a valid event and reads it back by entity', async () => {
  const log = makeEventLog(fakeClient())
  const env = lead('bk_A', 1000)
  assert.equal(await log.append(env), 'appended')
  assert.equal(await log.size(), 1)
  const got = await log.readForEntity('jkiss', 'bk_A')
  assert.equal(got.length, 1)
  assert.equal(got[0].eventType, 'LeadCreated')
  assert.equal(got[0].eventId, env.eventId)
})

test('append is idempotent on idempotencyKey (at-least-once dedupe)', async () => {
  const log = makeEventLog(fakeClient())
  const env = lead('bk_B', 1000) // idempotencyKey defaults to LeadCreated:bk_B
  assert.equal(await log.append(env), 'appended')
  assert.equal(await log.append(env), 'duplicate')
  assert.equal(await log.size(), 1)
})

test('append rejects an invalid envelope (missing tenant boundary)', async () => {
  const log = makeEventLog(fakeClient())
  const bad = { ...lead('bk_C', 1000), tenantId: '' } as EventEnvelope
  assert.equal(await log.append(bad), 'invalid')
  assert.equal(await log.size(), 0)
})

test('readForEntity returns newest-first and is tenant-scoped', async () => {
  const log = makeEventLog(fakeClient())
  await log.append(lead('bk_D', 1000))
  await log.append(createEvent({ eventType: 'QuoteRequested', tenantId: 'jkiss', actor, entityId: 'bk_D', occurredAt: 2000, payload: {} }))
  const got = await log.readForEntity('jkiss', 'bk_D')
  assert.deepEqual(got.map((e) => e.eventType), ['QuoteRequested', 'LeadCreated'])
  // A different tenant sees nothing for the same entity id.
  assert.equal((await log.readForEntity('other', 'bk_D')).length, 0)
})

test('publishEvent is a no-op returning null while the flag is OFF (default)', async () => {
  // Default flags: INTAKE_WORKFLOW_ENABLED is false → never touches Redis.
  const out = await publishEvent({ eventType: 'LeadCreated', entityId: 'bk_E', actor, payload: { source: 'online' } })
  assert.equal(out, null)
})
