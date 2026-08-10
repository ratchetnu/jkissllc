# Punch Engine — Activation Handoff

> **Purpose.** A self-contained brief for an agent or engineer with **no prior context** to
> take the punch engine from "shipped, flags off" to "safely enabled in Production".
> Everything under *Verified ground truth* was established by direct inspection of the
> repository and the live system — treat it as fact rather than re-deriving it.
>
> **Written:** 2026-08-09 · **Updated:** 2026-08-09 (dry-run `c1deff4`; concurrency `a3e2873`;
> E3 Preview evidence + new blocker B6)
> **Production:** `680d363` / `dpl_DRVCTFMZ2V8tuV3FNBGHyfK1sKSD`
>
> **NOTHING IN THIS DOCUMENT AUTHORISES ENABLING A FLAG.** Both flags are off, and the
> work below exists to earn the right to turn them on — not to assume it.

---

## Status at a glance

| evidence | state |
|---|---|
| E1 concurrency on the KV emulator | ✅ satisfied (`a3e2873`) |
| E2 mutation: remove the policy lock | ✅ satisfied — fails 5 of 8 tests |
| **E3 Preview against real Upstash** | 🟡 **PARTIALLY SATISFIED** — concurrency proven; lock expiry (scenario 4) unproven |
| E4 dry-run capability | ✅ satisfied (`c1deff4`) |
| **E4b dry-run RUN against Production** | ⬜ **OPEN** |
| E5 Production reconcile clean after backfill | ⬜ open |
| E6 rollback rehearsed with a populated index | ⬜ open |
| **B6 orphan-handling decision** | ⬜ **OPEN — new blocker found during E3** |

**Nothing has been run against Production — no backfill, no dry run, no flag change.**
E3 ran against the **Preview** store (`still-colt-145891`) with flags set **in-process only**;
no Vercel env var was changed, so no Preview deployment's behaviour was altered.
Both flags remain `false` in code and unset in Production.

The four open items share one property: **none can be produced from a developer machine.**
E3 needs Preview with the flag on; E4b, E5 and E6 need authorised Production access. Every
item that *could* be closed locally now has been.

---

## Repo

`ratchetnu/jkissllc` — Next.js App Router, TypeScript, Vercel, Upstash Redis.
Read `AGENTS.md` first; it carries the conventions that have actually bitten here.

## The two flags

| flag | governs | code default | Production |
|---|---|---|---|
| `SINGLE_OPEN_PUNCH_ENABLED` | **enforcement** — refuse a second concurrent clock-in on a different job, same service date | `false` | **unset** |
| `OPEN_PUNCH_INDEX_ENABLED` | **optimisation** — an index so the check is O(1) rather than a scan | `false` | **unset** |

Unset ⇒ the registered default (`false`) applies. Both are inert today, and #187 proved
that inertness rather than asserting it.

---

## Verified ground truth

### What has shipped, flags off

| PR | commit | contents |
|---|---|---|
| #153 | `edc59bd` | One punch engine, one open-punch policy, the open-punch index, backfill + reconcile tooling, admin surface |
| #187 | `680d363` | Exhaustive error contract, phantom-punch fix, flag-off equivalence proofs |

### Resolved, with evidence

- **#184 — silent 404.** `/api/portal/clock` fell through to `404 not_found`, so a
  **deactivated** crew member was told the job did not exist. Now a `Record` over the
  union — exhaustive *by type*, so a new variant fails compilation. Policy-block collapse
  is a `never`-guarded switch, not a trailing ternary.
- **#185 — flag-off equivalence.** Policy and index both have direct flag-OFF tests, each
  paired with a flag-ON test proving it is not vacuous.
- **Phantom punch defect.** `clearPunchFromIndex` had **exactly one caller** (route lane).
  `unassignCrewFromBooking` destroyed a punch and cleared nothing — with the index on,
  unassigning from a booking would have blocked that crew member's next clock-in
  *permanently*, since no clock-out can close a record that no longer exists. Fixed in the
  engine so every future caller inherits it.
- **Mutation testing.** Three mutations; two initially passed. One was a two-layer guard
  (not a weak test); **one was a genuinely weak test** that called `clearPunchFromIndex`
  directly and proved nothing about the wiring. Replaced with an integration test.

