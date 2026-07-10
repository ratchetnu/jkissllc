'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { UserPlus, Camera, ChevronDown, Sparkles, Phone, Pencil, Trash2, Wallet, History, Plus, X, Clock, Users, FileText, CalendarOff, Gauge } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { invalidateOps } from '../useOps'
import { Avatar, scoreColor, ymd, fmtDay, fmtTs, money, onActivate, MoneyInput, Toggle, centsToInput, looksLikeMoney, osLabel } from '../ui'
import ApplyScope from '../ApplyScope'
import CrewClaims from '../claims/CrewClaims'
import { computeCrewComp, type CrewCompSummary } from '../../../lib/crew-comp'
import { buildCrewScore, type CrewScore } from '../../../lib/crew-score'
import { mondayOf } from '../../../lib/dates'

type PayKind = 'driver' | 'helper' | 'contractor' | 'employee'
type PayHistoryEntry = { at: number; defaultPayCents?: number; payByBusiness?: Record<string, number>; effectiveDate?: string; active: boolean; notes?: string }
type Staff = {
  id: string; name: string; phone?: string; role?: string; photoUrl?: string; active: boolean
  payKind?: PayKind; defaultPayCents?: number; payByBusiness?: Record<string, number>
  payNotes?: string; payEffectiveDate?: string; payActive?: boolean; payHistory?: PayHistoryEntry[]
  usesTimeclock?: boolean
}
type CStats = { score: number | null; assignments: number; confirmed: number; completed: number; declined: number; noResponse: number; noShow: number }
type RouteLite = { routeNumber: string; assignedStaffId?: string; businessName: string; status: string; routeDate: string; reportTime: string; assignees?: { staffId: string; payCents?: number; role?: string }[] }

const PAY_KINDS: { key: PayKind; label: string }[] = [
  { key: 'driver', label: 'Driver' }, { key: 'helper', label: 'Helper' },
  { key: 'contractor', label: 'Contractor' }, { key: 'employee', label: 'Employee' },
]

