// Sprint 3.1 Phase C — building and proving the open-punch index.
//
// Three operations live here:
//   • enumerateOpenPunchesFromTruth() — the complete, correction-adjusted scan.
//     This is the SAME answer the Phase A audit computes, and it stays the
//     definition of correct. The index is only ever a cache of it.
//   • backfillOpenPunchIndex()        — build the index from truth under a lease,
//     then write the completion marker. The marker is written LAST and only on
//     success, so a crashed backfill leaves an index that is never read.
//   • reconcileOpenPunchIndex()       — compare index against truth and report
//     every difference; optionally repair. This is the parity proof.
//
// BOOKING INDEX ORDERING. The first implementation paged `bk:index` with
// ZREVRANGE twice and compared the two orderings to decide whether the scan was
// stable. `bk:index` is scored by updatedAt, so ANY concurrent booking write —
// a new booking, a status change, a payment — reorders it and failed the check.
// That turned ordinary booking traffic into clock-in refusals. Here the whole
// index is captured in ONE ZRANGE command, exactly as `scanAllRoutes` already
// does for routes: one command is one consistent snapshot, so there is no
// second ordering to disagree with. Completeness is judged on COUNT and
// UNIQUENESS, which are order-free properties.
import { scanAllRoutes } from '../routes'
import {
  countBookingIndex,
  effectiveServiceDate,
  readBookingsByTokens,
  scanBookingIndexPage,
  type Booking,
} from '../bookings'
import { effectivePunch, listCorrectionsForPunches, punchId } from '../time-corrections'
import { withLock } from '../kv-lock'
import {
  OPEN_PUNCH_INDEX_VERSION,
  bucketFor,
  listRegisteredBuckets,
  markPunchClosed,
  markPunchOpen,
  readBucket,
  readReadyMarker,
  writeReadyMarker,
  type ReadyMarker,
} from './open-punch-index'

const BOOKING_SCAN_MAX = 20_000
const BOOKING_READ_PAGE = 500
const CORRECTION_LOOKUP_PAGE = 200

export type TruthPunch = {
  punchId: string
  staffId: string
  bucket: string
  clockInAt: number
}

export type TruthScan =
  | { complete: true; punches: TruthPunch[]; routesScanned: number; bookingsScanned: number }
  | { complete: false; reason: string }

/**
 * Capture every booking token in ONE command. Complete only when the snapshot's
 * length and unique-count both equal the reported cardinality — order is never
 * consulted, so concurrent booking writes cannot fail this.
 */
export async function snapshotBookingTokens(): Promise<{ ok: true; tokens: string[] } | { ok: false; reason: string }> {
  const total = await countBookingIndex()
  if (total > BOOKING_SCAN_MAX) {
    return { ok: false, reason: `booking index holds ${total} entries, above the ${BOOKING_SCAN_MAX} scan ceiling` }
  }
  const tokens = total ? await scanBookingIndexPage(0, total) : []
  const unique = Array.from(new Set(tokens))
  if (tokens.length !== total || unique.length !== total) {
    return {
      ok: false,
      reason:
        `booking index snapshot was unstable: expected ${total} unique entries, ` +
        `received ${tokens.length} entries / ${unique.length} unique`,
    }
  }
  return { ok: true, tokens: unique }
}

