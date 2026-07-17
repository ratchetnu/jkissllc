# Unified Schedule — Multi-Industry (Operion Editions) Architecture

The unified Operations schedule is built as a **generic operational-job engine**, so
one codebase serves every Operion edition without a schema redesign per industry.

## The three layers

1. **Adapters (source → canonical).** Each work source has one pure projector that
   fills the generic `ScheduleItem` shape:
   - `bookingToScheduleItem` — customer Bookings (Book Now + manual), any service type.
   - `routeToScheduleItem` — contract / recurring routes.
   - _future:_ `hvacJobToScheduleItem`, `plumbingWorkOrderToScheduleItem`, … — a new
     edition adds a new adapter and (optionally) a new source record store. **Nothing
     in the engine, conflict detector, API, or UI changes.**
2. **Engine (canonical model).** `ScheduleItem` is industry-neutral:
   - `serviceKey?: string` — a generic slug (`'junk-removal'`, `'hvac'`, `'roofing'`, …).
   - `serviceLabel: string` — the human label the UI shows.
   - `meta: {label,value}[]` — an **open bag** of service-specific detail (load size,
     tonnage, unit model, roof pitch, acreage…) rendered as generic chips. New fields
     never require a type change.
   - `source: BOOK_NOW | MANUAL | CONTRACT_ROUTE | RECURRING_ROUTE | IMPORTED | OTHER`
     — the intake channel, extensible without touching consumers.
3. **Consumers (service-agnostic).**
   - **Conflict detection** reasons only over crew / vehicle / equipment / time /
     address — never over service type — so it is correct for every industry unchanged.
   - **The UI** renders source badge + status + `serviceLabel` + `meta` chips + crew /
     vehicle / equipment generically; it has no `if (junk)`/`if (moving)` branches.

## Why this matters for the platform strategy

- **Add an edition without a migration.** Onboarding HVAC, plumbing, electrical,
  roofing, landscaping, pest control, cleaning, or general field service is a new
  adapter + service labels + (optional) meta keys — not a schedule rewrite.
- **One schedule, many lines of business.** An operator running several editions sees
  every job on one board; the engine already merges arbitrary sources by date + time.
- **No industry lock-in in the core.** The junk/moving service enum stays where it
  belongs (the customer Booking model); the schedule engine treats it as opaque data.
- **Deterministic, edition-independent guarantees.** Conflict detection, pending-vs-
  confirmed lanes, idempotent one-record-one-job, and the zero-AI scheduling path hold
  identically across every edition because none of them depend on the industry.

## Extension checklist (adding an edition)

1. Add the intake/store for the new work type (or reuse Bookings with a new `serviceType`).
2. Write `xToScheduleItem(record) → ScheduleItem` filling `serviceKey`, `serviceLabel`,
   `meta`, crew, vehicle/equipment, date/time, lane, value, href.
3. Add the source to the `mergeSchedule` call in `/api/admin/schedule`.
4. (Optional) add a `SOURCE_STYLE` entry if it introduces a new `source`.
5. Done — engine, conflicts, lanes, counts, and UI work unchanged.
