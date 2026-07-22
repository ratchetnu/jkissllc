'use client'

import { useCallback, useEffect, useState } from 'react'
import AdminGate from '../../AdminGate'

type PayLineRoute = { source?: 'route' | 'booking'; routeNumber: string; routeDate: string; businessName: string; amountCents: number | null; payRateRaw?: string; hasProof: boolean; completedBy?: string; workedMinutes?: number }
type PayDeductionLine = { claimId: string; claimNumber: string; businessName: string; routeNumber?: string; reason: string; amountCents: number; date: string }
type ContractorPay = {
  staffId: string; name: string; routes: PayLineRoute[]; count: number; grossCents: number; unpricedCount: number
  deductions: PayDeductionLine[]; deductionCents: number; appliedCents: number; netCents: number; shortfallCents: number
}
type PaySummary = { start: string; end: string; contractors: ContractorPay[]; grandGrossCents: number; grandDeductionCents: number; grandNetCents: number; routeCount: number; deliveryRouteCount?: number; bookingCount?: number; payrollGaps?: Array<{ bookingNumber: string; reason: 'missing_service_date' }>; bookingWindowSaturated?: boolean; unpricedCount: number }

const money = (cents: number) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const fmtDate = (iso: string) => { const d = new Date(`${iso}T12:00:00Z`); return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) }
const fmtLong = (iso: string) => { const d = new Date(`${iso}T12:00:00Z`); return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) }
const fmtWorked = (minutes: number) => `${Math.floor(minutes / 60)}h ${minutes % 60}m`

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
function mondayOf(d: Date) { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); x.setHours(0, 0, 0, 0); return x }
function addDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate() + n); return x }

