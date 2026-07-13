# 08 — Event & Workflow Architecture (Phase 7)

> RECOMMENDATION, grounded in cited current-state facts. Deliberately **modular
> monolith + durable job queue**, not distributed events — the app can start
> simple and already has the primitives.

## 1. Reality check (FACT)

Today there is **no event bus and no outbox**. Side-effects are inline and
fail-soft: booking flows call `notify()` directly, cron sweeps
(`app/api/cron/daily/route.ts`) poll Redis and act, per-record `audit[]`/
`events[]` arrays are the only history, and the central attributed audit
(`app/lib/audit.ts`) covers only comms/reminders. Idempotency exists where it
matters (payment recording keyed by Stripe session, `record-payment.ts:14-62`;
reminder occurrence dedup via `setNxPx`, `reminders.ts:212-214`; booking
`idempotencyKey`).

This is fine for one tenant. It becomes fragile when (a) AI actions need an
approval→execute→audit trail, (b) automations must be tenant-configurable, and
(c) cross-domain reactions multiply. The minimal upgrade is a **durable outbox**,
not Kafka.

## 2. Recommended model: modular monolith + transactional outbox

- **In-process domain events** for synchronous, same-request reactions (already
  effectively how it works — formalize with a typed `emit(event)`).
- **Durable outbox** (a Redis list/zset `t:{tid}:outbox`) for anything that must
  survive a crash, retry, or run async: notifications, AI actions, webhooks,
  analytics. A worker (extend the existing 5-min cron) drains it.
- **No distributed system.** Revisit only if a single tenant's volume outgrows
  one worker — not before.

## 3. Business-event taxonomy (RECOMMENDATION)

Every event carries a **standard envelope**: `{ id, tenantId, type, occurredAt,
actor (userId|'system'|'ai:<feature>'), subjectId, payload, version }`. `tenantId`
is mandatory and comes from the request context (`05-...`).

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
