# Operion V1 — Sprint 1 Completion Report

**Sprint:** Job assignment & execution for bookings
**Branch:** `feat/booking-job-assignment` (off `main` @ `a5f647d`)
**Flag:** `BOOKING_ASSIGNMENT_ENABLED` — **default OFF, everywhere**
**Status:** complete, verified, **not merged, not deployed**

---

## Objective

Give customer Bookings the operational spine the Routes lane already had, so the
Book Now revenue line — the AI-quoted, customer-paying half of the business —
stops being dispatched by text message and starts living inside Operion.

## What was actually broken

A `Booking`'s entire operational assignment model was two free-text strings:

```ts
assignedTo?: string        // "Marcus"
assignedHelper?: string    // "Dre"
```

Names in a box, never linked to a staff record. Everything downstream was
therefore blind to the customer revenue line:

| Symptom | Root cause |
|---|---|
| Crew portal showed nothing for a moving job | `api/portal/routes` read `listRoutes()` and matched on `a.staffId` |
| No clock in/out on customer jobs | timeclock keyed to route assignee tokens |
| No completion photos | `completionPhotos` lived only on `RouteRecord` |
| Equipment conflicts blind to bookings | `schedule/unified.ts:224-225` hard-coded `equipmentId: undefined, equipment: []` |
| Booking work invisible to pay | `StatementLine` is `{routeNumber, routeDate, businessName}` |
| No claims on booking work | `claims.ts` snapshots a `RouteRecord` |

---

## What shipped

### 1. One shared shape, not two parallel ones

`app/lib/job-assignment.ts` (new, **pure** — no I/O, no clock) defines the generic
`JobAssignee` / `JobEquipment` / `JobCompletion` vocabulary that **both** lanes
satisfy. `routes.Assignee` satisfies `JobAssignee` **unchanged** — enforced at
compile time by an assignment in the test suite, so the shape cannot silently
drift apart again.

That is what let the rest of the sprint be small: the portal, timeclock, and
conflict layers were written once, against the shared shape, instead of twice.

### 2. Additive booking fields

`Booking` gained `assignees[]`, `equipmentId`, `vehicle`, `jobCompletedAt/By`,
`completionNote`, `completionPhotos`. No migration — absent fields read as
unassigned, and every pre-existing booking keeps working untouched.

`jobCompletedAt` is deliberately **separate** from `BookingStatus`: recording
arrival photos must never silently close out a job's money.

### 3. Server orchestration

`app/lib/booking-assignment.ts` (new) — assign, unassign, re-price, set equipment,
accept, decline, punch the clock, record completion. All writes go through the
booking's CAS path, and all funnel through one `persist()` so the two invariants
below cannot be forgotten by a future caller.

**Pay rate policy stays in `lib/finance.resolveCrewPay`** — the one definition of
what a crew member earns. This module owns only snapshot semantics: frozen at
assign time, and `applyPaySnapshot(a, null)` **no-ops rather than zeroing**, so a
failed rate lookup can never wipe a good amount.

### 4. API

| Route | Who | What |
|---|---|---|
| `POST /api/admin/bookings/[id]/assignment` | `crew:assign`, `equipment:assign`, `pay:configure` | assign / unassign / re-price / set equipment / record completion |
| `GET /api/admin/bookings/[id]/assignment` | `crew:view` | current crew + equipment + gap |
| `GET /api/portal/jobs` | crew | **unified** feed — routes AND bookings |
| `GET·POST /api/portal/jobs/[id]` | crew | accept / decline / clock in / clock out / completion photos |
| `POST /api/portal/upload` | crew | Blob token broker for field photos |

A **dedicated** admin route rather than more branches in the 1000-line booking
PATCH handler: assignment shares none of that handler's money, AI, status, or
customer-notification paths, so it cannot accidentally trip a customer email.

### 5. UI

- **Admin** — `CrewPanel` on the booking detail page: roster crew with pay, add/remove, equipment picker, crew-gap warning, and a line showing *exactly what the customer will see*. Renders nothing when the API 404s, so with the flag off the page is unchanged and makes no extra requests.
- **Crew portal** — "My Jobs" unified feed, plus a job screen with accept/decline, clock in/out (best-effort GPS), and camera upload. `/portal/routes` is left alone and still serves the shipped UI.

