# 06 — Business Events

**Files:** `app/lib/platform/events/{types,catalog,envelope,outbox}.ts` ·
**Tests:** `scripts/business-events.test.ts`.

## Envelope (`types.ts`)
Every event carries: `eventId`, `eventType`, `eventVersion`, `occurredAt`,
`tenantId` (mandatory), `actor`, `correlationId`, `causationId?`, `entityType`,
`entityId`, `idempotencyKey`, `payload`, `metadata`, `schemaVersion`.

## Catalog (`catalog.ts`)
37 typed event definitions (the full requested set: Lead/Quote/Deposit/Booking/
Job/Crew/Assignment/Availability/TimeOff/Clock/Compliance/Equipment/ChangeOrder/
Invoice/Payment/Review/Expense/Profitability/Maintenance and the AI-action
lifecycle). Each declares its current version, entity type, and required payload
keys. `isKnownEvent` / `currentVersion` back runtime validation.

## Validation (`envelope.ts`)
`createEvent(input)` builds an envelope (defaults version from the catalog,
correlationId to the eventId for a root, idempotencyKey to `type:entityId`).
`validateEnvelope` rejects: missing tenantId/entityId/idempotencyKey/actor,
unknown types, unsupported versions, and missing required payload keys.

## Outbox (`outbox.ts`)
`Outbox` interface + `InProcessOutbox` (validates, drops duplicate idempotency
keys → at-least-once + idempotent, drain/size). No broker, no Kafka — a Redis-
backed durable outbox can replace the impl later with no call-site change.

## Not done
The durable Redis outbox, real producers/consumers, and dead-letter handling —
deferred (roadmap Phase 5).