const dInput: React.CSSProperties = { height: 38, boxSizing: 'border-box', padding: '0 10px', background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 9, color: '#f3f4f6', fontSize: 13.5, outline: 'none' }
const preset: React.CSSProperties = { height: 38, boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 12px', fontSize: 12.5, fontWeight: 700, borderRadius: 9, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: 'var(--muted)', cursor: 'pointer' }

function Pay() {
  const now = new Date()
  const [start, setStart] = useState(ymd(mondayOf(now)))
  const [end, setEnd] = useState(ymd(addDays(mondayOf(now), 6)))
  const [data, setData] = useState<PaySummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async (s: string, e: string) => {
    setLoading(true); setError('')
    try {
      const d = await fetch(`/api/admin/routes/pay?start=${s}&end=${e}`, { credentials: 'same-origin' }).then(r => r.json())
      if (d.error) setError(d.error === 'UPSTASH_NOT_CONFIGURED' ? 'Redis is not configured.' : d.error)
      else setData(d)
    } catch { setError('Failed to load pay.') } finally { setLoading(false) }
  }, [])
  useEffect(() => { load(start, end) }, [load, start, end])

  function setRange(s: string, e: string) { setStart(s); setEnd(e) }
  function thisWeek() { const m = mondayOf(new Date()); setRange(ymd(m), ymd(addDays(m, 6))) }
  function lastWeek() { const m = addDays(mondayOf(new Date()), -7); setRange(ymd(m), ymd(addDays(m, 6))) }
  function thisMonth() { const n = new Date(); setRange(ymd(new Date(n.getFullYear(), n.getMonth(), 1)), ymd(new Date(n.getFullYear(), n.getMonth() + 1, 0))) }
  function lastMonth() { const n = new Date(); setRange(ymd(new Date(n.getFullYear(), n.getMonth() - 1, 1)), ymd(new Date(n.getFullYear(), n.getMonth(), 0))) }

  return (
    <div className="max-w-3xl mx-auto">
      <style>{`@media print { header, .no-print { display: none !important; } main { padding-top: 0 !important; } .glass-card { break-inside: avoid; } }`}</style>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-3xl font-black text-white" style={{ letterSpacing: '-0.03em' }}>Contractor Pay</h1>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>Completed work by contractor for the selected pay period.</p>
        </div>
        <a href="/admin/routes" className="no-print" style={{ ...preset, textDecoration: 'none' }}>← Dispatch</a>
      </div>

      {/* Controls */}
      <div className="no-print mt-5 mb-6" style={{ padding: 16, borderRadius: 14, border: '1px solid var(--line)', background: 'rgba(255,255,255,.02)' }}>
        <div className="flex items-end gap-3 flex-wrap">
          <label className="flex flex-col gap-1" style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>From
            <input type="date" value={start} max={end} onChange={e => setStart(e.target.value)} style={dInput} />
          </label>
          <label className="flex flex-col gap-1" style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>To
            <input type="date" value={end} min={start} onChange={e => setEnd(e.target.value)} style={dInput} />
          </label>
          <div className="flex gap-1.5 flex-wrap">
            <button onClick={thisWeek} style={preset}>This week</button>
            <button onClick={lastWeek} style={preset}>Last week</button>
            <button onClick={thisMonth} style={preset}>This month</button>
            <button onClick={lastMonth} style={preset}>Last month</button>
          </div>
          <button onClick={() => window.print()} className="btn" style={{ marginLeft: 'auto', height: 38 }}>Print / Save PDF</button>
        </div>
      </div>

      {/* Summary */}
      <div className="glass-card mb-6" style={{ borderRadius: 16, padding: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--muted)' }}>Pay period</div>
          <div style={{ fontSize: 16, fontWeight: 800, color: '#fff', marginTop: 2 }}>{fmtLong(start)} – {fmtLong(end)}</div>
          {data && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3 }}>{data.routeCount} completed job{data.routeCount === 1 ? '' : 's'} · {data.contractors.length} contractor{data.contractors.length === 1 ? '' : 's'}</div>}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--muted)' }}>Net owed</div>
          <div style={{ fontSize: 30, fontWeight: 900, color: '#86efac', letterSpacing: '-0.02em' }}>{data ? money(data.grandNetCents) : '—'}</div>
          {data && data.grandDeductionCents > 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3 }}>
              {money(data.grandGrossCents)} gross − {money(data.grandDeductionCents)} claim deductions
            </div>
          )}
        </div>
      </div>

      {data && data.unpricedCount > 0 && (
        <div className="mb-6 text-sm" style={{ padding: '10px 14px', borderRadius: 10, background: 'rgba(245,158,11,.1)', border: '1px solid rgba(245,158,11,.3)', color: '#fcd34d' }}>
          {data.unpricedCount} completed job{data.unpricedCount === 1 ? ' has' : 's have'} no readable pay rate and {data.unpricedCount === 1 ? "isn't" : "aren't"} included in the total. Add a crew pay rate to count it.
        </div>
      )}

      {data && (data.payrollGaps?.length ?? 0) > 0 && (
        <div className="mb-6 text-sm" role="alert" style={{ padding: '10px 14px', borderRadius: 10, background: 'rgba(245,158,11,.1)', border: '1px solid rgba(245,158,11,.3)', color: '#fcd34d' }}>
          Pay statement blocked: {data.payrollGaps!.map(g => g.bookingNumber).join(', ')} {data.payrollGaps!.length === 1 ? 'needs' : 'need'} a service date.
        </div>
      )}

      {data?.bookingWindowSaturated && (
        <div className="mb-6 text-sm" role="alert" style={{ padding: '10px 14px', borderRadius: 10, background: 'rgba(245,158,11,.1)', border: '1px solid rgba(245,158,11,.3)', color: '#fcd34d' }}>
          Booking payroll scan reached its safety limit. Verify older completed bookings before issuing statements.
        </div>
      )}

      {loading ? <p style={{ color: 'var(--muted)' }}>Loading…</p>
        : error ? <p style={{ color: '#f87171' }}>{error}</p>
        : !data || data.contractors.length === 0 ? <p style={{ color: 'var(--muted)' }}>No completed jobs in this period.</p>
        : (
        <div className="flex flex-col gap-4">
          {data.contractors.map(c => (
            <div key={c.staffId} className="glass-card" style={{ borderRadius: 14, padding: 18 }}>
              <div className="flex items-center justify-between gap-3 flex-wrap" style={{ paddingBottom: 12, borderBottom: '1px solid var(--line)' }}>
                <div>
                  <div style={{ fontSize: 17, fontWeight: 800, color: '#fff' }}>{c.name}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{c.count} job{c.count === 1 ? '' : 's'}{c.unpricedCount > 0 ? ` · ${c.unpricedCount} unpriced` : ''}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 22, fontWeight: 900, color: '#86efac' }}>{money(c.netCents)}</div>
                  {c.appliedCents > 0 && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{money(c.grossCents)} − {money(c.appliedCents)}</div>}
                </div>
              </div>
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {c.routes.map(r => (
                  <div key={`${r.source ?? 'route'}:${r.routeNumber}`} className="flex items-center gap-3" style={{ fontSize: 13, padding: '6px 0' }}>
                    <span style={{ minWidth: 52, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{fmtDate(r.routeDate)}</span>
                    <span style={{ minWidth: 74, fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--muted)' }}>{r.source === 'booking' ? 'Booking ' : ''}{r.routeNumber}</span>
                    <span style={{ flex: 1, color: '#e5e7eb', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.businessName}</span>
                    {r.workedMinutes !== undefined && <span title="Clocked time" style={{ fontSize: 11, color: 'var(--muted)' }}>{fmtWorked(r.workedMinutes)}</span>}
                    {r.hasProof && <span title="Proof attached" style={{ fontSize: 11, color: '#86efac' }}>✓ proof</span>}
                    <span style={{ minWidth: 74, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: r.amountCents == null ? '#fcd34d' : '#e5e7eb' }}>
                      {r.amountCents == null ? (r.payRateRaw ? r.payRateRaw : 'unpriced') : money(r.amountCents)}
                    </span>
                  </div>
                ))}
              </div>

              {/* Claim deductions. Every line names the claim it came from — pay is
                  never reduced by an amount the statement can't explain. */}
              {c.deductions.length > 0 && (
                <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--line)' }}>
                  <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>Claim deductions</div>
                  {c.deductions.map((d, i) => (
                    <div key={`${d.claimId}-${i}`} className="flex items-center gap-3" style={{ fontSize: 13, padding: '5px 0' }}>
                      <span style={{ minWidth: 52, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{fmtDate(d.date)}</span>
                      <span style={{ minWidth: 74, fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--muted)' }}>{d.claimNumber}</span>
                      <span style={{ flex: 1, color: '#e5e7eb', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {d.businessName}{d.routeNumber ? ` · ${d.routeNumber}` : ''}
                      </span>
                      <span style={{ minWidth: 74, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: d.amountCents < 0 ? '#86efac' : '#fca5a5' }}>
                        {d.amountCents < 0 ? `+${money(-d.amountCents)}` : `−${money(d.amountCents)}`}
                      </span>
                    </div>
                  ))}
                  <div className="flex items-center justify-between" style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line)', fontSize: 13.5, fontWeight: 800 }}>
                    <span style={{ color: 'var(--muted)' }}>Net pay</span>
                    <span style={{ color: '#86efac', fontVariantNumeric: 'tabular-nums' }}>{money(c.netCents)}</span>
                  </div>
                  {c.shortfallCents > 0 && (
                    <p style={{ marginTop: 8, fontSize: 12.5, color: '#fcd34d' }}>
                      {money(c.shortfallCents)} could not be withheld — it exceeds what they earned this period. It stays on their claim balance and was not collected.
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="mt-8 text-xs" style={{ color: 'var(--muted)' }}>Independent-contractor payout statement. Amounts are read from each job&apos;s crew pay snapshot; verify before paying. Claim deductions are taken from the posted claim ledger — see the claim for its full history.</p>
    </div>
  )
}

export default function PayPage() {
  return <AdminGate title="Contractor Pay"><Pay /></AdminGate>
}