const field: React.CSSProperties = { width: '100%', padding: '11px 13px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 11, color: 'var(--text)', fontSize: 14.5, outline: 'none' }
const btnSm: React.CSSProperties = { padding: '7px 13px', fontSize: 12.5, fontWeight: 700, borderRadius: 9, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: 'var(--muted)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }

function Hub() {
  const [staff, setStaff] = useState<Staff[]>([])
  const [stats, setStats] = useState<Record<string, CStats>>({})
  const [routes, setRoutes] = useState<RouteLite[]>([])
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState('')
  const [adding, setAdding] = useState(false)
  const [msg, setMsg] = useState('')
  const [applicantsToReview, setApplicantsToReview] = useState(0)
  const [timeOffPending, setTimeOffPending] = useState(0)
  const [signals, setSignals] = useState<Record<string, { availabilityWeeksSubmitted: number; availabilityWeeksExpected: number; incidents: number }>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [s, r] = await Promise.all([
        fetch('/api/admin/staff', { credentials: 'same-origin' }).then(x => x.json()),
        fetch('/api/admin/routes', { credentials: 'same-origin' }).then(x => x.json()),
      ])
      setStaff(s.items || []); setStats(r.stats || {}); setRoutes(r.items || [])
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [])

  // Applicant count for the sub-nav badge — how many are waiting on a decision.
  useEffect(() => {
    fetch('/api/admin/careers', { credentials: 'same-origin' })
      .then(x => x.json())
      .then(d => setApplicantsToReview((d.applicants || []).filter((a: { status: string }) => ['new', 'reviewed', 'information_requested'].includes(a.status)).length))
      .catch(() => {})
    // Pending time-off count for the sub-nav badge.
    fetch('/api/admin/timeoff', { credentials: 'same-origin' })
      .then(x => x.json())
      .then(d => setTimeOffPending((d.requests || []).filter((r: { status: string }) => r.status === 'pending').length))
      .catch(() => {})
    // Availability + incident signals for the Crew Score.
    fetch('/api/admin/crew-signals', { credentials: 'same-origin' })
      .then(x => x.json())
      .then(d => { if (d.signals) setSignals(d.signals) })
      .catch(() => {})
  }, [])
  useEffect(() => { load() }, [load])

  const today = ymd(new Date())
  const workload = useMemo(() => {
    const m: Record<string, RouteLite[]> = {}
    for (const r of routes) {
      if (!r.assignedStaffId || !['assigned', 'text_sent', 'confirmed'].includes(r.status) || r.routeDate < today) continue
      ;(m[r.assignedStaffId] ||= []).push(r)
    }
    return m
  }, [routes, today])

  // Earnings summary per crew member, computed from completed routes (see lib/crew-comp).
  const weekStart = mondayOf(today)
  const comps = useMemo(() => {
    const m: Record<string, CrewCompSummary> = {}
    for (const s of staff) m[s.id] = computeCrewComp(s.id, routes, today, weekStart)
    return m
  }, [staff, routes, today, weekStart])

  // Internal Crew Score (admin/manager only — never exposed to the crew portal).
  // Built from the server-computed reliability stats (`stats`, one source of truth);
  // availability and incident factors read "not measured" until wired in.
  const scores = useMemo(() => {
    const m: Record<string, CrewScore> = {}
    for (const s of staff) m[s.id] = buildCrewScore(stats[s.id], signals[s.id])
    return m
  }, [staff, stats, signals])

  const active = staff.filter(s => s.active)
  const inactive = staff.filter(s => !s.active)
  // Clients we've actually run routes for — the suggestions for a per-business rate.
  const businesses = useMemo(() => [...new Set(routes.map(r => r.businessName).filter(Boolean))].sort(), [routes])

  return (
    <div>
      <div className="os-rise" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <div>
          <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--muted)' }}>{active.length} active crew {active.length === 1 ? 'member' : 'members'}</p>
          <h1 className="jkos-h" style={{ fontSize: 'clamp(28px,6vw,40px)' }}>Your crew</h1>
        </div>
        <button onClick={() => setAdding(a => !a)} className="btn os-tap" style={{ borderRadius: 999, height: 44 }}><UserPlus size={17} /> Add crew member</button>
      </div>

      {/* Crew sub-navigation — Directory (here) + Applicants (the hiring pipeline). */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
        <span className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 15px', borderRadius: 999, fontSize: 13.5, fontWeight: 700, background: 'var(--red)', color: '#fff' }}>
          <Users size={15} /> Crew directory
        </span>
        <Link href="/admin/careers" className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 15px', borderRadius: 999, fontSize: 13.5, fontWeight: 700, background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', color: 'var(--muted)', textDecoration: 'none' }}>
          <FileText size={15} /> Applicants
          {applicantsToReview > 0 && <span style={{ fontSize: 11, fontWeight: 800, padding: '1px 8px', borderRadius: 999, background: 'var(--red)', color: '#fff' }}>{applicantsToReview}</span>}
        </Link>
        <Link href="/admin/operations/timeoff" className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 15px', borderRadius: 999, fontSize: 13.5, fontWeight: 700, background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', color: 'var(--muted)', textDecoration: 'none' }}>
          <CalendarOff size={15} /> Time Off
          {timeOffPending > 0 && <span style={{ fontSize: 11, fontWeight: 800, padding: '1px 8px', borderRadius: 999, background: 'var(--red)', color: '#fff' }}>{timeOffPending}</span>}
        </Link>
      </div>

      {msg && <div className="os-card" style={{ padding: '10px 14px', marginBottom: 16, fontSize: 13.5, color: '#fca5a5' }}>{msg}</div>}
      {adding && <EmployeeForm onDone={(m) => { setAdding(false); if (m) setMsg(m); load() }} onCancel={() => setAdding(false)} />}

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{[0, 1, 2].map(i => <div key={i} className="os-card" style={{ padding: 16, display: 'flex', gap: 13, alignItems: 'center' }}><div className="skeleton" style={{ width: 48, height: 48, borderRadius: 999 }} /><div style={{ flex: 1 }}><div className="skeleton" style={{ width: '40%', height: 15, borderRadius: 7 }} /><div className="skeleton" style={{ width: '25%', height: 11, borderRadius: 6, marginTop: 8 }} /></div></div>)}</div>
      ) : staff.length === 0 ? (
        <div className="os-card os-rise" style={{ padding: 34, textAlign: 'center' }}>
          <p className="jkos-h" style={{ fontSize: 18 }}>No crew yet</p>
          <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 6 }}>Add your crew to start assigning routes.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {active.map((s, i) => <EmployeeCard key={s.id} s={s} st={stats[s.id]} scoreData={scores[s.id]} businesses={businesses} upcoming={workload[s.id] || []} comp={comps[s.id]} open={openId === s.id} onToggle={() => setOpenId(o => o === s.id ? '' : s.id)} onOpen={() => setOpenId(s.id)} onChanged={load} setMsg={setMsg} delay={i} />)}
          {inactive.length > 0 && <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--muted)', margin: '14px 0 2px' }}>Inactive</div>}
          {inactive.map((s, i) => <EmployeeCard key={s.id} s={s} st={stats[s.id]} scoreData={scores[s.id]} businesses={businesses} upcoming={workload[s.id] || []} comp={comps[s.id]} open={openId === s.id} onToggle={() => setOpenId(o => o === s.id ? '' : s.id)} onOpen={() => setOpenId(s.id)} onChanged={load} setMsg={setMsg} delay={i} />)}
        </div>
      )}
    </div>
  )
}

