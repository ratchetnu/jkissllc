# 08 — Event & Workflow Architecture (Phase 7)

> Grounded in cited current-state facts. Deliberately **modular monolith +
> durable outbox**, not distributed events — the app can start simple and already
> has the primitives. Platform brand: **Operion**. Internal identifiers (the
> `platform:` / `opspilot:` Redis key families, in-code event names, the
> `docs/opspilot-os/` path) are retained verbatim as legacy identifiers.
>
> _(Updated 2026-07-14: the outbox + event-log + versioned catalog this doc
> recommended are now **SCAFFOLDED** in `app/lib/platform/events/`, wired behind a
> fail-soft, flag-gated producer. Sections below mark what is now FACT vs still
> RECOMMENDATION.)_

## 1. Reality check (FACT)

The **live** booking/dispatch paths still run side-effects inline and fail-soft:
booking flows call `notify()` directly, cron sweeps
(`app/api/cron/daily/route.ts`) poll Redis and act, per-record `audit[]`/
`events[]` arrays are the per-entity history, and the central attributed audit
(`app/lib/audit.ts`) covers comms/reminders. Idempotency exists where it matters
(payment recording keyed by Stripe session, `record-payment.ts`; reminder
occurrence dedup via `setNxPx`, `reminders.ts`; booking `idempotencyKey`).

_(Updated 2026-07-14 — the recommended upgrade is now **built but inert**:
`app/lib/platform/events/` ships the typed envelope + versioned catalog + a
durable at-least-once event log + an in-process outbox + a single producer API
(`publishEvent`). But **`publishEvent` is a no-op returning `null` unless
`INTAKE_WORKFLOW_ENABLED` is on (it is OFF)** and it is **fail-soft — it never
throws to the caller** — so nothing in the live booking path yet depends on, or is
changed by, eventing.)_

This inline model is fine for one tenant. It becomes fragile when (a) AI actions
need an approval→execute→audit trail, (b) automations must be tenant-configurable,
and (c) cross-domain reactions multiply — which is exactly why the durable outbox
(not Kafka) now exists as scaffold, ready to be switched on.

## 2. Recommended model: modular monolith + transactional outbox

- **In-process domain events** for synchronous, same-request reactions. _(Updated
  2026-07-14 — SCAFFOLDED: `InProcessOutbox` in `events/outbox.ts` — enqueue/drain
  with idempotency-key dedupe (at-least-once + idempotent), behind the stable
  `Outbox` interface so a Redis-backed impl can replace it with no call-site churn.)_
- **Durable event log** for anything that must survive a crash, retry, or run
  async. _(Updated 2026-07-14 — SCAFFOLDED: `events/event-log.ts` is a Redis-backed
  at-least-once append log — `platform:events:e:{id}` envelopes, a capped global
  index (`platform:events:log`, newest 10k), a per-entity timeline index
  (`platform:events:entity:{tenantId}:{entityId}`), and a 30-day idempotency
  marker (`platform:events:idem:{key}`, `SET NX PX`) so only the first writer of an
  idempotency key proceeds. NOTE: these keys use the **`platform:` global prefix**,
  so the tenancy chokepoint `scopeKey()` leaves them un-namespaced — the tenant
  boundary is instead carried **inside** the (validated) envelope and embedded in
  the per-entity index key.)_
- **No distributed system.** Revisit only if a single tenant's volume outgrows
  one worker — not before. (No message broker: delivery is via the in-process
  outbox / durable log, not Kafka.)

## 3. Business-event taxonomy (SCAFFOLDED)

Every event carries a **standard envelope**: `{ id, tenantId, type, occurredAt,
actor (userId|'system'|'ai:<feature>'), subjectId, payload, version }`. `tenantId`
is mandatory and comes from the request context (`05-...`).

_(Updated 2026-07-14 — FACT: this taxonomy is now realized in
`app/lib/platform/events/`. `types.ts` defines the typed `EventEnvelope`
(mandatory `tenantId`, `actor` of type `user|system|ai`, `correlationId` +
optional `causationId` for chain reconstruction, `idempotencyKey`, `schemaVersion`)
and the `BusinessEventType` union. `catalog.ts` is a **versioned registry of 37
event types** (each `version: 1` today, with `entityType` + `requiredPayload`);
`envelope.ts` `validateEnvelope()` rejects an unknown type, an unsupported
version, a missing tenant/entity/actor/idempotency key, or a missing required
payload key. The table below is that catalog — a few names were normalized in
code: `WorkerClockedOut` is not yet emitted (only `WorkerClockedIn`),
`UniformPhotoSubmitted` → `CompliancePhotoSubmitted`, and the AI-action family is
`AIActionDrafted / AIActionApprovalRequested / AIActionApproved / AIActionRejected
/ AIActionExecuted / AIActionFailed`.)_