Coverage: 25 new tests. Full suite **3591 / 0**.

### Tooling that already exists — do not rebuild it

Checked directly in `app/lib/timeclock/open-punch-backfill.ts` and
`/api/admin/operations/punch-index`:

| capability | status |
|---|---|
| Existing punch discovery | ✅ `enumerateOpenPunchesFromTruth()`, `snapshotBookingTokens()` |
| Index population | ✅ `backfillOpenPunchIndex(runId, now)` |
| Source/index reconciliation | ✅ `reconcileOpenPunchIndex({ repair })` |
| Mismatch reporting | ✅ `DriftReport` |
| Rerun safety / idempotency | ✅ converging upserts, lease-protected, marker written **last** |
| Admin surface | ✅ `POST /api/admin/operations/punch-index` — `backfill`, `reconcile` |
| **Dry-run** | ❌ **missing — this is the gap** |

---

## Activation blockers

### ~~B1 — Concurrency is unproven~~ → **RESOLVED LOCALLY** (#189, `a3e2873`) — E3 still open

`scripts/punch-concurrency.test.ts` drives the policy against the **real KV emulator as a
child process**. That substrate is the point, not a convenience: the policy's lock is
**distributed** (`SET NX PX` over the store), and a stubbed `fetch` resolves synchronously
— handing the winner the lock before the loser ever asks. An in-process fake cannot
express this race at all. The emulator is single-threaded, which is how Redis executes
commands, so `SET NX` atomicity models production rather than approximating it.

**Flag-ON behaviour, proven:**

- 2-way and 5-way simultaneous clock-ins each produce **exactly one open punch**, asserted
  by reading the routes back — not by absence of error
- every loser is refused for a **named** reason (`other_open_punch` / `busy`), never a
  generic failure
- a refusal is a **result, never a rejection** (checked with `allSettled`)
- a refused caller retrying three times still converges on one punch
- the winner re-tapping its own job does not double-open
- after a race the index agrees with truth **in both directions**: no `missing` (which
  would under-report and permit a double clock-in) and no `extra` (which would wrongly
  block a crew member)

**Flag-OFF baseline, also proven — and it is what makes the above meaningful:** the same
race with enforcement off produces **TWO open punches**. That is today's behaviour, and
exactly what the flag exists to stop. Without this baseline the flag-ON assertions could
pass for reasons unrelated to the policy.

**Mutation validation complete:** removing the distributed lock — same checks, no mutual
exclusion — **fails 5 of the 8 tests**. The coverage is load-bearing, not decorative.

**What it still does not prove → E3.** No network partition, no Upstash latency, no lease
expiry under real wall-clock pressure. B1 is closed *locally*; the Preview half is not.

### ~~B2 — No dry-run before the first backfill~~ → **RESOLVED** (#190, `c1deff4`)

`planOpenPunchBackfill()` now reports the live population, what a real run would write,
what it would remove as stale, drift in both directions, and whether the index is already
authoritative — **without a single write**.

Three properties are enforced rather than intended, each pinned by a test:

- **takes no lease**, so a planning run can never block the real run it is planning
- **never writes the ready marker** — the one write that changes how the system behaves
- **never calls** `markPunchOpen` / `markPunchClosed`

The route's dry-run branch returns *before* `runId` is minted, so a planning request is
structurally incapable of falling through into a real backfill.

Verified against the **real KV emulator as a child process** — the entire store dump is
compared before and after, which catches a rewritten value a key-count would miss.
Mutation-checked twice: making the planner write entries fails the no-writes test; making
it write the marker fails four tests including authoritativeness.

**Surface:** `POST /api/admin/operations/punch-index` with `{ "action": "backfill", "dryRun": true }`
(permission: `settings:manage`).

**B2 is resolved as a capability. It has NOT been exercised against Production** — see the
open item below.

### B3 — Flag order is load-bearing
An index that is authoritative but **unpopulated** reads as *"nobody has an open punch."*
That fails **open** — permitting exactly the double clock-in the policy prevents.

Correct order: **backfill → reconcile (verify coverage) → `OPEN_PUNCH_INDEX_ENABLED` →
observe → `SINGLE_OPEN_PUNCH_ENABLED`.**

