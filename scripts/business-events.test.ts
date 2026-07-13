// Business event catalog: envelope validation, tenant requirement, versioning,
// idempotent outbox, correlation propagation.
import assert from 'node:assert/strict'
import test from 'node:test'

import { EVENT_CATALOG } from '../app/lib/platform/events/catalog'
import { createEvent, validateEnvelope } from '../app/lib/platform/events/envelope'
import { InProcessOutbox } from '../app/lib/platform/events/outbox'
import type { EventEnvelope } from '../app/lib/platform/events/types'

const actor = { type: 'user' as const, id: 'u_1', role: 'admin' }

test('catalog contains the full initial event set (37)', () => {
  assert.equal(Object.keys(EVENT_CATALOG).length, 37)
})

test('a well-formed event validates cleanly', () => {
  const e = createEvent({ eventType: 'LeadCreated', tenantId: 'jkiss', actor, entityId: 'lead_1', payload: { source: 'web' } })
  assert.deepEqual(validateEnvelope(e), [])
  assert.equal(e.entityType, 'lead')
  assert.equal(e.idempotencyKey, 'LeadCreated:lead_1')
})

test('missing tenantId is rejected (the tenant boundary is mandatory)', () => {
  const e = createEvent({ eventType: 'BookingCreated', tenantId: '', actor, entityId: 'bk_1', payload: {} })
  assert.ok(validateEnvelope(e).some((m) => /tenantId/.test(m)))
})

test('a required payload key must be present', () => {
  const e = createEvent({ eventType: 'PaymentReceived', tenantId: 'jkiss', actor, entityId: 'pay_1', payload: {} })
  assert.ok(validateEnvelope(e).some((m) => /amountCents/.test(m)))
})

test('an unsupported version is rejected', () => {
  const e = createEvent({ eventType: 'LeadCreated', tenantId: 'jkiss', actor, entityId: 'lead_2', payload: { source: 'x' }, eventVersion: 99 })
  assert.ok(validateEnvelope(e).some((m) => /unsupported version/.test(m)))
})

test('an unknown event type is rejected', () => {
  const e = { ...createEvent({ eventType: 'LeadCreated', tenantId: 'jkiss', actor, entityId: 'x', payload: { source: 'x' } }), eventType: 'Nope' } as unknown as EventEnvelope
  assert.ok(validateEnvelope(e).some((m) => /unknown event type/.test(m)))
})

test('outbox drops duplicate idempotency keys (at-least-once + idempotent)', () => {
  const box = new InProcessOutbox()
  const e = createEvent({ eventType: 'BookingCreated', tenantId: 'jkiss', actor, entityId: 'bk_9', payload: {} })
  assert.equal(box.enqueue(e), true)
  assert.equal(box.enqueue(e), false, 'duplicate idempotency key must be dropped')
  assert.equal(box.size(), 1)
  assert.equal(box.drain().length, 1)
  assert.equal(box.size(), 0)
})

test('outbox rejects invalid envelopes', () => {
  const box = new InProcessOutbox()
  const bad = createEvent({ eventType: 'BookingCreated', tenantId: '', actor, entityId: 'bk_bad', payload: {} })
  assert.equal(box.enqueue(bad), false)
})

test('correlation + causation propagate down a chain', () => {
  const root = createEvent({ eventType: 'QuoteAccepted', tenantId: 'jkiss', actor, entityId: 'q_1', payload: {} })
  assert.equal(root.correlationId, root.eventId, 'a root event correlates to itself')
  const child = createEvent({
    eventType: 'BookingCreated', tenantId: 'jkiss', actor, entityId: 'bk_1', payload: {},
    correlationId: root.correlationId, causationId: root.eventId,
  })
  assert.equal(child.correlationId, root.correlationId)
  assert.equal(child.causationId, root.eventId)
})