| Event | Producer | Consumers | Sync/Async | Idempotency key |
|---|---|---|---|---|
| `LeadCreated` | quote/contact API | CRM, AI Sales, analytics | Async | leadId |
| `QuoteRequested/Generated/Sent/Viewed/Accepted` | quote flow | CRM, booking, analytics | Async | quoteId+type |
| `DepositPaid` | Stripe webhook | booking, ledger, notify | **Sync** (money) | stripeSessionId |
| `BookingCreated` | `book` API | dispatch, notify, CRM | Async | bookingToken |
| `JobScheduled` | scheduling | crew, calendar | Async | jobId |
| `CrewAssigned` / `AssignmentSent` | routes | crew-notify, availability | Async | routeToken+staffId |
| `AssignmentAccepted/Declined` | route confirm | dispatch, owner-alert | Async | assigneeToken |
| `AvailabilitySubmitted` | portal | scheduling, Crew Score | Async | staffId+week |
| `TimeOffRequested/Approved/Denied` | timeoff | scheduling, notify | Async | timeoffId |
| `WorkerClockedIn/Out` | route/[token] | TimeEntry read-model, audit | Async | routeToken+staffId+ts |
| `UniformPhotoSubmitted` | portal | compliance, reminder-suppress | Async | staffId+date |
| `EquipmentAssigned` | routes | fleet, double-book check | **Sync** (conflict) | equipmentId+jobId |
| `JobStarted/Delayed/Completed` | route/[token] | invoicing, notify, AI COO | Async | jobId+stage |
| `ChangeOrderCreated/Approved` | job | invoicing, notify | **Sync** (approval) | changeOrderId |
| `InvoiceIssued` | invoicing | ledger, notify | **Sync** | invoiceId |
| `PaymentReceived` | Stripe/Zelle | ledger, pay, notify | **Sync** (money) | paymentId |
| `ReviewRequested/Received` | post-job / site-reviews | marketing, AI | Async | bookingToken |
| `ExpenseRecorded` | expenses (NEW) | ledger, profitability | Async | expenseId |
| `ProfitabilityThresholdBreached` | ledger read-model | AI Finance, owner-alert | Async | tenantId+period |
| `VehicleMaintenanceDue` | fleet | owner-alert, dispatch | Async | equipmentId+due |
| `AIRecommendationCreated` | AI engine | approval queue, UI | Async | recommendationId |
| `AIActionApproved` | approval queue | action executor | **Sync** | approvalId |
| `AIActionExecuted/Failed` | action executor | audit, notify, rollback | **Sync** | actionId |

## 4. Per-category policy (RECOMMENDATION)

- **Money events (`*Paid`, `PaymentReceived`, `InvoiceIssued`)** — sync, strong
  idempotency (already keyed by provider id), audited, never dropped. Reuse
  `record-payment.ts` idempotency pattern.
- **AI action events (`AIAction*`)** — sync execution, mandatory audit
  (`AiActionLog`), rollback consideration recorded, tenant + user + level
  stamped. This is the backbone of Level 3+ (`07-...`).
- **Notification events** — async via outbox, retried with backoff, delivery
  tracked (extends the notification ledger already on bookings). Honor SMS
  suppression + opt-out (`sms:optout:*`).
- **Scheduling/workforce events** — async; consumers are advisory (approving
  time-off deliberately does NOT auto-unassign — `timeoff.ts:5-7` — keep that as
  an explicit consumer decision, not an implicit cascade).
- **Analytics events** — async, best-effort, lossy-tolerable; write to the
  tenant-scoped read model (fixing the two wrapper-bypass paths).

## 5. Failure handling & retries (RECOMMENDATION)

- Outbox entries carry `attempts` + `nextRetryAt`; exponential backoff; a
  dead-letter zset `t:{tid}:outbox:dead` after N attempts, surfaced in the admin
  UI + owner alert.
- Consumers are **idempotent by contract** (dedupe on the event's idempotency
  key) so at-least-once delivery is safe.
- Webhooks continue to return 200 fast and enqueue (already the pattern) so
  provider retry storms can't cascade.

## 6. What NOT to do

- No Kafka/RabbitMQ/EventBridge. No CQRS ceremony beyond the one analytics read
  model. No sagas. The outbox + idempotent consumers cover every workflow in
  this product at its realistic scale; distributed infrastructure would add
  operational burden a founder-led team should not carry yet.

## 7. Maturity (2026-07-14)

| Element | Evidence | Maturity |
|---|---|---|
| Typed envelope + validation | `events/types.ts`, `events/envelope.ts` | **MVP** — mandatory tenant boundary, correlation/causation, runtime validation |
| Versioned event catalog (37 types) | `events/catalog.ts` | **MVP** — versioned defs + required-payload checks |
| Durable at-least-once event log | `events/event-log.ts` | **MVP** — Redis append log, idempotent, capped index, per-entity timeline; testable via injected client |
| In-process outbox | `events/outbox.ts` | **Prototype** — interface + in-memory impl; Redis-backed durable impl still to build |
| Producer API `publishEvent` | `events/publish.ts` | **Prototype** — fail-soft, flag-gated by `INTAKE_WORKFLOW_ENABLED` (OFF); no live producers wired |
| Consumers / workers / dead-letter | — | **Planned** — §5 retry/dead-letter and §4 per-category consumers not yet built |

Net: the event **spine** (envelope, catalog, durable log, producer) is scaffolded
and unit-shaped, but **inert** — no live path publishes, no consumer drains, and
the durable Redis outbox + retry/dead-letter machinery of §5 remain to build.
Activation is deliberately a later, flag-gated step, not a silent default.
