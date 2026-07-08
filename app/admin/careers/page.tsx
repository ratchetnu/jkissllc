'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import AdminGate from '../AdminGate'
import type { Applicant, ApplicantStatus, Recommendation } from '../../lib/applicants'
import { APPLICANT_STATUS_LABEL, RECOMMENDATION_LABEL } from '../../lib/applicants'
import {
  BAND_META, RUBRIC_DIMENSIONS, RUBRIC_LABELS, SCENARIOS, POSITIONS, requiredDocKinds,
  type ScoreBand, type DocKind,
} from '../../lib/ats-config'

const DOC_LABEL: Record<DocKind, string> = {
  drivers_license: "Driver's License", id: 'State ID / License', ss_card: 'Social Security Card', headshot: 'Headshot (badge)',
}
const SCENARIO_PROMPT: Record<string, string> = Object.fromEntries(SCENARIOS.map(s => [s.key, s.prompt]))

const STATUS_TABS: { key: string; label: string; match: (a: Applicant) => boolean }[] = [
  { key: 'active', label: 'Active', match: a => !['hired', 'rejected'].includes(a.status) },
  { key: 'all', label: 'All', match: () => true },
  { key: 'new', label: 'New', match: a => a.status === 'new' },
  { key: 'interview', label: 'Interview', match: a => a.status === 'interview' || a.status === 'second_interview' },
  { key: 'hired', label: 'Hired', match: a => a.status === 'hired' },
  { key: 'rejected', label: 'Rejected', match: a => a.status === 'rejected' },
]

export default function CareersAdminPage() {
  return <AdminGate title="Careers"><CareersInner /></AdminGate>
}

function BandChip({ band, score }: { band: ScoreBand; score: number }) {
  const m = BAND_META[band]
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 99, fontSize: 12, fontWeight: 800, background: `${m.tone}22`, color: m.tone, border: `1px solid ${m.tone}55` }}>
      {m.emoji} {score}<span style={{ fontWeight: 600, opacity: .8 }}>/100</span>
    </span>
  )
}

