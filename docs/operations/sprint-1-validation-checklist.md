# Sprint 1 — Preview Validation Checklist (manual-assisted)

Branch `feat/booking-job-assignment` @ `54fe993` · flag `BOOKING_ASSIGNMENT_ENABLED=true` (Preview only)
Preview: `https://jkissllc-iu44fu95p-nunubaby-6829s-projects.vercel.app`
Production flag: absent — verified 404 on all Sprint 1 endpoints.

Record PASS / FAIL + what you actually saw for each ID. Send the IDs back; I'll complete the report.

---

## 0. Read first — four behaviors that look like bugs but are intended

| # | Behavior | Why |
|---|---|---|
| **G1** | **Do NOT mark the booking "Test Data."** | `isTest` bookings are filtered out of the crew portal feed (`app/api/portal/jobs/route.ts`) **and** the unified schedule (`app/api/admin/schedule/route.ts`). Marking it test makes steps 4–8 and the conflict check silently impossible. |
| **G2** | **Completing the job does NOT change booking status.** | `recordBookingCompletion` deliberately never touches `BookingStatus` — the owner closes the job out. Status still "confirmed" after step 8 is **correct**. |
| **G3** | **Assigning crew sends no notification.** | Assignment texts nobody and emails nobody, by design. Don't wait for a message. |
| **G4** | **Equipment conflicts do not block assignment.** | `setBookingEquipment` only checks the roster. Detection is read-side, in the schedule view. A conflicting assignment **succeeds**, then surfaces as a conflict. |

---

## 1. Pre-flight — tenant isolation (do this BEFORE writing any data)

The workflow writes timeclock punches, which are payroll-relevant. `app/lib/redis.ts` has
**no environment-level key namespacing** — isolation depends entirely on Preview's KV
credentials pointing at a different Upstash database.

| ID | Check | Pass condition |
|---|---|---|
| **ISO-1** | Vercel → project **jkissllc** → Storage. Two Upstash stores exist: `OperionPreview`, `jkissllc-analytics`. Note which environment each is connected to. | `OperionPreview` is connected to **Preview**; the other serves **Production**. They are different stores. |
| **ISO-2** | Vercel → Settings → Environment Variables → `KV_REST_API_URL`. Compare the **Preview** value against the **Production** value (dashboard shows values; `vercel env pull` redacts them). | The two hostnames **differ**. Identical host = shared database — **stop, do not run the workflow.** |
| **ISO-3** | Same comparison for `KV_REST_API_TOKEN` and `BLOB_STORE_ID`. | Preview values differ from Production. |

**ISO-4 — what tenancy does *not* give you.** `TENANCY_ENABLED` namespaces keys as
`t:{tenantId}:{key}` — that separates *tenants*, not *environments*. Two environments sharing
one Upstash database with the same tenant id collide on identical keys. Tenancy passing is
**not** evidence of Preview/Production isolation. Only ISO-1/ISO-2 settle it.

> If ISO-1/ISO-2 fail, stop and tell me. Everything below writes real records.

---

## 2. Admin test login requirements

| Item | Requirement |
|---|---|
| Vercel access | Preview is behind Vercel SSO. Be logged into the `nunubaby-6829s-projects` team in the same browser, or the URL 302s to `vercel.com/sso-api`. |
| URL | `{PREVIEW}/admin` |
| Option A — owner | Password only (no email) → `POST /api/admin/auth`, checked against **`ADMIN_PASSWORD` (Preview scope)**. Yields role `owner`. Simplest path. |
| Option B — admin/manager | Email + password → `POST /api/auth/login`. Account must exist in the **Preview** data store. |
| Permissions needed | `crew:view`, `crew:assign`, `equipment:assign`. Held by `owner`, `admin`, `manager`. |
| Will not work | A **crew** account — `useAdminSession` redirects crew to `/portal`. |

## 3. Crew test login requirements

The crew member must satisfy **all five** or steps 4–8 fail:

| # | Requirement | Where it bites |
|---|---|---|
| C1 | A **staff roster record** exists in Preview, with `active !== false` | `assignCrewToBooking` → `inactive_staff` |
| C2 | A **user account** with email + password, `role === 'crew'`, linked `staffId` | `requireCrew()` → 403 `not_a_crew_account` |
| C3 | That crew member is **assigned to this booking** (step 2) | portal returns 404 — indistinguishable from absent, by design |
| C4 | **Timeclock enabled** for them (`staffUsesTimeclock`) | step 5 → 403 `timeclock_off` |
| C5 | Browser **location permission** granted | punch still records with `denied: true` (best-effort, not a failure) |

Login URL: `{PREVIEW}/portal`

---

## 4. The eight steps

### Step 1 — Create booking
- **Do:** `/admin/bookings` → create a booking. Give it a **scheduled date** (needed for Step 3a). **Leave "Test Data" off (G1).**
- **Expect:** booking created with a `bookingNumber` and a `token`. Note the token — every later URL uses it.
- **State:** `bk:{token}` written; `bk:num:{bookingNumber}` → token; `bk:index` gains the token (score = `updatedAt`).
- **Fail if:** creation 403s (insufficient role), or the record lands with `isTest: true`.
- **ID: `S1`**