### B4 — The 503 is a new crew-visible refusal
Flag-on, a crew member whose punches cannot be verified is **refused**
(`punch_policy_unavailable`, 503) rather than allowed through. Correct default for a
payroll input — but a real behaviour change, and the copy is what someone reads at 7am.
Needs an explicit decision, not a discovery.

### B5 — Stale index while the flag is off
Tests prove nothing is *written* with the index off. A **previously populated** index
going stale while the flag is off is a different state and is **not covered**. Matters for
rollback: turning the flag off does not empty the index.

### B6 — Orphaned punch index entries can block ALL clock-ins → **NEW, found during E3**
Blocks `OPEN_PUNCH_INDEX_ENABLED`. **A decision is required before activation.**

**Problem.** An `rt:index` entry whose `rt:{token}` record is missing makes
`enumerateOpenPunchesFromTruth()` refuse to complete:

```
INCOMPLETE: indexed route e3cddc40A02… has no readable record
```

**Impact.** Every clock-in then returns `coverage_unavailable` (503) — for **every crew
member**, not just the one whose route is orphaned. Observed live during E3: five
consecutive attempts across separate crew all refused, and `reconcile`, `backfill` and the
dry run all reported incomplete for the same reason.

**Why this matters.** The **security** posture is right — it fails closed, so no duplicate
punch can slip through. The **operational** posture is not: there is no isolation and no
self-healing. One bad index member is a **total timeclock outage** until a human
reconciles, and nothing currently detects the condition or reports it.

The orphan is easy to create: any path that deletes a route record without `zrem`-ing
`rt:index` produces one. During E3 this was reproduced accidentally by exactly that
mistake in cleanup code.

**Required before activation — pick one:**

| option | shape | trade |
|---|---|---|
| **A** | Reconciliation automatically removes orphaned index entries | self-healing, but repairs silently — drift can hide |
| **B** | The clock-in path ignores invalid index members and records drift | no outage; needs care that "ignore" cannot become "under-report" and permit a double clock-in |
| **C** | An operational repair command + runbook exists, and monitoring detects drift | no code change to the hot path; relies on someone being paged |

**Recorded as a decision, not a recommendation.** A and B change failure behaviour on a
payroll input and deserve an owner's judgement; C accepts the outage risk in exchange for
leaving the hot path untouched. Tracked as **E7**.

---

## Evidence required before flipping

| # | evidence | who verifies |
|---|---|---|
| ~~E1~~ | ~~Concurrent clock-in test on the KV emulator~~ — **SATISFIED** by #189 (`a3e2873`), 8 tests incl. the flag-OFF baseline | ✅ |
| ~~E2~~ | ~~**Mutation:** remove the policy lock~~ — **SATISFIED**: removing it fails 5 of 8 tests | ✅ |
| **E3** | **Preview run against real Upstash** — 🟡 **PARTIALLY SATISFIED** (see below). Concurrency, contention, refusal and reconciliation proven; **scenario 4 lock expiry NOT proven** | ⬜ |
| ~~E4~~ | ~~Dry-run writes zero keys, plan matches the subsequent real run, marker stays absent~~ — **SATISFIED** by #190 (`c1deff4`), 11 tests + 2 mutations | ✅ |
| **E4b** | **A dry run actually RUN against Production**, reporting the live open-punch population and drift. **Not yet done** — no authorised Production KV access from a developer machine | operator |
| E5 | Production `reconcile` reports zero drift after backfill | operator |
| E6 | Rollback rehearsed: flag off with a populated index leaves behaviour unchanged | B5 |
| **E7** | **Orphan-handling decision made and implemented** (B6, option A / B / C) | ⬜ |

E1–E2 are local. **E3 and E5 cannot be produced from a developer machine** — they need
Preview and authorised Production access respectively.

---

## E3 — Preview evidence (real Upstash), 2026-08-09

Run against the **Preview** store `still-colt-145891` — Production is `smooth-vulture-92540`
and was never touched. Flags were set **in-process only**; no Vercel env var was changed, so
no Preview deployment's behaviour was altered for anyone else.

### Satisfied

