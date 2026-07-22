# Operion V1 — Sprint 1 Preview Validation Report

**Date:** 2026-07-21
**Branch:** `feat/booking-job-assignment`
**Preview deployment:** `dpl_75tqCBEv9vR3T1qg5UCk3uuzJhQH` (validation run) → redeployed with the fix
**Flag:** `BOOKING_ASSIGNMENT_ENABLED` — **Preview only**
**Outcome:** **workflow confirmed, with one defect found and fixed**

---

## 1. Data isolation — proven before any write

No test record was created until Preview was proven isolated from Production. The
CLI could not answer this (`vercel env pull` redacts integration-managed values —
both KV URLs return empty), so the Vercel Storage API was used instead.

### Store bindings for project `jkissllc`

| Resource | Preview | Production |
|---|---|---|
| KV / Redis | `store_su17aRaiDFYBUzPk` — **OperionPreview** → `['preview']` | `store_CJ8ZvzWGxOT85Xw6` — **jkissllc-analytics** → `['production']` |
| Blob | `store_Ulabe9q3GBD8ZYQh` — **operion-preview-blob** → `['preview']` | `store_WK8DoJzb2Q1lu5sv` — **jkiss-invoice-photos** → `['production','development']` |

**Distinct stores, disjoint environment bindings.** Preview writes cannot reach
production data.

### Three independent confirmations

1. **Storage bindings** — the table above.
2. **Runtime** — the new routes return `401` on Preview (flag on, auth-gated) and
   `404` on `jkissllc.com` (flag off, surface absent). The flag check runs *before*
   the auth check, so the status code is a reliable flag probe.
3. **Dataset contents** — Preview held 5 bookings numbered from `JK-B-1001` on a
   fresh counter, all `quote_received`, with smoke-test names, and **0 staff,
   0 equipment, 0 users**. Not a production dataset.

### Additional safety properties found

- **Preview has no Twilio, no Resend, and no AI gateway credentials.** The
  environment is structurally incapable of contacting a customer.
- **Vercel crons run only against Production**, so a booking in the Preview KV can
  never be picked up by the production reminder cron.

### Production untouched

Baseline captured before any change: **42 production env vars**, fingerprint
`53f960e0ae1b45e508cc`. `BOOKING_ASSIGNMENT_ENABLED` is **absent from Production**.
No Production environment variable was created, modified, or deleted. No production
deployment was made. `jkissllc.com` `/api/health` and `/quote` both return `200`.

---

## 2. Test fixture (Preview only)

| Kind | Identity |
|---|---|
| Crew | `Sprint1 TestDriver` — Driver, default rate $175.00 |
| Crew | `Sprint1 TestHelper` — Helper, default rate $120.00 |
| Equipment | `Sprint1 Test Truck 26ft` — company-owned |
| Crew login | `sprint1.driver@preview.test`, role `crew`, linked to the driver's staffId |
| Booking | `JK-B-1009` — moving, 2026-07-24, 8am–10am, crewSize 2, $850 |
| Booking | `JK-B-1010` — junk removal, same slot (deliberate collision) |
| Route | `JK-R-1001` — contract route, same slot (cross-lane collision) |

**Note on `isTest`:** the booking was deliberately created **without** `isTest`.
An `isTest` booking is excluded from the crew portal feed, which would have made
steps 4–7 untestable. This was safe because the store is isolated and Preview
cannot send. See finding F3.

---

## 3. End-to-end workflow

| # | Step | Result |
|---|---|---|
| 1 | Create booking | ✅ `JK-B-1009`, status auto-advanced `→ confirmation_link_sent` |
| 2 | Assign crew | ✅ driver + helper, pay auto-resolved from roster (`17500`/`12000`, source `crew_default`) |
| 3 | Assign equipment | ✅ roster link + name snapshot `Sprint1 Test Truck 26ft` |
| 4 | Accept from crew portal | ✅ after correctly refusing an early clock-in |
| 5 | GPS clock in | ✅ `denied: false`, coords `32.7555 / -97.3308` persisted |
| 6 | Upload completion photos | ⚠️ persistence ✅ — Blob upload leg blocked by a **pre-existing** env gap (F1) |
| 7 | Clock out | ✅ `19:47:09` |
| 8 | Verify completion state | ✅ crew view and admin view both correct |

### Step 2–3 detail

The crew gap tracked correctly throughout: after the driver alone it reported
`{assigned: 1, required: 2, short: true, incomplete: true}`; after the helper,
`{assigned: 2, required: 2, short: false, incomplete: false}`. Re-assigning the
same person returned `409 duplicate_staff`.

### Step 4–5 detail — invariants held