/** Effective open punches across both lanes. Complete-or-fail; never partial. */
export async function enumerateOpenPunchesFromTruth(): Promise<TruthScan> {
  const routes = await scanAllRoutes()
  if (!routes.complete) {
    return { complete: false, reason: routes.truncatedReason ?? 'route scan incomplete' }
  }

  const snap = await snapshotBookingTokens()
  if (!snap.ok) return { complete: false, reason: snap.reason }

  const bookings: Booking[] = []
  for (let start = 0; start < snap.tokens.length; start += BOOKING_READ_PAGE) {
    const page = snap.tokens.slice(start, start + BOOKING_READ_PAGE)
    const loaded = await readBookingsByTokens(page)
    if (loaded.missing) {
      return { complete: false, reason: `${loaded.missing} indexed booking record(s) were missing or malformed` }
    }
    bookings.push(...loaded.bookings)
  }

  // Raw candidates first, then one bounded correction lookup per page. A punch is
  // open on its EFFECTIVE times, so an admin correction that closed a shift must
  // remove it and one that reopened a shift must add it.
  type Raw = { id: string; staffId: string; bucket: string; clockInAt: number | null; clockOutAt: number | null }
  const raw: Raw[] = []

  for (const route of routes.routes) {
    for (const a of route.assignees ?? []) {
      if (!a.staffId) continue
      raw.push({
        id: punchId('route', route.token, a.staffId),
        staffId: a.staffId,
        bucket: bucketFor(route.routeDate),
        clockInAt: a.clockInAt ?? null,
        clockOutAt: a.clockOutAt ?? null,
      })
    }
  }
  for (const booking of bookings) {
    for (const a of booking.assignees ?? []) {
      if (!a.staffId) continue
      raw.push({
        id: punchId('booking', booking.token, a.staffId),
        staffId: a.staffId,
        bucket: bucketFor(effectiveServiceDate(booking)),
        clockInAt: a.clockInAt ?? null,
        clockOutAt: a.clockOutAt ?? null,
      })
    }
  }

  const punches: TruthPunch[] = []
  for (let start = 0; start < raw.length; start += CORRECTION_LOOKUP_PAGE) {
    const page = raw.slice(start, start + CORRECTION_LOOKUP_PAGE)
    const corrections = await listCorrectionsForPunches(page.map(p => p.id))
    for (const p of page) {
      const eff = effectivePunch({ clockInAt: p.clockInAt, clockOutAt: p.clockOutAt }, corrections.get(p.id) ?? [])
      if (eff.clockInAt != null && eff.clockOutAt == null) {
        punches.push({ punchId: p.id, staffId: p.staffId, bucket: p.bucket, clockInAt: eff.clockInAt })
      }
    }
  }

  return { complete: true, punches, routesScanned: routes.routes.length, bookingsScanned: bookings.length }
}

// ── Backfill ─────────────────────────────────────────────────────────────────

export type BackfillResult =
  | { ok: true; marker: ReadyMarker; removedStale: number }
  | { ok: false; reason: string; block?: 'busy' | 'incomplete' }

/**
 * What a backfill WOULD do, and what the index looks like right now.
 *
 * Produced without a single write. It answers the two questions nobody can
 * currently answer before committing to a first Production run: how many open
 * punches actually exist, and how far the index already is from truth.
 */
export type BackfillPlan =
  | {
      ok: true
      dryRun: true
      /** Open punches found in truth — the live population. */
      openPunches: number
      routesScanned: number
      bookingsScanned: number
      /** Entries a real run would write (missing + misfiled). */
      wouldIndex: number
      /** Already indexed under the right bucket — a real run would rewrite these to the same value. */
      alreadyCorrect: number
      /** Index entries truth does not support; a real run would remove them. */
      wouldRemoveStale: number
      /** Open in truth, absent from the index. The dangerous direction — the index would UNDER-report. */
      missing: string[]
      /** Indexed but not open in truth. Blocks a crew member wrongly. */
      extra: string[]
      /** Indexed under the wrong bucket. */
      misfiled: { punchId: string; indexed: string; expected: string }[]
      /**
       * Whether a completion marker exists TODAY. If true the index is already
       * treated as authoritative, so any drift above is live, not hypothetical.
       */
      markerPresent: boolean
      markerRunId?: string
    }
  | { ok: false; dryRun: true; reason: string; block?: 'incomplete' }

const LEASE_KEY = 'punchidx:backfill-lease'

/**
 * Build the index from truth, then mark it ready.
 *
 * IDEMPOTENT. Every write is a converging upsert, and stale entries are removed
 * by diffing the registered buckets against truth. Re-running after a crash, or
 * twice concurrently (the second caller is refused by the lease), converges on the
 * same index.
 *
 * ORDER MATTERS. Entries are written first, stale entries removed second, and the
 * completion marker LAST. An interrupted run therefore leaves the marker absent,
 * and an index with no marker is never read as authoritative — so a partial
 * backfill can never under-report an open punch.
 */
