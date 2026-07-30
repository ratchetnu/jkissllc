'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, RefreshCw, Timer } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { Stat, fmtTs, timestampRange } from '../ui'

// Sprint 3.1 Phase A — measurement only. Read gated server-side on `audit:view`.
// Nothing here enforces a rule or changes a punch; it answers one question: does a
// contractor ever hold two punches at once?
//
// Everything rendered is a count, a boolean, or a timestamp. No names, staff ids,
// job identifiers, tokens, or locations are fetched or shown.

type Lane = {
  indexCount: number; scanned: number; read: number; missingRecords: number
  pageLimitReached: boolean; scanComplete: boolean
  recordsAtAuditCap: number; recordsAtEventCap: number
}
type Surface = 'link' | 'portal' | 'unattributable'
type Report = {
  summary: {
    evaluatedAt: number
    punches: { total: number; open: number; complete: number; invalid: number }
    openDuplicates: {
      contractorsGlobal: number; contractorsSameDate: number
      maxOpenForOneContractor: number; earliestOpenAt: number | null; latestOpenAt: number | null
    }
    overlaps: {
      pairsGlobal: number; pairsSameDate: number
      contractorsGlobal: number; contractorsSameDate: number
      earliestOverlapStartAt: number | null; latestOverlapEndAt: number | null
      byPairKind: Record<'route/route' | 'route/booking' | 'booking/booking', number>
      pairsInvolvingOpenPunch: number
    }
    attribution: {
      inferred: true
      punchesBySurface: Record<Surface, number>
      overlapPairsWithAnyLinkSide: number
      overlapPairsBothPortal: number
      overlapPairsWithUnattributableSide: number
    }
  }
  coverage: {
    routes: Lane; bookings: Lane; authoritative: boolean
    caps: { routeScanMax: number; routeAuditCap: number; routeEventCap: number; bookingEventCap: number; bookingPageSize: number; bookingMaxPages: number }
  }
}

const h2: React.CSSProperties = { fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted)', marginBottom: 10 }
const note: React.CSSProperties = { fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }
const num = (n: number) => n.toLocaleString('en-US')

function LaneRow({ label, lane }: { label: string; lane: Lane }) {
  return (
    <div className="os-card" style={{ padding: 14 }}>
      <p style={{ ...h2, marginBottom: 8 }}>{label}</p>
      <div style={grid}>
        <Stat label="Indexed" value={num(lane.indexCount)} />
        <Stat label="Scanned" value={num(lane.scanned)} />
        <Stat label="Read" value={num(lane.read)} />
        <Stat label="Complete" value={lane.scanComplete ? 'Yes' : 'No'} tone={lane.scanComplete ? '#34d399' : '#fcd34d'} />
      </div>
      <p style={{ ...note, marginTop: 9 }}>
        {num(lane.missingRecords)} unreadable · {num(lane.recordsAtAuditCap)} at the audit cap ·{' '}
        {num(lane.recordsAtEventCap)} at the event cap
        {lane.pageLimitReached && ' · page limit reached'}
      </p>
    </div>
  )
}

