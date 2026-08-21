'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { COMPANY } from '../../lib/company';
import Link from 'next/link'
import {
  POSITIONS, EXPERIENCE_LEVELS, SCENARIOS, assessmentFor, PAY_NOTICE,
  type Position,
} from '../../lib/ats-config'

type Rating = { level: string; confidence: number }
type Skills = Record<string, Record<string, Rating>>

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const STEPS = ['You', 'Availability', 'Experience', 'Scenarios', 'Review']

export default function ApplyPage() {
  const [position, setPosition] = useState<Position>('driver')
  const [step, setStep] = useState(1)
  // contact
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [phone, setPhone] = useState('')
  // eligibility
  const [age21plus, setAge21] = useState(false)
  const [reliableTransport, setTransport] = useState(false)
  const [canOperateBoxTruck, setBoxTruck] = useState(false)
  const [canLiftHeavy, setLift] = useState(false)
  const [smartphone, setSmartphone] = useState(false)
  // availability
  const [availableStart, setStart] = useState('')
  const [availableDays, setDays] = useState<string[]>([])
  const [availabilityNotes, setAvailNotes] = useState('')
  const [experienceSummary, setExpSummary] = useState('')
  // assessment + scenarios
  const [skills, setSkills] = useState<Skills>({})
  const [scenarios, setScenarios] = useState<Record<string, string>>({})
  // submit
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const submissionKey = useRef(crypto.randomUUID())

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('position')
    if (requested === 'helper') queueMicrotask(() => setPosition('helper'))
  }, [])

  const isDriver = position === 'driver'
  const cats = useMemo(() => assessmentFor(position), [position])

  const inp: React.CSSProperties = { width: '100%', padding: '12px 14px', background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.10)', borderRadius: 10, color: '#f3f4f6', fontSize: 16, outline: 'none' }
  const sel: React.CSSProperties = { ...inp, cursor: 'pointer', colorScheme: 'dark', fontSize: 14 }
  const lbl: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 6 }
  const pill = (active: boolean): React.CSSProperties => ({ background: active ? 'var(--red)' : 'rgba(255,255,255,.05)', border: `1px solid ${active ? 'var(--red)' : 'rgba(255,255,255,.12)'}`, color: active ? '#fff' : 'var(--text)', borderRadius: 12, padding: '8px 14px', fontSize: 14, fontWeight: 600, cursor: 'pointer' })

  function rating(cat: string, q: string): Rating { return skills[cat]?.[q] ?? { level: 'none', confidence: 5 } }
  function setRating(cat: string, q: string, patch: Partial<Rating>) {
    setSkills(prev => ({ ...prev, [cat]: { ...prev[cat], [q]: { ...rating(cat, q), ...patch } } }))
  }
  function toggleDay(d: string) { setDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]) }

  const contactOk = name.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && phone.trim()

  async function submit() {
    setBusy(true); setErr('')
    try {
      const res = await fetch('/api/careers/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          submissionKey: submissionKey.current, position, name, email, phone,
          age21plus, reliableTransport, canOperateBoxTruck: isDriver ? canOperateBoxTruck : undefined, canLiftHeavy, smartphone,
          availableStart, availableDays, availabilityNotes, experienceSummary,
          skills,
          scenarios: SCENARIOS.map(s => ({ key: s.key, answer: scenarios[s.key] || '' })),
        }),
      })
      const j = await res.json()
      if (!res.ok) { setErr(j.error ?? 'Something went wrong. Please try again.'); setBusy(false); return }
      setDone(j.applicantNumber || 'received')
    } catch { setErr('Connection error — please try again.'); setBusy(false) }
  }

  const Header = (
    <header className="fixed top-0 left-0 right-0 z-50" style={{ background: 'rgba(11,11,12,0.95)', backdropFilter: 'blur(12px)', borderBottom: '1px solid var(--line)' }}>
      <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
        <Link href="/" className="text-xl font-black tracking-tight" style={{ color: '#fff', letterSpacing: '-0.03em' }}>J Kiss <span style={{ color: 'var(--red)' }}>LLC</span></Link>
        <Link href="/careers" className="text-sm font-semibold transition hover:text-white" style={{ color: 'var(--muted)' }}>← Careers</Link>
      </div>
    </header>
  )

  if (done) {
    return (
      <main className="min-h-screen" style={{ background: 'var(--bg)' }}>
        {Header}
        <section className="pt-40 pb-20 px-6">
          <div className="max-w-lg mx-auto glass-card p-10 text-center" style={{ borderRadius: 20 }}>
            <div className="text-5xl mb-5">✅</div>
            <h1 className="text-2xl font-black text-white mb-3">Application Submitted</h1>
            <p className="text-base mb-2" style={{ color: 'var(--muted)', lineHeight: 1.6 }}>Thanks, {name.split(' ')[0] || 'and welcome'}! We received your {POSITIONS[position].title} application.</p>
            <p className="text-sm mb-6" style={{ color: 'rgba(255,255,255,.5)' }}>Your reference number is <strong className="text-white">{done}</strong>. If we&apos;d like to move forward, we&apos;ll reach out by phone or email.</p>
            <Link href="/" className="btn">← Back to Home</Link>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="min-h-screen" style={{ background: 'var(--bg)' }}>
      {Header}
      <section className="pt-28 pb-24 px-6">
        <div className="max-w-3xl mx-auto">
          <div className="label mb-4" style={{ display: 'inline-block' }}>{POSITIONS[position].title} · ${POSITIONS[position].payPerDay}/day to start</div>
          <h1 className="text-3xl md:text-4xl font-black text-white mb-2" style={{ letterSpacing: '-0.03em' }}>Contractor Application</h1>
          <p className="text-xs font-bold uppercase tracking-widest mb-6" style={{ color: 'var(--muted)' }}>Step {step} of 5 · {STEPS[step - 1]}</p>

          {/* progress bar */}
          <div className="flex gap-1.5 mb-8">
            {STEPS.map((_, i) => <div key={i} style={{ flex: 1, height: 4, borderRadius: 4, background: i < step ? 'var(--red)' : 'rgba(255,255,255,.10)' }} />)}
          </div>

          <div className="glass-card p-6 md:p-8" style={{ borderRadius: 20 }}>

            {/* STEP 1 — position + contact + eligibility */}
            {step === 1 && (
              <>
                <label style={lbl}>Position</label>
                <div className="flex gap-2 mb-5">
                  {(['driver', 'helper'] as Position[]).map(p => (
                    <button key={p} type="button" onClick={() => setPosition(p)} style={pill(position === p)}>{POSITIONS[p].title} · ${POSITIONS[p].payPerDay}/day</button>
                  ))}
                </div>
                <div className="grid sm:grid-cols-2 gap-3 mb-5">
                  <div className="sm:col-span-2"><label style={lbl}>Full name</label><input value={name} onChange={e => setName(e.target.value)} autoCapitalize="words" style={inp} /></div>
                  <div><label style={lbl}>Email</label><input value={email} onChange={e => setEmail(e.target.value)} type="email" style={inp} /></div>
                  <div><label style={lbl}>Phone</label><input value={phone} onChange={e => setPhone(e.target.value)} type="tel" style={inp} /></div>
                </div>
                <label style={lbl}>Confirm you meet these ({POSITIONS[position].title})</label>
                <div className="space-y-2">
                  <Check label="I have reliable transportation" checked={reliableTransport} onChange={setTransport} />
                  <Check label="I can lift heavy items (150+ lbs with assistance)" checked={canLiftHeavy} onChange={setLift} />
                  <Check label={`I have a smartphone${isDriver ? ' with data' : ''}`} checked={smartphone} onChange={setSmartphone} />
                  {isDriver && <Check label="I am at least 21 years old" checked={age21plus} onChange={setAge21} />}
                  {isDriver && <Check label="I can safely operate a 26' box truck" checked={canOperateBoxTruck} onChange={setBoxTruck} />}
                </div>
                <p className="text-xs mt-3" style={{ color: 'rgba(255,255,255,.4)' }}>Answer honestly — these don&apos;t disqualify you automatically, they just help us place you.</p>
                <Nav onNext={() => setStep(2)} nextDisabled={!contactOk} nextLabel="Continue →" />
              </>
            )}

            {/* STEP 2 — availability */}
            {step === 2 && (
              <>
                <div className="mb-4"><label style={lbl}>Earliest start date</label><input value={availableStart} onChange={e => setStart(e.target.value)} type="date" style={inp} /></div>
                <label style={lbl}>Days you can work</label>
                <div className="flex flex-wrap gap-2 mb-4">
                  {DAYS.map(d => <button key={d} type="button" onClick={() => toggleDay(d)} style={pill(availableDays.includes(d))}>{d}</button>)}
                </div>
                <div className="mb-4"><label style={lbl}>Availability notes <span style={{ fontWeight: 400 }}>(optional)</span></label><input value={availabilityNotes} onChange={e => setAvailNotes(e.target.value)} placeholder="e.g. weekends, flexible, can start ASAP" style={inp} /></div>
                <div><label style={lbl}>Tell us about your experience <span style={{ fontWeight: 400 }}>(optional but helps)</span></label><textarea value={experienceSummary} onChange={e => setExpSummary(e.target.value)} rows={4} placeholder="Where have you worked, what kind of jobs, anything you're proud of…" style={{ ...inp, resize: 'vertical' }} /></div>
                <Nav onBack={() => setStep(1)} onNext={() => setStep(3)} nextLabel="Continue →" />
              </>
            )}

            {/* STEP 3 — skills assessment */}
            {step === 3 && (
              <>
                <p className="text-sm mb-5" style={{ color: 'var(--muted)', lineHeight: 1.5 }}>For each item, pick your experience level and rate your confidence (1–10). If you&apos;ve never done it, leave it on &quot;None.&quot;</p>
                {cats.map(cat => (
                  <div key={cat.key} className="mb-6">
                    <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--red)' }}>{cat.title}</p>
                    <div className="space-y-3">
                      {cat.questions.map(q => {
                        const r = rating(cat.key, q.key)
                        return (
                          <div key={q.key} className="rounded-xl p-3" style={{ background: 'rgba(255,255,255,.02)', border: '1px solid var(--line)' }}>
                            <p className="text-sm font-semibold text-white mb-2">{q.label}</p>
                            <div className="grid sm:grid-cols-2 gap-2 items-center">
                              <select value={r.level} onChange={e => setRating(cat.key, q.key, { level: e.target.value })} style={sel}>
                                {EXPERIENCE_LEVELS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
                              </select>
                              <div className="flex items-center gap-2">
                                <span className="text-xs" style={{ color: 'var(--muted)' }}>Confidence</span>
                                <input type="range" min={1} max={10} value={r.confidence} onChange={e => setRating(cat.key, q.key, { confidence: Number(e.target.value) })} style={{ flex: 1, accentColor: '#E0002A' }} disabled={r.level === 'none'} />
                                <span className="text-sm font-bold tabular-nums text-white" style={{ width: 20, textAlign: 'right' }}>{r.level === 'none' ? '–' : r.confidence}</span>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
                <Nav onBack={() => setStep(2)} onNext={() => setStep(4)} nextLabel="Continue →" />
              </>
            )}

            {/* STEP 4 — scenarios */}
            {step === 4 && (
              <>
                <p className="text-sm mb-5" style={{ color: 'var(--muted)', lineHeight: 1.5 }}>Real situations from the job. There are no trick answers — tell us what you&apos;d actually do. A sentence or two each is plenty.</p>
                <div className="space-y-4">
                  {SCENARIOS.map((s, i) => (
                    <div key={s.key}>
                      <label style={lbl}>{i + 1}. {s.prompt}</label>
                      <textarea value={scenarios[s.key] || ''} onChange={e => setScenarios(prev => ({ ...prev, [s.key]: e.target.value }))} rows={2} placeholder="Your answer…" style={{ ...inp, resize: 'vertical', fontSize: 15 }} />
                    </div>
                  ))}
                </div>
                <Nav onBack={() => setStep(3)} onNext={() => setStep(5)} nextLabel="Continue →" />
              </>
            )}

            {/* STEP 5 — review + submit. Sensitive documents are post-approval only. */}
            {step === 5 && (
              <>
                <div className="space-y-1.5 mb-5">
                  {[['Opportunity', `${POSITIONS[position].title} · $${POSITIONS[position].payPerDay}/day`], ['Name', name], ['Contact', [email, phone].filter(Boolean).join(' · ')], ['Earliest start', availableStart || '—'], ['Days', availableDays.join(', ') || '—']].map(([k, v], i) => (
                    <div key={i} className="flex justify-between gap-3 py-1.5 text-sm" style={i > 0 ? { borderTop: '1px solid rgba(255,255,255,.06)' } : undefined}>
                      <span style={{ color: 'var(--muted)' }}>{k}</span><span className="text-white text-right">{v || '—'}</span>
                    </div>
                  ))}
                </div>
                <div className="rounded-xl p-4 mb-4" style={{ background: 'rgba(52,211,153,.06)', border: '1px solid rgba(52,211,153,.2)' }}>
                  <p className="text-sm font-semibold text-white mb-1">No identity or tax documents are needed now.</p>
                  <p className="text-xs" style={{ color: 'var(--muted)', lineHeight: 1.5 }}>If approved, you&apos;ll receive a secure onboarding link for your W-9, contractor agreement, and any role-specific documents. We never ask for a Social Security card image.</p>
                </div>
                <p className="text-xs mb-4" style={{ color: 'rgba(255,255,255,.4)', lineHeight: 1.5 }}>By submitting, you confirm the information is accurate and understand this is an application for an independent-contractor opportunity, not an offer of employment. By providing your phone number, you agree to receive messages about your application from {COMPANY.legalName}. Message &amp; data rates may apply. Reply STOP to opt out, HELP for help.</p>
                {err && <p className="text-sm mb-3" role="alert" style={{ color: '#f87171' }}>{err}</p>}
                <Nav onBack={() => setStep(4)} onNext={submit} nextLabel={busy ? 'Submitting…' : 'Submit Contractor Application →'} nextDisabled={busy || !contactOk} />
              </>
            )}

            {err && step !== 5 && <p className="text-sm mt-4" role="alert" style={{ color: '#f87171' }}>{err}</p>}
          </div>

          {step === 1 && <p className="text-xs text-center mt-5" style={{ color: 'rgba(255,255,255,.35)' }}>💵 {PAY_NOTICE}</p>}
        </div>
      </section>
    </main>
  )
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer" style={{ background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ width: 18, height: 18, accentColor: '#E0002A', flexShrink: 0 }} />
      <span className="text-sm" style={{ color: 'var(--text)' }}>{label}</span>
    </label>
  )
}

function Nav({ onBack, onNext, nextLabel, nextDisabled }: { onBack?: () => void; onNext: () => void; nextLabel: string; nextDisabled?: boolean }) {
  return (
    <div className="flex gap-2 mt-6">
      {onBack && <button type="button" onClick={onBack} className="btn-ghost" style={{ padding: '12px 18px', fontSize: 14 }}>← Back</button>}
      <button type="button" onClick={onNext} disabled={nextDisabled} className="btn" style={{ padding: '12px 22px', fontSize: 15, flex: 1, justifyContent: 'center', opacity: nextDisabled ? 0.5 : 1 }}>{nextLabel}</button>
    </div>
  )
}
