'use client'

import { useCallback, useEffect, useState } from 'react'
import { Activity, AlertTriangle, RefreshCw } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { Stat, fmtTs } from '../ui'

// Crew activity — aggregate-only view of the booking assignment audit ledger.
// Read gated server-side on `audit:view` (admin only). Everything on this page is
// a count, a boolean, or a date: no customer, crew-identity, token, pay, note, or
// photo data is fetched or rendered, and there are no per-booking rows.
//
// When the scan cannot prove it saw the whole index, this page refuses to present
// the numbers as authoritative — it shows them as lower bounds behind a warning.

type Coverage = {
  indexCount: number
  tokensScanned: number
  bookingsRead: number
  missingRecords: number
  pagesRead: number
  pageLimitReached: boolean
  scanComplete: boolean
}

type Summary = {
  range: { start: string; end: string; days: number }
  coverage: Coverage
  totals: { events: number; accepted: number; declined: number; clockIn: number; clockOut: number; completionRecorded: number }
  firstEventAt: number | null
  lastEventAt: number | null
  distinctCrew: number
  completionIdempotency: { withRequestId: number; distinctRequestIds: number; duplicateRequestIds: number; legacyWithoutRequestId: number }
  eventCap: { maxEventsPerBooking: number; bookingsAtCap: number; mayHaveDroppedEvents: boolean }
}

const RANGES = [7, 30, 90] as const

const card: React.CSSProperties = { padding: 16 }
const h2: React.CSSProperties = { fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted)', marginBottom: 10 }
const note: React.CSSProperties = { fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }
const num = (n: number) => n.toLocaleString('en-US')

function Banner({ tone, icon, children }: { tone: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div role="status" className="os-card" style={{ padding: '12px 14px', display: 'flex', gap: 10, alignItems: 'flex-start', border: `1px solid ${tone}59`, background: `${tone}14` }}>
      {icon}
      <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.55 }}>{children}</div>
    </div>
  )
}

