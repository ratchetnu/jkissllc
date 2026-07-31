// Due-index backfill — bounded, resumable, idempotent, and dry-runnable.
//
// WHY THIS EXISTS. Enabling `OPERION_DUE_INDEX` flips the cron's read source to the
// index. Any job enqueued BEFORE the index was being maintained has no entry, so
// flipping the flag against a cold index would strand exactly the queued and
// retrying work the index is supposed to protect. This walks the booking index once
// and writes the entries, so coverage can be proven before anything is switched.
//
// WHAT IT WILL NOT DO. It never deletes, mutates or advances a booking or a job. The
// only writes are ZADD/ZREM on the two `aidue:*` ZSETs, which are a cache of
// derivable truth — the booking record stays authoritative throughout. A ZREM here
// retires an index entry for a job that is not due; it does not touch the job.
//
// COST. This is itself an O(n) walk — the expensive thing we are trying to stop
// doing every three minutes. It is a ONE-OFF, it is bounded per call, it reports its
// own request cost, and `dryRun` lets you price it before spending anything.
import { scanBookingIndexPage, countBookingIndex, readBookingsByTokens, type Booking } from './bookings'
import { rebuildDueIndex, laneDueScore, DUE_LANES, type DueLane } from './ai-due-index'

/** Bounded per call so one invocation cannot run away or time out. Resume with the
 *  returned cursor. */
export const BACKFILL_PAGE = 100
export const BACKFILL_MAX_PAGES_PER_CALL = 20

export type BackfillOptions = {
  /** Count and price the work WITHOUT writing anything. */
  dryRun?: boolean
  /** Resume point — the booking-index offset to start from. */
  cursor?: number
  pageSize?: number
  maxPages?: number
}

export type BackfillResult = {
  dryRun: boolean
  /** Where this call started, and where the next call should resume. */
  startCursor: number
  nextCursor: number | null      // null = the walk finished
  complete: boolean
  indexed: number                // total bookings in the index
  scanned: number                // index entries walked this call
  read: number                   // booking records actually loaded
  missingRecords: number         // index entries whose record could not be read
  /** Entries that WOULD be (or were) written/retired, per lane. */
  wouldAdd: Record<DueLane, number>
  wouldRemove: Record<DueLane, number>
  /** Jobs discovered that are due right now — the ones a cold index would strand. */
  dueNow: Record<DueLane, number>
  written: number                // 0 on a dry run
  writeFailures: number
  /** Redis requests this call spent, and what finishing the walk would cost. */
  estimatedRedisRequests: number
  estimatedRequestsToComplete: number
}

const emptyLanes = (): Record<DueLane, number> => ({ initial: 0, final: 0 })

/**
 * Walk one bounded slice of the booking index and populate the due indexes.
 *
 * Idempotent and safe to re-run from any cursor: ZADD overwrites a member's score
 * and ZREM on an absent member is a no-op, so re-running a page converges on the
 * same state. Running the whole thing twice is equivalent to running it once.
 */
