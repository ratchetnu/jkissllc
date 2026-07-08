'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Building2, ClipboardList, MapPin, CalendarClock, Users, CheckCircle2, ChevronLeft, Send, Sparkles, Truck, Phone, Lock } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { ymd, fmtLongDay, scoreColor, DOW, weekdaysLabel, Avatar, MoneyInput, money, moneyOrDash, profitColor, centsToInput, looksLikeMoney } from '../ui'

const VEHICLE = 'Box truck' // J KISS is box-truck only — never asked, always this.

type Staff = { id: string; name: string; phone?: string; role?: string; active: boolean; defaultPayCents?: number; payByBusiness?: Record<string, number>; payActive?: boolean }
type Stats = Record<string, { score: number | null }>
type RouteLite = { assignedStaffId?: string; businessName: string; status: string; routeDate: string }
type BusinessRec = { key: string; name: string; contractRateCents?: number; pricingActive?: boolean }

const bizKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

// Mirrors lib/finance.resolveCrewPay so the builder can preview the same number
// the server will snapshot. The server remains the source of truth.
function previewCrewPay(s: Staff | undefined, businessName: string): number | undefined {
  if (!s || s.payActive === false) return undefined
  const o = s.payByBusiness?.[bizKey(businessName)]
  if (typeof o === 'number') return o
  return typeof s.defaultPayCents === 'number' ? s.defaultPayCents : undefined
}
const dollarsToCents = (v: string): number | undefined =>
  looksLikeMoney(v) ? Math.round(Number(v.replace(/[$,\s]/g, '')) * 100) : undefined

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
  const [bizRecords, setBizRecords] = useState<BusinessRec[]>([])
  const [form, setForm] = useState({ businessName: '', description: '', businessPrice: '', reportAddress: '', contactPerson: '', contactPhone: '', routeDate: '', reportTime: '', staffId: '', specialNotes: '' })
  const [priceTouched, setPriceTouched] = useState(false)
  const [repeats, setRepeats] = useState(false)
  const [weekdays, setWeekdays] = useState<number[]>([])
  const [crew, setCrew] = useState<{ staffId: string; pay: string }[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<null | { recurring?: boolean; generated?: number; schedule?: string; routeNumber?: string; token?: string; assigned?: boolean; sent?: boolean }>(null)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    Promise.all([
      fetch('/api/admin/routes', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({})),
      fetch('/api/admin/staff', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({})),
      fetch('/api/admin/businesses', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({})),
    ]).then(([r, s, b]) => {
      setRoutes(r.items || []); setStats(r.stats || {})
      setStaff((s.items || []).filter((x: Staff) => x.active))
      setBizRecords(b.items || [])
    })
  }, [])

  const set = (k: keyof typeof form, v: string) => setForm(f => ({ ...f, [k]: v }))
  const businesses = useMemo(() => [...new Set(routes.map(r => r.businessName).filter(Boolean))].sort(), [routes])
  const today = ymd(new Date())

  // The client's contract rate, if one is on file and active.
  const contractCents = useMemo(() => {
    const rec = bizRecords.find(b => b.key === bizKey(form.businessName))
    return rec && rec.pricingActive !== false ? rec.contractRateCents : undefined
  }, [bizRecords, form.businessName])

  // The price shown is DERIVED: the contract rate until the owner types over it.
  // (An effect that wrote the rate into form state would fight the user's typing
  // and cascade a render every time the business changed.)
  const businessPrice = priceTouched ? form.businessPrice : centsToInput(contractCents)

  // Each selected crew member's pay: what the owner typed, else their configured
  // rate for this client.
  const crewWithPay = useMemo(() =>
    crew.map(c => {
      const s = staff.find(x => x.id === c.staffId)
      const resolved = previewCrewPay(s, form.businessName)
      const cents = c.pay.trim() ? dollarsToCents(c.pay) : resolved
      return { ...c, staff: s, resolvedCents: resolved, cents }
    }).filter((x): x is typeof x & { staff: Staff } => !!x.staff),
  [crew, staff, form.businessName])

  // Live preview of the same math the server will do.
  const priceCents = businessPrice.trim() ? dollarsToCents(businessPrice) : undefined
  const payoutCents = crewWithPay.reduce((sum, c) => sum + (c.cents ?? 0), 0)
  const unpricedCrew = crewWithPay.filter(c => c.cents == null).length
  const profitCents = priceCents == null ? null : priceCents - payoutCents
  const priceInvalid = businessPrice.trim() !== '' && !looksLikeMoney(businessPrice)
  const payInvalid = crew.some(c => c.pay.trim() !== '' && !looksLikeMoney(c.pay))

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

  // Recommend a driver first (a route needs one), then most reliable, then
  // lightest workload.
  const recommendedId = useMemo(() => {
    const eligible = staff.filter(s => s.phone)
    if (!eligible.length) return undefined
    const isDriver = (s: Staff) => /driver/i.test(s.role || '')
    return [...eligible].sort((a, b) => {
      const da = isDriver(a), db = isDriver(b)
      if (da !== db) return da ? -1 : 1
      const sa = stats[a.id]?.score ?? 70, sb = stats[b.id]?.score ?? 70
      if (sb !== sa) return sb - sa
      return (workload[a.id] || 0) - (workload[b.id] || 0)
    })[0].id
  }, [staff, stats, workload])

  const canContinue = (): boolean => {
    if (step === 0) return form.businessName.trim().length > 0
    if (step === 1) return !priceInvalid
    if (step === 4) return !payInvalid
    if (step === 2) return form.reportAddress.trim().length > 0
    if (step === 3) return repeats ? (weekdays.length > 0 && form.reportTime.trim().length > 0) : (/^\d{4}-\d{2}-\d{2}$/.test(form.routeDate) && form.reportTime.trim().length > 0)
    return true
  }

  async function submit() {
    setSubmitting(true); setError('')
    try {
      if (repeats) {
        // Recurring contract → a template that auto-generates + assigns routes.
        // Generated routes snapshot the client's contract rate at generation time,
        // so the template itself carries no price.
        const res = await fetch('/api/admin/route-templates', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({
            label: `${form.businessName} — ${weekdaysLabel(weekdays)}`, businessName: form.businessName,
            reportAddress: form.reportAddress, reportTime: form.reportTime, contactPerson: form.contactPerson,
            contactPhone: form.contactPhone, vehicle: VEHICLE, description: form.description,
            specialNotes: form.specialNotes, weekdays, defaultStaffId: crew[0]?.staffId || undefined, autoNotify: crew.length > 0,
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

      const payload = {
        ...form, businessPrice, vehicle: VEHICLE,
        // Only send crew pay the owner actually typed — a blank lets the server
        // resolve the person's configured rate.
        crew: crew.filter(c => c.staffId).map(c => ({ staffId: c.staffId, pay: c.pay.trim() || undefined })),
      }
      const post = (b: Record<string, unknown>) => fetch('/api/admin/routes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(b),
      })

      let res = await post(payload)
      let d = await res.json()

      // The server refuses to silently save a route that pays out more than it
      // earns. Confirm, then retry with the acknowledgement.
      if (res.status === 409 && d.warning === 'pay_exceeds_price') {
        if (!confirm(d.message)) return
        res = await post({ ...payload, acknowledgeWarning: true })
        d = await res.json()
      }

      if (!res.ok) { setError(d.error || 'Could not create the assignment.'); return }
      setDone({ routeNumber: d.route?.routeNumber || '', token: d.route?.token, assigned: crew.length > 0 })
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

  const crewStaff = crew.map(c => ({ ...c, staff: staff.find(s => s.id === c.staffId) })).filter((x): x is { staffId: string; pay: string; staff: Staff } => !!x.staff)
  const primaryStaff = crewStaff[0]?.staff
  const inCrew = (id: string) => crew.some(c => c.staffId === id)
  const toggleCrew = (id: string) => setCrew(c => c.some(x => x.staffId === id) ? c.filter(x => x.staffId !== id) : [...c, { staffId: id, pay: '' }])
  const setCrewPay = (id: string, pay: string) => setCrew(c => c.map(x => x.staffId === id ? { ...x, pay } : x))
  const crewLabel = crewStaff.length === 0 ? '' : crewStaff.length === 1 ? crewStaff[0].staff.name.split(' ')[0] : `${crewStaff[0].staff.name.split(' ')[0]} +${crewStaff.length - 1}`

  if (done) return (
    <div className="os-rise" style={{ maxWidth: 460, margin: '6vh auto 0', textAlign: 'center' }}>
      <div className="os-card" style={{ padding: 34 }}>
        <div style={{ width: 60, height: 60, borderRadius: 999, background: 'rgba(34,197,94,.16)', display: 'grid', placeItems: 'center', margin: '0 auto' }}><CheckCircle2 size={32} color="#22c55e" /></div>
        <h1 className="jkos-h" style={{ fontSize: 24, marginTop: 16 }}>{done.recurring ? 'Recurring contract set' : 'Assignment created'}</h1>
        <p style={{ color: 'var(--muted)', marginTop: 8, fontSize: 14.5 }}>
          {done.recurring
            ? `${done.schedule} · ${done.generated} route${done.generated === 1 ? '' : 's'} generated for the next 2 weeks${primaryStaff ? `, assigned to ${crewLabel}` : ''}. New routes keep generating automatically — no daily setup.`
            : <>{done.routeNumber && <b style={{ color: 'var(--text)' }}>{done.routeNumber}</b>} · {done.sent ? `confirmation text sent to ${crewLabel || 'the crew'}.` : done.assigned ? `assigned to ${crewLabel || 'the crew'} — nothing was texted yet.` : 'saved as a draft.'}</>}
        </p>
        {!done.recurring && done.assigned && !done.sent && (
          <button onClick={sendText} disabled={sending} className="btn os-tap" style={{ borderRadius: 12, justifyContent: 'center', marginTop: 18, width: '100%' }}>
            <Send size={17} /> {sending ? 'Sending…' : `Text ${crewStaff.length > 1 ? 'the crew' : (crewLabel || 'the crew')} to confirm`}
          </button>
        )}
        {error && <p style={{ color: '#f87171', fontSize: 13.5, marginTop: 12 }}>{error}</p>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
          <button onClick={() => { setDone(null); setStep(0); setRepeats(false); setWeekdays([]); setCrew([]); setPriceTouched(false); setForm({ businessName: form.businessName, description: '', businessPrice: '', reportAddress: '', contactPerson: '', contactPhone: '', routeDate: '', reportTime: '', staffId: '', specialNotes: '' }) }} className="btn os-tap" style={{ borderRadius: 12, justifyContent: 'center' }}>Create another</button>
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
            <div>
              <span style={labelCss}>What {form.businessName || 'the business'} pays for this route</span>
              <MoneyInput value={businessPrice} onChange={v => { setPriceTouched(true); set('businessPrice', v) }} invalid={priceInvalid} aria-label="Business charge" />
              {priceInvalid ? (
                <p style={{ fontSize: 12.5, color: '#f87171', marginTop: 6 }}>Enter a positive dollar amount, e.g. 350 or 350.00.</p>
              ) : contractCents != null && !priceTouched ? (
                <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6 }}>From their contract rate ({money(contractCents)}). Type over it to price this route differently.</p>
              ) : contractCents == null ? (
                <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6 }}>No contract rate on file for this client. Leave blank and this route won’t show revenue or profit.</p>
              ) : null}
            </div>
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
            <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: -8 }}>Pick everyone on this route — driver and any helpers. Set each person’s pay.</p>
            {staff.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 14 }}>No active crew yet. You can save this as a draft and add crew later.</p>}
            {[...staff].sort((a, b) => (a.id === recommendedId ? -1 : b.id === recommendedId ? 1 : (stats[b.id]?.score ?? 70) - (stats[a.id]?.score ?? 70))).map(s => {
              const sel = inCrew(s.id)
              const rec = s.id === recommendedId
              const score = stats[s.id]?.score
              const payVal = crew.find(c => c.staffId === s.id)?.pay ?? ''
              return (
                <div key={s.id} className="os-card" style={{ padding: 0, overflow: 'hidden', borderColor: sel ? 'var(--red)' : 'var(--line)', borderWidth: sel ? 2 : 1 }}>
                  <button onClick={() => toggleCrew(s.id)} className="os-tap" style={{ width: '100%', padding: 14, textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 13, background: 'none', border: 'none' }}>
                    <Avatar name={s.name} size={46} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 700, fontSize: 15.5 }}>{s.name}</span>
                        {s.role && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{s.role}</span>}
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
                  {sel && (() => {
                    const resolved = previewCrewPay(s, form.businessName)
                    const bad = payVal.trim() !== '' && !looksLikeMoney(payVal)
                    return (
                      <div style={{ padding: '0 14px 12px 73px' }}>
                        <MoneyInput value={payVal} onChange={v => setCrewPay(s.id, v)} invalid={bad} placeholder={resolved != null ? (resolved / 100).toFixed(2) : '0.00'} aria-label={`Pay for ${s.name}`} />
                        <p style={{ fontSize: 12, color: bad ? '#f87171' : 'var(--muted)', marginTop: 5 }}>
                          {bad ? 'Enter a positive dollar amount.'
                            : payVal.trim() ? 'Custom pay for this route only.'
                              : resolved != null ? `Their rate: ${money(resolved)}. Leave blank to use it.`
                                : 'No pay rate set for them — add one in Employees, or type one here.'}
                        </p>
                      </div>
                    )
                  })()}
                </div>
              )
            })}
          </div>
        )}

        {step === 5 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="os-card" style={{ padding: 18 }}>
              <SummaryRow label="Business" val={form.businessName} />
              <SummaryRow label="Work" val={[form.description || 'Contract route', `· ${VEHICLE}`].join(' ')} />
              <SummaryRow label="Report to" val={form.reportAddress} />
              <SummaryRow label="When" val={repeats ? `Repeats ${weekdaysLabel(weekdays)} · ${form.reportTime}` : `${fmtLongDay(form.routeDate)} · ${form.reportTime}`} />
              <SummaryRow label={repeats ? 'Crew (each route)' : 'Crew'} val={crewStaff.length ? crewStaff.map(c => c.staff.name.split(' ')[0]).join(', ') : repeats ? 'Unassigned (drafts)' : 'Unassigned (draft)'} last />
            </div>

            {/* Money — admin only. Never shown to the crew. */}
            {!repeats && (
              <div className="os-card" style={{ padding: 18 }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 12 }}>
                  <Lock size={11} /> Money · admin only
                </div>
                <SummaryRow label="Business charge" val={moneyOrDash(priceCents ?? null)} />
                {crewWithPay.map(c => (
                  <SummaryRow key={c.staffId} label={`${c.staff.name.split(' ')[0]}${c.staff.role ? ` (${c.staff.role})` : ''}`} val={c.cents == null ? 'no pay set' : `−${money(c.cents)}`} />
                ))}
                <SummaryRow label="Total labour payout" val={`−${money(payoutCents)}`} />
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, paddingTop: 11, marginTop: 4, borderTop: '1px solid var(--line)' }}>
                  <span style={{ fontSize: 13, fontWeight: 800 }}>Estimated profit</span>
                  <span className="tabular-nums" style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-.02em', color: profitColor(profitCents) }}>{moneyOrDash(profitCents)}</span>
                </div>
                {profitCents != null && profitCents < 0 && (
                  <p style={{ fontSize: 12.5, color: '#fca5a5', marginTop: 9 }}>This route pays out more than it earns. You&rsquo;ll be asked to confirm before it saves.</p>
                )}
                {unpricedCrew > 0 && (
                  <p style={{ fontSize: 12.5, color: '#fcd34d', marginTop: 9 }}>{unpricedCrew} crew member{unpricedCrew === 1 ? ' has' : 's have'} no pay set — profit shown is optimistic.</p>
                )}
                {priceCents == null && (
                  <p style={{ fontSize: 12.5, color: '#fcd34d', marginTop: 9 }}>No price on this route, so it won&rsquo;t count toward revenue or profit.</p>
                )}
              </div>
            )}
            {repeats ? (
              <div style={{ padding: 14, borderRadius: 14, background: 'rgba(224,0,42,.08)', border: '1px solid rgba(224,0,42,.22)' }}>
                <p style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--text)' }}>Routes generate automatically for <b>{weekdaysLabel(weekdays)}</b>, 2 weeks out and rolling.{primaryStaff?.phone ? ` Each one texts ${primaryStaff.name.split(' ')[0]} to confirm.` : ''}</p>
              </div>
            ) : crewStaff.some(c => c.staff.phone) && (
              <div style={{ padding: 14, borderRadius: 14, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>Each crew member gets their own link (you send it — not automatic)</div>
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
          : <button onClick={submit} disabled={submitting || priceInvalid || payInvalid} className="btn os-tap" style={{ borderRadius: 12, flex: 1, justifyContent: 'center', opacity: submitting || priceInvalid || payInvalid ? .5 : 1 }}>{submitting ? 'Creating…' : repeats ? 'Create recurring contract' : crew.length ? 'Create assignment' : 'Save as draft'}</button>}
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