function EmployeeCard({ s, st, scoreData, businesses, upcoming, comp, open, onToggle, onOpen, onChanged, setMsg, delay }: { s: Staff; st?: CStats; scoreData?: CrewScore; businesses: string[]; upcoming: RouteLite[]; comp?: CrewCompSummary; open: boolean; onToggle: () => void; onOpen: () => void; onChanged: () => void; setMsg: (m: string) => void; delay: number }) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  // Collapsing the card drops edit mode too, so reopening it shows the detail view
  // rather than jumping straight back into the form.
  useEffect(() => { if (!open) setEditing(false) }, [open])
  // Prefer the richer client Crew Score; fall back to the server reliability score.
  const score = scoreData?.score ?? st?.score
  const completionPct = st && st.assignments > 0 ? Math.round((st.completed / st.assignments) * 100) : null

  async function post(patch: Record<string, unknown>) {
    setBusy(true)
    try { await fetch('/api/admin/staff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ id: s.id, name: s.name, phone: s.phone, role: s.role, photoUrl: s.photoUrl, active: s.active, ...patch }) }); onChanged() }
    finally { setBusy(false) }
  }
  async function del() { if (!confirm(`Remove ${s.name}? Past routes keep their history.`)) return; setBusy(true); try { await fetch(`/api/admin/staff?id=${s.id}`, { method: 'DELETE', credentials: 'same-origin' }); onChanged() } finally { setBusy(false) } }

  return (
    <div className="os-card os-rise" style={{ overflow: 'hidden', opacity: s.active ? 1 : .6, animationDelay: `${Math.min(delay * 40, 200)}ms` }}>
      <div onClick={onToggle} onKeyDown={onActivate(onToggle)} role="button" tabIndex={0} aria-expanded={open} className="os-tap" style={{ cursor: 'pointer', padding: 15, display: 'flex', alignItems: 'center', gap: 13 }}>
        <Avatar name={s.name} photoUrl={s.photoUrl} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: 16 }}>{s.name}</span>
            {s.role && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{s.role}</span>}
            {!s.active && <span style={{ fontSize: 10.5, fontWeight: 800, padding: '1px 8px', borderRadius: 99, background: 'rgba(255,255,255,.08)', color: 'var(--muted)' }}>Inactive</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13, marginTop: 4, fontSize: 12.5, color: 'var(--muted)' }}>
            <span>Reliability <b style={{ color: scoreColor(score) }}>{score == null ? 'new' : score}</b></span>
            <span>{upcoming.length} upcoming</span>
            {s.defaultPayCents != null && s.payActive !== false && <span className="tabular-nums" style={{ color: '#86efac', fontWeight: 700 }}>{money(s.defaultPayCents)}/route</span>}
            {!s.phone && <span style={{ color: '#fca5a5', display: 'inline-flex', alignItems: 'center', gap: 3 }}><Phone size={11} /> no phone</span>}
          </div>
        </div>
        <button onClick={e => { e.stopPropagation(); onOpen(); setEditing(true) }} aria-label={`Edit ${s.name}`} className="os-tap"
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 10, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: 'var(--muted)', cursor: 'pointer', flexShrink: 0 }}>
          <Pencil size={15} />
        </button>
        <ChevronDown size={19} style={{ color: 'var(--muted)', flexShrink: 0, transition: 'transform .3s var(--os-ease)', transform: open ? 'rotate(180deg)' : 'none' }} />
      </div>

      <div className={`os-expand${open ? ' open' : ''}`}>
        <div><div style={{ padding: '0 15px 16px' }}>
          <div style={{ height: 1, background: 'var(--line)', marginBottom: 14 }} />
          {editing ? (
            <EmployeeForm existing={s} onDone={(m) => { setEditing(false); if (m) setMsg(m); onChanged() }} onCancel={() => setEditing(false)} />
          ) : (
            <>
              <PaySettings s={s} businesses={businesses} onChanged={onChanged} setMsg={setMsg} />

              {comp && <CrewEarnings comp={comp} s={s} />}

              {scoreData && <CrewScoreCard data={scoreData} />}

              {/* Record */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(72px, 1fr))', gap: 8, marginBottom: 14 }}>
                <Stat n={st?.completed ?? 0} label="Completed" />
                <Stat n={st?.confirmed ?? 0} label="Confirmed" />
                <Stat n={st?.declined ?? 0} label="Declined" />
                <Stat n={st?.noShow ?? 0} label="No-show" tone={(st?.noShow ?? 0) > 0 ? '#fca5a5' : undefined} />
                <Stat n={completionPct == null ? '—' : `${completionPct}%`} label="Completion" />
              </div>

              {upcoming.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>Upcoming</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {upcoming.slice(0, 6).map(r => (
                      <div key={r.routeNumber} style={{ display: 'flex', gap: 10, fontSize: 13 }}>
                        <span style={{ minWidth: 66, color: 'var(--muted)' }}>{fmtDay(r.routeDate)}</span>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.businessName}</span>
                        <span style={{ color: 'var(--muted)' }}>{r.reportTime}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <CrewClaims staffId={s.id} />

              {/* Timeclock — whether this person punches in/out (with GPS) on their
                  route link. Off = no clock section shows for them at all. */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '11px 13px', marginBottom: 14, borderRadius: 12, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                  <Clock size={16} style={{ color: 'var(--red-glow)', flexShrink: 0 }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700 }}>Timeclock</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{s.usesTimeclock !== false ? 'Clocks in/out with GPS on their route link' : 'No clock — this person doesn’t punch in'}</div>
                  </div>
                </div>
                <Toggle on={s.usesTimeclock !== false} onChange={v => post({ usesTimeclock: v })} />
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={() => setEditing(true)} disabled={busy} style={btnSm}><Pencil size={13} /> Edit</button>
                <button onClick={() => post({ active: !s.active })} disabled={busy} style={btnSm}>{s.active ? 'Deactivate' : 'Reactivate'}</button>
                <button onClick={del} disabled={busy} style={{ ...btnSm, color: '#f87171', marginLeft: 'auto' }}><Trash2 size={13} /> Remove</button>
              </div>
            </>
          )}
        </div></div>
      </div>
    </div>
  )
}

// ── Pay Settings ─────────────────────────────────────────────────────────────
// What this person earns per route. Snapshotted onto a route when they're
// assigned, so editing here never changes routes they already ran.
const bizKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

// Internal Crew Score breakdown — a scheduling aid for admins/managers ONLY.
// Never rendered in the crew portal. Composite + per-factor sub-scores; factors
// without data read "not measured" rather than faking a number.
function CrewScoreCard({ data }: { data: CrewScore }) {
  return (
    <div style={{ marginBottom: 16, padding: 14, borderRadius: 14, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ ...osLabel, display: 'flex', alignItems: 'center', gap: 7 }}><Gauge size={13} /> Crew Score · internal</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
          <span className="jkos-h tabular-nums" style={{ fontSize: 22, color: scoreColor(data.score) }}>{data.score == null ? '—' : data.score}</span>
          <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{data.band}</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {data.factors.map(f => (
          <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 82, flexShrink: 0, fontSize: 12, color: 'var(--muted)' }}>{f.label}</span>
            <div style={{ flex: 1, height: 6, borderRadius: 999, background: 'rgba(255,255,255,.06)', overflow: 'hidden' }}>
              {f.score != null && <div style={{ width: `${f.score}%`, height: '100%', background: scoreColor(f.score) }} />}
            </div>
            <span className="tabular-nums" style={{ width: 34, flexShrink: 0, textAlign: 'right', fontSize: 12, fontWeight: 700, color: f.score == null ? 'var(--muted)' : scoreColor(f.score) }}>{f.score == null ? '—' : f.score}</span>
          </div>
        ))}
      </div>
      <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 10 }}>Visible to admins &amp; managers only — never shown to crew. Scheduling aid, not a guarantee.</p>
    </div>
  )
}

