'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Building2, ClipboardList, MapPin, CalendarClock, Users, CheckCircle2, ChevronLeft, Send, Sparkles, Truck, Phone } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { ymd, fmtLongDay, scoreColor, DOW, weekdaysLabel, Avatar } from '../ui'

const VEHICLE = 'Box truck' // J KISS is box-truck only — never asked, always this.

type Staff = { id: string; name: string; phone?: string; role?: string; active: boolean }
type Stats = Record<string, { score: number | null }>
type RouteLite = { assignedStaffId?: string; businessName: string; status: string; routeDate: string }

const STEP_META = [
  { key: 'business', title: 'Which business is this for?', Icon: Building2 },
  { key: 'work', title: 'What’s the work?', Icon: ClipboardList },
  { key: 'location', title: 'Where do they report?', Icon: MapPin },
  { key: 'schedule', title: 'When?', Icon: CalendarClock },
  { key: 'assign', title: 'Who’s taking it?', Icon: Users },
  { key: 'review', title: 'Review & send', Icon: CheckCircle2 },
]

const field: React.CSSProperties = { width: '100%', padding: '14px 15px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 14, color: 'var(--text)', fontSize: 16, outline: 'none' }
const labelCss: React.CSSProperties = { fontSize: 12.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 6, display: 'block' }

const pill = (on: boolean): React.CSSProperties => ({ flex: 1, padding: '11px', borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: 'pointer', border: `1px solid ${on ? 'var(--red)' : 'var(--line)'}`, background: on ? 'var(--red)' : 'transparent', color: on ? '#fff' : 'var(--muted)' })
const dayChip = (on: boolean): React.CSSProperties => ({ width: 42, height: 42, borderRadius: 12, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: `1px solid ${on ? 'var(--red)' : 'var(--line)'}`, background: on ? 'var(--red)' : 'transparent', color: on ? '#fff' : 'var(--muted)' })
const presetBtn: React.CSSProperties = { padding: '7px 13px', borderRadius: 999, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: '1px solid var(--line)', background: 'transparent', color: 'var(--muted)' }

function Builder() {
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [staff, setStaff] = useState<Staff[]>([])
  const [stats, setStats] = useState<Stats>({})
  const [routes, setRoutes] = useState<RouteLite[]>([])
  const [form, setForm] = useState({ businessName: '', description: '', payRate: '', reportAddress: '', contactPerson: '', contactPhone: '', routeDate: '', reportTime: '', staffId: '', specialNotes: '' })
  const [repeats, setRepeats] = useState(false)
  const [weekdays, setWeekdays] = useState<number[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<null | { recurring?: boolean; generated?: number; schedule?: string; routeNumber?: string; token?: string; assigned?: boolean; sent?: boolean }>(null)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    Promise.all([
      fetch('/api/admin/routes', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({})),
      fetch('/api/admin/staff', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({})),
    ]).then(([r, s]) => {
      setRoutes(r.items || []); setStats(r.stats || {})
      setStaff((s.items || []).filter((x: Staff) => x.active))
    })
  }, [])

  const set = (k: keyof typeof form, v: string) => setForm(f => ({ ...f, [k]: v }))
  const businesses = useMemo(() => [...new Set(routes.map(r => r.businessName).filter(Boolean))].sort(), [routes])
  const today = ymd(new Date())

  // Upcoming, still-live workload per employee.
  const workload = useMemo(() => {
    const m: Record<string, number> = {}
    for (const r of routes) {
      if (!r.assignedStaffId) continue
      if (!['assigned', 'text_sent', 'confirmed'].includes(r.status)) continue
      if (r.routeDate < today) continue
      m[r.assignedStaffId] = (m[r.assignedStaffId] || 0) + 1
    }
    return m
  }, [routes, today])

  // Recommend the most reliable eligible employee, lightest workload as tiebreak.
  const recommendedId = useMemo(() => {
    const eligible = staff.filter(s => s.phone)
    if (!eligible.length) return undefined
    return [...eligible].sort((a, b) => {
      const sa = stats[a.id]?.score ?? 70, sb = stats[b.id]?.score ?? 70
      if (sb !== sa) return sb - sa
      return (workload[a.id] || 0) - (workload[b.id] || 0)
    })[0].id
  }, [staff, stats, workload])

  const canContinue = (): boolean => {
    if (step === 0) return form.businessName.trim().length > 0
    if (step === 2) return form.reportAddress.trim().length > 0
    if (step === 3) return repeats ? (weekdays.length > 0 && form.reportTime.trim().length > 0) : (/^\d{4}-\d{2}-\d{2}$/.test(form.routeDate) && form.reportTime.trim().length > 0)
    return true
  }

  async function submit() {
    setSubmitting(true); setError('')
    try {
      if (repeats) {
        // Recurring contract → a template that auto-generates + assigns routes.
        const res = await fetch('/api/admin/route-templates', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({
            label: `${form.businessName} — ${weekdaysLabel(weekdays)}`, businessName: form.businessName,
            reportAddress: form.reportAddress, reportTime: form.reportTime, contactPerson: form.contactPerson,
            contactPhone: form.contactPhone, vehicle: VEHICLE, payRate: form.payRate, description: form.description,
            specialNotes: form.specialNotes, weekdays, defaultStaffId: form.staffId || undefined, autoNotify: Boolean(form.staffId),
          }),
        })
        const d = await res.json()
        if (!res.ok) { setError(d.error || 'Could not create the contract.'); return }
        // Generate the next 2 weeks now so routes appear immediately.
        let generated = 0
        try { const g = await fetch(`/api/admin/route-templates/${d.template.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ action: 'generate', horizonDays: 14 }) }).then(r => r.json()); generated = g.created?.length || 0 } catch { /* cron will still generate */ }
        setDone({ recurring: true, generated, schedule: weekdaysLabel(weekdays) })
        return
      }
      const res = await fetch('/api/admin/routes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ ...form, vehicle: VEHICLE }),
      })
      const d = await res.json()
      if (!res.ok) { setError(d.error || 'Could not create the assignment.'); return }
      setDone({ routeNumber: d.route?.routeNumber || '', token: d.route?.token, assigned: Boolean(form.staffId) })
    } catch { setError('Network error — please try again.') } finally { setSubmitting(false) }
  }

  async function sendText() {
    if (!done?.token) return
    setSending(true)
    try {
      const res = await fetch(`/api/admin/routes/${done.token}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ action: 'send' }) })
      const d = await res.json()
      if (res.ok && !d.smsWarning) setDone(prev => prev ? { ...prev, sent: true } : prev)
      else setError(d.smsWarning || d.error || 'Could not send the text.')
    } catch { setError('Network error — please try again.') } finally { setSending(false) }
  }

  const selectedStaff = staff.find(s => s.id === form.staffId)

  if (done) return (
    <div className="os-rise" style={{ maxWidth: 460, margin: '6vh auto 0', textAlign: 'center' }}>
      <div className="os-card" style={{ padding: 34 }}>
        <div style={{ width: 60, height: 60, borderRadius: 999, background: 'rgba(34,197,94,.16)', display: 'grid', placeItems: 'center', margin: '0 auto' }}><CheckCircle2 size={32} color="#22c55e" /></div>
        <h1 className="jkos-h" style={{ fontSize: 24, marginTop: 16 }}>{done.recurring ? 'Recurring contract set' : 'Assignment created'}</h1>
        <p style={{ color: 'var(--muted)', marginTop: 8, fontSize: 14.5 }}>
          {done.recurring
            ? `${done.schedule} · ${done.generated} route${done.generated === 1 ? '' : 's'} generated for the next 2 weeks${selectedStaff ? `, assigned to ${selectedStaff.name.split(' ')[0]}` : ''}. New routes keep generating automatically — no daily setup.`
            : <>{done.routeNumber && <b style={{ color: 'var(--text)' }}>{done.routeNumber}</b>} · {done.sent ? `confirmation text sent to ${selectedStaff?.name?.split(' ')[0] || 'the crew'}.` : done.assigned ? `assigned to ${selectedStaff?.name?.split(' ')[0] || 'the crew'} — nothing was texted yet.` : 'saved as a draft.'}</>}
        </p>
        {!done.recurring && done.assigned && !done.sent && (
          <button onClick={sendText} disabled={sending} className="btn os-tap" style={{ borderRadius: 12, justifyContent: 'center', marginTop: 18, width: '100%' }}>
            <Send size={17} /> {sending ? 'Sending…' : `Send confirmation text${selectedStaff ? ` to ${selectedStaff.name.split(' ')[0]}` : ''}`}
          </button>
        )}
        {error && <p style={{ color: '#f87171', fontSize: 13.5, marginTop: 12 }}>{error}</p>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
          <button onClick={() => { setDone(null); setStep(0); setRepeats(false); setWeekdays([]); setForm({ businessName: form.businessName, description: '', payRate: '', reportAddress: '', contactPerson: '', contactPhone: '', routeDate: '', reportTime: '', staffId: '', specialNotes: '' }) }} className="btn os-tap" style={{ borderRadius: 12, justifyContent: 'center' }}>Create another</button>
          <Link href="/admin/operations" className="btn-ghost os-tap" style={{ borderRadius: 12, justifyContent: 'center' }}>Back to Operations</Link>
        </div>
      </div>
    </div>
  )

  const meta = STEP_META[step]
  return (
    <div style={{ maxWidth: 560, margin: '0 auto' }}>
      {/* Progress */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 22 }}>
        {STEP_META.map((_, i) => (
          <div key={i} style={{ flex: 1, height: 4, borderRadius: 99, background: i <= step ? 'var(--red)' : 'var(--line)', transition: 'background .3s var(--os-ease)' }} />
        ))}
      </div>

      <div key={step} className="os-rise">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <meta.Icon size={18} style={{ color: 'var(--red-glow)' }} />
          <span style={{ fontSize: 12.5, fontWeight: 800, letterSpacing: '.04em', color: 'var(--muted)', textTransform: 'uppercase' }}>Step {step + 1} of {STEP_META.length}</span>
        </div>
        <h1 className="jkos-h" style={{ fontSize: 'clamp(24px,5vw,32px)', marginBottom: 20 }}>{meta.title}</h1>

        {/* ── Step content ── */}
        {step === 0 && (
          <div>
            <input autoFocus placeholder="Business / client name" value={form.businessName} onChange={e => set('businessName', e.target.value)} style={field} onKeyDown={e => { if (e.key === 'Enter' && canContinue()) setStep(1) }} />
            {businesses.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <span style={labelCss}>Recent clients</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {businesses.slice(0, 8).map(b => (
                    <button key={b} onClick={() => set('businessName', b)} className="os-tap"
                      style={{ padding: '8px 14px', borderRadius: 999, fontSize: 13.5, fontWeight: 600, cursor: 'pointer', border: `1px solid ${form.businessName === b ? 'var(--red)' : 'var(--line)'}`, background: form.businessName === b ? 'var(--red)' : 'transparent', color: form.businessName === b ? '#fff' : 'var(--muted)' }}>{b}</button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {step === 1 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 9, padding: '11px 15px', borderRadius: 12, background: 'rgba(224,0,42,.10)', border: '1px solid rgba(224,0,42,.25)', alignSelf: 'flex-start' }}>
              <Truck size={17} style={{ color: 'var(--red-glow)' }} /><span style={{ fontWeight: 700, fontSize: 14 }}>Box truck</span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>· standard equipment</span>
            </div>
            <div><span style={labelCss}>What’s the job?</span><textarea autoFocus placeholder="e.g. Palletized delivery run, 12 stops…" value={form.description} onChange={e => set('description', e.target.value)} rows={3} style={{ ...field, resize: 'vertical' }} /></div>
            <div><span style={labelCss}>Pay for this route (optional)</span><input placeholder="e.g. $175/route" value={form.payRate} onChange={e => set('payRate', e.target.value)} style={field} /></div>
          </div>
        )}

        {step === 2 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div><span style={labelCss}>Report / pickup address</span><input autoFocus placeholder="Street, city" value={form.reportAddress} onChange={e => set('reportAddress', e.target.value)} style={field} /></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div><span style={labelCss}>On-site contact (optional)</span><input placeholder="Name" value={form.contactPerson} onChange={e => set('contactPerson', e.target.value)} style={field} /></div>
              <div><span style={labelCss}>Contact phone</span><input placeholder="Phone" value={form.contactPhone} onChange={e => set('contactPhone', e.target.value)} style={field} /></div>
            </div>
          </div>
        )}

        {step === 3 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={() => setRepeats(false)} style={pill(!repeats)}>One-time</button>
              <button type="button" onClick={() => setRepeats(true)} style={pill(repeats)}>Repeats weekly</button>
            </div>
            {!repeats ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div><span style={labelCss}>Date</span><input type="date" min={today} value={form.routeDate} onChange={e => set('routeDate', e.target.value)} style={field} /></div>
                <div><span style={labelCss}>Report time</span><input placeholder="e.g. 7:00 AM" value={form.reportTime} onChange={e => set('reportTime', e.target.value)} style={field} /></div>
              </div>
            ) : (
              <div>
                <span style={labelCss}>Which days does this contract run?</span>
                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                  {DOW.map((d, i) => (
                    <button key={i} type="button" onClick={() => setWeekdays(w => w.includes(i) ? w.filter(x => x !== i) : [...w, i].sort((a, b) => a - b))} style={dayChip(weekdays.includes(i))}>{d}</button>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 10 }}>
                  <button type="button" onClick={() => setWeekdays([1, 2, 3, 4, 5])} style={presetBtn}>Mon–Fri</button>
                  <button type="button" onClick={() => setWeekdays([1, 2, 3, 4, 5, 6])} style={presetBtn}>Mon–Sat</button>
                  <button type="button" onClick={() => setWeekdays([0, 1, 2, 3, 4, 5, 6])} style={presetBtn}>Every day</button>
                </div>
                <div style={{ marginTop: 16 }}><span style={labelCss}>Report time</span><input placeholder="e.g. 7:00 AM" value={form.reportTime} onChange={e => set('reportTime', e.target.value)} style={field} /></div>
                <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 12 }}>Routes generate automatically for the next 2 weeks and keep rolling — you won’t re-add this business each day.</p>
              </div>
            )}
          </div>
        )}

        {step === 4 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {staff.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 14 }}>No active crew yet. You can save this as a draft and assign later.</p>}
            {[...staff].sort((a, b) => (a.id === recommendedId ? -1 : b.id === recommendedId ? 1 : (stats[b.id]?.score ?? 70) - (stats[a.id]?.score ?? 70))).map(s => {
              const sel = form.staffId === s.id
              const rec = s.id === recommendedId
              const score = stats[s.id]?.score
              return (
                <button key={s.id} onClick={() => set('staffId', sel ? '' : s.id)} className="os-card os-tap" style={{ padding: 14, textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 13, borderColor: sel ? 'var(--red)' : 'var(--line)', borderWidth: sel ? 2 : 1 }}>
                  <Avatar name={s.name} size={46} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700, fontSize: 15.5 }}>{s.name}</span>
                      {rec && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, fontWeight: 800, padding: '2px 8px', borderRadius: 99, background: 'rgba(224,0,42,.16)', color: '#fff' }}><Sparkles size={11} /> Recommended</span>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 3, fontSize: 12.5, color: 'var(--muted)' }}>
                      <span>Reliability <b style={{ color: scoreColor(score) }}>{score == null ? 'new' : score}</b></span>
                      <span>{workload[s.id] || 0} upcoming</span>
                      {!s.phone && <span style={{ color: '#fca5a5', display: 'inline-flex', alignItems: 'center', gap: 3 }}><Phone size={11} /> no phone</span>}
                    </div>
                  </div>
                  <div style={{ width: 22, height: 22, borderRadius: 999, flexShrink: 0, border: `2px solid ${sel ? 'var(--red)' : 'var(--line)'}`, background: sel ? 'var(--red)' : 'transparent', display: 'grid', placeItems: 'center' }}>{sel && <CheckCircle2 size={16} color="#fff" />}</div>
                </button>
              )
            })}
            <button onClick={() => set('staffId', '')} className="os-tap" style={{ padding: 14, borderRadius: 14, textAlign: 'left', cursor: 'pointer', background: 'transparent', border: `1px dashed ${form.staffId === '' ? 'var(--red)' : 'var(--line)'}`, color: form.staffId === '' ? 'var(--text)' : 'var(--muted)', fontWeight: 600, fontSize: 14 }}>
              Assign later — save as a draft
            </button>
          </div>
        )}

        {step === 5 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="os-card" style={{ padding: 18 }}>
              <SummaryRow label="Business" val={form.businessName} />
              <SummaryRow label="Work" val={[form.description || 'Contract route', `· ${VEHICLE}`, form.payRate && `· ${form.payRate}`].filter(Boolean).join(' ')} />
              <SummaryRow label="Report to" val={form.reportAddress} />
              <SummaryRow label="When" val={repeats ? `Repeats ${weekdaysLabel(weekdays)} · ${form.reportTime}` : `${fmtLongDay(form.routeDate)} · ${form.reportTime}`} />
              <SummaryRow label={repeats ? 'Crew (each route)' : 'Assigned'} val={selectedStaff ? selectedStaff.name : repeats ? 'Unassigned (drafts)' : 'Unassigned (draft)'} last />
            </div>
            {repeats ? (
              <div style={{ padding: 14, borderRadius: 14, background: 'rgba(224,0,42,.08)', border: '1px solid rgba(224,0,42,.22)' }}>
                <p style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--text)' }}>Routes generate automatically for <b>{weekdaysLabel(weekdays)}</b>, 2 weeks out and rolling.{selectedStaff?.phone ? ` Each one texts ${selectedStaff.name.split(' ')[0]} to confirm.` : ''}</p>
              </div>
            ) : selectedStaff?.phone && (
              <div style={{ padding: 14, borderRadius: 14, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>You’ll send them this text (not automatic)</div>
                <p style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--text)' }}>J KISS LLC Route Assignment: You have been assigned a route for {fmtLongDay(form.routeDate).replace(/,.*/, '')} at {form.reportTime}. Location: {form.reportAddress}. Confirm here: <span style={{ color: 'var(--red)' }}>[secure link]</span>. Reply STOP to opt out.</p>
              </div>
            )}
            {error && <p style={{ color: '#f87171', fontSize: 14 }}>{error}</p>}
          </div>
        )}
      </div>

      {/* Nav */}
      <div style={{ display: 'flex', gap: 12, marginTop: 28 }}>
        {step > 0 && <button onClick={() => setStep(s => s - 1)} className="btn-ghost os-tap" style={{ borderRadius: 12, paddingLeft: 16, paddingRight: 18 }}><ChevronLeft size={17} /> Back</button>}
        {step < 5
          ? <button onClick={() => canContinue() && setStep(s => s + 1)} disabled={!canContinue()} className="btn os-tap" style={{ borderRadius: 12, flex: 1, justifyContent: 'center', opacity: canContinue() ? 1 : .5 }}>Continue</button>
          : <button onClick={submit} disabled={submitting} className="btn os-tap" style={{ borderRadius: 12, flex: 1, justifyContent: 'center' }}>{submitting ? 'Creating…' : repeats ? 'Create recurring contract' : form.staffId ? 'Create assignment' : 'Save as draft'}</button>}
      </div>
    </div>
  )
}

function SummaryRow({ label, val, last }: { label: string; val: string; last?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '9px 0', borderBottom: last ? 'none' : '1px solid var(--line)' }}>
      <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--muted)', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 600, textAlign: 'right' }}>{val}</span>
    </div>
  )
}

export default function NewAssignmentPage() {
  return <OperationsShell><Builder /></OperationsShell>
}
