'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { FileBarChart, Download } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { Stat } from '../ui'
import { REPORT_CATALOG, type ReportDef, type ReportRow } from '../../../lib/reports/catalog'
import { revenueDailyRows, claimsGroupRows, filterRowsByDate } from '../../../lib/reports/build'

// Dedicated reporting surface. Read-only, gated server-side on reports:view. Backed by
// the two existing engines (revenue + claims); rows are built with the SAME pure
// adapters the export endpoint uses, so the screen and the CSV can't diverge. There is
// intentionally no company P&L — see the note at the bottom.

type Revenue = { today: number; week: number; month: number; year: number; allTime: number; series: Array<{ date: string; amountCents: number }> }
type ClaimGroup = { key: string; label: string; claimCount: number; totalCents: number; recoveredCents: number; outstandingCents: number }
type ClaimsReport = { totalCents: number; recoveredCents: number; outstandingCents: number; claimCount: number; byBusiness: ClaimGroup[]; byCrew: ClaimGroup[] }

const MAX_TABLE_ROWS = 250
const usd = (c: unknown) => (Number(c ?? 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const th: React.CSSProperties = { textAlign: 'left', padding: '9px 12px', fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap' }
const td: React.CSSProperties = { padding: '9px 12px', fontSize: 13, color: 'var(--text)', borderTop: '1px solid var(--line)', whiteSpace: 'nowrap' }
const field: React.CSSProperties = { padding: '8px 11px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 10, color: 'var(--text)', fontSize: 14, outline: 'none' }

const cellText = (kind: string, v: unknown) => (kind === 'cents' ? usd(v) : v == null ? '—' : String(v))

function ReportTable({ def, rows, exportHref }: { def: ReportDef; rows: ReportRow[]; exportHref: string }) {
  const shown = rows.slice(0, MAX_TABLE_ROWS)
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 14, padding: 14, marginBottom: 16 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--text)' }}>{def.title}</div>
        <a href={exportHref} download style={{ ...field, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 700, color: 'var(--muted)' }}>
          <Download size={13} /> Export CSV
        </a>
      </div>
      {rows.length === 0 ? (
        <div style={{ color: 'var(--muted)', fontSize: 13, padding: '14px 2px' }}>No rows for this report yet.</div>
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 10 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 360 }}>
            <thead><tr>{def.columns.map(c => <th key={c.key} style={th}>{c.label}</th>)}</tr></thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={i}>{def.columns.map(c => <td key={c.key} style={{ ...td, fontWeight: c.kind === 'text' ? 700 : 400 }}>{cellText(c.kind, r[c.key])}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > MAX_TABLE_ROWS && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>Showing first {MAX_TABLE_ROWS} of {rows.length} — export CSV for the full set.</div>}
    </div>
  )
}

function Board() {
  const [rev, setRev] = useState<Revenue | null>(null)
  const [claims, setClaims] = useState<ClaimsReport | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'denied' | 'error'>('loading')
  const [generatedAt, setGeneratedAt] = useState<number | null>(null)
  const [from, setFrom] = useState(''); const [to, setTo] = useState('')

  const load = useCallback(async () => {
    setState('loading')
    try {
      const [rRes, cRes] = await Promise.all([
        fetch('/api/admin/reports', { credentials: 'same-origin' }),
        fetch('/api/admin/reports/claims', { credentials: 'same-origin' }),
      ])
      if (rRes.status === 401 || rRes.status === 403 || cRes.status === 401 || cRes.status === 403) { setState('denied'); return }
      if (!rRes.ok || !cRes.ok) { setState('error'); return }
      const rJson = await rRes.json(); const cJson = await cRes.json()
      setRev(rJson.data?.revenue ?? null); setClaims(cJson.report ?? null); setGeneratedAt(cJson.generatedAt ?? Date.now()); setState('ok')
    } catch { setState('error') }
  }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- mount load; result state is set post-await
  useEffect(() => { load() }, [load])

  const dateQS = useMemo(() => { const p = new URLSearchParams(); if (from) p.set('from', from); if (to) p.set('to', to); const s = p.toString(); return s ? `&${s}` : '' }, [from, to])
  const revenueRows = useMemo(() => rev ? filterRowsByDate(revenueDailyRows({ revenue: { series: rev.series } }), 'date', from || undefined, to || undefined) : [], [rev, from, to])
  const byBusinessRows = useMemo(() => claims ? claimsGroupRows(claims.byBusiness) : [], [claims])
  const byCrewRows = useMemo(() => claims ? claimsGroupRows(claims.byCrew) : [], [claims])
  const def = (id: string) => REPORT_CATALOG.find(r => r.id === id)!

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: '18px 16px 40px' }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', margin: 0, display: 'flex', alignItems: 'center', gap: 9 }}><FileBarChart size={20} /> Reports</h1>
        <p style={{ color: 'var(--muted)', fontSize: 13.5, margin: '6px 0 0' }}>
          Revenue and claims reports from live data. Read-only · export to CSV.
          {generatedAt && <span> · as of {new Date(generatedAt).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>}
        </p>
      </header>

      {state === 'loading' && <div style={{ color: 'var(--muted)', padding: '40px 0', textAlign: 'center' }}>Loading reports…</div>}
      {state === 'denied' && <div style={{ padding: 24, border: '1px solid var(--line)', borderRadius: 14, color: 'var(--muted)' }}>You don’t have access to reports (requires <code>reports:view</code>).</div>}
      {state === 'error' && <div style={{ padding: 24, border: '1px solid var(--line)', borderRadius: 14, color: 'var(--muted)' }}>Couldn’t load reports. <button type="button" onClick={load} style={{ ...field, cursor: 'pointer', marginLeft: 8 }}>Retry</button></div>}

      {state === 'ok' && (
        <>
          {/* Revenue */}
          <section style={{ marginBottom: 26 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 12 }}>
              <h2 style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', margin: 0 }}>Revenue</h2>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <label style={{ display: 'grid', gap: 3, fontSize: 11, color: 'var(--muted)', fontWeight: 700 }}>From<input type="date" value={from} onChange={e => setFrom(e.target.value)} style={field} /></label>
                <label style={{ display: 'grid', gap: 3, fontSize: 11, color: 'var(--muted)', fontWeight: 700 }}>To<input type="date" value={to} onChange={e => setTo(e.target.value)} style={field} /></label>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 14 }}>
              <Stat label="Today" value={usd(rev?.today)} />
              <Stat label="This week" value={usd(rev?.week)} />
              <Stat label="This month" value={usd(rev?.month)} />
              <Stat label="This year" value={usd(rev?.year)} />
              <Stat label="All time" value={usd(rev?.allTime)} />
            </div>
            <ReportTable def={def('revenue-daily')} rows={revenueRows} exportHref={`/api/admin/reports/export?report=revenue-daily${dateQS}`} />
          </section>

          {/* Claims */}
          <section>
            <h2 style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', margin: '0 0 12px' }}>Claims</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginBottom: 14 }}>
              <Stat label="Claims" value={String(claims?.claimCount ?? 0)} />
              <Stat label="Gross" value={usd(claims?.totalCents)} />
              <Stat label="Recovered" value={usd(claims?.recoveredCents)} />
              <Stat label="Outstanding" value={usd(claims?.outstandingCents)} tone={claims && claims.outstandingCents > 0 ? '#f59e0b' : undefined} />
            </div>
            <ReportTable def={def('claims-by-business')} rows={byBusinessRows} exportHref="/api/admin/reports/export?report=claims-by-business" />
            <ReportTable def={def('claims-by-crew')} rows={byCrewRows} exportHref="/api/admin/reports/export?report=claims-by-crew" />
          </section>

          <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '18px 0 0', lineHeight: 1.5 }}>
            These are <strong>revenue</strong> and <strong>claims recovery</strong> reports, not a company profit-and-loss statement.
            Net profit reporting depends on the <code>expenses</code> capability, which is planned and not yet implemented — so no P&L is shown.
          </p>
        </>
      )}
    </div>
  )
}

export default function ReportsPage() {
  return <OperationsShell><Board /></OperationsShell>
}
