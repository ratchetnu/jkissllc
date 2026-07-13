// ── Transactional outbox (interface + in-process impl) ───────────────────────
//
// Prepares for durable, at-least-once delivery WITHOUT a message broker. This
// sprint ships the interface plus an in-process implementation so producers can
// emit against a stable contract now; a Redis-backed durable outbox (per
// 08-event-and-workflow-architecture.md) can replace the impl later with no
// call-site changes. Consumers must be idempotent (dedupe on idempotencyKey).

import type { EventEnvelope } from './types'
import { validateEnvelope } from './envelope'

export interface Outbox {
  /** Enqueue an event. Returns false if invalid or a duplicate idempotency key. */
  enqueue(env: EventEnvelope): boolean
  /** Remove and return all currently-queued events (dedupe memory is retained). */
  drain(): EventEnvelope[]
  /** Number of events currently queued. */
  size(): number
}

export class InProcessOutbox implements Outbox {
  private queue: EventEnvelope[] = []
  private seen = new Set<string>()

  enqueue(env: EventEnvelope): boolean {
    if (validateEnvelope(env).length > 0) return false
    if (this.seen.has(env.idempotencyKey)) return false // at-least-once + idempotent → drop dup
    this.seen.add(env.idempotencyKey)
    this.queue.push(env)
    return true
  }

  drain(): EventEnvelope[] {
    const out = this.queue
    this.queue = []
    return out
  }

  size(): number {
    return this.queue.length
  }
}
