# Due-index recovery — staged sequence after the Redis request exhaustion

## What happened

`cron/ai-jobs` runs every 3 minutes (480 ticks/day). Both of its runners selected
work with `listBookings(500)`, which is **1 `ZRANGEBYSCORE` + one `GET` per
booking**. Two runners per tick ≈ **2N + 2 Redis requests**, where N is the number of
bookings in the index.

Against an Upstash quota of **500,000 requests** (≈16,667/day over a month):

| Bookings (N) | Requests/tick | Requests/day | Quota exhausted in |
|---|---|---|---|
| 25 | 52 | ~25,000 | ~20 days |
| 50 | 102 | ~49,000 | ~10 days |
| 100 | 202 | ~97,000 | ~5 days |
| 200 | 402 | ~193,000 | ~2.6 days |

The quota hit 500,000/500,000. Every KV call began returning
`ERR max requests limit exceeded`, so `/api/health` reported `unhealthy`
(`kv_unreachable`, HTTP 503) and the homepage returned 500.

## What the code change does

- `runDueFinalAiJobs` gains an indexed path. It previously had **none** — its
  `listBookings(500)` was unconditional.
- Both lanes read from their own ZSET: `aidue:index` (initial), `aidue:final`
  (final). Separate keys are required, not cosmetic: both are keyed by booking
  token, and one booking can hold an initial and a final job at once with different
  due times. One shared ZSET would let each lane overwrite the other's score.
- **The indexed path never falls back to a scan.** A failed index read returns
  `ok: false`, the tick processes nothing, alerts `due_index_read_failed`
  (CRITICAL), and retries next tick. Falling back would reinstate the exact query
  that caused the outage.
- Cron logs per tick: `selectedFromIndex`, `dueProcessed`, `staleRetired`,
  `missingRetired`, `indexReadFailed`, `estimatedRedisRequests`, and
  `fullScanPerformed`.

**Nothing is enabled by this change.** `OPERION_DUE_INDEX` and
`OPERION_DUE_INDEX_DARK_LAUNCH` both remain OFF, so the scan stays authoritative and
behaviour is byte-identical until someone deliberately flips it.

## ⚠️ Do NOT use dark-launch as the emergency enable step

`OPERION_DUE_INDEX_DARK_LAUNCH` makes `dueIndexMaintained()` true, which runs the
full scan **and** an index read for parity comparison every tick. Under quota
pressure that is **more** consumption, not less. Dark-launch is a correctness proof
for a healthy system, not a recovery lever.

## Staged recovery sequence

Every step is gated. Steps 1, 5 and 7 are Production actions requiring explicit
owner approval.

### 1. Restore Redis service — **owner action**

Upgrade the Upstash plan, or wait for the quota to reset.

*Rollback:* a plan upgrade is reversible by downgrading after the cycle. Waiting has
nothing to roll back.

### 2. Confirm health without a full scan

```
curl -s https://www.jkissllc.com/api/health
```

Expect `{"status":"healthy"}` and HTTP 200. This costs **one write + one read** — it
does not scan.

*Rollback:* read-only, none needed.

### 3. Bounded backfill — DRY RUN

```
POST /api/admin/ai/due-index   {"action":"backfill","dryRun":true,"pageSize":100,"maxPages":20}
```

Dry run is the **default**; only an explicit `dryRun:false` writes. Requires
`ai:prompts:manage` (admin). Resume with the returned `nextCursor` until
`complete: true`.

*Rollback:* writes nothing.

### 4. Report cost and counts

The response carries `indexed`, `scanned`, `wouldAdd`, `wouldRemove`, `dueNow`,
`estimatedRedisRequests` and `estimatedRequestsToComplete`. **Stop here and report**
before spending the write budget.

### 5. Real backfill — **owner approval required**

```
POST /api/admin/ai/due-index   {"action":"backfill","dryRun":false,"cursor":<resume>}
```

Cost ≈ one `ZRANGE` per page + one `GET` per booking + **two ZSET writes per
booking** (one per lane). Idempotent — safe to re-run from any cursor.

*Rollback:* `DEL aidue:index` and `DEL aidue:final`. The indexes are a cache of
derivable truth; with the read flag OFF, deleting them changes nothing that runs.
No booking or job is ever modified by the backfill.

### 6. Validate coverage

```
GET /api/admin/ai/due-index?action=coverage
```

Require `covered: true` and `missingFromIndex` empty for **both** lanes.
`missingFromIndex` is the dangerous direction — due per the booking record but
absent from the index, i.e. jobs that would be stranded if the read source flipped
now. Do not proceed while it is non-empty.

*Rollback:* read-only.

### 7. Enable the read path — **owner approval required**

Set `OPERION_DUE_INDEX=true` in Production. Do **not** set
`OPERION_DUE_INDEX_DARK_LAUNCH`.

*Rollback:* unset `OPERION_DUE_INDEX`. The scan path is untouched and resumes
immediately on the next tick; no data migration is involved either way.

### 8. Verify cron volume and health

Watch `[cron/ai-jobs] selection` for a few ticks. Expect:

- `fullScanPerformed: false`
- `source: initial:index,final:index`
- `estimatedRedisRequests` in single digits per tick, not `2N+2`
- `indexReadFailed: false`
- `/api/health` still `healthy`

Any `due_index_read_failed` alert means a tick did no work — investigate before
leaving it on.

*Rollback:* as step 7.

### 9. Continue Sprint 7

Only once Production KV is healthy and cron volume is confirmed low.

## Residual work

`listBookings(500)` still has ~20 other callers (admin lists, exports, portal jobs,
availability, analytics). Those are request-driven rather than every-3-minutes, so
they were not the outage, but they carry the same 1+N shape and are worth a separate
pass if quota pressure returns.
