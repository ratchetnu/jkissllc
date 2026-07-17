# Unified Operations ↔ Book Now — Audit & Architecture

_Branch: `feat/unified-operations-book-now`. Scope: integrate the customer-facing
Book Now workflow with core Operations so ALL scheduled work — Book Now jobs,
manual jobs, contract routes, recurring routes, deliveries, moving, junk-removal,
estate-cleanouts — appears in one unified operational schedule. No AI Command
Center files are touched by this work._

## 1. Executive summary

The business already runs on **two Redis-backed record stores that never meet**:

| Store | Model | Key space | Covers | Created by |
|---|---|---|---|---|
| **Bookings** | `Booking` (`app/lib/bookings.ts`) | `bk:*`, index `bk:index` | Every customer job: moving, junk-removal, estate/garage cleanout, eviction, appliance-delivery, freight | Book Now (`source:'online'`) via `POST /api/quote`+`/api/book`; manual (`source:'admin'`) via `POST /api/admin/bookings` |
| **Routes** | `RouteRecord` (`app/lib/routes.ts`) | `rt:*`, index `rt:index`; templates `rt:tpl:*` | B2B contract + recurring dispatch routes | `POST /api/admin/routes`; recurring via `route-templates` |

**Book Now is already a job-intake channel, not a separate OS.** A public quote
request is persisted as a first-class `Booking` in the *same* store the admin
reads (`booking-requests.ts` → `persistQuoteRequest`), with photos, AI estimate,
quote history, payments, audit events, and idempotency. So the Phase-2/3
"canonical Operations job" for a Book Now request **already exists** — it is the
`Booking` record. There is no duplicate-job problem to unwind for Book Now.

**The real gaps are downstream of intake:**

1. **No unified schedule.** The owner cannot see one day's work in one place.
   - Ops Home "Today's operations" = **routes only** (`operations/page.tsx:33`).
   - Book Now queue = **bookings only** (`operations/book-now/page.tsx`).
   - The only calendar in the app (`app/admin/routes/WeekView.tsx`) is
     **routes-only** and stranded in the legacy `/admin/routes` surface, not the
     Operations shell.
2. **Capacity/availability is single-sided.** `availability.ts` sums booking
   work-units per day against a flat capacity but **never consults routes** (and
   routes never consult bookings). A day packed with contract routes still
   advertises full booking capacity.
3. **No conflict detection of any kind.** Exhaustive search found zero crew /
   vehicle / equipment overlap checking. The only guards are write-locks
   (`route-mutex`, booking CAS) and a soft, non-blocking crew-availability warning.
4. **Crew-assignment asymmetry.** Routes assign crew as structured
   `assignees[]` (stable `staffId`, per-person confirm/SMS/timeclock/pay).
   Bookings assign crew as **free-text names** (`assignedTo`/`assignedHelper`),
   with no link to the `staff:*` roster — so a person can't be cross-checked
   across a booking and a route today.
5. **Equipment is route-only.** `equipment.ts` roster links to routes via
   `equipmentId`; bookings never reference equipment.

## 2. Current lifecycle map

### Booking (customer job) lifecycle — `BookingStatus`
```
quote_received → pending_payment → pending_zelle_verification → payment_received
→ booking_created → confirmation_link_sent → customer_viewed
→ time_verification_pending → time_verified → confirmed
→ in_progress → continued → completed / partially_completed / could_not_complete
→ cancelled / refunded
```
- Scheduled date = `effectiveServiceDate(b)` (`continuation.returnDate` → `selectedDate`
  → sole `availableDates[0]`). Time = `selectedWindow`.
- `canMarkConfirmed()` already enforces "real, priced, scheduled" before `confirmed`.
- `CLOSED_STATUSES` are terminal; history (events, payments, photos, AI) is never destroyed.
- Idempotent creation on `idempotencyKey` (`bk:idem:*`). One request → one booking.

### Route (contract dispatch) lifecycle — `RouteStatus`
```
draft → assigned → text_sent → confirmed → declined / no_response / no_show
→ completed / cancelled
```
- Scheduled date = `routeDate`. Time = `reportTime` (free text).
- Crew = `assignees[]` (rolled up by `rollupStatus`). Recurring routes carry `templateId`.

