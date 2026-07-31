# Operational readiness — baseline, observation, monitoring, rollback

Sprint 7. Covers the operational-gap log, the 24-hour and seven-day observation
windows, monitoring, and rollback.

**The observations below have NOT been performed.** They are elapsed-time
requirements, and the surface is built so they cannot be reported as done before
they are. `windowStatus()` derives completion from timestamps plus the existence of
a follow-up reading; there is no stored flag to set.

---

## 1. Operational baseline — captured 2026-07-31T18:03:17Z

Machine-collected:

| Field | Value |
|---|---|
| Production build | `dpl_GgKwL43VgUsWf32CJt9MAdi3LXrt` |
| Commit | `06ed1c60` (PR #145, cron cadence) |
| Deployed | 2026-07-31T17:40:14Z |
| `/api/health` | `healthy` / HTTP 200 |
| Cron runs/day | **297** (was 1,393) |
| Upstash plan | paid / subscription (Vercel Marketplace `icfg_wSVJZtrAAQlPVsNBByTKQyA7`) |
| Billing period | 2026-07-01 → 2026-07-31T23:59:59Z |
| Spend this period | $0.18 |

**Not machine-readable — must be transcribed from the Upstash console:**

| Field | Where |
|---|---|
| Requests used | Console → the Production database → Details → COMMANDS gauge |
| Allowance | Same gauge (`n / 500k per month` on free tier) |

The Vercel Marketplace API exposes **spend, not usage**, and the store's own
credentials are Production-only and redacted (`vercel env pull` returns
`[SENSITIVE]`). So the count is an **externally sourced reading**. The API refuses
one that arrives without a stated source — a transcribed number with no provenance
is indistinguishable from a guess, and this surface exists to stop guesses being
read as observations.

> ⚠️ The console workspace selector defaults to **Personal**. The Production
> database lives in the **Vercel-linked** workspace, not Personal. The right
> database is the one whose COMMANDS gauge is highest — a database reading `1 / 500k`
> is not the one serving Production.

### Expected 24-hour consumption from the new schedule

Derived from Production telemetry (`estimatedRedisRequests: 16` per `ai-jobs` tick,
measured 2026-07-31T17:24:34Z) and the PR #145 schedule:

| cron | runs/day | est. req/run | est. req/day |
|---|---|---|---|
| ai-jobs | 96 | ~16 | ~1,540 |
| reminders | 96 | ~5 | ~480 |
| operion-reconcile | 48 | ~5 | ~240 |
| operion-sync | 48 | ~5 | ~240 |
| vision-shadow | 4 | ~5 | ~20 |
| shadow-alerts | 4 | ~5 | ~20 |
| daily | 1 | ~50 | ~50 |
| **cron total** | **297** | | **≈ 2,600/day** |

Plus request-driven traffic (admin pages, portal, public booking), which is not
scheduled and therefore not projectable from here.

**Projection: ≈ 78,000 requests/month from crons alone — about 16% of a 500,000
allowance**, against ~369k/month before PR #145.

Only the observation confirms this. Per-run costs other than `ai-jobs` are
estimates, not measurements.

---

## 2. Follow-up procedure — READ-ONLY, sparse by design

Polling Redis to measure Redis consumption corrupts the measurement. Take **two
readings, days apart**. Do not script a poll.

### At T+24h (on or after 2026-08-01T18:03Z)

1. Read the console gauge (see the warning above about workspaces).
2. Single health probe: `curl -s https://www.jkissllc.com/api/health` — 1 write + 1 read.
3. Record it:

```
POST /api/admin/operations/readiness
{
  "action": "capture_reading",
  "id": "ops_followup24h",
  "kind": "follow_up",
  "build": "<from /api/health>",
  "health": "healthy",
  "cronRunsPerDay": 297,
  "estimatedRedisRequestsPerDay": 2600,
  "upstash": { "requestsUsed": <gauge>, "allowance": 500000,
               "source": "upstash console — <db name> — Details tab" }
}
```

4. `GET /api/admin/operations/readiness` returns the delta, the projection, and
   whether the projected 30-day total fits the allowance.

### At T+7d (on or after 2026-08-07T18:03Z)

Same, with `"id": "ops_followup7d"`. A follow-up only satisfies a window it
actually outlasted — a reading taken at T+24h does **not** close the seven-day
window, and the API enforces that rather than trusting the label.

### Reading the result

`GET` returns a `verdict`. It is **not ready** while any of these hold:

- an open `blocker` gap exists;
- the 24-hour window is incomplete;
- the seven-day window is incomplete.

Each reason states how far short it is (e.g. `seven-day_observation_incomplete:10h/168h`).

---

## 3. Recording gaps during the window

```
POST /api/admin/operations/readiness
{ "action": "record_gap", "id": "gap_<id>", "severity": "blocker|degraded|papercut",
  "surface": "book-now|crew-portal|admin|…", "summary": "…", "detail": "…" }
```

`blocker` means someone could not do their job. Re-recording the same id preserves
the original observation time and observer, so a retry cannot backdate or
re-attribute a gap. Resolve with `{"action":"resolve_gap","id":"…"}`; the first
resolution time stands.

Authorization: reading takes `audit:view` (admin only), writing takes
`settings:manage` (admin only). Tenant-scoped throughout.

---

## 4. Monitoring

| Signal | Where | Means |
|---|---|---|
| `/api/health` | public, unauthenticated | `unhealthy` + 503 ⇒ a **critical** component is down. KV is the only critical one. |
| `[ALERT] health_critical` | Production logs | `errorClass: kv_unreachable` — fires every health probe while KV is down |
| `[cron/ai-jobs] selection` | Production logs | per-tick `estimatedRedisRequests` and `fullScanPerformed` |
| `due_index_read_failed` | Production logs, CRITICAL | with the index enabled, the tick did **no work** |
| `ERR max requests limit exceeded` | Production logs | Upstash quota exhausted — the July 31 outage signature |

Health is deliberately a **single** write+read. Do not build a dashboard that polls
it aggressively; that turns the monitor into a consumer of the thing it monitors.

---

## 5. Rollback

| Action | Rollback |
|---|---|
| PR #145 cron cadence | `git revert` and redeploy. Cadence ships as code, so rollback is a deploy, not a console change. |
| PR #144 due-index code | Inert by default — both flags off, scan authoritative. Nothing to roll back unless enabled. |
| Enabling `OPERION_DUE_INDEX` | Unset it. The scan path is untouched and resumes next tick; no migration either way. |
| Due-index backfill | `DEL aidue:index`, `DEL aidue:final`. A cache of derivable truth; with the read flag off, deleting changes nothing that runs. No booking or job is modified by the backfill. |
| Upstash plan change | Downgrade after the billing period. |
| A bad Production deploy | Vercel → Deployments → promote the previous READY build. Verify `/api/health` reports the expected `build`. |

---

## 6. Outstanding operational follow-ups

These are **not** engineering work and are **not** complete:

- [ ] **T+24h reading** — earliest 2026-08-01T18:03Z
- [ ] **T+7d reading** — earliest 2026-08-07T18:03Z
- [ ] Confirm projected monthly consumption fits the allowance once both readings exist
- [ ] Decide on `OPERION_DUE_INDEX` — currently off; worth ~1,300 req/day at present volume, more as bookings grow

Current state of the seven-day window: **not started against a recorded baseline**
until the baseline above is captured through the API. Capturing it is step one of
the follow-up.
