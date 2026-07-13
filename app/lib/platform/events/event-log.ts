// ── Durable event log (Redis-backed at-least-once store) ─────────────────────
//
// The persistent home for published business events. The in-process `Outbox`
// (outbox.ts) is a synchronous same-process contract; this is the durable
// append-only log that makes events "the foundation for reporting, automation,
// analytics, and future AI reasoning" (see 08-event-and-workflow-architecture.md).
//
// Storage mirrors the audit/telemetry convention (audit.ts, ai/telemetry.ts):
//   platform:events:e:{eventId}                 → the envelope JSON (SET)
//   platform:events:log                          → global index (ZSET score=occurredAt)
//   platform:events:entity:{tenantId}:{entityId} → per-entity index (ZSET) for timelines
//   platform:events:idem:{idempotencyKey}        → dedupe marker (SET NX PX)
// All keys use the `platform:` global prefix, so the tenancy chokepoint
// (scopeKey) leaves them un-namespaced; the tenant boundary is carried INSIDE the
// envelope (validated) and embedded in the per-entity index key.
//
// A factory (makeEventLog) takes a minimal client so the logic is unit-testable
// with an in-memory fake; the default `eventLog` binds it to the real `redis`.

import { redis } from '../../redis'
import type { EventEnvelope } from './types'
import { validateEnvelope } from './envelope'

const LOG_INDEX = 'platform:events:log'
const eventKey = (id: string) => `platform:events:e:${id}`
const idemKey = (k: string) => `platform:events:idem:${k}`
const entityIndex = (tenantId: string, entityId: string) => `platform:events:entity:${tenantId}:${entityId}`

const LOG_CAP = 10_000 // newest N kept in the global index
const IDEM_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30-day dedupe window

export type AppendResult = 'appended' | 'duplicate' | 'invalid'

/** The subset of the redis wrapper this log needs — lets tests inject a fake. */
export interface EventLogClient {
  setNxPx(key: string, value: string, ttlMs: number): Promise<boolean>
  set(key: string, value: string): Promise<void>
  get(key: string): Promise<string | null>
  zadd(key: string, score: number, member: string): Promise<void>
  zrevrange(key: string, start: number, stop: number): Promise<string[]>
  zcard(key: string): Promise<number>
  eval?(script: string, keys: string[], args: string[]): Promise<unknown>
}

export function makeEventLog(client: EventLogClient) {
  async function append(env: EventEnvelope): Promise<AppendResult> {
    if (validateEnvelope(env).length > 0) return 'invalid'
    // Dedupe first (at-least-once + idempotent): only the first writer of an
    // idempotencyKey proceeds. TTL bounds the marker set.
    const first = await client.setNxPx(idemKey(env.idempotencyKey), env.eventId, IDEM_TTL_MS)
    if (!first) return 'duplicate'
    const json = JSON.stringify(env)
    await client.set(eventKey(env.eventId), json)
    await client.zadd(LOG_INDEX, env.occurredAt, env.eventId)
    await client.zadd(entityIndex(env.tenantId, env.entityId), env.occurredAt, env.eventId)
    // Best-effort trim of the global index so it can't grow unbounded. Keeps the
    // newest LOG_CAP by rank; per-entity indexes stay small (one booking's life).
    if (client.eval) {
      try {
        await client.eval(
          "redis.call('ZREMRANGEBYRANK', KEYS[1], 0, -1 - tonumber(ARGV[1]))",
          [LOG_INDEX],
          [String(LOG_CAP)],
        )
      } catch { /* trim is best-effort */ }
    }
    return 'appended'
  }

  async function hydrate(ids: string[]): Promise<EventEnvelope[]> {
    const out: EventEnvelope[] = []
    for (const id of ids) {
      const raw = await client.get(eventKey(id))
      if (!raw) continue
      try { out.push(JSON.parse(raw) as EventEnvelope) } catch { /* skip corrupt */ }
    }
    return out
  }

  /** Newest-first events for one entity (e.g. a booking token) within a tenant. */
  async function readForEntity(tenantId: string, entityId: string, limit = 100): Promise<EventEnvelope[]> {
    const ids = await client.zrevrange(entityIndex(tenantId, entityId), 0, Math.max(0, limit - 1))
    return hydrate(ids)
  }

  /** Newest-first events across the whole platform log. */
  async function readRecent(limit = 100): Promise<EventEnvelope[]> {
    const ids = await client.zrevrange(LOG_INDEX, 0, Math.max(0, limit - 1))
    return hydrate(ids)
  }

  async function size(): Promise<number> {
    return client.zcard(LOG_INDEX)
  }

  return { append, readForEntity, readRecent, size }
}

/** The production log, bound to the real (tenancy-scoped) redis wrapper. */
export const eventLog = makeEventLog(redis)