## 3. Schema decision — projection, not a third table

The task describes a "canonical Operations job" with `source_type` / `source_record_id`
/ service_type / crew / vehicle / equipment / status / money. Taken literally, a
brand-new physical `Job` table would **duplicate** booking + route rows and demand
a two-way sync — directly violating the engineering contract ("reuse existing
tables", "do not duplicate jobs", "do not create another disconnected calendar",
"do not destroy historical data").

**Decision: the canonical Operations job is a read-model projection**, not a new
store. A pure, deterministic layer maps each `Booking` and each `RouteRecord` into
one common `ScheduleItem` shape:

```
ScheduleItem {
  id, source: BOOK_NOW | MANUAL | CONTRACT_ROUTE | RECURRING_ROUTE | IMPORTED | OTHER,
  sourceRecordId, kind: 'booking' | 'route',
  serviceType, customerOrBusiness, address,
  date (yyyy-mm-dd), timeLabel, sortMinutes,
  lane: 'pending' | 'confirmed',              // Phase 5 pending-vs-confirmed
  status, statusLabel,
  crew[], vehicle, equipment[],
  valueCents, paymentState, attention[],       // authorization-gated at the API
  href                                         // cross-nav to the source record
}
```

Source mapping (Phase 2 "do not flatten away source-specific data"):
- `Booking source:'online'` → **BOOK_NOW**
- `Booking source:'admin'`  → **MANUAL**
- `RouteRecord` with `templateId` → **RECURRING_ROUTE**
- `RouteRecord` without `templateId` → **CONTRACT_ROUTE**
- IMPORTED / OTHER reserved for future intake channels.

The source records remain the owners of their own data (intake answers, photos, AI,
quotes, confirmations, crew confirmations, pay). The projection is derived on read
and is **never persisted**, so there is nothing to keep in sync and nothing to
migrate destructively. This satisfies "one canonical job", "source type + id",
"idempotent (one request → one job)", and "do not duplicate jobs" simultaneously.

## 4. What this branch will build (isolated commits)

1. **Audit + architecture** (this document).
2. **`app/lib/schedule/unified.ts`** — pure Booking/Route → `ScheduleItem`
   projection + `mergeSchedule()`, with source badges, pending/confirmed lane,
   date + sort-time derivation. Unit tested.
3. **`app/lib/schedule/conflicts.ts`** — deterministic crew/vehicle/equipment
   overlap, missing-resource, accepted-not-scheduled, scheduled-not-linked,
   duplicate-job checks. No AI. Unit tested.
4. **`app/api/admin/schedule/route.ts`** — reads `bk:*` + `rt:*`, returns the
   merged, date/range-filtered schedule + conflicts. `requireStaffSession`;
   money/value fields gated by permission. Zero AI calls on the path.
5. **`app/admin/operations/schedule/`** — the unified schedule UI: Today / Day /
   Week / Pending / Unscheduled, chronological, all sources together, source
   badges, restrained pending lane, cross-navigation to the source record.
   Responsive at 390 / 768 / 1440. One new nav item ("Schedule").
6. **Reconciliation dry-run** — classifies existing bookings (request-only /
   accepted-unscheduled / scheduled-linked / duplicate / completed / cancelled /
   ambiguous); counts + record IDs; no automatic mass conversion.
7. **Tests** — projection, merge, conflicts, idempotency, source badges,
   pending≠confirmed, authorization, and a guard proving scheduling/filtering
   makes **zero** AI calls.

## 5. Boundaries & overlap (AI Command Center session)

- **Not touched:** `app/admin/operations/ai/**`, `app/api/admin/ai-*`,
  `app/lib/estimation/*`, `app/lib/ai/*`, shadow store, AI nav/settings/alerts.
- **Shared file touched (flagged for merge):** `app/admin/operations/nav-config.ts`
  — appends ONE `work`-group nav item ("Schedule"); the AI Command Center entry
  is left byte-identical. All other new files are net-new and non-overlapping.
- **No live AI** on any scheduling, projection, conflict, or page-load path.