// Read-only earnings summary — what this crew member has EARNED from completed work.
// Distinct from the pay-rate settings above (which configure the rate). Truthful:
// no "paid/outstanding" until crew-payout settlement exists (see future-improvements).
function CrewEarnings({ comp, s }: { comp: CrewCompSummary; s: Staff }) {
  const rate = typeof s.defaultPayCents === 'number' ? money(s.defaultPayCents) : '—'
  const basis = s.payKind ? PAY_KINDS.find(k => k.key === s.payKind)?.label : 'Per route'
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ ...osLabel, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 7 }}><Wallet size={13} /> Earnings</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 10 }}>
        <MoneyTile label="This pay week" value={money(comp.periodEarningsCents)} />
        <MoneyTile label="Year to date" value={money(comp.ytdEarningsCents)} tone="#86efac" />
        <MoneyTile label="Lifetime" value={money(comp.lifetimeEarningsCents)} />
      </div>
      <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: comp.recent.length ? 8 : 0 }}>
        {comp.completedRoutes} completed · {comp.upcomingRoutes} upcoming · rate {rate}{basis ? ` · ${basis}` : ''}
        {comp.businesses.length ? ` · ${comp.businesses.length} client${comp.businesses.length === 1 ? '' : 's'}` : ''}
      </p>
      {comp.recent.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted)' }}>Recent earnings</div>
          {comp.recent.map(l => (
            <div key={l.routeNumber} style={{ display: 'flex', gap: 10, fontSize: 13 }}>
              <span style={{ minWidth: 66, color: 'var(--muted)' }}>{fmtDay(l.date)}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.businessName}</span>
              <span className="tabular-nums" style={{ fontWeight: 700 }}>{money(l.payCents)}</span>
            </div>
          ))}
        </div>
      )}
      <p style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 8 }}>Earned from completed work. Payouts aren’t settled in OpsPilot yet.</p>
    </div>
  )
}