/**
 * Plan a backfill without performing one. Read-only, by construction.
 *
 * WHY THIS EXISTS. Until now the only way to learn what a backfill would do was to
 * run it. On a first Production pass against live crew data that makes the first
 * observation of the result the same moment it is already written — the wrong order
 * for a subsystem whose failure mode is "a crew member cannot clock in".
 *
 * THREE THINGS IT DELIBERATELY DOES NOT DO:
 *
 *   • It takes NO LEASE. A dry run needs no mutual exclusion — it writes nothing —
 *     and taking the lease would let a planning run block a real one. The scan can
 *     take a while, so that is not a theoretical cost.
 *   • It never writes the READY MARKER. Writing it would make an unpopulated index
 *     authoritative, which fails OPEN and permits exactly the double clock-in the
 *     policy exists to prevent. The marker is the one write that changes how the
 *     system BEHAVES, so a planning path must never be able to emit it.
 *   • It never calls markPunchOpen / markPunchClosed, so no index state moves.
 *
 * The numbers it returns are a snapshot taken without a lock, so a punch opened
 * mid-scan may land on either side of it. That is fine for planning and is NOT fine
 * as a parity proof — `reconcileOpenPunchIndex` is what must be clean before the
 * index is trusted.
 */
export async function planOpenPunchBackfill(): Promise<BackfillPlan> {
  const truth = await enumerateOpenPunchesFromTruth()
  if (!truth.complete) return { ok: false, dryRun: true, reason: truth.reason, block: 'incomplete' }

  const expected = new Map(truth.punches.map(p => [p.punchId, p]))
  const seen = new Map<string, { staffId: string; bucket: string }>()
  for (const ref of await listRegisteredBuckets()) {
    for (const id of await readBucket(ref.staffId, ref.bucket)) {
      seen.set(id, { staffId: ref.staffId, bucket: ref.bucket })
    }
  }

  const missing: string[] = []
  const misfiled: { punchId: string; indexed: string; expected: string }[] = []
  let alreadyCorrect = 0
  for (const [id, p] of expected) {
    const at = seen.get(id)
    if (!at) { missing.push(id); continue }
    if (at.bucket !== p.bucket) misfiled.push({ punchId: id, indexed: at.bucket, expected: p.bucket })
    else alreadyCorrect++
  }
  const extra = [...seen.keys()].filter(id => !expected.has(id))

  const marker = await readReadyMarker()

  return {
    ok: true,
    dryRun: true,
    openPunches: truth.punches.length,
    routesScanned: truth.routesScanned,
    bookingsScanned: truth.bookingsScanned,
    wouldIndex: missing.length + misfiled.length,
    alreadyCorrect,
    wouldRemoveStale: extra.length,
    missing,
    extra,
    misfiled,
    markerPresent: !!marker,
    markerRunId: marker?.runId,
  }
}