```
clock_in BEFORE accept  → {"error":"not_confirmed","message":"Accept the job before you clock in."}
accept                  → {"ok":true}
clock_in WITH GPS       → {"ok":true,"already":false,"denied":false}
clock_in again          → {"ok":true,"already":true,"denied":false}     ← idempotent
clock_out               → {"ok":true,"already":false,"denied":false}
clock_out again         → {"ok":true,"already":true,"denied":false}     ← idempotent
```

### Step 6 detail — sanitization and accumulation

Two batches totalling six inputs were submitted, including hostile ones. Three
photos persisted:

| Input | Outcome |
|---|---|
| `…/completion-1.jpg` | stored |
| `…/completion-1.jpg` (duplicate) | **deduped** |
| `javascript:alert(1)` | **rejected** |
| `data:image/png;base64,AAAA` | **rejected** |
| `12345` (number) | **rejected** |
| `"  …/completion-2.jpg  "` | stored, **trimmed** |
| `…/completion-3.jpg` (second batch) | **accumulated**, did not replace batch 1 |

### Step 8 detail — what each side sees

**Crew:** own role, own pay, accept/clock timestamps, vehicle, co-worker *names
only*. No customer money — no invoice total, no balance, no payment state.

**Admin:** both crew with pay snapshots and sources, GPS coordinates (the owner's
proof), completion timestamp + `jobCompletedBy: crew`, note, 3 photos, and the
derived `assignedTo` / `assignedHelper`.

---

## 4. Validation checks requested