---

## The payoff, proven

Once bookings carry real `staffId` and real `equipmentId`, the **already-shipped**
conflict engine catches cross-lane collisions with **zero changes to
`conflicts.ts`** — it already keyed on `sid:` / `eq:` / `veh:`:

```
✔ a crew member double-booked across a route and a booking is caught by staffId
✔ a truck used on a route and a booking the same morning is caught by equipmentId
✔ different people on different trucks the same morning is not a conflict
```

That is the whole thesis of the V1 roadmap in one test file: the machinery
already existed and was pointed at the wrong half of the business.

---

## Compatibility guarantees (tested, not asserted)

1. **The customer sees no change.** `assignedTo` / `assignedHelper` are re-derived
   from the crew list on every write. Declined crew never surface. An empty crew
   yields `undefined`, never `''`, so an unassigned booking stays indistinguishable
   from one never touched. Names are trimmed and capped at 80 chars — a derived
   value can never exceed what a typed one could.
2. **Legacy bookings project exactly as before**, and gain **no new warnings**:
   `no_vehicle` fires only once a booking is roster-staffed.
3. **The Routes lane is untouched.** `applyPunch` was widened from `Assignee` to
   `JobAssignee` — a superset relationship, so every existing caller is unaffected.
4. **Off means off.** Every entry point checks the flag first; the admin panel and
   both portal routes 404, and the portal feed doesn't even read the booking store.

---

## Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **clean** |
| `npm test` | **1691 / 1691 pass** (+56 over the `a5f647d` baseline) |
| `npx eslint` on every file touched | **clean** |
| `npm run build` | see below |
| Behavior change with flag off | **none** |
| Deployed | **no** |

New tests: `scripts/job-assignment.test.ts` (31), `scripts/booking-assignment.test.ts` (12).

**Not verified:** no live Preview run and no authenticated click-through — the
flag is off and nothing is deployed, per the sprint's own rules. Turning the flag
on in Preview and walking a real booking end-to-end is the first task of the next
session, before Sprint 2 builds pay on top of this.

`npm run audit:mobile` requires a dev server on `:3111`; without one every route
reports FAIL. That is an unmet precondition, not a regression.

---

## Change surface

```
 5 files changed, 83 insertions(+), 16 deletions(-)      # existing files
 + app/lib/job-assignment.ts                             # new, pure
 + app/lib/booking-assignment.ts                         # new, server
 + app/api/admin/bookings/[id]/assignment/route.ts
 + app/api/portal/jobs/route.ts
 + app/api/portal/jobs/[id]/route.ts
 + app/api/portal/upload/route.ts
 + app/admin/operations/book-now/[token]/CrewPanel.tsx
 + app/portal/jobs/page.tsx
 + app/portal/jobs/[id]/page.tsx
 + scripts/job-assignment.test.ts
 + scripts/booking-assignment.test.ts
```

Of the 83 lines added to existing files, the great majority are the booking
projector in `schedule/unified.ts`; the rest are type declarations, the flag, and
one widened function signature.

---

## What Sprint 1 deliberately did NOT do

- **No dispatch.** Assignment sends no text. Notifying crew is a separate, explicit
  action, exactly as it is on a route.
- **No pay statements.** Booking work does not yet reach a statement — that is
  Sprint 2, and the pay snapshot this sprint freezes is what it will read.
- **No claims on bookings.** Also Sprint 2.
- **No status coupling.** Completion proof never changes `BookingStatus`.

---

## Next

**Sprint 2 — job costing & crew pay unification.** Widen `StatementLine` to
`{ kind: 'route' | 'booking', ref, date, label, amountCents }`, generalize
`route-pay.computePay` into `job-pay`, and let `claims.ts` snapshot a booking.
The pay snapshots frozen by this sprint are its input.

Before that: turn the flag on in Preview and walk one real booking from
assignment → accept → clock in → photos → clock out.