export async function backfillOpenPunchIndex(runId: string, now: number): Promise<BackfillResult> {
  return withLock<BackfillResult>(
    LEASE_KEY,
    async lock => {
      const truth = await enumerateOpenPunchesFromTruth()
      if (!truth.complete) return { ok: false, reason: truth.reason, block: 'incomplete' }

      // Still ours? The scan can outrun a lease; writing under a lost lease would
      // race a second backfill.
      try {
        await lock?.assertHeld()
      } catch {
        return { ok: false, reason: 'backfill lease lost during the scan', block: 'busy' }
      }

      for (const p of truth.punches) {
        await markPunchOpen(p.punchId, p.staffId, p.bucket, p.clockInAt)
      }

      // Remove anything the index holds that truth does not. Without this a
      // re-run after data changed would leave a phantom entry blocking a real
      // crew member with no way to clear it.
      const expected = new Set(truth.punches.map(p => p.punchId))
      let removedStale = 0
      for (const ref of await listRegisteredBuckets()) {
        for (const id of await readBucket(ref.staffId, ref.bucket)) {
          if (!expected.has(id)) {
            await markPunchClosed(id, ref.staffId)
            removedStale++
          }
        }
      }

      try {
        await lock?.assertHeld()
      } catch {
        return { ok: false, reason: 'backfill lease lost before the completion marker', block: 'busy' }
      }

      const marker: ReadyMarker = {
        version: OPEN_PUNCH_INDEX_VERSION,
        completedAt: now,
        routesScanned: truth.routesScanned,
        bookingsScanned: truth.bookingsScanned,
        openPunchesIndexed: truth.punches.length,
        runId,
      }
      await writeReadyMarker(marker)
      return { ok: true, marker, removedStale }
    },
    {
      ttlMs: 30_000,
      attempts: 1,
      renew: true,
      holder: 'punchidx-backfill',
      onStoreError: 'busy',
      onBusy: () => ({ ok: false, reason: 'another backfill holds the lease', block: 'busy' as const }),
    },
  )
}

// ── Reconciliation (the parity proof) ────────────────────────────────────────

export type DriftReport = {
  complete: boolean
  reason?: string
  /** Open in truth, absent from the index — the dangerous direction. */
  missing: string[]
  /** Present in the index, not open in truth — blocks a crew member wrongly. */
  extra: string[]
  /** Indexed under the wrong bucket. */
  misfiled: { punchId: string; indexed: string; expected: string }[]
  truthCount: number
  indexedCount: number
  repaired: boolean
}

/**
 * Compare the index against a complete scan. This is what must be clean before
 * the index is allowed to be authoritative, and what detects drift afterwards.
 *
 * `repair: true` makes the index match truth. Repair only ever moves the index
 * TOWARDS the complete scan; it never edits a punch, a route, or a booking.
 */
export async function reconcileOpenPunchIndex(opts?: { repair?: boolean }): Promise<DriftReport> {
  const empty: DriftReport = {
    complete: false, missing: [], extra: [], misfiled: [],
    truthCount: 0, indexedCount: 0, repaired: false,
  }

  const truth = await enumerateOpenPunchesFromTruth()
  if (!truth.complete) return { ...empty, reason: truth.reason }

  const expected = new Map(truth.punches.map(p => [p.punchId, p]))
  const seen = new Map<string, { staffId: string; bucket: string }>()

  for (const ref of await listRegisteredBuckets()) {
    for (const id of await readBucket(ref.staffId, ref.bucket)) {
      seen.set(id, { staffId: ref.staffId, bucket: ref.bucket })
    }
  }

  const missing: string[] = []
  const extra: string[] = []
  const misfiled: { punchId: string; indexed: string; expected: string }[] = []

  for (const [id, p] of expected) {
    const at = seen.get(id)
    if (!at) { missing.push(id); continue }
    if (at.bucket !== p.bucket) misfiled.push({ punchId: id, indexed: at.bucket, expected: p.bucket })
  }
  for (const [id] of seen) {
    if (!expected.has(id)) extra.push(id)
  }

  let repaired = false
  if (opts?.repair && (missing.length || extra.length || misfiled.length)) {
    for (const id of missing) {
      const p = expected.get(id)!
      await markPunchOpen(p.punchId, p.staffId, p.bucket, p.clockInAt)
    }
    for (const { punchId: id } of misfiled) {
      const p = expected.get(id)!
      await markPunchOpen(p.punchId, p.staffId, p.bucket, p.clockInAt)
    }
    for (const id of extra) {
      const at = seen.get(id)!
      await markPunchClosed(id, at.staffId)
    }
    repaired = true
  }

  return {
    complete: true,
    missing: missing.sort(),
    extra: extra.sort(),
    misfiled: misfiled.sort((a, b) => a.punchId.localeCompare(b.punchId)),
    truthCount: expected.size,
    indexedCount: seen.size,
    repaired,
  }
}
