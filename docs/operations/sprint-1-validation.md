# Sprint 1 Validation — Booking Job Assignment

**Status: PARTIAL — setup complete, operational test BLOCKED (see §4).**
Branch `feat/booking-job-assignment` @ `54fe993` · flag `BOOKING_ASSIGNMENT_ENABLED`
Date 2026-07-21 · Not merged · Production untouched

---

## 1. Environment

| Item | Value |
|---|---|
| Branch | `feat/booking-job-assignment` (`54fe993`, 2 commits on `a5f647d`) |
| Preview | `https://jkissllc-iu44fu95p-nunubaby-6829s-projects.vercel.app` (Ready) |
| Preview flag | `BOOKING_ASSIGNMENT_ENABLED=true` — **Preview scope only** |
| Production flag | **absent** (defaults `false`) |
| Features merged | none — no additional work pulled in |

---

## 2. Verified

**V1 — Test suite green on the branch.** `npm test` → **1691 pass / 0 fail**, matching the
recorded Sprint 1 baseline. No regressions introduced by the two Sprint 1 commits.

**V2 — Production is unaffected.** With the flag absent in Production, every Sprint 1
endpoint is dormant on the live site:

```
GET https://www.jkissllc.com/api/admin/bookings/{id}/assignment  -> 404
GET https://www.jkissllc.com/api/portal/jobs/{id}                -> 404
GET https://www.jkissllc.com/api/portal/upload                   -> 404
```

404 (not 401) is the flag-off signal: every handler checks the flag *before* auth and
returns `notFound()`, so the surface is indistinguishable from absent. This is the
strongest available evidence for the "no regressions in existing booking flow"
requirement on the production path.

**V3 — Flag scope is correct.** `vercel env ls production | grep BOOKING_ASSIGNMENT` → 0 rows.
The flag exists only in Preview.

**V4 — Model-level coverage.** `scripts/job-assignment.test.ts` holds 31 tests covering the
assignment shape, role matching, lead/helper derivation, declined-crew handling, pay
snapshots, crew-requirement math, equipment matching, duplicate-assignment rejection,
roster-link enforcement, completion-photo validation (http(s) only, deduped, capped), and
the flag default being `false`.

These are **pure-function tests**. They do not exercise HTTP, session auth, Redis
persistence, or the booking state machine end to end.

---

## 3. Not yet validated

Every item below requires the live operational run and is **unproven** as of this report:

- Booking status transitions across the full lifecycle
- Crew availability updates after assignment
- Equipment conflict detection in a live cross-lane scenario
- Completion-photo persistence to blob storage
- Admin visibility of the completed job
- Non-regression of the *interactive* booking flow (only the API surface was probed)

---

## 4. Blockers

**B1 — Preview is behind Vercel SSO deployment protection.**
Every request to the Preview host 302-redirects to `vercel.com/sso-api`. Automated access
needs a protection-bypass token, which is not currently configured. A human logged into
the Vercel team reaches it normally in a browser.

**B2 — No admin or crew credentials.**
Steps 1–3 need an admin session (`ADMIN_PASSWORD`, encrypted in Preview env). Steps 4–8
need a **crew** session: `requireCrew()` in `app/api/portal/_lib/crew.ts` admits only a
principal whose `role === 'crew'` with a `staffId`, and every portal query is scoped to
that id. An admin session cannot stand in for a crew session.

**B3 — Preview/Production data isolation is UNCONFIRMED.**
`app/lib/redis.ts` namespaces keys by **tenant** (`t:{tenantId}:{key}`, and only while
`TENANCY_ENABLED=true`). There is **no environment-level namespacing**. Isolation therefore
rests entirely on `KV_REST_API_URL`/`KV_REST_API_TOKEN` resolving to a different Upstash
database in Preview than in Production.

Evidence suggesting isolation is real: an Upstash resource named **`OperionPreview`** is
attached to the project, and the `KV_*` variables are Preview-scoped.
Why it is still unconfirmed: `vercel env pull` returns empty values for these keys
(redaction, a known trap in this project), and reading the decrypted values through the
API was correctly blocked.

**This matters because the operational test is not read-only.** It writes a booking,
mutates crew availability, and records **timeclock punches**, which are payroll-relevant.
Assigning a real crew member may also dispatch a real notification to that person.
Confirm the store binding before running it.

---

## 5. Runbook for the operational test

Once B1–B3 are resolved, run in one sitting against the Preview URL above.

| # | Step | Expected |
|---|---|---|
| 1 | Create a booking (admin) | Booking persists; status at initial state |
| 2 | Assign a real crew member | Assignee carries roster identity + job-link token; no free-text name |
| 3 | Assign equipment/truck | Cross-lane conflict check runs against the routes lane |
| 3a | Re-assign the same truck to an overlapping job | **Conflict detected and refused** |
| 4 | Accept from crew portal (`/portal`, crew login) | `acceptedAt` set; job appears under My Jobs |
| 5 | Start GPS clock | Punch recorded with lat/lng/accuracy; `locationDenied` path if permission refused |
| 6 | Upload completion photos | Only http(s) URLs stored, deduped, capped; blob persists |
| 7 | Clock out | Second punch recorded; interval closed |
| 8 | Verify completion state | Completion note + photos recorded; **BookingStatus unchanged** — see note |

**Note on step 8:** by design, `recordBookingCompletion` records proof of work and
**never changes `BookingStatus`** (`app/api/portal/jobs/[id]/route.ts`) — the owner still
closes the job out. A tester expecting the booking to flip to "complete" automatically
will misread this as a defect. Validate against intended behavior, not assumption.

Capture for each step: HTTP status, resulting record, and any notification actually sent.

---

## 6. Rollback

- Remove the Preview flag: `vercel env rm BOOKING_ASSIGNMENT_ENABLED preview`
- Delete the Preview branch: `git push origin --delete feat/booking-job-assignment`
- Production requires no action — the flag was never set there (V2, V3).

---

## 7. Gate

Sprint 2 remains **blocked**. The end-to-end workflow is not confirmed: §3 is entirely
unvalidated. Do not begin Sprint 2 until steps 1–8 have been executed and recorded.
