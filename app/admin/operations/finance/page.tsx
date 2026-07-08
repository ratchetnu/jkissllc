'use client'

// Money — ADMIN ONLY. Revenue in, payouts out, profit between.
// Reachable from the OS home card and Settings → More tools. Drivers and
// contractors have no route to this page and no API that returns its data.
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, Wallet, TrendingUp, TriangleAlert, Users, Building2 } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { money, moneyOrDash, profitColor, fmtDay, ymd, StatusChip, osField, osLabel } from '../ui'

type Group = { key: string; label: string; routeCount: number; revenueCents: number; payoutCents: number; profitCents: number }
type Line = {
  token: string; routeNumber: string; routeDate: string; businessName: string; status: string
  revenueCents: number | null; payoutCents: number; profitCents: number | null; unpricedCrew: number
  crew: { staffId: string; name: string; role?: string; payCents?: number }[]
}
type Summary = {
  routeCount: number
  revenueCents: number; payoutCents: number; profitCents: number
  driverPayoutCents: number; helperPayoutCents: number; otherPayoutCents: number
  unpricedRoutes: number; unpricedCrewRoutes: number
  byBusiness: Group[]; byCrew: Group[]; routes: Line[]
}
type Staff = { id: string; name: string }

const STATUSES = [
  { key: 'all', label: 'All (excl. cancelled)' },
  { key: 'completed', label: 'Completed' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'assigned', label: 'Assigned' },
  { key: 'text_sent', label: 'Awaiting confirm' },
  { key: 'no_show', label: 'No show' },
  { key: 'cancelled', label: 'Cancelled' },
]

// Default window: the last 30 days through today, in the operator's local calendar.
function defaultRange(): { start: string; end: string } {
  const end = new Date()
  const start = new Date(end.getTime() - 29 * 86_400_000)
  return { start: ymd(start), end: ymd(end) }
}