export async function backfillDueIndexes(opts: BackfillOptions = {}): Promise<BackfillResult> {
  const dryRun = opts.dryRun !== false        // SAFE BY DEFAULT — writing is opt-in
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? BACKFILL_PAGE, 500))
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? BACKFILL_MAX_PAGES_PER_CALL, 100))
  const startCursor = Math.max(0, opts.cursor ?? 0)

  const indexed = await countBookingIndex()
  let cursor = startCursor
  let scanned = 0, read = 0, missingRecords = 0, written = 0, writeFailures = 0
  let requests = 1                            // the ZCARD above
  const wouldAdd = emptyLanes(), wouldRemove = emptyLanes(), dueNow = emptyLanes()
  const now = Date.now()

  for (let page = 0; page < maxPages; page++) {
    const tokens = await scanBookingIndexPage(cursor, pageSize)
    requests += 1                             // the ZRANGE
    if (!tokens.length) { cursor = -1; break }

    const { bookings, missing } = await readBookingsByTokens(tokens)
    requests += tokens.length                 // one GET per token
    scanned += tokens.length
    missingRecords += missing
    read += bookings.length

    for (const b of bookings) {
      for (const lane of DUE_LANES) {
        const score = laneDueScore(lane, b)
        if (score == null) wouldRemove[lane]++
        else {
          wouldAdd[lane]++
          if (score <= now) dueNow[lane]++     // work a cold index would have stranded
        }
      }
    }

    if (!dryRun) {
      const r = await rebuildDueIndex(bookings)
      // Two ZSET ops per booking — one per lane.
      requests += bookings.length * DUE_LANES.length
      written += r.added + r.removed
      writeFailures += r.failed
    }

    cursor += tokens.length
    if (tokens.length < pageSize || cursor >= indexed) { cursor = -1; break }
  }

  const complete = cursor === -1
  const remaining = complete ? 0 : Math.max(0, indexed - cursor)
  // Finishing costs: one ZRANGE per page + one GET per booking + two ZSET ops each.
  const perPage = Math.ceil(remaining / pageSize)
  const estimatedRequestsToComplete = complete ? 0 : perPage + remaining + (dryRun ? 0 : remaining * DUE_LANES.length)

  return {
    dryRun, startCursor,
    nextCursor: complete ? null : cursor,
    complete, indexed, scanned, read, missingRecords,
    wouldAdd, wouldRemove, dueNow,
    written, writeFailures,
    estimatedRedisRequests: requests,
    estimatedRequestsToComplete,
  }
}

/** Coverage proof: how many bookings hold due work, and how many the index knows
 *  about. Read-only — never writes. Used to validate coverage BEFORE enabling the
 *  read path, and to spot drift afterwards. */
export type CoverageReport = {
  indexed: number
  scanned: number
  complete: boolean
  dueNow: Record<DueLane, number>
  inIndex: Record<DueLane, number>
  missingFromIndex: Record<DueLane, string[]>
  covered: boolean
  estimatedRedisRequests: number
}

export async function verifyDueIndexCoverage(
  readIndex: (lane: DueLane, at: number, limit: number) => Promise<string[]>,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<CoverageReport> {
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? BACKFILL_PAGE, 500))
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? BACKFILL_MAX_PAGES_PER_CALL, 100))
  const indexed = await countBookingIndex()
  const now = Date.now()
  let requests = 1, scanned = 0, cursor = 0, complete = false

  const dueTokens: Record<DueLane, Set<string>> = { initial: new Set(), final: new Set() }

  for (let page = 0; page < maxPages; page++) {
    const tokens = await scanBookingIndexPage(cursor, pageSize)
    requests += 1
    if (!tokens.length) { complete = true; break }
    const { bookings } = await readBookingsByTokens(tokens)
    requests += tokens.length
    scanned += tokens.length
    for (const b of bookings as Booking[]) {
      for (const lane of DUE_LANES) {
        const score = laneDueScore(lane, b)
        if (score != null && score <= now) dueTokens[lane].add(b.token)
      }
    }
    cursor += tokens.length
    if (tokens.length < pageSize || cursor >= indexed) { complete = true; break }
  }

  const inIndex = emptyLanes()
  const missingFromIndex: Record<DueLane, string[]> = { initial: [], final: [] }
  for (const lane of DUE_LANES) {
    const known = new Set(await readIndex(lane, now, 1000))
    requests += 1
    inIndex[lane] = known.size
    // The DANGEROUS direction: due per the record but absent from the index — the
    // jobs that would be stranded if the read source flipped right now.
    missingFromIndex[lane] = [...dueTokens[lane]].filter(t => !known.has(t)).slice(0, 50)
  }

  return {
    indexed, scanned, complete,
    dueNow: { initial: dueTokens.initial.size, final: dueTokens.final.size },
    inIndex, missingFromIndex,
    covered: complete && DUE_LANES.every(l => missingFromIndex[l].length === 0),
    estimatedRedisRequests: requests,
  }
}