function CareersInner() {
  const [list, setList] = useState<Applicant[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('active')
  const [selId, setSelId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/careers', { credentials: 'same-origin' })
      if (res.status === 401) return
      const j = await res.json()
      setList(Array.isArray(j.applicants) ? j.applicants : [])
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => list.filter(STATUS_TABS.find(t => t.key === tab)!.match), [list, tab])
  const sel = useMemo(() => list.find(a => a.id === selId) || null, [list, selId])

  async function act(action: string, value?: unknown) {
    if (!sel) return
    setBusy(true)
    try {
      const res = await fetch('/api/admin/careers', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sel.id, action, value }) })
      const j = await res.json()
      if (res.ok && j.applicant) setList(prev => prev.map(a => a.id === sel.id ? j.applicant : a))
    } catch { /* ignore */ }
    setBusy(false)
  }
  async function remove() {
    if (!sel || !confirm(`Delete ${sel.name}'s application? This can't be undone.`)) return
    await fetch(`/api/admin/careers?id=${sel.id}`, { method: 'DELETE' })
    setList(prev => prev.filter(a => a.id !== sel.id)); setSelId(null)
  }

  const chip = (active: boolean): React.CSSProperties => ({ padding: '6px 12px', borderRadius: 99, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: `1px solid ${active ? 'var(--red)' : 'var(--line)'}`, background: active ? 'var(--red)' : 'rgba(255,255,255,.04)', color: active ? '#fff' : 'var(--muted)' })

  return (
    <main className="min-h-screen pt-16" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      <div className="max-w-6xl mx-auto px-3 sm:px-5 py-5">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h1 className="text-2xl font-black text-white" style={{ letterSpacing: '-0.03em' }}>Careers · ATS</h1>
          <span className="text-sm" style={{ color: 'var(--muted)' }}>{list.length} applicant{list.length === 1 ? '' : 's'}</span>
        </div>
        <div className="flex flex-wrap gap-2 mb-5">
          {STATUS_TABS.map(t => <button key={t.key} onClick={() => setTab(t.key)} style={chip(tab === t.key)}>{t.label}</button>)}
        </div>

        <div className="flex flex-col lg:flex-row gap-5">
          {/* list */}
          <div style={{ flex: '0 0 340px' }} className={sel ? 'hidden lg:block' : ''}>
            {loading ? <p className="text-sm" style={{ color: 'var(--muted)' }}>Loading…</p>
              : filtered.length === 0 ? <p className="text-sm" style={{ color: 'var(--muted)' }}>No applicants here yet.</p>
                : (
                  <div className="space-y-2">
                    {filtered.map(a => (
                      <button key={a.id} onClick={() => setSelId(a.id)} className="glass-card w-full text-left p-3.5" style={{ borderRadius: 12, border: `1px solid ${selId === a.id ? 'var(--red)' : 'var(--line)'}` }}>
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="font-bold text-white text-sm">{a.name}</span>
                          <BandChip band={a.score.band} score={a.score.score} />
                        </div>
                        <div className="flex items-center justify-between gap-2 text-xs" style={{ color: 'var(--muted)' }}>
                          <span>{POSITIONS[a.position].title} · {a.applicantNumber}</span>
                          <span>{APPLICANT_STATUS_LABEL[a.status]}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
          </div>

          {/* detail — manager review */}
          <div style={{ flex: 1 }}>
            {!sel ? <div className="glass-card p-10 text-center" style={{ borderRadius: 16 }}><p className="text-sm" style={{ color: 'var(--muted)' }}>Select an applicant to review.</p></div>
              : <Review key={sel.id} a={sel} act={act} remove={remove} busy={busy} onBack={() => setSelId(null)} />}
          </div>
        </div>
      </div>
    </main>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="glass-card p-5 mb-4" style={{ borderRadius: 14 }}>
      <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)' }}>{title}</p>
      {children}
    </div>
  )
}

function Review({ a, act, remove, busy, onBack }: {
  a: Applicant; act: (action: string, value?: unknown) => void; remove: () => void; busy: boolean; onBack: () => void
}) {
  const [notes, setNotes] = useState(a.managerNotes || '')
  const reqKinds = requiredDocKinds(a.position)
  const has = (k: DocKind) => a.documents.some(d => d.kind === k)
  const docUrl = (k: DocKind) => a.documents.find(d => d.kind === k)?.url
  const headshot = a.documents.find(d => d.kind === 'headshot')

  // Identity documents are stored as private blob pathnames and can only be read
  // back through the authed streaming route. Records created before that change
  // still hold absolute https URLs, so both shapes must resolve.
  const docHref = (v: string) =>
    v.startsWith('http') ? v : `/api/admin/careers/doc?p=${encodeURIComponent(v)}`
  const s = a.score

  const btn = (bg: string): React.CSSProperties => ({ padding: '9px 14px', borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: busy ? 'wait' : 'pointer', border: 'none', background: bg, color: '#fff', opacity: busy ? 0.6 : 1 })

  return (
    <div>
      <button onClick={onBack} className="btn-ghost lg:hidden mb-3" style={{ padding: '8px 14px', fontSize: 13 }}>← List</button>

      {/* header */}
      <div className="glass-card p-5 mb-4" style={{ borderRadius: 14 }}>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-xl font-black text-white">{a.name}</h2>
            <p className="text-sm" style={{ color: 'var(--muted)' }}>{POSITIONS[a.position].title} · ${POSITIONS[a.position].payPerDay}/day · {a.applicantNumber}</p>
            <p className="text-sm mt-1" style={{ color: 'var(--text)' }}>{a.email} · {a.phone}</p>
          </div>
          <div className="text-right">
            <BandChip band={s.band} score={s.score} />
            <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>{BAND_META[s.band].label}</p>
          </div>
        </div>
        {a.promotedStaffId && <p className="text-xs mt-3" style={{ color: '#34d399' }}>✓ Added to the crew roster</p>}
      </div>

      {/* score breakdown */}
      <Section title="Readiness score breakdown">
        <div className="space-y-2">
          {s.components.map(c => (
            <div key={c.key}>
              <div className="flex justify-between text-xs mb-1"><span style={{ color: 'var(--text)' }}>{c.label}</span><span className="tabular-nums" style={{ color: 'var(--muted)' }}>{c.points}/{c.max}</span></div>
              <div style={{ height: 6, borderRadius: 6, background: 'rgba(255,255,255,.08)' }}><div style={{ height: 6, borderRadius: 6, width: `${c.max ? (c.points / c.max) * 100 : 0}%`, background: 'var(--red)' }} /></div>
            </div>
          ))}
        </div>
      </Section>

      {/* documents checklist */}
      <Section title="Required documents">
        <div className="space-y-2">
          {reqKinds.map(k => (
            <div key={k} className="flex items-center justify-between gap-2 text-sm">
              <span style={{ color: has(k) ? 'var(--text)' : '#f87171' }}>{has(k) ? '✓' : '✗'} {DOC_LABEL[k]}</span>
              {(() => { const u = docUrl(k); return u
                ? <a href={docHref(u)} target="_blank" rel="noreferrer" className="text-xs underline" style={{ color: 'var(--red)' }}>View</a>
                : <span className="text-xs" style={{ color: '#f87171' }}>Missing</span> })()}
            </div>
          ))}
        </div>
        {s.missingDocs.length > 0 && <p className="text-xs mt-2" style={{ color: '#f87171' }}>Missing: {s.missingDocs.map(k => DOC_LABEL[k]).join(', ')}</p>}
      </Section>

      {/* badge headshot */}
      {headshot && (
        <Section title="Employee badge headshot">
          <div className="flex items-center gap-4 flex-wrap">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={headshot.url} alt="" style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 10, border: `2px solid ${a.badgeHeadshotUrl ? '#34d399' : 'var(--line)'}` }} />
            <div>
              <p className="text-sm mb-2" style={{ color: a.badgeHeadshotUrl ? '#34d399' : 'var(--muted)' }}>{a.badgeHeadshotUrl ? '✓ Approved for badge' : 'Not yet approved'}</p>
              {a.badgeHeadshotUrl
                ? <button onClick={() => act('unapprove_headshot')} style={btn('#6b7280')}>Unapprove</button>
                : <button onClick={() => act('approve_headshot')} style={btn('#059669')}>Approve for badge</button>}
            </div>
          </div>
        </Section>
      )}

      {/* strengths / weaknesses / risk */}
      <div className="grid md:grid-cols-3 gap-4 mb-4">
        <MiniList title="Strengths" items={s.strengths} tone="#34d399" empty="None flagged" />
        <MiniList title="Weaknesses" items={s.weaknesses} tone="#fbbf24" empty="None flagged" />
        <MiniList title="Risk factors" items={s.riskFactors} tone="#f87171" empty="None flagged" />
      </div>

      {/* experience summary */}
      {a.experienceSummary && <Section title="Experience summary (applicant)"><p className="text-sm" style={{ color: 'var(--text)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{a.experienceSummary}</p></Section>}

      {/* availability */}
      <Section title="Availability">
        <p className="text-sm" style={{ color: 'var(--text)' }}>Start: {a.availableStart || '—'} · Days: {(a.availableDays || []).join(', ') || '—'}{a.availabilityNotes ? ` · ${a.availabilityNotes}` : ''}</p>
      </Section>

      {/* scenario rubric */}
      <Section title="Scenario rubric (auto-scored)">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {RUBRIC_DIMENSIONS.map(d => (
            <div key={d} className="text-center">
              <div className="text-lg font-black tabular-nums text-white">{Math.round(s.scenarioRubric[d] * 100)}<span className="text-xs" style={{ color: 'var(--muted)' }}>%</span></div>
              <div className="text-xs" style={{ color: 'var(--muted)' }}>{RUBRIC_LABELS[d]}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* scenario answers */}
      <Section title="Scenario answers">
        <div className="space-y-3">
          {a.scenarios.filter(sc => sc.answer.trim()).length === 0 && <p className="text-sm" style={{ color: '#f87171' }}>No scenario answers provided.</p>}
          {a.scenarios.filter(sc => sc.answer.trim()).map(sc => (
            <div key={sc.key}>
              <p className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>{SCENARIO_PROMPT[sc.key]}</p>
              <p className="text-sm" style={{ color: 'var(--text)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{sc.answer}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* suggested interview questions */}
      {s.suggestedQuestions.length > 0 && (
        <Section title="Recommended interview questions">
          <ul className="space-y-2">
            {s.suggestedQuestions.map((q, i) => <li key={i} className="text-sm flex items-start gap-2" style={{ color: 'var(--text)' }}><span style={{ color: 'var(--red)' }}>Q</span>{q}</li>)}
          </ul>
        </Section>
      )}

      {/* manager notes */}
      <Section title="Manager notes">
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="Notes from your review / interview…" style={{ width: '100%', padding: '10px 12px', background: 'rgba(255,255,255,.04)', border: '1px solid var(--line)', borderRadius: 10, color: '#f3f4f6', fontSize: 14, resize: 'vertical' }} />
        <button onClick={() => act('notes', notes)} className="btn-ghost mt-2" style={{ padding: '8px 14px', fontSize: 13 }}>Save notes</button>
      </Section>

      {/* recommendation + status */}
      <Section title="Decision">
        <p className="text-xs mb-2" style={{ color: 'var(--muted)' }}>Recommendation {a.recommendation ? `· currently: ${RECOMMENDATION_LABEL[a.recommendation]}` : ''}</p>
        <div className="flex flex-wrap gap-2 mb-4">
          <button onClick={() => act('hire')} style={btn('#059669')}>✓ Hire</button>
          <button onClick={() => act('recommendation', 'second_interview' as Recommendation)} style={btn('#2563eb')}>Second Interview</button>
          <button onClick={() => act('recommendation', 'waitlist' as Recommendation)} style={btn('#d97706')}>Waitlist</button>
          <button onClick={() => act('recommendation', 'reject' as Recommendation)} style={btn('#b91c1c')}>Reject</button>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-xs" style={{ color: 'var(--muted)' }}>Status</label>
          <select value={a.status} onChange={e => act('status', e.target.value as ApplicantStatus)} style={{ padding: '8px 12px', background: 'rgba(255,255,255,.04)', border: '1px solid var(--line)', borderRadius: 10, color: '#f3f4f6', fontSize: 13, cursor: 'pointer', colorScheme: 'dark' }}>
            {(Object.keys(APPLICANT_STATUS_LABEL) as ApplicantStatus[]).map(st => <option key={st} value={st}>{APPLICANT_STATUS_LABEL[st]}</option>)}
          </select>
          <button onClick={() => act('rescore')} className="btn-ghost" style={{ padding: '8px 12px', fontSize: 12 }}>Re-score</button>
          <button onClick={remove} style={{ padding: '8px 12px', fontSize: 12, background: 'transparent', border: '1px solid rgba(248,113,113,.4)', color: '#f87171', borderRadius: 10, cursor: 'pointer', marginLeft: 'auto' }}>Delete</button>
        </div>
      </Section>
    </div>
  )
}

function MiniList({ title, items, tone, empty }: { title: string; items: string[]; tone: string; empty: string }) {
  return (
    <div className="glass-card p-4" style={{ borderRadius: 12 }}>
      <p className="text-xs font-bold uppercase tracking-widest mb-2" style={{ color: tone }}>{title}</p>
      {items.length === 0 ? <p className="text-xs" style={{ color: 'var(--muted)' }}>{empty}</p>
        : <ul className="space-y-1.5">{items.map((it, i) => <li key={i} className="text-sm flex items-start gap-2" style={{ color: 'var(--text)' }}><span style={{ color: tone }}>•</span>{it}</li>)}</ul>}
    </div>
  )
}