function Finance() {
  const [range, setRange] = useState(defaultRange)
  const [business, setBusiness] = useState('')
  const [staffId, setStaffId] = useState('')
  const [status, setStatus] = useState('completed')
  const [summary, setSummary] = useState<Summary | null>(null)
  const [staff, setStaff] = useState<Staff[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    const q = new URLSearchParams()
    if (range.start) q.set('start', range.start)
    if (range.end) q.set('end', range.end)
    if (business) q.set('business', business)
    if (staffId) q.set('staffId', staffId)
    if (status) q.set('status', status)
    try {
      const d = await fetch(`/api/admin/finance?${q}`, { credentials: 'same-origin' }).then(r => r.json())
      if (d.summary) setSummary(d.summary)
      else setErr(d.error === 'UPSTASH_NOT_CONFIGURED' ? 'Storage is not configured.' : 'Could not load finance.')
    } catch { setErr('Network error.') } finally { setLoading(false) }
  }, [range.start, range.end, business, staffId, status])
  useEffect(() => { load() }, [load])

  // Filter options come from the FULL dataset, once. Deriving them from `summary`
  // would collapse the dropdown to whatever the current filter matched, leaving
  // no way back to "all".
  const [allBiz, setAllBiz] = useState<string[]>([])
  useEffect(() => {
    Promise.all([
      fetch('/api/admin/staff', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({})),
      fetch('/api/admin/routes', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({})),
    ]).then(([s, r]) => {
      setStaff(s.items || [])
      setAllBiz([...new Set(((r.items || []) as { businessName?: string }[]).map(x => x.businessName).filter((b): b is string => !!b))].sort())
    })
  }, [])

  const businesses = useMemo(() => allBiz, [allBiz])
  const hasGaps = !!summary && (summary.unpricedRoutes > 0 || summary.unpricedCrewRoutes > 0)

  return (
    <div>
      <Link href="/admin/operations" className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--muted)', fontSize: 13.5, fontWeight: 600, textDecoration: 'none', marginBottom: 14 }}><ChevronLeft size={16} /> Operations</Link>

      <div className="os-rise" style={{ marginBottom: 20 }}>
        <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Wallet size={13} /> Admin only</p>
        <h1 className="jkos-h" style={{ fontSize: 'clamp(28px,6vw,40px)' }}>Money</h1>
      </div>

      {/* Filters */}
      <div className="os-card os-rise" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))', gap: 10 }}>
          <div>
            <div style={{ ...osLabel, marginBottom: 6 }}>From</div>
            <input type="date" value={range.start} onChange={e => setRange(r => ({ ...r, start: e.target.value }))} style={osField} />
          </div>
          <div>
            <div style={{ ...osLabel, marginBottom: 6 }}>To</div>
            <input type="date" value={range.end} onChange={e => setRange(r => ({ ...r, end: e.target.value }))} style={osField} />
          </div>
          <div>
            <div style={{ ...osLabel, marginBottom: 6 }}>Status</div>
            <select value={status} onChange={e => setStatus(e.target.value)} style={osField}>
              {STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </div>
          <div>
            <div style={{ ...osLabel, marginBottom: 6 }}>Business</div>
            <select value={business} onChange={e => setBusiness(e.target.value)} style={osField}>
              <option value="">All businesses</option>
              {businesses.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div>
            <div style={{ ...osLabel, marginBottom: 6 }}>Crew</div>
            <select value={staffId} onChange={e => setStaffId(e.target.value)} style={osField}>
              <option value="">Everyone</option>
              {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        </div>
      </div>

      {err && <div className="os-card" style={{ padding: '11px 14px', marginBottom: 16, fontSize: 13.5, color: '#fca5a5' }}>{err}</div>}

      {loading || !summary ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="skeleton" style={{ width: '100%', height: 96, borderRadius: 16 }} />
          <div className="skeleton" style={{ width: '100%', height: 160, borderRadius: 16 }} />
        </div>
      ) : (
        <>
          {/* Headline */}
          <div className="os-card os-rise" style={{ padding: 20, marginBottom: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(140px, 100%), 1fr))', gap: 10 }}>
              <Big label="Revenue in" val={money(summary.revenueCents)} />
              <Big label="Paid out" val={money(summary.payoutCents)} tone={summary.payoutCents > 0 ? '#fca5a5' : undefined} />
              <Big label="Estimated profit" val={money(summary.profitCents)} tone={profitColor(summary.profitCents)} Icon={TrendingUp} />
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 12 }}>
              {summary.routeCount} route{summary.routeCount === 1 ? '' : 's'} · {fmtDay(range.start)} – {fmtDay(range.end)}
            </div>
          </div>

          {/* Honesty strip: don't let a total imply completeness it doesn't have. */}
          {hasGaps && (
            <div className="os-card os-rise" style={{ padding: '13px 15px', marginBottom: 14, display: 'flex', gap: 10, alignItems: 'flex-start', borderColor: 'rgba(252,211,77,.4)' }}>
              <TriangleAlert size={15} style={{ color: '#fcd34d', flexShrink: 0, marginTop: 2 }} />
              <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>
                {summary.unpricedRoutes > 0 && <>{summary.unpricedRoutes} route{summary.unpricedRoutes === 1 ? '' : 's'} have no contract price, so they add <b style={{ color: 'var(--text)' }}>$0</b> to revenue. </>}
                {summary.unpricedCrewRoutes > 0 && <>{summary.unpricedCrewRoutes} route{summary.unpricedCrewRoutes === 1 ? ' has' : 's have'} crew with no pay set, so payouts are understated. </>}
                Profit above is an estimate, not a closed book.
              </div>
            </div>
          )}

          {/* Payout split */}
          <div className="os-card os-rise" style={{ padding: 20, marginBottom: 14 }}>
            <div style={{ ...osLabel, marginBottom: 12 }}>Where the payout went</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(110px, 100%), 1fr))', gap: 10 }}>
              <Small label="Drivers" val={money(summary.driverPayoutCents)} />
              <Small label="Helpers" val={money(summary.helperPayoutCents)} />
              <Small label="Other crew" val={money(summary.otherPayoutCents)} />
            </div>
          </div>

          {/* By business */}
          {summary.byBusiness.length > 0 && (
            <div className="os-card os-rise" style={{ padding: 20, marginBottom: 14 }}>
              <div style={{ ...osLabel, display: 'inline-flex', alignItems: 'center', gap: 7, marginBottom: 12 }}><Building2 size={12} /> By business</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {summary.byBusiness.map(g => (
                  <div key={g.key} style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13.5 }}>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.label}<span style={{ color: 'var(--muted)', fontSize: 12 }}> · {g.routeCount}</span></span>
                    <span className="tabular-nums" style={{ color: 'var(--muted)', fontSize: 12.5, minWidth: 74, textAlign: 'right' }}>{money(g.revenueCents)}</span>
                    <span className="tabular-nums" style={{ fontWeight: 700, minWidth: 74, textAlign: 'right', color: profitColor(g.profitCents) }}>{money(g.profitCents)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* By crew — a cost sheet, so no revenue/profit column */}
          {summary.byCrew.length > 0 && (
            <div className="os-card os-rise" style={{ padding: 20, marginBottom: 14 }}>
              <div style={{ ...osLabel, display: 'inline-flex', alignItems: 'center', gap: 7, marginBottom: 12 }}><Users size={12} /> By crew</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {summary.byCrew.map(g => (
                  <div key={g.key} style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13.5 }}>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.label}<span style={{ color: 'var(--muted)', fontSize: 12 }}> · {g.routeCount} route{g.routeCount === 1 ? '' : 's'}</span></span>
                    <span className="tabular-nums" style={{ fontWeight: 700 }}>{money(g.payoutCents)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Route ledger */}
          <div className="os-card os-rise" style={{ padding: 20 }}>
            <div style={{ ...osLabel, marginBottom: 12 }}>Routes</div>
            {summary.routes.length === 0 ? (
              <p style={{ fontSize: 13.5, color: 'var(--muted)' }}>No routes match these filters.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 420 }}>
                  {summary.routes.map(r => (
                    <Link key={r.token} href={`/admin/operations/${r.token}`} className="os-tap"
                      style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 11px', borderRadius: 11, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)', textDecoration: 'none', color: 'var(--text)' }}>
                      <span style={{ fontSize: 12.5, color: 'var(--muted)', minWidth: 62 }}>{fmtDay(r.routeDate)}</span>
                      <span style={{ flex: 1, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.businessName}
                        {r.unpricedCrew > 0 && <span style={{ color: '#fcd34d', fontSize: 11.5 }}> · {r.unpricedCrew} unpriced</span>}
                      </span>
                      <StatusChip status={r.status} size="sm" />
                      <span className="tabular-nums" style={{ fontSize: 12.5, color: 'var(--muted)', minWidth: 70, textAlign: 'right' }}>{moneyOrDash(r.revenueCents)}</span>
                      <span className="tabular-nums" style={{ fontSize: 12.5, color: '#fca5a5', minWidth: 66, textAlign: 'right' }}>−{money(r.payoutCents)}</span>
                      <span className="tabular-nums" style={{ fontSize: 13, fontWeight: 700, minWidth: 74, textAlign: 'right', color: profitColor(r.profitCents) }}>{moneyOrDash(r.profitCents)}</span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Big({ label, val, tone, Icon }: { label: string; val: string; tone?: string; Icon?: typeof TrendingUp }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--muted)', fontWeight: 700 }}>
        {Icon && <Icon size={12} />} {label}
      </div>
      <div className="tabular-nums" style={{ fontSize: 'clamp(22px,4.6vw,30px)', fontWeight: 800, letterSpacing: '-.03em', marginTop: 3, color: tone || 'var(--text)' }}>{val}</div>
    </div>
  )
}

function Small({ label, val }: { label: string; val: string }) {
  return (
    <div style={{ padding: '11px 12px', borderRadius: 11, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
      <div className="tabular-nums" style={{ fontSize: 17, fontWeight: 800, letterSpacing: '-.02em' }}>{val}</div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{label}</div>
    </div>
  )
}

export default function FinancePage() {
  return <OperationsShell><Finance /></OperationsShell>
}