function CrewActivity() {
  const [days, setDays] = useState<number>(7)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const load = useCallback(async (rangeDays: number) => {
    setLoading(true); setErr('')
    try {
      const res = await fetch(`/api/admin/booking-assignment-activity?days=${rangeDays}`, { credentials: 'same-origin' })
      const d = await res.json().catch(() => null)
      if (!res.ok) { setErr(d?.message ?? 'Could not load crew activity.'); setSummary(null); return }
      setSummary(d.summary as Summary)
    } catch {
      setErr('Could not load crew activity. Check your connection and try again.')
      setSummary(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(days) }, [days, load])

  const c = summary?.coverage
  const incomplete = !!c && !c.scanComplete
  const empty = !!summary && summary.totals.events === 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <h1 className="jkos-h" style={{ fontSize: 24, display: 'inline-flex', alignItems: 'center', gap: 9 }}>
          <Activity size={20} aria-hidden="true" /> Crew Activity
        </h1>
        <p style={{ ...note, marginTop: 5 }}>
          Aggregate counts from the booking assignment audit trail. Totals only — no customer,
          crew, or booking detail is shown here.
        </p>
      </div>

      {/* ── Range ── */}
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={h2}>Date range</legend>
        <div role="group" aria-label="Date range" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {RANGES.map(r => {
            const on = days === r
            return (
              <button key={r} type="button" className="os-tap" aria-pressed={on}
                onClick={() => setDays(r)} disabled={loading}
                style={{ minHeight: 44, padding: '0 15px', borderRadius: 10, fontSize: 13.5, fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? .6 : 1, border: `1px solid ${on ? 'var(--red)' : 'var(--line)'}`, background: on ? 'color-mix(in srgb, var(--red) 14%, transparent)' : 'var(--card)', color: on ? 'var(--red)' : 'var(--text)' }}>
                Last {r} days
              </button>
            )
          })}
          <button type="button" className="os-tap" onClick={() => void load(days)} disabled={loading}
            aria-label="Refresh crew activity"
            style={{ minHeight: 44, padding: '0 15px', borderRadius: 10, fontSize: 13.5, fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? .6 : 1, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--text)' }}>
            <RefreshCw size={14} aria-hidden="true" style={{ verticalAlign: -2, marginRight: 6 }} />
            Refresh
          </button>
        </div>
      </fieldset>

      <div aria-live="polite" aria-busy={loading} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* ── Loading ── */}
        {loading && <p style={note}>Loading crew activity…</p>}

        {/* ── Error ── */}
        {!loading && err && (
          <>
            <p role="alert" style={{ color: '#f87171', fontSize: 13.5 }}>{err}</p>
            <button type="button" className="os-tap" onClick={() => void load(days)}
              style={{ minHeight: 44, alignSelf: 'flex-start', padding: '0 15px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--text)', fontWeight: 700, cursor: 'pointer' }}>
              Try again
            </button>
          </>
        )}

        {!loading && !err && summary && (
          <>
            {/* ── Incomplete scan: refuse to present authoritative totals ── */}
            {incomplete && (
              <Banner tone="#f59e0b" icon={<AlertTriangle size={17} aria-hidden="true" style={{ color: '#fcd34d', flexShrink: 0 }} />}>
                <strong>These totals are lower bounds, not authoritative.</strong> The scan covered{' '}
                {num(c!.tokensScanned)} of {num(c!.indexCount)} indexed bookings
                {c!.pageLimitReached && ' (page limit reached)'}
                {c!.missingRecords > 0 && `, and ${num(c!.missingRecords)} indexed ${c!.missingRecords === 1 ? 'record was' : 'records were'} unreadable`}
                . Real activity is at least what is shown below and may be higher. Narrow the date
                range or re-run before drawing conclusions.
              </Banner>
            )}

            {/* ── Empty ── */}
            {empty && (
              <Banner tone="#60a5fa">
                No booking assignment events in this range
                {incomplete ? ' among the bookings that could be scanned' : ''}. That means no crew
                member accepted, declined, clocked, or filed completion proof on a booking between{' '}
                {summary.range.start} and {summary.range.end}.
              </Banner>
            )}

            {/* ── Totals ── */}
            <section aria-label="Event totals">
              <h2 style={h2}>Events {incomplete && '(lower bound)'}</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
                <Stat label="Total events" value={num(summary.totals.events)} />
                <Stat label="Accepted" value={num(summary.totals.accepted)} tone="#34d399" />
                <Stat label="Declined" value={num(summary.totals.declined)} tone="#f87171" />
                <Stat label="Clock in" value={num(summary.totals.clockIn)} />
                <Stat label="Clock out" value={num(summary.totals.clockOut)} />
                <Stat label="Completion recorded" value={num(summary.totals.completionRecorded)} />
              </div>
            </section>

            {/* ── Window + reach ── */}
            <section aria-label="Activity window">
              <h2 style={h2}>Window</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
                <Stat label="First event" value={summary.firstEventAt ? fmtTs(summary.firstEventAt) : '—'} />
                <Stat label="Most recent event" value={summary.lastEventAt ? fmtTs(summary.lastEventAt) : '—'} />
                <Stat label="Distinct crew" value={num(summary.distinctCrew)} sub="count only" />
                <Stat label="Range" value={`${summary.range.days}d`} sub={`${summary.range.start} → ${summary.range.end}`} />
              </div>
            </section>

            {/* ── Completion idempotency ── */}
            <section aria-label="Completion idempotency" className="os-card" style={card}>
              <h2 style={h2}>Completion idempotency</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
                <Stat label="With request ID" value={num(summary.completionIdempotency.withRequestId)} />
                <Stat label="Distinct request IDs" value={num(summary.completionIdempotency.distinctRequestIds)} />
                <Stat label="Duplicate request IDs"
                  value={num(summary.completionIdempotency.duplicateRequestIds)}
                  tone={summary.completionIdempotency.duplicateRequestIds > 0 ? '#f87171' : '#34d399'} />
                <Stat label="Legacy, no request ID" value={num(summary.completionIdempotency.legacyWithoutRequestId)} sub="outside this check" />
              </div>
              <p style={{ ...note, marginTop: 11 }}>
                Request IDs are compared within a single booking, which is the scope the server
                dedupes in. <strong>Zero duplicates means every completion event carrying a request
                ID was recorded exactly once.</strong>
              </p>
              {summary.completionIdempotency.legacyWithoutRequestId > 0 && (
                <p style={{ ...note, marginTop: 7 }}>
                  The {num(summary.completionIdempotency.legacyWithoutRequestId)} legacy{' '}
                  {summary.completionIdempotency.legacyWithoutRequestId === 1 ? 'event' : 'events'} without a
                  request ID {summary.completionIdempotency.legacyWithoutRequestId === 1 ? 'was' : 'were'} written
                  before request IDs existed. They are <strong>outside</strong> this check and are
                  neither evidence of a duplicate nor evidence of correctness — they simply cannot
                  be evaluated either way.
                </p>
              )}
            </section>

            {/* ── Coverage + cap ── */}
            <section aria-label="Scan coverage" className="os-card" style={card}>
              <h2 style={h2}>Scan coverage</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
                <Stat label="Indexed bookings" value={num(c!.indexCount)} />
                <Stat label="Scanned" value={num(c!.tokensScanned)} />
                <Stat label="Read" value={num(c!.bookingsRead)} />
                <Stat label="Scan complete" value={c!.scanComplete ? 'Yes' : 'No'} tone={c!.scanComplete ? '#34d399' : '#fcd34d'} />
              </div>
              <p style={{ ...note, marginTop: 11 }}>
                Each booking keeps at most {num(summary.eventCap.maxEventsPerBooking)} audit events.
                {summary.eventCap.mayHaveDroppedEvents
                  ? ` ${num(summary.eventCap.bookingsAtCap)} ${summary.eventCap.bookingsAtCap === 1 ? 'booking is' : 'bookings are'} at that cap, so older events for ${summary.eventCap.bookingsAtCap === 1 ? 'it' : 'them'} may already have rolled off and the counts above are a lower bound for ${summary.eventCap.bookingsAtCap === 1 ? 'that booking' : 'those bookings'}.`
                  : ' No booking has reached that cap, so nothing has rolled off.'}
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  )
}

export default function CrewActivityPage() {
  return <OperationsShell><CrewActivity /></OperationsShell>
}