| scenario | result | latency |
|---|---|---|
| 2 simultaneous, one crew, two jobs | **1 open punch**; loser `other_open_punch` | 7.2s / 10.1s |
| 5 simultaneous, one crew, five jobs | **1 open punch**; 3× `other_open_punch`, 1× `busy` | 7.0–15.8s |
| 5 **different** crew simultaneously | **5 open punches**, zero refusals | 6.7–7.0s |
| retry after refusal (×3) | still **1 punch**; `other_open_punch` each time | 3.3s |
| reconciliation | truth 9 / indexed 9, **drift 0** | 5.4s |

Zero errors across all scenarios. The multi-crew case matters as much as the contention
cases: it proves the lock is genuinely **per-staff**, so five crew members do not falsely
block one another.

### NOT satisfied — scenario 4, lock expiry

**Unproven, after two attempts.** Attempt 1 used a 2s probe TTL, which the policy's patient
retry simply outwaited — so "accepted" did not mean "not blocked" and the result is
meaningless. Attempt 2 used 6s but ran during the B6 outage window, so every call returned
`coverage_unavailable` and the result is uninterpretable.

**Stale-lease recovery therefore remains unproven.** It is recorded here as unproven rather
than inferred from the other five passing scenarios.

### Finding — scan-path latency confirms B3

With the index **not** authoritative the policy falls back to the full scan, and on real
Upstash that costs **7–15 seconds per clock-in**. That is not a viable crew experience.

This turns B3's ordering from a preference into a hard requirement: **backfill and verify
before `OPEN_PUNCH_INDEX_ENABLED`**, because the fallback is what a crew member would
otherwise live with.

### Finding — B6

See the blocker above. Discovered because an orphaned `rt:index` entry, created by cleanup
code that deleted a route record without removing it from the index, took the entire
timeclock down for the duration of the run.

### Cleanup

23 evidence routes and their orphaned index entries removed; ready marker cleared; the
store was **never flushed**. Verified afterwards: scan complete, **drift 0**,
`indexIsAuthoritative: false`, zero evidence routes remaining. All 23 orphans were ours;
no pre-existing entry was touched.

---

## Activation checklist

### Before `OPEN_PUNCH_INDEX_ENABLED`

- [ ] **Backfill dry run** — against Production, reporting the live population (**E4b**)
- [ ] **Production reconciliation** — zero drift (**E5**)
- [ ] **Index authoritative marker** — written by a real backfill, in the order B3 requires
- [ ] **Orphan handling decision** — B6 option A, B or C chosen *and implemented* (**E7**)

### Before `SINGLE_OPEN_PUNCH_ENABLED`

- [x] **Preview real-Upstash concurrency** — E3, five scenarios (**satisfied**)
- [ ] **Lock expiry validation** — E3 scenario 4 (**still unproven**)
- [ ] **Production evidence** — the index has been on and clean for an observation window
- [ ] **B4 decision recorded** — the flag-on 503 is a new crew-visible refusal

Order is not optional: the index flag comes first, and only after the fallback-latency
finding above is designed around.

---

## Completion criteria

`OPEN_PUNCH_INDEX_ENABLED` may be enabled when **E4b + E5 + E7** hold and B3's order is
followed. E7 (the B6 orphan-handling decision) is new and was not known when this document
was first written.
E4 is satisfied; the capability exists. What remains is *using* it against Production.

`SINGLE_OPEN_PUNCH_ENABLED` may be enabled when **E3 holds in full** — its concurrency half
is satisfied, its lock-expiry half is not — the index has been
on and clean for an observation window, and **B4 has an owner decision recorded**.

Neither may be enabled on the strength of a green local test run alone. The emulator
cannot express network partition, Upstash latency, or lock-TTL expiry under real
wall-clock pressure — so a green local run is necessary and *not sufficient*.

---

## Known limits of this document

- No authenticated Production UI verification was performed; admin surfaces were proven to
  exist and be auth-gated (`401`), not visually confirmed.
- **No Production backfill has been performed — real or dry.** The dry-run capability now
  exists (#190, `c1deff4`) but has never been pointed at Production, because no authorised
  Production KV access exists from a developer machine. **How many open punches exist
  today, and therefore how large the first backfill is, remains UNKNOWN.** Running the dry
  run is the next operator action, and it is safe: it writes nothing and cannot make the
  index authoritative.
- Test coverage above is measured by reference and by mutation, not by exhaustive audit.
  Two coverage claims in this repo have already proven vacuous under mutation, so treat
  counts as a floor.