function PunchOverlaps() {
  const [data, setData] = useState<Report | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const res = await fetch('/api/admin/punch-overlaps', { credentials: 'same-origin' })
      const d = await res.json().catch(() => null)
      if (!res.ok) { setErr(d?.message ?? 'Could not measure punch overlaps.'); setData(null); return }
      setData(d as Report)
    } catch {
      setErr('Could not measure punch overlaps. Check your connection and try again.')
      setData(null)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  const s = data?.summary
  const c = data?.coverage
  const incomplete = !!c && !c.authoritative
  const clean = !!s && s.openDuplicates.contractorsGlobal === 0 && s.overlaps.pairsGlobal === 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <h1 className="jkos-h" style={{ fontSize: 24, display: 'inline-flex', alignItems: 'center', gap: 9 }}>
          <Timer size={20} aria-hidden="true" /> Punch Overlaps
        </h1>
        <p style={{ ...note, marginTop: 5 }}>
          Does anyone hold two punches at once? Measurement only — nothing here changes a punch
          or enforces a rule. Totals only; no crew, job, or location detail is shown.
        </p>
      </div>

      <button type="button" className="os-tap" onClick={() => void load()} disabled={loading}
        aria-label="Re-run the punch overlap measurement"
        style={{ minHeight: 44, alignSelf: 'flex-start', padding: '0 15px', borderRadius: 10, fontSize: 13.5, fontWeight: 700, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--text)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, whiteSpace: 'nowrap', flexShrink: 0, opacity: loading ? .6 : 1, cursor: loading ? 'not-allowed' : 'pointer' }}>
        <RefreshCw size={14} aria-hidden="true" /> {loading ? 'Measuring…' : 'Re-run'}
      </button>

      <div aria-live="polite" aria-busy={loading} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {loading && <p style={note}>Scanning routes and bookings…</p>}

        {!loading && err && (
          <>
            <p role="alert" style={{ color: '#f87171', fontSize: 13.5 }}>{err}</p>
            <button type="button" className="os-tap" onClick={() => void load()}
              style={{ minHeight: 44, alignSelf: 'flex-start', padding: '0 15px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--text)', fontWeight: 700, cursor: 'pointer' }}>
              Try again
            </button>
          </>
        )}

        {!loading && !err && s && c && (
          <>
            {incomplete && (
              <div role="status" className="os-card" style={{ padding: '12px 14px', display: 'flex', gap: 10, alignItems: 'flex-start', border: '1px solid rgba(245,158,11,.35)', background: 'rgba(245,158,11,.08)' }}>
                <AlertTriangle size={17} aria-hidden="true" style={{ color: '#fcd34d', flexShrink: 0 }} />
                <div style={{ fontSize: 13, lineHeight: 1.55 }}>
                  <strong>These are lower bounds, not authoritative.</strong> A lane did not scan
                  completely, so real overlaps may be higher than shown. Do not conclude “zero
                  overlaps” from this run — see Scan coverage below.
                </div>
              </div>
            )}

            {clean && !incomplete && (
              <div role="status" className="os-card" style={{ padding: '12px 14px', border: '1px solid rgba(52,211,153,.35)', background: 'rgba(52,211,153,.08)', fontSize: 13, lineHeight: 1.55 }}>
                <strong>No duplicate open punches and no historical overlaps found</strong>, across a
                complete scan of both lanes. On this evidence D1 has not occurred in real data.
              </div>
            )}

            <section aria-label="Currently open duplicates">
              <h2 style={h2}>Open right now</h2>
              <div style={grid}>
                <Stat label="Contractors, 2+ open" value={num(s.openDuplicates.contractorsGlobal)}
                  tone={s.openDuplicates.contractorsGlobal > 0 ? '#f87171' : '#34d399'} sub="any date" />
                <Stat label="…same service date" value={num(s.openDuplicates.contractorsSameDate)}
                  tone={s.openDuplicates.contractorsSameDate > 0 ? '#f87171' : '#34d399'} sub="what the portal guard covers" />
                <Stat label="Most open, one person" value={num(s.openDuplicates.maxOpenForOneContractor)} />
                <Stat label="Open punches" value={num(s.punches.open)} />
              </div>
              <p style={{ ...note, marginTop: 9 }}>
                {timestampRange(s.openDuplicates.earliestOpenAt, s.openDuplicates.latestOpenAt,
                  'No open punches in this scan.', '\u00b7 latest')}{' '}
                The portal’s existing guard is <strong>day-scoped</strong>, so the same-date figure is
                what today’s rule would have prevented; the global figure is what a stricter rule would catch.
              </p>
            </section>

            <section aria-label="Historical overlaps">
              <h2 style={h2}>Historical overlaps</h2>
              <div style={grid}>
                <Stat label="Overlapping pairs" value={num(s.overlaps.pairsGlobal)}
                  tone={s.overlaps.pairsGlobal > 0 ? '#f87171' : '#34d399'} sub="any date" />
                <Stat label="…same service date" value={num(s.overlaps.pairsSameDate)} />
                <Stat label="Contractors affected" value={num(s.overlaps.contractorsGlobal)} />
                <Stat label="Pairs with an open side" value={num(s.overlaps.pairsInvolvingOpenPunch)} />
              </div>
              <div style={{ ...grid, marginTop: 10 }}>
                <Stat label="route / route" value={num(s.overlaps.byPairKind['route/route'])} />
                <Stat label="route / booking" value={num(s.overlaps.byPairKind['route/booking'])} />
                <Stat label="booking / booking" value={num(s.overlaps.byPairKind['booking/booking'])} />
              </div>
              <p style={{ ...note, marginTop: 9 }}>
                {timestampRange(s.overlaps.earliestOverlapStartAt, s.overlaps.latestOverlapEndAt,
                  'No overlapping intervals in this scan.')}{' '}
                Open punches are measured to {fmtTs(s.evaluatedAt)}, the moment this ran.
                Intervals that merely touch end-to-end are not counted as overlapping.
              </p>
            </section>

            <section aria-label="Attribution" className="os-card" style={{ padding: 16 }}>
              <h2 style={h2}>Surface attribution (inferred)</h2>
              <div style={grid}>
                <Stat label="Public link" value={num(s.attribution.punchesBySurface.link)} />
                <Stat label="Portal" value={num(s.attribution.punchesBySurface.portal)} />
                <Stat label="Unattributable" value={num(s.attribution.punchesBySurface.unattributable)} sub="evidence rolled off" />
                <Stat label="Overlap pairs w/ a link side" value={num(s.attribution.overlapPairsWithAnyLinkSide)} />
              </div>
              <p style={{ ...note, marginTop: 11 }}>
                <strong>Best-effort, not authoritative.</strong> A punch record carries no surface
                marker, so this is inferred from the audit trail — the portal stamps an actor id and
                writes “from the portal”; the public link stamps neither. That trail is capped at{' '}
                {num(c.caps.routeAuditCap)} entries per route, so a punch can outlive the entry that
                would have identified it. Those land in <strong>unattributable</strong>, which is a real
                answer rather than a failure.
              </p>
            </section>

            <section aria-label="Scan coverage" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <h2 style={h2}>Scan coverage</h2>
              <LaneRow label="Routes" lane={c.routes} />
              <LaneRow label="Bookings" lane={c.bookings} />
              <p style={note}>
                Totals are {c.authoritative ? <strong>authoritative</strong> : <strong>lower bounds</strong>} — both
                lanes must scan completely to be authoritative. Caps: route scan {num(c.caps.routeScanMax)},
                route audit {num(c.caps.routeAuditCap)}, route events {num(c.caps.routeEventCap)},
                booking events {num(c.caps.bookingEventCap)}, booking pages {num(c.caps.bookingMaxPages)} ×{' '}
                {num(c.caps.bookingPageSize)}. Records at a cap may have lost older history.
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  )
}

export default function PunchOverlapsPage() {
  return <OperationsShell><PunchOverlaps /></OperationsShell>
}