### ✅ Booking status transitions correctly
Create → `confirmation_link_sent` (the existing POST handler's own logic).
Critically, **recording completion did NOT change `BookingStatus`** — it stayed
`confirmation_link_sent` while `jobCompletedAt` was set. This is the designed
separation: proof-of-work must never silently close out a job's money.

### ✅ Equipment conflicts are detected
Live from `/api/admin/schedule`, **cross-lane**:

```
[error] crew_overlap      (booking + route) Sprint1 TestDriver double-booked 2026-07-24 (JK-B-1009 and JK-R-1001)
[error] vehicle_overlap   (booking + route) Sprint1 Test Truck 26ft double-booked (JK-B-1009 and JK-R-1001)
[error] equipment_overlap (booking + route) Sprint1 Test Truck 26ft double-booked (JK-B-1009 and JK-R-1001)
```

This is the Sprint 1 thesis confirmed against a running system: a crew member and
a truck double-booked across a **contract route** and a **customer moving job** are
now caught — by the pre-existing conflict engine, with no changes to
`conflicts.ts`. Before Sprint 1 this was structurally undetectable.

### ✅ Completion photos persist correctly
Verified above, including dedup, scheme rejection, trimming, and accumulation
across two field uploads. See F1 for the Blob transport caveat.

### ✅ Admin can see the completed job
Verified via `GET /api/admin/bookings/{token}` — full crew, pay, GPS, completion,
photos.

### ✅ No regressions in the existing booking flow

| Surface | Status |
|---|---|
| `/api/portal/routes` (legacy feed) | `200` — contains **only** routes; no booking fields leaked |
| `/api/portal/me`, `/availability`, `/pay` | `200` |
| `/api/admin/bookings`, `/routes`, `/schedule`, `/equipment` | `200` |
| Public `/`, `/quote`, `/api/health` | `200` |
| Production `jkissllc.com` `/quote`, `/api/health` | `200` |
| Full unit suite | **1694 / 1694 pass** |

### ⚠️ Crew availability updates — the premise needs correcting
Assignment does **not** update crew availability, and was never designed to.
`lib/crew-availability.ts` is a **weekly declaration the crew submit themselves** —
"an input, not a promise", per its own header. Nothing derives it from assignments.

What *does* update when you assign is the **conflict state** in the unified
schedule, which is how the system reasons about "this person is already booked".
That path is verified above.

This is a genuine product gap rather than a bug: the availability surface does not
show assigned load, so a manager consulting availability sees what someone *said*
they could work, not what they are *already on*. Recommend folding this into
Sprint 5. Recorded as F4.

---

## 5. Findings

### F1 — Blob upload is not configured in Preview (pre-existing, not Sprint 1)
`BLOB_READ_WRITE_TOKEN` is **absent from Preview** and **present in Production**.
The Preview blob store exposes only `BLOB_STORE_ID` and `BLOB_WEBHOOK_PUBLIC_KEY`.

Confirmed pre-existing: the **admin invoice-photo broker** (`/api/admin/blob-upload`,
untouched by Sprint 1) fails identically in Preview with the same error. So photo
upload has never worked in Preview for any surface.

*Impact:* the Blob transport leg of step 6 could not be exercised. The Sprint 1
persistence, sanitization, and accumulation logic was fully validated by supplying
URLs directly. **Not a Sprint 1 defect.**

*Recommendation:* add a Preview-scoped `BLOB_READ_WRITE_TOKEN` for the
`operion-preview-blob` store, then re-run step 6 end to end. This also unblocks
testing admin invoice photos in Preview.

### F2 — DEFECT (found here, fixed): stale customer-facing crew name
**Severity: moderate — customer-visible.**

Removing the **last** roster crew member left `assignedTo` naming someone no longer
on the job. That name appears on the customer's confirmation page. It also produced
a **phantom `crew_overlap`** on the schedule, because the projector falls back to
the legacy free-text names when there is no roster crew, and conflict detection
matches those by name.

Observed live:
```
crew: []                                       ← unassign worked
customerFacing: {assignedTo: "Sprint1 TestDriver"}   ← stale
[error] crew_overlap … (JK-B-1009 and JK-B-1010)     ← phantom
```

*Root cause:* `persist()` skipped the name derivation when the crew list was empty,
on the theory that it was protecting a name the owner had typed by hand. On a
roster-managed booking that name was **derived, not typed** — and
`unassignCrewFromBooking` had already destroyed the evidence by setting
`assignees = undefined` when the list emptied.

*Fix* (commit `b5bbba6`): unassign keeps the array even when empty — its *presence*
marks the booking as roster-managed — and `persist()` derives whenever
`assignees !== undefined` rather than `assignees?.length`. A booking that was never
roster-managed still has `assignees === undefined`, so hand-typed names remain
untouched and the original guarantee is intact.

*Tests:* 3 regression tests added, including one that pins the stale-name shape
itself so a reintroduction surfaces as a phantom conflict rather than shipping
silently.

**This defect was invisible to the unit suite and only appeared against a running
system. It is the direct justification for having run this validation.**

*Re-verified live* on the redeployed Preview (`dpl` alias `jkissllc-52vw5impf`):

```
after assign   → customerFacing: {assignedTo: "Sprint1 TestDriver"}
after unassign → crew: []   customerFacing: {assignedTo: None, assignedHelper: None}   ← cleared
```

Schedule after the fix — the phantom is gone, the genuine cross-lane conflicts
remain, and the un-crewed booking now reports the *accurate* signal:

```
[error]   crew_overlap      (booking + route)  JK-B-1009 and JK-R-1001
[error]   vehicle_overlap   (booking + route)  JK-B-1009 and JK-R-1001
[error]   equipment_overlap (booking + route)  JK-B-1009 and JK-R-1001
[warning] missing_crew      (booking)          JK-B-1010 … with no crew assigned
PHANTOM crew_overlap on the un-crewed JK-B-1010: 0   (expected 0)
```

`JK-B-1009` re-verified intact after the fix: both crew with pay snapshots,
vehicle, `jobCompletedBy: crew`, 3 photos, status still `confirmation_link_sent`.

### F3 — `isTest` bookings are invisible to the crew portal
The portal feed filters `!b.isTest`, so a sandbox-flagged booking cannot be used to
exercise the crew workflow. "Safe test data" and "testable" are currently in
tension. Correct for production hygiene, but it means future end-to-end tests must
use real records in an isolated store (as this one did). Worth an explicit decision
before Sprint 2.

### F4 — Availability does not reflect assigned load
See §4. Product gap, recommend Sprint 5.

### F5 — Preview auto-deploy did not trigger on push
`git push` to `feat/booking-job-assignment` did not produce a new Preview build;
the deployment had to be made explicitly with `vercel deploy`. Worth checking the
Git integration's branch settings.

---

## 6. Cleanup state

The following **Preview-only** records were created and remain in the Preview KV:
2 staff, 1 equipment, 1 crew user, 2 bookings (`JK-B-1009`, `JK-B-1010`), 1 route
(`JK-R-1001`). They are harmless test data in an isolated store and are useful for
re-running the flow after the F1 blob fix. Say the word and I will delete them.

**Nothing in Production was created, modified, or deleted.**

---

## 7. Verdict

**The Sprint 1 end-to-end workflow is confirmed.** A customer booking can be
crewed from the roster, given a truck, accepted by the crew member in the portal,
clocked in and out with GPS, and completed with photographic proof — with the
admin seeing all of it, and with cross-lane crew and equipment conflicts detected
against a running system.

One customer-visible defect was found and fixed. Two environment gaps (F1, F5) and
two product gaps (F3, F4) are recorded and none block Sprint 2.

**Remaining before Sprint 2 is considered fully de-risked:** re-run step 6 over the
real Blob transport once F1 is configured. Everything else is verified.

Flag remains **OFF in Production**. Nothing merged. Nothing deployed to Production.
