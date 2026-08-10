# Punch Engine — Activation Handoff

> **Purpose.** A self-contained brief for an agent or engineer with **no prior context** to
> take the punch engine from "shipped, flags off" to "safely enabled in Production".
> Everything under *Verified ground truth* was established by direct inspection of the
> repository and the live system — treat it as fact rather than re-deriving it.
>
> **Written:** 2026-08-09 · **Updated:** 2026-08-09 (dry-run shipped, `c1deff4`)
> **Production:** `680d363` / `dpl_DRVCTFMZ2V8tuV3FNBGHyfK1sKSD`
>
> **NOTHING IN THIS DOCUMENT AUTHORISES ENABLING A FLAG.** Both flags are off, and the
> work below exists to earn the right to turn them on — not to assume it.

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

### B1 — Concurrency is unproven → #189
Blocks `SINGLE_OPEN_PUNCH_ENABLED`.

All 25 tests run a **single caller** against an in-memory `Map`. The feature exists to
arbitrate simultaneous clock-ins, and that scenario is untested. **The most likely place
for this to be wrong is the place not covered.**

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

---

## Evidence required before flipping

| # | evidence | who verifies |
|---|---|---|
| E1 | Concurrent clock-in test on the KV emulator: exactly one punch, losers get `other_open_punch`, retries converge, stale state does not corrupt the index | #189 |
| E2 | **Mutation:** remove the policy lock → the "exactly one punch" assertion fails | #189 |
| E3 | Preview run against **real Upstash**, concurrent, flag ON in Preview only | #189 |
| ~~E4~~ | ~~Dry-run writes zero keys, plan matches the subsequent real run, marker stays absent~~ — **SATISFIED** by #190 (`c1deff4`), 11 tests + 2 mutations | ✅ |
| **E4b** | **A dry run actually RUN against Production**, reporting the live open-punch population and drift. **Not yet done** — no authorised Production KV access from a developer machine | operator |
| E5 | Production `reconcile` reports zero drift after backfill | operator |
| E6 | Rollback rehearsed: flag off with a populated index leaves behaviour unchanged | B5 |

E1–E2 are local. **E3 and E5 cannot be produced from a developer machine** — they need
Preview and authorised Production access respectively.

---

## Completion criteria

`OPEN_PUNCH_INDEX_ENABLED` may be enabled when **E4b + E5** hold and B3's order is followed.
E4 is satisfied; the capability exists. What remains is *using* it against Production.

`SINGLE_OPEN_PUNCH_ENABLED` may be enabled when **E1 + E2 + E3** hold, the index has been
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