function MoneyTile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="os-card" style={{ padding: '10px 12px' }}>
      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>{label}</div>
      <div className="tabular-nums" style={{ fontSize: 16, fontWeight: 800, marginTop: 3, color: tone || 'var(--text)' }}>{value}</div>
    </div>
  )
}

function PaySettings({ s, businesses, onChanged, setMsg }: { s: Staff; businesses: string[]; onChanged: () => void; setMsg: (m: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [kind, setKind] = useState<PayKind | ''>(s.payKind || '')
  const [defaultPay, setDefaultPay] = useState(centsToInput(s.defaultPayCents))
  const [active, setActive] = useState(s.payActive ?? true)
  const [effective, setEffective] = useState(s.payEffectiveDate || '')
  const [notes, setNotes] = useState(s.payNotes || '')
  // Overrides are edited as display-name → dollar string; the server re-keys them.
  const [overrides, setOverrides] = useState<{ biz: string; pay: string }[]>(() =>
    Object.entries(s.payByBusiness ?? {}).map(([k, cents]) => ({
      biz: businesses.find(b => bizKey(b) === k) || k,
      pay: centsToInput(cents),
    })),
  )
  const [scope, setScope] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [showHistory, setShowHistory] = useState(false)

  const defaultInvalid = defaultPay.trim() !== '' && !looksLikeMoney(defaultPay)
  const badOverride = overrides.find(o => o.biz.trim() && o.pay.trim() && !looksLikeMoney(o.pay))
  const invalid = defaultInvalid || !!badOverride

  const origDefault = centsToInput(s.defaultPayCents)
  const origOverrides = JSON.stringify(Object.entries(s.payByBusiness ?? {}).sort())
  const nextOverrides = JSON.stringify(
    overrides.filter(o => o.biz.trim() && o.pay.trim()).map(o => [bizKey(o.biz), Math.round(Number(o.pay.replace(/[$,\s]/g, '')) * 100)] as [string, number]).sort(),
  )
  const payChanged = defaultPay.trim() !== origDefault.trim() || active !== (s.payActive ?? true) || origOverrides !== nextOverrides

  function reset() {
    setKind(s.payKind || ''); setDefaultPay(centsToInput(s.defaultPayCents)); setActive(s.payActive ?? true)
    setEffective(s.payEffectiveDate || ''); setNotes(s.payNotes || '')
    setOverrides(Object.entries(s.payByBusiness ?? {}).map(([k, c]) => ({ biz: businesses.find(b => bizKey(b) === k) || k, pay: centsToInput(c) })))
    setEditing(false); setScope(false); setErr('')
  }

  async function save(applyTo: 'none' | 'future' | 'selected' = 'none', routeTokens: string[] = []) {
    if (invalid) { setErr('Pay must be a positive dollar amount, e.g. 175 or 175.00.'); return }
    if (active && !defaultPay.trim() && !overrides.some(o => o.biz.trim() && o.pay.trim())) {
      setErr('Set a default route pay, or switch this pay off.'); return
    }
    const payByBusiness: Record<string, string> = {}
    for (const o of overrides) if (o.biz.trim() && o.pay.trim()) payByBusiness[o.biz.trim()] = o.pay.trim()

    setBusy(true); setErr('')
    try {
      const res = await fetch('/api/admin/staff', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({
          id: s.id, name: s.name, phone: s.phone, role: s.role, photoUrl: s.photoUrl, active: s.active,
          payKind: kind || undefined, defaultPay: defaultPay.trim(), payByBusiness,
          payActive: active, payEffectiveDate: effective || undefined, payNotes: notes,
          applyTo, routeTokens,
        }),
      })
      const d = await res.json()
      if (!res.ok) { setErr(d.error || 'Could not save pay.'); return }
      const n = d.reprice?.updated?.length ?? 0
      setMsg(n > 0 ? `Pay saved — ${n} upcoming route${n === 1 ? '' : 's'} re-priced.` : 'Compensation saved.')
      if (n > 0) invalidateOps()   // re-priced routes show fresh on Home/List, not ≤10s-stale
      setEditing(false); setScope(false); onChanged()
    } catch { setErr('Network error.') } finally { setBusy(false) }
  }

  function onSave() {
    if (invalid) { setErr('Pay must be a positive dollar amount, e.g. 175 or 175.00.'); return }
    if (payChanged) setScope(true)
    else save('none')
  }

  const history = [...(s.payHistory ?? [])].reverse()
  const overrideCount = Object.keys(s.payByBusiness ?? {}).length

  return (
    <div style={{ marginBottom: 14, padding: 13, borderRadius: 12, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: editing ? 12 : 8 }}>
        <Wallet size={14} style={{ color: 'var(--red-glow)' }} />
        <div style={{ ...osLabel, flex: 1 }}>Crew compensation</div>
        {!editing && <button onClick={() => setEditing(true)} className="os-tap" style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer' }}>Edit</button>}
      </div>

      {!editing ? (
        <>
          {s.defaultPayCents == null && overrideCount === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--muted)' }}>No pay rate set. Routes they&rsquo;re assigned to will show as unpriced crew.</p>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
                <span className="tabular-nums" style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-.02em', color: s.payActive === false ? 'var(--muted)' : 'var(--text)' }}>{s.defaultPayCents == null ? '—' : money(s.defaultPayCents)}</span>
                <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>default per route</span>
                {s.payKind && <span style={{ fontSize: 10.5, fontWeight: 800, padding: '2px 8px', borderRadius: 99, background: 'rgba(224,0,42,.16)', color: '#fff', textTransform: 'capitalize' }}>{s.payKind}</span>}
                {s.payActive === false && <span style={{ fontSize: 10.5, fontWeight: 800, padding: '2px 8px', borderRadius: 99, background: 'rgba(255,255,255,.08)', color: 'var(--muted)' }}>Inactive</span>}
              </div>
              {overrideCount > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 9 }}>
                  {Object.entries(s.payByBusiness ?? {}).map(([k, cents]) => (
                    <div key={k} style={{ display: 'flex', gap: 10, fontSize: 13 }}>
                      <span style={{ flex: 1, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{businesses.find(b => bizKey(b) === k) || k}</span>
                      <span className="tabular-nums" style={{ fontWeight: 700, color: '#86efac' }}>{money(cents)}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          {s.payEffectiveDate && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>Effective {fmtDay(s.payEffectiveDate)}</div>}
          {s.payNotes && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6 }}>{s.payNotes}</div>}

          {history.length > 0 && (
            <>
              <button onClick={() => setShowHistory(h => !h)} className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 10, fontSize: 12, fontWeight: 700, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                <History size={12} /> {showHistory ? 'Hide' : 'Pay'} history ({history.length})
              </button>
              {showHistory && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 8 }}>
                  {history.map((h, i) => (
                    <div key={i} style={{ display: 'flex', gap: 10, fontSize: 12.5, alignItems: 'center' }}>
                      <span style={{ color: 'var(--muted)', minWidth: 100 }}>{fmtTs(h.at)}</span>
                      <span className="tabular-nums" style={{ fontWeight: 700 }}>{h.defaultPayCents == null ? 'cleared' : money(h.defaultPayCents)}</span>
                      {!h.active && <span style={{ color: 'var(--muted)' }}>· inactive</span>}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 7 }}>How they&rsquo;re engaged</div>
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
              {PAY_KINDS.map(k => {
                const on = kind === k.key
                return (
                  <button key={k.key} type="button" onClick={() => setKind(on ? '' : k.key)}
                    style={{ padding: '8px 15px', borderRadius: 999, fontSize: 13, fontWeight: 700, cursor: 'pointer', border: `1px solid ${on ? 'var(--red)' : 'var(--line)'}`, background: on ? 'var(--red)' : 'transparent', color: on ? '#fff' : 'var(--muted)' }}>{k.label}</button>
                )
              })}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>Default route pay</div>
              <MoneyInput value={defaultPay} onChange={setDefaultPay} invalid={defaultInvalid} aria-label="Default route pay" disabled={busy} />
            </div>
            <div>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>Effective date</div>
              <input type="date" value={effective} onChange={e => setEffective(e.target.value)} style={field} />
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 7 }}>Business-specific pay <span style={{ fontWeight: 500 }}>— overrides the default</span></div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {overrides.map((o, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input list={`biz-${s.id}`} placeholder="Business" value={o.biz} onChange={e => setOverrides(v => v.map((x, j) => j === i ? { ...x, biz: e.target.value } : x))} style={{ ...field, flex: 1 }} />
                  <div style={{ width: 118 }}>
                    <MoneyInput value={o.pay} onChange={p => setOverrides(v => v.map((x, j) => j === i ? { ...x, pay: p } : x))} invalid={!!o.pay.trim() && !looksLikeMoney(o.pay)} aria-label={`Pay for ${o.biz || 'business'}`} />
                  </div>
                  <button type="button" onClick={() => setOverrides(v => v.filter((_, j) => j !== i))} aria-label="Remove override" className="os-tap" style={{ ...btnSm, padding: 8, color: '#fca5a5' }}><X size={14} /></button>
                </div>
              ))}
              <datalist id={`biz-${s.id}`}>{businesses.map(b => <option key={b} value={b} />)}</datalist>
              <button type="button" onClick={() => setOverrides(v => [...v, { biz: '', pay: '' }])} style={{ ...btnSm, alignSelf: 'flex-start' }}><Plus size={13} /> Add a business rate</button>
            </div>
          </div>

          <textarea placeholder="Pay notes (e.g. paid weekly by Zelle)" value={notes} onChange={e => setNotes(e.target.value)} rows={2} style={{ ...field, marginTop: 12, resize: 'vertical' }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 11, marginTop: 10, padding: '10px 12px', borderRadius: 11, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
            <Toggle on={active} onChange={setActive} label="Pay active" />
            <div><div style={{ fontSize: 13.5, fontWeight: 700 }}>Pay active</div><div style={{ fontSize: 12, color: 'var(--muted)' }}>Off = rate kept on file but not auto-applied to new routes.</div></div>
          </label>

          {invalid && <p style={{ color: '#f87171', fontSize: 12.5, marginTop: 8 }}>Pay must be a positive dollar amount, e.g. 175 or 175.00.</p>}
          {err && <p style={{ color: '#f87171', fontSize: 13, marginTop: 8 }}>{err}</p>}

          {scope ? (
            <ApplyScope
              candidatesUrl={`/api/admin/staff?candidates=${encodeURIComponent(s.id)}`}
              mode="pay" busy={busy}
              onCancel={() => setScope(false)}
              onConfirm={({ applyTo, routeTokens }) => save(applyTo, routeTokens)}
            />
          ) : (
            <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
              <button onClick={onSave} disabled={busy || invalid} className="btn os-tap" style={{ borderRadius: 11, height: 40, flex: 1, justifyContent: 'center', opacity: busy || invalid ? .55 : 1 }}>{busy ? 'Saving…' : 'Save pay'}</button>
              <button onClick={reset} disabled={busy} className="btn-ghost os-tap" style={{ borderRadius: 11, height: 40 }}>Cancel</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Stat({ n, label, tone }: { n: number | string; label: string; tone?: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '8px 4px', borderRadius: 10, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
      <div className="tabular-nums" style={{ fontSize: 18, fontWeight: 800, color: tone || 'var(--text)' }}>{n}</div>
      <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 1 }}>{label}</div>
    </div>
  )
}

function EmployeeForm({ existing, onDone, onCancel }: { existing?: Staff; onDone: (msg?: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(existing?.name || '')
  const [phone, setPhone] = useState(existing?.phone || '')
  const [role, setRole] = useState(existing?.role || '')
  const [photoUrl, setPhotoUrl] = useState(existing?.photoUrl || '')
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  async function pickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; e.target.value = ''
    if (!f) return
    setUploading(true); setErr('')
    try {
      const dataUrl = await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = rej; fr.readAsDataURL(f) })
      const up = await fetch('/api/admin/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ image: dataUrl }) })
      const j = await up.json().catch(() => ({}))
      if (up.ok && j.url) setPhotoUrl(j.url); else setErr(j.error || 'Photo upload failed.')
    } catch { setErr('Photo upload failed.') } finally { setUploading(false) }
  }

  async function save() {
    if (!name.trim()) { setErr('A name is required.'); return }
    setSaving(true); setErr('')
    try {
      const res = await fetch('/api/admin/staff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ id: existing?.id, name, phone, role, photoUrl, active: existing ? existing.active : true }) })
      const d = await res.json()
      if (!res.ok) { setErr(d.error || 'Could not save.'); return }
      onDone(existing ? undefined : `${name.trim()} added to your crew.`)
    } catch { setErr('Network error.') } finally { setSaving(false) }
  }

  const previewStaff: Staff = { id: 'x', name: name || '—', photoUrl: photoUrl || undefined, active: true }
  return (
    <div className={existing ? '' : 'os-card os-rise'} style={existing ? {} : { padding: 16, marginBottom: 16 }}>
      {!existing && <p style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 12 }}>New crew member</p>}
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 12 }}>
        <Avatar name={previewStaff.name} photoUrl={previewStaff.photoUrl} size={56} />
        <label style={{ ...btnSm, cursor: uploading ? 'wait' : 'pointer' }}>
          <Camera size={14} /> {uploading ? 'Uploading…' : photoUrl ? 'Change photo' : 'Add photo'}
          <input type="file" accept="image/*" onChange={pickPhoto} style={{ display: 'none' }} disabled={uploading} />
        </label>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <input placeholder="Name" value={name} onChange={e => setName(e.target.value)} style={field} />
        <input placeholder="Phone" value={phone} onChange={e => setPhone(e.target.value)} style={field} />
      </div>
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 7 }}>Role</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {['Driver', 'Helper'].map(r => {
            const on = role === r
            return (
              <button key={r} type="button" onClick={() => setRole(on ? '' : r)}
                style={{ padding: '9px 18px', borderRadius: 999, fontSize: 13.5, fontWeight: 700, cursor: 'pointer', border: `1px solid ${on ? 'var(--red)' : 'var(--line)'}`, background: on ? 'var(--red)' : 'transparent', color: on ? '#fff' : 'var(--muted)' }}>{r}</button>
            )
          })}
          <button type="button" onClick={() => setRole(role === 'Driver' || role === 'Helper' || role === '' ? 'Other' : '')}
            style={{ padding: '9px 18px', borderRadius: 999, fontSize: 13.5, fontWeight: 700, cursor: 'pointer', border: `1px solid ${role && role !== 'Driver' && role !== 'Helper' ? 'var(--red)' : 'var(--line)'}`, background: role && role !== 'Driver' && role !== 'Helper' ? 'var(--red)' : 'transparent', color: role && role !== 'Driver' && role !== 'Helper' ? '#fff' : 'var(--muted)' }}>Other</button>
        </div>
        {role !== '' && role !== 'Driver' && role !== 'Helper' && (
          <input autoFocus placeholder="Role name" value={role === 'Other' ? '' : role} onChange={e => setRole(e.target.value)} style={{ ...field, marginTop: 8 }} />
        )}
      </div>
      {err && <p style={{ color: '#f87171', fontSize: 13, marginTop: 10 }}>{err}</p>}
      <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
        <button onClick={save} disabled={saving || uploading} className="btn os-tap" style={{ borderRadius: 11, height: 40, flex: 1, justifyContent: 'center' }}>{saving ? 'Saving…' : existing ? 'Save changes' : 'Add crew member'}</button>
        <button onClick={onCancel} className="btn-ghost os-tap" style={{ borderRadius: 11, height: 40 }}>Cancel</button>
      </div>
    </div>
  )
}

export default function EmployeesPage() {
  return <OperationsShell><Hub /></OperationsShell>
}
