// ── publishEvent — the single, fail-soft producer API ────────────────────────
//
// Every business event is emitted through this function. It is:
//   • FLAG-GATED — a no-op returning null unless INTAKE_WORKFLOW_ENABLED is on,
//     so wiring it into the live booking path changes nothing until we enable it.
//   • FAIL-SOFT — it NEVER throws to the caller. A bug or Redis hiccup in the
//     event layer must not break a customer's quote/booking/payment. Producers
//     call this and ignore the result.
//   • TENANT-STAMPED — defaults tenantId from the request's tenant context (or the
//     reference tenant) and actor to 'system' when the caller doesn't supply one.
//
// Producers never touch the outbox or event-log directly — they call publishEvent,
// so the durable transport can evolve with no call-site churn.

import { isEnabled } from '../flags'
import { currentTenantId } from '../tenancy/context'
import { DEFAULT_TENANT_ID } from '../tenancy/types'
import { createEvent, validateEnvelope, type CreateEventInput } from './envelope'
import { eventLog } from './event-log'
import type { EventActor, EventEnvelope } from './types'

// tenantId/actor become optional here (defaulted); everything else is as createEvent.
export type PublishInput<T extends Record<string, unknown>> =
  Omit<CreateEventInput<T>, 'tenantId' | 'actor'> & { tenantId?: string; actor?: EventActor }

export async function publishEvent<T extends Record<string, unknown>>(
  input: PublishInput<T>,
): Promise<EventEnvelope<T> | null> {
  if (!isEnabled('INTAKE_WORKFLOW_ENABLED')) return null
  try {
    const tenantId = input.tenantId ?? safeTenant()
    const actor: EventActor = input.actor ?? { type: 'system', id: 'system' }
    const env = createEvent<T>({ ...input, tenantId, actor })
    const problems = validateEnvelope(env)
    if (problems.length) {
      console.warn(`[events] dropped invalid ${input.eventType}:`, problems.join('; '))
      return null
    }
    const result = await eventLog.append(env)
    return result === 'invalid' ? null : env
  } catch (err) {
    // Swallow — the booking path must never depend on eventing succeeding.
    console.warn(`[events] publish failed (soft) for ${input.eventType}:`, err instanceof Error ? err.message : err)
    return null
  }
}

function safeTenant(): string {
  try {
    return currentTenantId() ?? DEFAULT_TENANT_ID
  } catch {
    return DEFAULT_TENANT_ID
  }
}
