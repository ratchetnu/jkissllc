// ── Event envelope construction + validation ─────────────────────────────────

import { randomUUID } from 'node:crypto'
import type { BusinessEventType, EventActor, EventEnvelope } from './types'
import { EVENT_CATALOG, isKnownEvent, currentVersion } from './catalog'

export const SCHEMA_VERSION = 1

export type CreateEventInput<T extends Record<string, unknown>> = {
  eventType: BusinessEventType
  tenantId: string
  actor: EventActor
  entityId: string
  payload: T
  entityType?: string
  idempotencyKey?: string
  correlationId?: string
  causationId?: string
  metadata?: Record<string, unknown>
  eventVersion?: number
  // Injected for deterministic tests; default to real values in production.
  eventId?: string
  occurredAt?: number
}

export function createEvent<T extends Record<string, unknown>>(input: CreateEventInput<T>): EventEnvelope<T> {
  const def = isKnownEvent(input.eventType) ? EVENT_CATALOG[input.eventType] : undefined
  const eventId = input.eventId ?? randomUUID()
  return {
    eventId,
    eventType: input.eventType,
    eventVersion: input.eventVersion ?? (def ? currentVersion(input.eventType) : 1),
    occurredAt: input.occurredAt ?? Date.now(),
    tenantId: input.tenantId,
    actor: input.actor,
    correlationId: input.correlationId ?? eventId, // a root event correlates to itself
    causationId: input.causationId,
    entityType: input.entityType ?? def?.entityType ?? 'unknown',
    entityId: input.entityId,
    idempotencyKey: input.idempotencyKey ?? `${input.eventType}:${input.entityId}`,
    payload: input.payload,
    metadata: input.metadata ?? {},
    schemaVersion: SCHEMA_VERSION,
  }
}

/** Structural + semantic validation. Returns a list of problems (empty = valid). */
export function validateEnvelope(env: EventEnvelope): string[] {
  const errors: string[] = []
  if (!env.eventId) errors.push('missing eventId')
  if (!env.tenantId) errors.push('missing tenantId') // the tenant boundary is mandatory
  if (!env.entityId) errors.push('missing entityId')
  if (!env.idempotencyKey) errors.push('missing idempotencyKey')
  if (!env.correlationId) errors.push('missing correlationId')
  if (!env.actor || !env.actor.id) errors.push('missing actor')

  if (!isKnownEvent(env.eventType)) {
    errors.push(`unknown event type "${env.eventType}"`)
    return errors
  }
  const def = EVENT_CATALOG[env.eventType]
  if (env.eventVersion !== def.version) {
    errors.push(`unsupported version ${env.eventVersion} for ${env.eventType} (supported: ${def.version})`)
  }
  for (const key of def.requiredPayload) {
    if (env.payload == null || !(key in env.payload)) errors.push(`payload missing required key "${key}"`)
  }
  return errors
}

export function assertValidEnvelope(env: EventEnvelope): void {
  const errors = validateEnvelope(env)
  if (errors.length) throw new Error(`invalid event envelope:\n- ${errors.join('\n- ')}`)
}

export function isValidEnvelope(env: EventEnvelope): boolean {
  return validateEnvelope(env).length === 0
}