### Step 2 — Assign crew
- **Do:** `/admin/operations/book-now/{token}` → **Crew** panel → add your crew member.
- **Expect:** 200. Row appears with a **pay figure** resolved from the roster. "Customer sees" line shows the derived name.
- **State:** `assignees[]` gains `{staffId, name, phone, role, jobToken, payCents, paySource}`; `assignedTo` / `assignedHelper` **re-derived** (first driver leads).
- **Fail if:** the Crew panel is **invisible** (API 404 → flag not live); `400 unknown_staff` / `inactive_staff`; `409 duplicate_staff`; `400 invalid`.
- **ID: `S2`**

### Step 3 — Assign equipment
- **Do:** Same panel → pick a truck from the equipment roster.
- **Expect:** 200; the truck's name shows as the vehicle.
- **State:** `equipmentId` set; `vehicle` set to a **name snapshot** taken at assign time.
- **Fail if:** `400 unknown_equipment`.
- **ID: `S3`**

### Step 3a — Equipment conflict detection *(the "conflicts are detected" requirement)*
- **Do:** Assign the **same truck** to a second job — a route or another booking — on the **same date**. Then open the unified schedule view.
- **Expect:** the second assignment **succeeds** (G4), and the schedule reports an **equipment double-booking conflict** covering both items. This is the cross-lane check: conflicts key on `eq:{equipmentId}`, and bookings now project `equipmentId` into the schedule.
- **State:** none beyond Step 3 on each record.
- **Fail if:** no conflict appears. Confirm first that both items are **non-test**, **not archived**, and on the **same date** — any of those three suppresses it for reasons unrelated to Sprint 1.
- **ID: `S3a`**

### Step 4 — Accept the job (crew portal)
- **Do:** Log in at `{PREVIEW}/portal` as the crew member → the booking should appear under **My Jobs** → open it → **Accept**.
- **Expect:** 200. Job shows accepted.
- **State:** on that assignee — `confirmedAt` set, `confirmedVia: 'link'`, `confirmIp` recorded; any prior `declinedAt` / `declineReason` cleared.
- **Fail if:** the job **isn't listed** → `isTest`, archived, not assigned, or flag off. Tapping Accept twice must be **idempotent** and keep the **first** timestamp.
- **ID: `S4`**

### Step 5 — Start GPS clock
- **Do:** Clock in. Allow location when prompted.
- **Expect:** `{ ok: true, already: false, denied: false }`.
- **State:** `clockInAt` set on the assignee, with GPS captured.
- **Fail if:** `403 timeclock_off` (C4); `not_confirmed` → **Step 4 didn't persist — clocking in requires acceptance**; `denied: true` is *not* a failure (permission refused, punch still recorded).
- **ID: `S5`**

### Step 6 — Upload completion photos
- **Do:** Upload **two** photos from the job screen. Try re-uploading one to test dedupe.
- **Expect:** upload token minted, blobs stored, URLs attached to the job.
- **State:** `completionPhotos[]` **accumulates** (a second upload adds, never replaces); http(s) only, deduped, capped.
- **Fail if:** 404 (flag off) / 401 (not crew); file rejected — allowed types are jpeg, png, webp, heic, heif, max **15 MB**.
- **ID: `S6`**

### Step 7 — Clock out
- **Expect:** 200.
- **State:** `clockOutAt` set.
- **Fail if:** `not_clocked_in` → Step 5 didn't persist.
- **ID: `S7`**

### Step 8 — Complete the job
- **Do:** Submit completion (optional note).
- **Expect:** completion recorded.
- **State:** `jobCompletedAt` set; `jobCompletedBy: 'crew'`; note trimmed to 2000 chars. **`BookingStatus` unchanged (G2).**
- **Fail if:** the booking status **changes on its own** — that is a real defect, report it.
- **ID: `S8`**

### Step 9 — Verify the admin view
- **Do:** Reload `/admin/operations/book-now/{token}`.
- **Expect:** crew row shows accepted + clock-in + clock-out times; completion photos and note visible; equipment shown.
- **Fail if:** any timestamp recorded in the portal is missing here (read/write path divergence).
- **ID: `S9`**

---

## 5. Final isolation confirmation (after the run)

| ID | Check | Pass condition |
|---|---|---|
| **ISO-5** | Open **Production** admin (`www.jkissllc.com/admin`) and search the booking number from S1. | **Not found.** Its presence means Preview wrote to Production data. |
| **ISO-6** | Confirm the crew member's Production timeclock/pay shows **no** punch for the test window. | No punches. This is the payroll-safety check. |
| **ISO-7** | Confirm no real customer/crew notification was sent during the run. | None — assignment sends nothing (G3); verify nothing else fired. |

---

## 6. Cleanup

- Archive or delete the test booking in Preview.
- Remove the second conflicting assignment from S3a.
- Leave the Preview flag in place if a re-run is likely; otherwise `vercel env rm BOOKING_ASSIGNMENT_ENABLED preview`.

---

## 7. Send back

```
ISO-1 __  ISO-2 __  ISO-3 __
S1 __  S2 __  S3 __  S3a __  S4 __  S5 __  S6 __  S7 __  S8 __  S9 __
ISO-5 __  ISO-6 __  ISO-7 __
Notes / unexpected responses:
```

Sprint 2 stays blocked until S1–S9 are recorded.
