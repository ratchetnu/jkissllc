'use client'

import { useEffect, useMemo, useState } from 'react'
import { COMPANY } from '../../lib/company';
import Link from 'next/link'
import {
  POSITIONS, REQUIRED_DOCS, HEADSHOT_GUIDELINES, EXPERIENCE_LEVELS,
  SCENARIOS, assessmentFor, requiredDocKinds, PAY_NOTICE,
  type Position, type DocKind,
} from '../../lib/ats-config'

type Rating = { level: string; confidence: number }
type Skills = Record<string, Record<string, Rating>>

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const STEPS = ['You', 'Availability', 'Experience', 'Scenarios', 'Documents', 'Review']

// Downscale an image file to a compact JPEG data URL for upload.
async function toDataUrl(file: File, maxDim = 1600, quality = 0.82): Promise<string> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
    const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no ctx')
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close?.()
    return canvas.toDataURL('image/jpeg', quality)
  } catch {
    return await new Promise((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result))
      fr.onerror = () => reject(new Error('read failed'))
      fr.readAsDataURL(file)
    })
  }
}

// Rough "is the background white?" check for headshots — samples the four corners.
async function looksWhiteBg(dataUrl: string): Promise<boolean> {
  try {
    const img = new window.Image()
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl })
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d'); if (!ctx) return true
    ctx.drawImage(img, 0, 0)
    const pts = [[4, 4], [img.width - 5, 4], [4, img.height - 5], [img.width - 5, img.height - 5]]
    let whiteCorners = 0
    for (const [x, y] of pts) {
      const [r, g, b] = ctx.getImageData(x, y, 1, 1).data
      if (r > 205 && g > 205 && b > 205) whiteCorners++
    }
    return whiteCorners >= 3
  } catch { return true }
}

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
  // assessment + scenarios + docs
  const [skills, setSkills] = useState<Skills>({})
  const [scenarios, setScenarios] = useState<Record<string, string>>({})
  // `docs` holds the stored reference we submit: a public URL for the headshot, a
  // private blob pathname for identity documents. A pathname is not loadable in an
  // <img>, so previews come from `previews` — the local data URL we already read
  // off the file. The applicant sees their photo; the bytes never round-trip.
  const [docs, setDocs] = useState<Partial<Record<DocKind, string>>>({})
  const [previews, setPreviews] = useState<Partial<Record<DocKind, string>>>({})
  const [docBusy, setDocBusy] = useState<DocKind | null>(null)
  const [headshotWarn, setHeadshotWarn] = useState(false)
  // submit
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('')
  const [done, setDone] = useState<string | null>(null)

  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get('position')
    if (p === 'helper' || p === 'driver') setPosition(p)
  }, [])

  const isDriver = position === 'driver'
  const cats = useMemo(() => assessmentFor(position), [position])
  const reqDocs = REQUIRED_DOCS[position]
  const missingDocs = requiredDocKinds(position).filter(k => !docs[k])

  const inp: React.CSSProperties = { width: '100%', padding: '12px 14px', background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.10)', borderRadius: 10, color: '#f3f4f6', fontSize: 16, outline: 'none' }
  const sel: React.CSSProperties = { ...inp, cursor: 'pointer', colorScheme: 'dark', fontSize: 14 }
  const lbl: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 6 }
  const pill = (active: boolean): React.CSSProperties => ({ background: active ? 'var(--red)' : 'rgba(255,255,255,.05)', border: `1px solid ${active ? 'var(--red)' : 'rgba(255,255,255,.12)'}`, color: active ? '#fff' : 'var(--text)', borderRadius: 12, padding: '8px 14px', fontSize: 14, fontWeight: 600, cursor: 'pointer' })

  function rating(cat: string, q: string): Rating { return skills[cat]?.[q] ?? { level: 'none', confidence: 5 } }
  function setRating(cat: string, q: string, patch: Partial<Rating>) {
    setSkills(prev => ({ ...prev, [cat]: { ...prev[cat], [q]: { ...rating(cat, q), ...patch } } }))
  }
  function toggleDay(d: string) { setDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]) }

  async function uploadDoc(kind: DocKind, file: File) {
    setDocBusy(kind); setErr('')
    try {
      const dataUrl = await toDataUrl(file)
      if (kind === 'headshot') setHeadshotWarn(!(await looksWhiteBg(dataUrl)))
      const res = await fetch('/api/careers/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: dataUrl, kind }) })
      const j = await res.json()
      if (res.ok && j.url) {
        setDocs(prev => ({ ...prev, [kind]: j.url }))
        setPreviews(prev => ({ ...prev, [kind]: dataUrl }))
      }
      else setErr(j.error ?? 'Upload failed — please try again.')
    } catch { setErr('That file could not be uploaded. Try a different photo.') }
    finally { setDocBusy(null) }
  }

  const contactOk = name.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && phone.trim()

  async function submit() {
    if (missingDocs.length) { setStep(5); setErr('Please upload all required documents before submitting.'); return }
    setBusy(true); setErr('')
    try {
      const res = await fetch('/api/careers/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          position, name, email, phone,
          age21plus, reliableTransport, canOperateBoxTruck: isDriver ? canOperateBoxTruck : undefined, canLiftHeavy, smartphone,
          availableStart, availableDays, availabilityNotes, experienceSummary,
          skills,
          scenarios: SCENARIOS.map(s => ({ key: s.key, answer: scenarios[s.key] || '' })),
          documents: Object.entries(docs).map(([kind, url]) => ({ kind, url })),
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
          <h1 className="text-3xl md:text-4xl font-black text-white mb-2" style={{ letterSpacing: '-0.03em' }}>Application</h1>
          <p className="text-xs font-bold uppercase tracking-widest mb-6" style={{ color: 'var(--muted)' }}>Step {step} of 6 · {STEPS[step - 1]}</p>

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

            {/* STEP 5 — documents (gated) */}
            {step === 5 && (
              <>
                <p className="text-sm mb-1 text-white font-semibold">Upload your documents</p>
                <p className="text-xs mb-5" style={{ color: 'var(--muted)', lineHeight: 1.5 }}>Clear phone photos are fine. You can&apos;t submit until all three are attached.</p>
                <div className="space-y-3">
                  {reqDocs.map(d => (
                    <div key={d.kind} className="rounded-xl p-4" style={{ background: 'rgba(255,255,255,.02)', border: `1px solid ${docs[d.kind] ? 'rgba(52,211,153,.4)' : 'var(--line)'}` }}>
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-bold text-white">{d.label} {docs[d.kind] && <span style={{ color: '#34d399' }}>✓</span>}</p>
                          <p className="text-xs" style={{ color: 'var(--muted)' }}>{d.help}</p>
                        </div>
                        <label className="file-label btn-ghost" style={{ padding: '9px 14px', fontSize: 13, cursor: docBusy === d.kind ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}>
                          {docBusy === d.kind ? 'Uploading…' : docs[d.kind] ? 'Replace' : '📷 Upload'}
                          <input type="file" aria-label={`Upload ${d.label}`} accept="image/*" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadDoc(d.kind, f) }} disabled={docBusy === d.kind} className="file-input-a11y" />
                        </label>
                      </div>
                      {previews[d.kind] && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={previews[d.kind]} alt="" style={{ marginTop: 10, maxHeight: 120, borderRadius: 8, border: '1px solid rgba(255,255,255,.1)' }} />
                      )}
                      {d.kind === 'headshot' && headshotWarn && (
                        <p className="text-xs mt-2" style={{ color: '#fbbf24' }}>⚠️ This doesn&apos;t look like a plain white background. It may be rejected for your badge — see the rules below.</p>
                      )}
                    </div>
                  ))}
                </div>
                <div className="rounded-xl p-4 mt-4" style={{ background: 'rgba(224,0,42,.05)', border: '1px solid rgba(224,0,42,.2)' }}>
                  <p className="text-xs font-bold uppercase tracking-widest mb-2" style={{ color: 'var(--red)' }}>Headshot requirements</p>
                  <ul className="grid sm:grid-cols-2 gap-1">
                    {HEADSHOT_GUIDELINES.map((g, i) => <li key={i} className="text-xs flex items-start gap-1.5" style={{ color: 'var(--text)' }}><span style={{ color: '#34d399' }}>•</span>{g}</li>)}
                  </ul>
                </div>
                <Nav onBack={() => setStep(4)} onNext={() => setStep(6)} nextLabel="Review →" nextDisabled={missingDocs.length > 0} />
              </>
            )}

            {/* STEP 6 — review + submit */}
            {step === 6 && (
              <>
                <div className="space-y-1.5 mb-5">
                  {[['Position', `${POSITIONS[position].title} · $${POSITIONS[position].payPerDay}/day`], ['Name', name], ['Contact', [email, phone].filter(Boolean).join(' · ')], ['Earliest start', availableStart || '—'], ['Days', availableDays.join(', ') || '—'], ['Documents', `${requiredDocKinds(position).length - missingDocs.length}/${requiredDocKinds(position).length} uploaded`]].map(([k, v], i) => (
                    <div key={i} className="flex justify-between gap-3 py-1.5 text-sm" style={i > 0 ? { borderTop: '1px solid rgba(255,255,255,.06)' } : undefined}>
                      <span style={{ color: 'var(--muted)' }}>{k}</span><span className="text-white text-right">{v || '—'}</span>
                    </div>
                  ))}
                </div>
                {missingDocs.length > 0 && <p className="text-sm mb-3" style={{ color: '#fbbf24' }}>⚠️ You still need to upload {missingDocs.length} required document(s). <button onClick={() => setStep(5)} className="underline" style={{ color: '#fbbf24' }}>Go back</button>.</p>}
                <p className="text-xs mb-4" style={{ color: 'rgba(255,255,255,.4)', lineHeight: 1.5 }}>By submitting, you confirm the information is accurate. {COMPANY.legalName} is an equal-opportunity employer. By providing your phone number, you agree to receive text messages about your application from {COMPANY.legalName} at the number provided. Message &amp; data rates may apply. Reply STOP to opt out, HELP for help.</p>
                {err && <p className="text-sm mb-3" role="alert" style={{ color: '#f87171' }}>{err}</p>}
                <Nav onBack={() => setStep(5)} onNext={submit} nextLabel={busy ? 'Submitting…' : 'Submit Application →'} nextDisabled={busy || missingDocs.length > 0 || !contactOk} />
              </>
            )}

            {err && step !== 6 && <p className="text-sm mt-4" role="alert" style={{ color: '#f87171' }}>{err}</p>}
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
