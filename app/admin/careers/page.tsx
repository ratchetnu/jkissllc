'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import AdminGate from '../AdminGate'
import type { Applicant, ApplicantStatus, Recommendation } from '../../lib/applicants'
import { APPLICANT_STATUS_LABEL, RECOMMENDATION_LABEL, APPLICANT_INACTIVE } from '../../lib/applicants'
import {
  BAND_META, RUBRIC_DIMENSIONS, RUBRIC_LABELS, SCENARIOS, POSITIONS, CONTRACTOR_ONBOARDING_DOCS,
  type ScoreBand, type DocKind,
} from '../../lib/ats-config'

const DOC_LABEL: Record<DocKind, string> = {
  drivers_license: "Driver's License", id: 'State ID / License', ss_card: 'Legacy Social Security Card',
  headshot: 'Headshot (badge)', w9: 'Form W-9', contractor_agreement: 'Contractor Agreement', insurance: 'Vehicle Insurance',
}
const SCENARIO_PROMPT: Record<string, string> = Object.fromEntries(SCENARIOS.map(s => [s.key, s.prompt]))

const fmtTs = (at: number): string =>
  new Date(at).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

const STATUS_TABS: { key: string; label: string; match: (a: Applicant) => boolean }[] = [
  { key: 'active', label: 'Active', match: a => !APPLICANT_INACTIVE.includes(a.status) },
  { key: 'new', label: 'New', match: a => a.status === 'new' },
  { key: 'info', label: 'Info Requested', match: a => a.status === 'information_requested' },
  { key: 'interview', label: 'Interviewing', match: a => a.status === 'interview' || a.status === 'second_interview' },
  { key: 'approved', label: 'Approved Contractors', match: a => a.status === 'hired' },
  { key: 'archived', label: 'Archived', match: a => a.status === 'archived' || a.status === 'withdrawn' },
  { key: 'all', label: 'All', match: () => true },
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
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [agreement, setAgreement] = useState<{ configured: boolean; blocking: string | null; current?: { version: number; filename: string; publishedAt: number } | null } | null>(null)
  const [canDecide, setCanDecide] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/careers', { credentials: 'same-origin' })
      if (res.status === 401) return
      const j = await res.json()
      setList(Array.isArray(j.applicants) ? j.applicants : [])
      setCanDecide(j.permissions?.canDecide === true)
    } catch { setError('Applicants could not be loaded. Try refreshing the page.') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    void fetch('/api/admin/contractor-agreement', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.ok) setAgreement({ configured: d.configured, blocking: d.blocking, current: d.current }) })
      .catch(() => {})
  }, [])

  const filtered = useMemo(() => list.filter(STATUS_TABS.find(t => t.key === tab)!.match), [list, tab])
  const sel = useMemo(() => list.find(a => a.id === selId) || null, [list, selId])

  async function act(action: string, value?: unknown) {
    if (!sel) return
    setBusy(true)
    setError(''); setNotice('')
    try {
      const res = await fetch('/api/admin/careers', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sel.id, action, value }) })
      const j = await res.json()
      if (j.applicant) setList(prev => prev.map(a => a.id === sel.id ? j.applicant : a))
      if (!res.ok) {
        // A duplicate-crew conflict is a decision to make, not a failure to retry:
        // nothing changed, and the admin must explicitly accept the consequence.
        if (j.reason === 'crew_link_confirmation_required') {
          await load()
          setError(`${j.error} ${j.consequence ?? ''}`.trim())
          return
        }
        throw new Error(j.error || 'The applicant could not be updated.')
      }
      if (j.warning) setError(j.warning)
      else setNotice(action === 'confirm_crew_link'
        ? 'Crew member linked and paused for onboarding.'
        : action === 'countersign_onboarding'
          ? 'Agreement countersigned and sealed.'
          : action === 'verify_onboarding'
            ? 'Contractor verified and activated.'
            : '')
      if (action === 'confirm_crew_link' || action === 'hire') await load()
    } catch (e) { setError(e instanceof Error ? e.message : 'The applicant could not be updated.') }
    finally { setBusy(false) }
  }

  const chip = (active: boolean): React.CSSProperties => ({ padding: '6px 12px', borderRadius: 99, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: `1px solid ${active ? 'var(--red)' : 'var(--line)'}`, background: active ? 'var(--red)' : 'rgba(255,255,255,.04)', color: active ? '#fff' : 'var(--muted)' })

  return (
    <main className="min-h-screen pt-16" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      <div className="max-w-6xl mx-auto px-3 sm:px-5 py-5">
        <div className="mb-2">
          <Link href="/admin/operations/employees" className="text-sm" style={{ color: 'var(--muted)', textDecoration: 'none' }}>← Crew directory</Link>
        </div>
        <div className="flex items-center justify-between gap-3 mb-4">
          <h1 className="text-2xl font-black text-white" style={{ letterSpacing: '-0.03em' }}>Applicants</h1>
          <span className="text-sm" style={{ color: 'var(--muted)' }}>{list.length} applicant{list.length === 1 ? '' : 's'}</span>
        </div>
        {error && <p role="alert" className="text-sm mb-4" style={{ color: '#f87171' }}>{error}</p>}
        {notice && <p role="status" className="text-sm mb-4" style={{ color: '#34d399' }}>{notice}</p>}
        {agreement && !agreement.configured && (
          <div role="alert" className="rounded-xl p-4 mb-4" style={{ background: 'rgba(251,191,36,.08)', border: '1px solid rgba(251,191,36,.4)' }}>
            <p className="text-sm font-bold" style={{ color: '#fcd34d' }}>No contractor agreement is published</p>
            <p className="text-xs mt-1" style={{ color: 'var(--muted)', lineHeight: 1.55 }}>
              {agreement.blocking} Approvals still create a blocked crew record, but no onboarding link can be sent until an
              administrator uploads the counsel-approved PDF.
            </p>
          </div>
        )}
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
              : <Review key={sel.id} a={sel} act={act} busy={busy} canDecide={canDecide} onBack={() => setSelId(null)} />}
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

function Review({ a, act, busy, canDecide, onBack }: {
  a: Applicant; act: (action: string, value?: unknown) => void; busy: boolean; canDecide: boolean; onBack: () => void
}) {
  const [notes, setNotes] = useState(a.managerNotes || '')
  const [counterSignatureName, setCounterSignatureName] = useState('')
  const [counterSignatureTitle, setCounterSignatureTitle] = useState('Authorized Representative')
  const [counterSignatureIntent, setCounterSignatureIntent] = useState(false)
  const reqKinds = CONTRACTOR_ONBOARDING_DOCS[a.position].map(d => d.kind)
  reqKinds.push('contractor_agreement')
  if (a.contractorOnboarding?.usesPersonalVehicle) reqKinds.push('insurance')
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
  const signInput: React.CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: 9, border: '1px solid var(--line)', background: 'rgba(255,255,255,.04)', color: 'var(--text)' }

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
        {a.promotedStaffId && <p className="text-xs mt-3" style={{ color: a.contractorOnboarding?.verifiedAt && !a.contractEndedAt ? '#34d399' : '#fbbf24' }}>
          {a.contractEndedAt
            ? 'Relationship ended — not available for new work'
            : a.contractorOnboarding?.verifiedAt
              ? '✓ Onboarding verified — ready for work'
              : a.contractorOnboarding?.submittedAt
                ? 'Crew record linked — work blocked until admin verification'
                : 'Crew record linked — work blocked until onboarding is completed'}
        </p>}
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

      {a.pendingCrewLink && canDecide && (
        <Section title="Existing crew member found">
          <div role="alert" className="rounded-xl p-4" style={{ background: 'rgba(251,191,36,.08)', border: '1px solid rgba(251,191,36,.45)' }}>
            <p className="text-sm font-bold" style={{ color: '#fcd34d' }}>{a.pendingCrewLink.staffName} is already active on the roster</p>
            <p className="text-xs mt-2" style={{ color: 'var(--muted)', lineHeight: 1.6 }}>
              Their W-9 is not verified. Linking this application pauses them for contractor onboarding: they become
              unavailable for assignments, dispatch, portal activation, and ordinary pay until an administrator verifies
              their documents. Nothing has changed yet — the roster and this application are untouched.
            </p>
            <div className="flex flex-wrap gap-2 mt-3">
              <button disabled={busy} onClick={() => { if (confirm(`Link ${a.pendingCrewLink!.staffName} and pause them for onboarding?`)) void act('confirm_crew_link') }} style={btn('#b45309')}>
                Link existing crew and pause for onboarding
              </button>
            </div>
          </div>
        </Section>
      )}

      {/* Post-approval contractor onboarding. No sensitive document is collected at application time. */}
      {a.status === 'hired' && <Section title="1099 contractor onboarding">
        <div className="flex flex-wrap gap-2 mb-3 items-center">
          <span className="text-sm" style={{ color: a.contractorOnboarding?.verifiedAt ? '#34d399' : 'var(--text)' }}>
            {a.contractorOnboarding?.verifiedAt ? '✓ Verified' : a.contractorOnboarding?.submittedAt ? 'Submitted — awaiting admin verification' : a.contractorOnboarding?.delivery === 'sent' ? 'Secure link sent' : 'Onboarding link not delivered'}
          </span>
          {a.contractorOnboarding?.submittedAt && <span className="text-xs" style={{ color: 'var(--muted)' }}>· submitted {fmtTs(a.contractorOnboarding.submittedAt)}</span>}
          {a.contractorOnboarding?.agreementVersion && <span className="text-xs" style={{ color: 'var(--muted)' }}>· agreement v{a.contractorOnboarding.agreementVersion}</span>}
          {a.contractorOnboarding?.electronicSignature?.contractor && <span className="text-xs" style={{ color: '#93c5fd' }}>· contractor signed</span>}
          {a.contractorOnboarding?.electronicSignature?.company && <span className="text-xs" style={{ color: '#34d399' }}>· company countersigned</span>}
        </div>
        {/* A failed send is the difference between "approved" and "can actually start". */}
        {a.contractorOnboarding?.delivery === 'failed' && (
          <div role="alert" className="rounded-xl p-3 mb-3" style={{ background: 'rgba(248,113,113,.08)', border: '1px solid rgba(248,113,113,.45)' }}>
            <p className="text-sm font-bold" style={{ color: '#fca5a5' }}>Onboarding email failed to send</p>
            <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
              This contractor has never received their link and cannot start. Last attempt{' '}
              {a.contractorOnboarding.deliveryAttemptedAt ? fmtTs(a.contractorOnboarding.deliveryAttemptedAt) : 'unknown'}
              {a.contractorOnboarding.deliveryError ? ` — ${a.contractorOnboarding.deliveryError}` : ''}.
            </p>
            <button disabled={busy} onClick={() => act('resend_onboarding')} style={{ ...btn('#b91c1c'), marginTop: 8 }}>Resend now</button>
          </div>
        )}
        {a.contractorOnboarding?.delivery === 'sent' && !a.contractorOnboarding.verifiedAt && (
          <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>
            Last delivery attempt {a.contractorOnboarding.deliveryAttemptedAt ? fmtTs(a.contractorOnboarding.deliveryAttemptedAt) : '—'} · delivered
          </p>
        )}
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
        <div className="flex flex-wrap gap-2 mt-4">
          {!a.contractorOnboarding?.submittedAt && <button disabled={busy} onClick={() => act('resend_onboarding')} style={btn('#2563eb')}>{a.contractorOnboarding?.requestedAt ? 'Resend secure link' : 'Send secure link'}</button>}
          {a.contractorOnboarding?.submittedAt && a.contractorOnboarding.electronicSignature?.company && !a.contractorOnboarding.verifiedAt && <button disabled={busy} onClick={() => act('verify_onboarding')} style={btn('#059669')}>Verify and activate</button>}
        </div>
        {a.contractorOnboarding?.submittedAt && a.contractorOnboarding.electronicSignature?.contractor && !a.contractorOnboarding.electronicSignature?.company && canDecide && (
          <div className="rounded-xl p-4 mt-4 space-y-3" style={{ border: '1px solid rgba(167,139,250,.5)', background: 'rgba(124,58,237,.08)' }}>
            <p className="text-sm font-bold text-white">J Kiss LLC countersignature</p>
            <p className="text-xs" style={{ color: 'var(--muted)', lineHeight: 1.55 }}>Review the uploaded documents and the contractor’s signature evidence. Your name, account, timestamp, IP address, and this exact agreement version will be recorded in the execution certificate.</p>
            <div className="grid sm:grid-cols-2 gap-3">
              <div><label htmlFor={`counter-name-${a.id}`} className="text-xs font-bold block mb-1" style={{ color: 'var(--muted)' }}>Your full legal name</label><input id={`counter-name-${a.id}`} value={counterSignatureName} onChange={e => setCounterSignatureName(e.target.value)} autoComplete="name" style={signInput} /></div>
              <div><label htmlFor={`counter-title-${a.id}`} className="text-xs font-bold block mb-1" style={{ color: 'var(--muted)' }}>Signing title</label><input id={`counter-title-${a.id}`} value={counterSignatureTitle} onChange={e => setCounterSignatureTitle(e.target.value)} autoComplete="organization-title" style={signInput} /></div>
            </div>
            <label className="flex gap-3 items-start text-sm"><input type="checkbox" checked={counterSignatureIntent} onChange={e => setCounterSignatureIntent(e.target.checked)} style={{ width: 18, height: 18, marginTop: 2 }} /><span>I am authorized to bind J Kiss LLC and intend this electronic signature to countersign agreement v{a.contractorOnboarding.agreementVersion}.</span></label>
            <button disabled={busy || !counterSignatureIntent || counterSignatureName.trim().length < 2 || counterSignatureTitle.trim().length < 2} onClick={() => void act('countersign_onboarding', { intent: counterSignatureIntent, signatureName: counterSignatureName, title: counterSignatureTitle })} style={{ ...btn('#7c3aed'), opacity: busy || !counterSignatureIntent || counterSignatureName.trim().length < 2 || counterSignatureTitle.trim().length < 2 ? .55 : 1 }}>Countersign and seal agreement</button>
          </div>
        )}
      </Section>}

      {/* badge headshot */}
      {headshot && (
        <Section title="Crew badge headshot">
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
        {(a.duplicateApplicantNumbers?.length ?? 0) > 0 && <p className="text-xs mb-3" style={{ color: '#fbbf24' }}>Possible prior application: {a.duplicateApplicantNumbers?.join(', ')}</p>}
        {a.informationRequest && <p className="text-xs mb-2" style={{ color: 'var(--muted)' }}>Requested: {a.informationRequest.message}</p>}
        {a.informationResponse && <p className="text-sm mb-3" style={{ color: '#34d399' }}>Applicant response: {a.informationResponse.message}</p>}
        <p className="text-xs mb-2" style={{ color: 'var(--muted)' }}>Recommendation {a.recommendation ? `· currently: ${RECOMMENDATION_LABEL[a.recommendation]}` : ''}</p>
        <div className="flex flex-wrap gap-2 mb-4">
          {canDecide && <button disabled={busy} onClick={() => act('hire')} style={btn('#059669')}>✓ Approve → Contractor/Crew</button>}
          <button disabled={busy} onClick={() => act('status', 'interview')} style={btn('#2563eb')}>Interview</button>
          <button disabled={busy} onClick={() => { const w = prompt('What information do you need from the applicant?'); if (w != null) act('request_info', w) }} style={btn('#7c3aed')}>Request info</button>
          <button disabled={busy} onClick={() => act('status', 'waitlist')} style={btn('#d97706')}>Waitlist</button>
          {canDecide && <button disabled={busy} onClick={() => act('recommendation', 'reject' as Recommendation)} style={btn('#b91c1c')}>Deny</button>}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-xs" style={{ color: 'var(--muted)' }}>Status</label>
          <select disabled={busy} value={a.status} onChange={e => act('status', e.target.value as ApplicantStatus)} style={{ padding: '8px 12px', background: 'rgba(255,255,255,.04)', border: '1px solid var(--line)', borderRadius: 10, color: '#f3f4f6', fontSize: 13, cursor: 'pointer', colorScheme: 'dark' }}>
            {(Object.keys(APPLICANT_STATUS_LABEL) as ApplicantStatus[]).filter(st => st === a.status || (st !== 'hired' && (canDecide || st !== 'rejected'))).map(st => <option key={st} value={st}>{APPLICANT_STATUS_LABEL[st]}</option>)}
          </select>
          <button disabled={busy} onClick={() => act('rescore')} className="btn-ghost" style={{ padding: '8px 12px', fontSize: 12 }}>Re-score</button>
          {canDecide && <button disabled={busy} onClick={() => act('status', 'archived')} style={{ padding: '8px 12px', fontSize: 12, background: 'transparent', border: '1px solid rgba(248,113,113,.4)', color: '#f87171', borderRadius: 10, cursor: 'pointer', marginLeft: 'auto' }}>Archive</button>}
        </div>
        {canDecide && <div className="mt-3 pt-3 flex items-center justify-between gap-3" style={{ borderTop: '1px solid var(--line)' }}>
          <p className="text-xs" style={{ color: a.legalHold?.active ? '#fbbf24' : 'var(--muted)' }}>{a.legalHold?.active ? `Legal hold: ${a.legalHold.reason}` : 'No legal hold'}</p>
          <button disabled={busy} onClick={() => { if (a.legalHold?.active) act('legal_hold', { active: false }); else { const reason = prompt('Reason for legal hold'); if (reason) act('legal_hold', { active: true, reason }) } }} className="btn-ghost" style={{ padding: '7px 10px', fontSize: 12 }}>{a.legalHold?.active ? 'Release hold' : 'Place legal hold'}</button>
        </div>}
        {canDecide && a.status === 'hired' && <div className="mt-3 pt-3 flex items-center justify-between gap-3" style={{ borderTop: '1px solid var(--line)' }}>
          <p className="text-xs" style={{ color: a.contractEndedAt ? '#fbbf24' : 'var(--muted)' }}>{a.contractEndedAt ? `Contract ended ${fmtTs(a.contractEndedAt)}; retention clocks are running.` : 'Contractor relationship active'}</p>
          <button disabled={busy} onClick={() => act(a.contractEndedAt ? 'reopen_contract' : 'end_contract')} style={{ padding: '7px 10px', fontSize: 12, background: 'transparent', border: '1px solid var(--line)', color: 'var(--text)', borderRadius: 10 }}>{a.contractEndedAt ? 'Reopen relationship' : 'End relationship'}</button>
        </div>}
        {a.promotedStaffId && (
          <p className="text-xs mt-3" style={{ color: '#34d399' }}>
            ✓ Linked to crew record · <Link href="/admin/operations/employees" style={{ color: 'var(--red)', textDecoration: 'none' }}>view in Crew →</Link>
          </p>
        )}
      </Section>

      {/* Activity timeline — the applicant lifecycle (submitted → decisions → crew). */}
      {Array.isArray(a.events) && a.events.length > 0 && (
        <Section title="Activity">
          <div className="space-y-2">
            {[...a.events].reverse().map((e, i) => (
              <div key={i} className="flex gap-3 text-sm" style={{ color: 'var(--text)' }}>
                <span className="tabular-nums shrink-0" style={{ color: 'var(--muted)', minWidth: 128, fontSize: 12 }}>{fmtTs(e.at)}</span>
                <span>{e.action}{e.note ? <span style={{ color: 'var(--muted)' }}> — {e.note}</span> : null}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
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
