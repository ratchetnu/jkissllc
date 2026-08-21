'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  ChevronLeft, ChevronRight, Search, AlertTriangle, CheckCircle2, Mail,
  ShieldCheck, FileText, Users, X,
} from 'lucide-react'
import AdminGate from '../AdminGate'
import { Avatar } from '../operations/ui'
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

// Searching "jose" must find "José", and "Nunez" must find "Ñuñez". Stripping
// combining marks is the difference between a usable roster search and one that
// quietly fails on a large share of a DFW workforce's names.
const norm = (v: string): string => v.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
const haystack = (a: Applicant): string =>
  norm(`${a.name} ${a.email} ${a.phone} ${a.applicantNumber} ${POSITIONS[a.position].title}`)

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

// ── Presentation layer ───────────────────────────────────────────────────────
// Scoped to .ap-* so nothing here can leak into the rest of the OS. Hover and
// pressed states live in CSS because inline styles cannot express them, and the
// difference between "a button" and "a control that answers you" is exactly
// those states.
const CSS = `
.ap-seg { display:flex; flex-wrap:wrap; gap:2px; padding:3px; border-radius:13px; background:rgba(255,255,255,.05); border:1px solid var(--line); }
.ap-seg button { flex:0 0 auto; display:inline-flex; align-items:center; gap:7px; padding:7px 13px; border-radius:10px; border:none; background:transparent; color:var(--muted); font-size:13px; font-weight:600; cursor:pointer; white-space:nowrap; transition:background .18s var(--os-ease), color .18s var(--os-ease); }
.ap-seg button[aria-pressed="true"] { background:color-mix(in srgb, #fff 10%, var(--card)); color:var(--text); font-weight:700; box-shadow:0 1px 2px rgba(0,0,0,.4); }
@media (hover:hover) { .ap-seg button:not([aria-pressed="true"]):hover { color:var(--text); background:rgba(255,255,255,.05); } }
.ap-badge { font-size:11px; font-weight:700; padding:1px 6px; border-radius:99px; background:rgba(255,255,255,.08); color:var(--muted); font-variant-numeric:tabular-nums; }
.ap-seg button[aria-pressed="true"] .ap-badge { background:rgba(255,255,255,.15); color:var(--text); }

.ap-row { display:flex; align-items:center; gap:12px; width:100%; text-align:left; padding:11px 14px; background:transparent; border:none; border-top:1px solid var(--line); cursor:pointer; color:var(--text); transition:background .16s var(--os-ease); }
.ap-row:first-child { border-top:none; }
@media (hover:hover) { .ap-row:hover { background:rgba(255,255,255,.045); } }
.ap-row[aria-current="true"] { background:color-mix(in srgb, #fff 8%, var(--card)); }
.ap-row:active { background:rgba(255,255,255,.075); }

@media (min-width:1024px) { .ap-list { position:sticky; top:106px; max-height:calc(100svh - 128px); overflow-y:auto; overscroll-behavior:contain; } }

.ap-btn { display:inline-flex; align-items:center; justify-content:center; gap:7px; padding:9px 15px; border-radius:11px; font-size:13.5px; font-weight:650; cursor:pointer; border:1px solid transparent; transition:background .16s var(--os-ease), border-color .16s var(--os-ease), transform .12s var(--os-ease); }
.ap-btn:active { transform:scale(.97); }
.ap-btn:disabled { opacity:.45; cursor:not-allowed; transform:none; }
.ap-btn-primary { background:var(--red); color:#fff; }
@media (hover:hover) { .ap-btn-primary:not(:disabled):hover { background:var(--red-600); } }
.ap-btn-go { background:rgba(52,211,153,.13); color:#6ee7b7; border-color:rgba(52,211,153,.32); }
@media (hover:hover) { .ap-btn-go:not(:disabled):hover { background:rgba(52,211,153,.2); } }
.ap-btn-tinted { background:rgba(255,255,255,.06); color:var(--text); border-color:var(--line); }
@media (hover:hover) { .ap-btn-tinted:not(:disabled):hover { background:rgba(255,255,255,.1); } }
.ap-btn-plain { background:transparent; color:var(--muted); }
@media (hover:hover) { .ap-btn-plain:not(:disabled):hover { color:var(--text); background:rgba(255,255,255,.05); } }
.ap-btn-danger { background:transparent; color:#f87171; border-color:rgba(248,113,113,.35); }
@media (hover:hover) { .ap-btn-danger:not(:disabled):hover { background:rgba(248,113,113,.1); } }

.ap-hair { border-top:1px solid var(--line); }
.ap-ring-arc { transition:stroke-dashoffset .7s var(--os-ease); }
.ap-disclose { display:inline-flex; align-items:center; gap:6px; padding:4px 0; background:none; border:none; color:var(--muted); font-size:12.5px; font-weight:650; cursor:pointer; transition:color .16s var(--os-ease); }
@media (hover:hover) { .ap-disclose:hover { color:var(--text); } }
.ap-disclose .ap-chev-open { transform:rotate(90deg); }
.ap-disclose svg { transition:transform .28s var(--os-ease); }
.ap-field { width:100%; padding:10px 13px; border-radius:11px; border:1px solid var(--line); background:color-mix(in srgb, var(--card) 90%, transparent); color:var(--text); font-size:14.5px; outline:none; transition:border-color .16s var(--os-ease); }
.ap-field:focus { border-color:color-mix(in srgb, var(--red) 55%, var(--line)); }
.ap-field[type="search"]::-webkit-search-cancel-button { -webkit-appearance:none; appearance:none; }
@media (prefers-reduced-motion:reduce) { .ap-seg button, .ap-row, .ap-btn, .ap-field, .ap-ring-arc, .ap-disclose, .ap-disclose svg { transition:none !important; } .ap-btn:active { transform:none; } }
`

type BtnKind = 'primary' | 'go' | 'tinted' | 'plain' | 'danger'
function Btn({ kind = 'tinted', children, ...rest }: { kind?: BtnKind } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...rest} className={`ap-btn ap-btn-${kind}${rest.className ? ` ${rest.className}` : ''}`}>{children}</button>
}

/** Readiness score as a value, not a decoration: a tone dot and the number. */
function Score({ band, score, size = 'md' }: { band: ScoreBand; score: number; size?: 'sm' | 'md' }) {
  const m = BAND_META[band]
  const sm = size === 'sm'
  return (
    <span title={m.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: sm ? '2px 8px' : '3px 10px', borderRadius: 99, fontSize: sm ? 11.5 : 12.5, fontWeight: 700, background: `${m.tone}1a`, color: m.tone, border: `1px solid ${m.tone}3d`, whiteSpace: 'nowrap' }}>
      <span aria-hidden style={{ width: 6, height: 6, borderRadius: 99, background: m.tone, flexShrink: 0 }} />
      <span className="tabular-nums">{score}</span>
      {!sm && <span style={{ fontWeight: 500, opacity: .7 }}>/100</span>}
    </span>
  )
}

/** Grouped card — the OS's inset panel, with an optional sentence-case title. */
function Card({ title, note, children, tone }: { title?: string; note?: string; children: React.ReactNode; tone?: string }) {
  return (
    <section className="os-card" style={{ padding: 18, marginBottom: 14, borderColor: tone }}>
      {title && (
        <header style={{ marginBottom: 12 }}>
          <h3 style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)', letterSpacing: '-.01em' }}>{title}</h3>
          {note && <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, lineHeight: 1.5 }}>{note}</p>}
        </header>
      )}
      {children}
    </section>
  )
}

/** Inline banner. Never a native dialog — those block the page and read to a
 *  screen reader as nothing at all. */
function Banner({ tone, icon: Icon, title, children, role = 'status' }: {
  tone: string; icon: React.ComponentType<{ size?: number }>; title: string; children?: React.ReactNode; role?: 'status' | 'alert'
}) {
  return (
    <div role={role} style={{ display: 'flex', gap: 11, padding: '13px 15px', borderRadius: 14, background: `${tone}14`, border: `1px solid ${tone}44`, marginBottom: 14 }}>
      <span style={{ color: tone, flexShrink: 0, marginTop: 1 }}><Icon size={17} /></span>
      <div style={{ minWidth: 0 }}>
        <p style={{ fontSize: 13.5, fontWeight: 700, color: tone }}>{title}</p>
        {children && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.55 }}>{children}</div>}
      </div>
    </div>
  )
}

function CareersInner() {
  const [list, setList] = useState<Applicant[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('active')
  const [query, setQuery] = useState('')
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

  const counts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const t of STATUS_TABS) out[t.key] = list.filter(t.match).length
    return out
  }, [list])

  const q = norm(query.trim())
  const filtered = useMemo(() => {
    const inTab = list.filter(STATUS_TABS.find(t => t.key === tab)!.match)
    return q ? inTab.filter(a => haystack(a).includes(q)) : inTab
  }, [list, tab, q])
  // A search that misses inside the current filter is a dead end unless we say how
  // many it WOULD have found everywhere — and offer the one click that gets there.
  const matchesAnywhere = useMemo(() => q ? list.filter(a => haystack(a).includes(q)).length : 0, [list, q])
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

  const inReview = counts.active ?? 0
  const approved = counts.approved ?? 0

  return (
    <>
      <style>{CSS}</style>
      <div className="os-rise">
        <Link href="/admin/operations/employees" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: -4, fontSize: 13, fontWeight: 600, color: 'var(--muted)', textDecoration: 'none' }}>
          <ChevronLeft size={15} /> Crew directory
        </Link>

        <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', margin: '10px 0 18px' }}>
          <div>
            <h1 className="jkos-h" style={{ fontSize: 'clamp(28px, 5vw, 36px)' }}>Applicants</h1>
            <p style={{ fontSize: 13.5, color: 'var(--muted)', marginTop: 5 }}>
              {loading ? 'Loading…'
                : list.length === 0 ? 'No applications have been received yet.'
                  : `${inReview} in review · ${approved} approved contractor${approved === 1 ? '' : 's'} · ${list.length} total`}
            </p>
          </div>
          {agreement?.configured && agreement.current && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
              <ShieldCheck size={14} /> Agreement v{agreement.current.version} published
            </span>
          )}
        </header>

        {error && <Banner role="alert" tone="#f87171" icon={AlertTriangle} title="Something needs your attention">{error}</Banner>}
        {notice && <Banner tone="#34d399" icon={CheckCircle2} title={notice} />}
        {agreement && !agreement.configured && (
          <Banner role="alert" tone="#fbbf24" icon={AlertTriangle} title="No contractor agreement is published">
            {agreement.blocking} Approvals still create a blocked crew record, but no onboarding link can be sent until an
            administrator uploads the counsel-approved PDF.
          </Banner>
        )}

        {/* Search + segmented filter. The segments carry their own counts so the
            queue's shape is legible before you click anything. */}
        <div style={{ position: 'relative', marginBottom: 10 }}>
          <span aria-hidden style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', display: 'flex' }}><Search size={16} /></span>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            type="search"
            aria-label="Search applicants by name, email, phone, or number"
            placeholder="Search applicants"
            className="ap-field"
            style={{ paddingLeft: 38, paddingRight: query ? 38 : 13 }}
          />
          {query && (
            <button onClick={() => setQuery('')} aria-label="Clear search" style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', display: 'flex', padding: 5, borderRadius: 99, border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer' }}><X size={14} /></button>
          )}
        </div>
        <div className="ap-seg" role="group" aria-label="Filter applicants by status" style={{ marginBottom: 16 }}>
          {STATUS_TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)} aria-pressed={tab === t.key}>
              {t.label}<span className="ap-badge">{counts[t.key] ?? 0}</span>
            </button>
          ))}
        </div>

        <div className="flex flex-col lg:flex-row" style={{ gap: 16, alignItems: 'flex-start' }}>
          {/* Inset grouped list */}
          <div className={`ap-list${sel ? ' hidden lg:block' : ''}`} style={{ flex: '0 0 336px', width: '100%', maxWidth: '100%' }}>
            {loading ? (
              <div className="os-card" style={{ padding: 18 }}>
                {[0, 1, 2].map(i => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', opacity: 1 - i * 0.25 }}>
                    <div style={{ width: 38, height: 38, borderRadius: 99, background: 'rgba(255,255,255,.06)' }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ height: 10, width: '55%', borderRadius: 5, background: 'rgba(255,255,255,.06)' }} />
                      <div style={{ height: 8, width: '38%', borderRadius: 5, background: 'rgba(255,255,255,.045)', marginTop: 7 }} />
                    </div>
                  </div>
                ))}
                <p className="sr-only">Loading applicants…</p>
              </div>
            ) : filtered.length === 0 ? (
              <div className="os-card" role="status" style={{ padding: '34px 22px', textAlign: 'center' }}>
                <span style={{ display: 'inline-grid', placeItems: 'center', width: 46, height: 46, borderRadius: 99, background: 'rgba(255,255,255,.05)', color: 'var(--muted)', marginBottom: 12 }}><Users size={21} /></span>
                <p style={{ fontSize: 14, fontWeight: 700 }}>{query ? 'No matches' : 'Nothing here'}</p>
                <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 5, lineHeight: 1.5 }}>
                  {query
                    ? <>Nothing in <b style={{ color: 'var(--text)' }}>{STATUS_TABS.find(t => t.key === tab)!.label}</b> matches “{query}”.</>
                    : <>No applicants are in <b style={{ color: 'var(--text)' }}>{STATUS_TABS.find(t => t.key === tab)!.label}</b> right now.</>}
                </p>
                {query && tab !== 'all' && matchesAnywhere > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <Btn kind="tinted" onClick={() => setTab('all')}>
                      <Search size={14} /> {matchesAnywhere} match{matchesAnywhere === 1 ? '' : 'es'} in All
                    </Btn>
                  </div>
                )}
              </div>
            ) : (
              <div className="os-card" style={{ overflow: 'hidden', padding: 0 }}>
                {filtered.map(a => {
                  const active = selId === a.id
                  const photo = a.badgeHeadshotUrl || undefined
                  return (
                    <button key={a.id} onClick={() => setSelId(a.id)} className="ap-row" aria-current={active ? 'true' : undefined}>
                      <Avatar name={a.name} photoUrl={photo} size={38} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                          <span style={{ fontSize: 14, fontWeight: 650, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                          <Score band={a.score.band} score={a.score.score} size="sm" />
                        </span>
                        <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {APPLICANT_STATUS_LABEL[a.status]} · {POSITIONS[a.position].title} · {a.applicantNumber}
                        </span>
                      </span>
                      <span aria-hidden style={{ color: 'var(--muted)', opacity: active ? 1 : .5, display: 'flex' }}><ChevronRight size={16} /></span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* Detail — manager review */}
          <div style={{ flex: 1, minWidth: 0, width: '100%' }}>
            {!sel ? (
              <div className="os-card" role="status" style={{ padding: '58px 24px', textAlign: 'center' }}>
                <span style={{ display: 'inline-grid', placeItems: 'center', width: 52, height: 52, borderRadius: 99, background: 'rgba(255,255,255,.05)', color: 'var(--muted)', marginBottom: 14 }}><FileText size={23} /></span>
                <p style={{ fontSize: 15, fontWeight: 700 }}>Select an applicant to review</p>
                <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6, maxWidth: 340, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.55 }}>
                  Their readiness score, scenario answers, onboarding documents, and decision controls all open here.
                </p>
              </div>
            ) : <Review key={sel.id} a={sel} act={act} busy={busy} canDecide={canDecide} onBack={() => setSelId(null)} />}
          </div>
        </div>
      </div>
    </>
  )
}

function Review({ a, act, busy, canDecide, onBack }: {
  a: Applicant; act: (action: string, value?: unknown) => void; busy: boolean; canDecide: boolean; onBack: () => void
}) {
  const [notes, setNotes] = useState(a.managerNotes || '')
  const [counterSignatureName, setCounterSignatureName] = useState('')
  const [counterSignatureTitle, setCounterSignatureTitle] = useState('Authorized Representative')
  const [counterSignatureIntent, setCounterSignatureIntent] = useState(false)
  // Progressive disclosure replaces window.prompt/confirm: every question is asked
  // inline, in the page, where it can be labelled, cancelled, and read aloud.
  const [confirmLink, setConfirmLink] = useState(false)
  const [infoRequest, setInfoRequest] = useState<string | null>(null)
  const [holdReason, setHoldReason] = useState<string | null>(null)
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

  const counterReady = counterSignatureIntent && counterSignatureName.trim().length >= 2 && counterSignatureTitle.trim().length >= 2
  const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '9px 0', fontSize: 13.5 }

  return (
    <div>
      <div className="lg:hidden" style={{ marginBottom: 10 }}>
        <Btn kind="plain" onClick={onBack} style={{ paddingLeft: 8 }}><ChevronLeft size={15} /> All applicants</Btn>
      </div>

      {/* Identity header */}
      <div className="os-card" style={{ padding: 18, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
          <Avatar name={a.name} photoUrl={a.badgeHeadshotUrl || undefined} size={54} />
          <div style={{ flex: 1, minWidth: 200 }}>
            <h2 className="jkos-h" style={{ fontSize: 21 }}>{a.name}</h2>
            <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 3 }}>
              {POSITIONS[a.position].title} · ${POSITIONS[a.position].payPerDay}/day · {a.applicantNumber}
            </p>
            <p style={{ fontSize: 13, color: 'var(--text)', marginTop: 5 }}>{a.email} · {a.phone}</p>
          </div>
          <div style={{ textAlign: 'right' }}>
            <Score band={s.band} score={s.score} />
            <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 5 }}>{BAND_META[s.band].label}</p>
          </div>
        </div>
        {a.promotedStaffId && (
          <p className="ap-hair" style={{ marginTop: 14, paddingTop: 12, fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 7, color: a.contractorOnboarding?.verifiedAt && !a.contractEndedAt ? '#34d399' : '#fbbf24' }}>
            {a.contractEndedAt
              ? 'Relationship ended — not available for new work'
              : a.contractorOnboarding?.verifiedAt
                ? <><CheckCircle2 size={14} /> Onboarding verified — ready for work</>
                : a.contractorOnboarding?.submittedAt
                  ? 'Crew record linked — work blocked until admin verification'
                  : 'Crew record linked — work blocked until onboarding is completed'}
          </p>
        )}
      </div>

      <ReadinessCard score={s} />

      {a.pendingCrewLink && canDecide && (
        <Card title="Existing crew member found" tone="rgba(251,191,36,.4)">
          <Banner role="alert" tone="#fbbf24" icon={AlertTriangle} title={`${a.pendingCrewLink.staffName} is already active on the roster`}>
            Their W-9 is not verified. Linking this application pauses them for contractor onboarding: they become
            unavailable for assignments, dispatch, portal activation, and ordinary pay until an administrator verifies
            their documents. Nothing has changed yet — the roster and this application are untouched.
          </Banner>
          {!confirmLink ? (
            <Btn kind="tinted" disabled={busy} onClick={() => setConfirmLink(true)}>Link existing crew and pause for onboarding…</Btn>
          ) : (
            <div className="ap-hair" style={{ paddingTop: 12 }}>
              <p style={{ fontSize: 13, color: 'var(--text)', marginBottom: 10 }}>
                Link <b>{a.pendingCrewLink.staffName}</b> and pause them for onboarding?
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Btn kind="primary" disabled={busy} onClick={() => { setConfirmLink(false); void act('confirm_crew_link') }}>Link and pause</Btn>
                <Btn kind="plain" disabled={busy} onClick={() => setConfirmLink(false)}>Cancel</Btn>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Post-approval contractor onboarding. No sensitive document is collected at application time. */}
      {a.status === 'hired' && (
        <Card title="1099 contractor onboarding">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontSize: 13.5, fontWeight: 650, color: a.contractorOnboarding?.verifiedAt ? '#34d399' : 'var(--text)' }}>
              {a.contractorOnboarding?.verifiedAt ? 'Verified' : a.contractorOnboarding?.submittedAt ? 'Submitted — awaiting admin verification' : a.contractorOnboarding?.delivery === 'sent' ? 'Secure link sent' : 'Onboarding link not delivered'}
            </span>
            {a.contractorOnboarding?.submittedAt && <span className="ap-badge">submitted {fmtTs(a.contractorOnboarding.submittedAt)}</span>}
            {a.contractorOnboarding?.agreementVersion && <span className="ap-badge">agreement v{a.contractorOnboarding.agreementVersion}</span>}
            {a.contractorOnboarding?.electronicSignature?.contractor && <span className="ap-badge" style={{ color: '#93c5fd' }}>contractor signed</span>}
            {a.contractorOnboarding?.electronicSignature?.company && <span className="ap-badge" style={{ color: '#6ee7b7' }}>company countersigned</span>}
          </div>

          {/* A failed send is the difference between "approved" and "can actually start". */}
          {a.contractorOnboarding?.delivery === 'failed' && (
            <Banner role="alert" tone="#f87171" icon={Mail} title="Onboarding email failed to send">
              This contractor has never received their link and cannot start. Last attempt{' '}
              {a.contractorOnboarding.deliveryAttemptedAt ? fmtTs(a.contractorOnboarding.deliveryAttemptedAt) : 'unknown'}
              {a.contractorOnboarding.deliveryError ? ` — ${a.contractorOnboarding.deliveryError}` : ''}.
              <div style={{ marginTop: 10 }}><Btn kind="primary" disabled={busy} onClick={() => act('resend_onboarding')}>Resend now</Btn></div>
            </Banner>
          )}
          {a.contractorOnboarding?.delivery === 'sent' && !a.contractorOnboarding.verifiedAt && (
            <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
              Last delivery attempt {a.contractorOnboarding.deliveryAttemptedAt ? fmtTs(a.contractorOnboarding.deliveryAttemptedAt) : '—'} · delivered
            </p>
          )}

          <div>
            {reqKinds.map((k, i) => {
              const u = docUrl(k)
              return (
                <div key={k} className={i ? 'ap-hair' : undefined} style={rowStyle}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: has(k) ? 'var(--text)' : '#f87171', minWidth: 0 }}>
                    <span aria-hidden style={{ width: 6, height: 6, borderRadius: 99, background: has(k) ? '#34d399' : '#f87171', flexShrink: 0 }} />
                    {DOC_LABEL[k]}
                  </span>
                  {u
                    ? <a href={docHref(u)} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--red)', textDecoration: 'none', flexShrink: 0 }}>View</a>
                    : <span style={{ fontSize: 12.5, color: '#f87171', flexShrink: 0 }}>Missing</span>}
                </div>
              )
            })}
          </div>
          {s.missingDocs.length > 0 && <p style={{ fontSize: 12, color: '#f87171', marginTop: 10 }}>Missing: {s.missingDocs.map(k => DOC_LABEL[k]).join(', ')}</p>}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
            {!a.contractorOnboarding?.submittedAt && <Btn kind="primary" disabled={busy} onClick={() => act('resend_onboarding')}><Mail size={15} />{a.contractorOnboarding?.requestedAt ? 'Resend secure link' : 'Send secure link'}</Btn>}
            {a.contractorOnboarding?.submittedAt && a.contractorOnboarding.electronicSignature?.company && !a.contractorOnboarding.verifiedAt && <Btn kind="go" disabled={busy} onClick={() => act('verify_onboarding')}><CheckCircle2 size={15} /> Verify and activate</Btn>}
          </div>

          {a.contractorOnboarding?.submittedAt && a.contractorOnboarding.electronicSignature?.contractor && !a.contractorOnboarding.electronicSignature?.company && canDecide && (
            <div style={{ marginTop: 16, padding: 16, borderRadius: 14, border: '1px solid rgba(167,139,250,.4)', background: 'rgba(124,58,237,.07)' }}>
              <p style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)' }}>J Kiss LLC countersignature</p>
              <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 5, lineHeight: 1.55 }}>
                Review the uploaded documents and the contractor’s signature evidence. Your name, account, timestamp, IP address, and this exact agreement version will be recorded in the execution certificate.
              </p>
              <div className="grid sm:grid-cols-2" style={{ gap: 12, marginTop: 13 }}>
                <div>
                  <label htmlFor={`counter-name-${a.id}`} style={{ display: 'block', fontSize: 12, fontWeight: 650, color: 'var(--muted)', marginBottom: 5 }}>Your full legal name</label>
                  <input id={`counter-name-${a.id}`} value={counterSignatureName} onChange={e => setCounterSignatureName(e.target.value)} autoComplete="name" className="ap-field" />
                </div>
                <div>
                  <label htmlFor={`counter-title-${a.id}`} style={{ display: 'block', fontSize: 12, fontWeight: 650, color: 'var(--muted)', marginBottom: 5 }}>Signing title</label>
                  <input id={`counter-title-${a.id}`} value={counterSignatureTitle} onChange={e => setCounterSignatureTitle(e.target.value)} autoComplete="organization-title" className="ap-field" />
                </div>
              </div>
              <label style={{ display: 'flex', gap: 11, alignItems: 'flex-start', fontSize: 13, lineHeight: 1.5, margin: '13px 0' }}>
                <input type="checkbox" checked={counterSignatureIntent} onChange={e => setCounterSignatureIntent(e.target.checked)} style={{ width: 18, height: 18, marginTop: 1, flexShrink: 0, accentColor: 'var(--red)' }} />
                <span>I am authorized to bind J Kiss LLC and intend this electronic signature to countersign agreement v{a.contractorOnboarding.agreementVersion}.</span>
              </label>
              <Btn kind="primary" disabled={busy || !counterReady} onClick={() => void act('countersign_onboarding', { intent: counterSignatureIntent, signatureName: counterSignatureName, title: counterSignatureTitle })}>
                <ShieldCheck size={15} /> Countersign and seal agreement
              </Btn>
            </div>
          )}
        </Card>
      )}

      {/* badge headshot */}
      {headshot && (
        <Card title="Crew badge headshot">
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={headshot.url} alt="" style={{ width: 92, height: 92, objectFit: 'cover', borderRadius: 14, border: `1px solid ${a.badgeHeadshotUrl ? 'rgba(52,211,153,.5)' : 'var(--line)'}` }} />
            <div>
              <p style={{ fontSize: 13.5, marginBottom: 10, color: a.badgeHeadshotUrl ? '#6ee7b7' : 'var(--muted)' }}>{a.badgeHeadshotUrl ? 'Approved for badge' : 'Not yet approved'}</p>
              {a.badgeHeadshotUrl
                ? <Btn kind="tinted" disabled={busy} onClick={() => act('unapprove_headshot')}>Unapprove</Btn>
                : <Btn kind="go" disabled={busy} onClick={() => act('approve_headshot')}>Approve for badge</Btn>}
            </div>
          </div>
        </Card>
      )}

      <Signals score={s} />

      {a.experienceSummary && (
        <Card title="Experience summary" note="In the applicant’s own words.">
          <p style={{ fontSize: 13.5, color: 'var(--text)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{a.experienceSummary}</p>
        </Card>
      )}

      <Card title="Availability">
        <div style={rowStyle}><span style={{ color: 'var(--muted)' }}>Start</span><span>{a.availableStart || '—'}</span></div>
        <div className="ap-hair" style={rowStyle}><span style={{ color: 'var(--muted)' }}>Days</span><span style={{ textAlign: 'right' }}>{(a.availableDays || []).join(', ') || '—'}</span></div>
        {a.availabilityNotes && <div className="ap-hair" style={rowStyle}><span style={{ color: 'var(--muted)' }}>Notes</span><span style={{ textAlign: 'right' }}>{a.availabilityNotes}</span></div>}
      </Card>

      {/* Same row grammar as the readiness card, so the two assessment panels read
          as one language. Deliberately NOT tinted: a rubric percentage is relative
          across the five dimensions, not a pass mark — even a strong candidate sits
          near 50, so borrowing the shortfall thresholds would cry wolf on everyone. */}
      <Card title="Scenario rubric" note="Auto-scored from the answers below. Compare the five against each other, not against 100.">
        <div style={{ display: 'grid', gap: 12 }}>
          {RUBRIC_DIMENSIONS.map(d => {
            const pct = Math.max(0, Math.min(1, s.scenarioRubric[d]))
            return (
              <div key={d}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12.5, marginBottom: 6 }}>
                  <span style={{ color: 'var(--text)' }}>{RUBRIC_LABELS[d]}</span>
                  <span className="tabular-nums" style={{ color: 'var(--muted)', flexShrink: 0 }}>{Math.round(pct * 100)}%</span>
                </div>
                <div style={{ height: 3, borderRadius: 99, background: 'rgba(255,255,255,.06)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', borderRadius: 99, width: `${pct * 100}%`, background: 'rgba(255,255,255,.26)' }} />
                </div>
              </div>
            )
          })}
        </div>
      </Card>

      <Card title="Scenario answers">
        {a.scenarios.filter(sc => sc.answer.trim()).length === 0 && <p style={{ fontSize: 13.5, color: '#f87171' }}>No scenario answers provided.</p>}
        {a.scenarios.filter(sc => sc.answer.trim()).map((sc, i) => (
          <div key={sc.key} className={i ? 'ap-hair' : undefined} style={{ paddingTop: i ? 12 : 0, marginTop: i ? 12 : 0 }}>
            <p style={{ fontSize: 12, fontWeight: 650, color: 'var(--muted)', lineHeight: 1.5 }}>{SCENARIO_PROMPT[sc.key]}</p>
            <p style={{ fontSize: 13.5, color: 'var(--text)', lineHeight: 1.6, whiteSpace: 'pre-wrap', marginTop: 5 }}>{sc.answer}</p>
          </div>
        ))}
      </Card>

      {s.suggestedQuestions.length > 0 && (
        <Card title="Recommended interview questions">
          <ul style={{ display: 'grid', gap: 9 }}>
            {s.suggestedQuestions.map((q, i) => (
              <li key={i} style={{ fontSize: 13.5, display: 'flex', gap: 9, color: 'var(--text)', lineHeight: 1.55 }}>
                <span aria-hidden style={{ color: 'var(--red)', fontWeight: 800, flexShrink: 0 }}>{i + 1}</span>{q}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Manager notes">
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="Notes from your review / interview…" className="ap-field" style={{ resize: 'vertical', lineHeight: 1.55 }} aria-label="Manager notes" />
        <div style={{ marginTop: 10 }}><Btn kind="tinted" disabled={busy} onClick={() => act('notes', notes)}>Save notes</Btn></div>
      </Card>

      {/* recommendation + status */}
      <Card title="Decision">
        {(a.duplicateApplicantNumbers?.length ?? 0) > 0 && <p style={{ fontSize: 12, color: '#fbbf24', marginBottom: 11 }}>Possible prior application: {a.duplicateApplicantNumbers?.join(', ')}</p>}
        {a.informationRequest && <p style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 7 }}>Requested: {a.informationRequest.message}</p>}
        {a.informationResponse && <p style={{ fontSize: 13, color: '#6ee7b7', marginBottom: 11 }}>Applicant response: {a.informationResponse.message}</p>}
        <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 9 }}>
          Recommendation{a.recommendation ? ` · currently: ${RECOMMENDATION_LABEL[a.recommendation]}` : ''}
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {canDecide && <Btn kind="go" disabled={busy} onClick={() => act('hire')}><CheckCircle2 size={15} /> Approve → Contractor/Crew</Btn>}
          <Btn kind="tinted" disabled={busy} onClick={() => act('status', 'interview')}>Interview</Btn>
          <Btn kind="tinted" disabled={busy} onClick={() => setInfoRequest(infoRequest === null ? '' : null)} aria-expanded={infoRequest !== null}>Request info</Btn>
          <Btn kind="tinted" disabled={busy} onClick={() => act('status', 'waitlist')}>Waitlist</Btn>
          {canDecide && <Btn kind="danger" disabled={busy} onClick={() => act('recommendation', 'reject' as Recommendation)}>Deny</Btn>}
        </div>

        {infoRequest !== null && (
          <div className="ap-hair" style={{ marginTop: 13, paddingTop: 13 }}>
            <label htmlFor={`info-${a.id}`} style={{ display: 'block', fontSize: 12, fontWeight: 650, color: 'var(--muted)', marginBottom: 6 }}>What information do you need from the applicant?</label>
            <textarea id={`info-${a.id}`} value={infoRequest} onChange={e => setInfoRequest(e.target.value)} rows={2} className="ap-field" style={{ resize: 'vertical' }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 9 }}>
              <Btn kind="primary" disabled={busy || infoRequest.trim().length === 0} onClick={() => { act('request_info', infoRequest); setInfoRequest(null) }}>Send request</Btn>
              <Btn kind="plain" disabled={busy} onClick={() => setInfoRequest(null)}>Cancel</Btn>
            </div>
          </div>
        )}

        <div className="ap-hair" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 13, paddingTop: 13 }}>
          <label htmlFor={`status-${a.id}`} style={{ fontSize: 12, color: 'var(--muted)' }}>Status</label>
          <select id={`status-${a.id}`} disabled={busy} value={a.status} onChange={e => act('status', e.target.value as ApplicantStatus)} className="ap-field" style={{ width: 'auto', padding: '8px 12px', fontSize: 13, cursor: 'pointer', colorScheme: 'dark' }}>
            {(Object.keys(APPLICANT_STATUS_LABEL) as ApplicantStatus[]).filter(st => st === a.status || (st !== 'hired' && (canDecide || st !== 'rejected'))).map(st => <option key={st} value={st}>{APPLICANT_STATUS_LABEL[st]}</option>)}
          </select>
          <Btn kind="plain" disabled={busy} onClick={() => act('rescore')}>Re-score</Btn>
          {canDecide && <Btn kind="danger" disabled={busy} onClick={() => act('status', 'archived')} style={{ marginLeft: 'auto' }}>Archive</Btn>}
        </div>

        {canDecide && (
          <div className="ap-hair" style={{ marginTop: 13, paddingTop: 13 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <p style={{ fontSize: 12.5, color: a.legalHold?.active ? '#fbbf24' : 'var(--muted)' }}>{a.legalHold?.active ? `Legal hold: ${a.legalHold.reason}` : 'No legal hold'}</p>
              <Btn kind="plain" disabled={busy} onClick={() => { if (a.legalHold?.active) { setHoldReason(null); act('legal_hold', { active: false }) } else setHoldReason(holdReason === null ? '' : null) }} aria-expanded={holdReason !== null}>
                {a.legalHold?.active ? 'Release hold' : 'Place legal hold'}
              </Btn>
            </div>
            {holdReason !== null && !a.legalHold?.active && (
              <div style={{ marginTop: 10 }}>
                <label htmlFor={`hold-${a.id}`} style={{ display: 'block', fontSize: 12, fontWeight: 650, color: 'var(--muted)', marginBottom: 6 }}>Reason for the legal hold</label>
                <input id={`hold-${a.id}`} value={holdReason} onChange={e => setHoldReason(e.target.value)} className="ap-field" />
                <div style={{ display: 'flex', gap: 8, marginTop: 9 }}>
                  <Btn kind="primary" disabled={busy || holdReason.trim().length === 0} onClick={() => { act('legal_hold', { active: true, reason: holdReason }); setHoldReason(null) }}>Place hold</Btn>
                  <Btn kind="plain" disabled={busy} onClick={() => setHoldReason(null)}>Cancel</Btn>
                </div>
              </div>
            )}
          </div>
        )}

        {canDecide && a.status === 'hired' && (
          <div className="ap-hair" style={{ marginTop: 13, paddingTop: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <p style={{ fontSize: 12.5, color: a.contractEndedAt ? '#fbbf24' : 'var(--muted)' }}>{a.contractEndedAt ? `Contract ended ${fmtTs(a.contractEndedAt)}; retention clocks are running.` : 'Contractor relationship active'}</p>
            <Btn kind="plain" disabled={busy} onClick={() => act(a.contractEndedAt ? 'reopen_contract' : 'end_contract')}>{a.contractEndedAt ? 'Reopen relationship' : 'End relationship'}</Btn>
          </div>
        )}

        {a.promotedStaffId && (
          <p className="ap-hair" style={{ marginTop: 13, paddingTop: 13, fontSize: 12.5, color: '#6ee7b7', display: 'flex', alignItems: 'center', gap: 7 }}>
            <CheckCircle2 size={14} /> Linked to crew record ·{' '}
            <Link href="/admin/operations/employees" style={{ color: 'var(--red)', textDecoration: 'none', fontWeight: 650 }}>view in Crew →</Link>
          </p>
        )}
      </Card>

      {/* Activity timeline — the applicant lifecycle (submitted → decisions → crew). */}
      {Array.isArray(a.events) && a.events.length > 0 && (
        <Card title="Activity">
          {[...a.events].reverse().map((e, i) => (
            <div key={i} className={i ? 'ap-hair' : undefined} style={{ display: 'flex', gap: 12, fontSize: 13, color: 'var(--text)', padding: '8px 0', lineHeight: 1.5 }}>
              <span className="tabular-nums" style={{ color: 'var(--muted)', minWidth: 118, flexShrink: 0, fontSize: 12 }}>{fmtTs(e.at)}</span>
              <span>{e.action}{e.note ? <span style={{ color: 'var(--muted)' }}> — {e.note}</span> : null}</span>
            </div>
          ))}
        </Card>
      )}
    </div>
  )
}

/**
 * Readiness, summary first.
 *
 * A flat list of nine components gave every row the same weight, so the score you
 * already knew was restated nine times and the one deficit that decides the hire
 * was indistinguishable from the eight that are fine. This leads with the number,
 * names only what falls short, and keeps the passing components one tap away —
 * the OS's own "calm, progressive-disclosure" rule, applied.
 */
function ReadinessCard({ score }: { score: Applicant['score'] }) {
  const [showAll, setShowAll] = useState(false)
  const pctOf = (c: { points: number; max: number }) => c.max ? Math.max(0, Math.min(1, c.points / c.max)) : 0
  const short = score.components.filter(c => pctOf(c) < 0.85)
  const met = score.components.filter(c => pctOf(c) >= 0.85)
  const tone = BAND_META[score.band].tone

  const R = 30, CIRC = 2 * Math.PI * R
  // Draw the arc in after mount so the ring reads as a measurement being taken,
  // not a static graphic. Reduced-motion users get it already drawn.
  const [drawn, setDrawn] = useState(false)
  useEffect(() => { const t = setTimeout(() => setDrawn(true), 40); return () => clearTimeout(t) }, [])

  const row = (c: { key: string; label: string; points: number; max: number }, i: number) => {
    const pct = pctOf(c)
    const fill = pct < 0.5 ? 'rgba(248,113,113,.72)' : pct < 0.85 ? 'rgba(251,191,36,.62)' : 'rgba(255,255,255,.26)'
    const lit = pct < 0.85
    return (
      <div key={c.key} style={{ marginTop: i ? 12 : 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12.5, marginBottom: 6 }}>
          <span style={{ color: lit ? 'var(--text)' : 'var(--muted)' }}>{c.label}</span>
          <span className="tabular-nums" style={{ color: lit ? 'var(--text)' : 'var(--muted)', flexShrink: 0 }}>{c.points}/{c.max}</span>
        </div>
        <div style={{ height: 3, borderRadius: 99, background: 'rgba(255,255,255,.06)', overflow: 'hidden' }}>
          <div style={{ height: '100%', borderRadius: 99, width: `${pct * 100}%`, background: fill }} />
        </div>
      </div>
    )
  }

  return (
    <section className="os-card" style={{ padding: 18, marginBottom: 14 }}>
      {/* Hero: the score itself, once, at the size its importance deserves. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ position: 'relative', width: 76, height: 76, flexShrink: 0 }}>
          <svg width="76" height="76" viewBox="0 0 76 76" role="img"
            aria-label={`Readiness score ${score.score} out of 100 — ${BAND_META[score.band].label}`}>
            <circle cx="38" cy="38" r={R} fill="none" stroke="rgba(255,255,255,.07)" strokeWidth="6" />
            <circle className="ap-ring-arc" cx="38" cy="38" r={R} fill="none" stroke={tone} strokeWidth="6" strokeLinecap="round"
              strokeDasharray={CIRC} strokeDashoffset={drawn ? CIRC * (1 - score.score / 100) : CIRC}
              transform="rotate(-90 38 38)" />
          </svg>
          <div aria-hidden style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
            <span className="tabular-nums" style={{ fontSize: 23, fontWeight: 800, letterSpacing: '-.03em', color: 'var(--text)' }}>{score.score}</span>
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontSize: 15, fontWeight: 700, color: tone, letterSpacing: '-.01em' }}>{BAND_META[score.band].label}</p>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
            {short.length === 0
              ? `All ${score.components.length} components at target.`
              : `${short.length} of ${score.components.length} component${score.components.length === 1 ? '' : 's'} below target.`}
          </p>
        </div>
      </div>

      {/* Only what needs a decision. */}
      {short.length > 0 && (
        <div className="ap-hair" style={{ marginTop: 16, paddingTop: 14 }}>
          <p style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 11 }}>Needs attention</p>
          {short.map(row)}
        </div>
      )}

      {/* Everything that is fine, one tap away rather than nine rows of noise. */}
      {met.length > 0 && (
        <div className="ap-hair" style={{ marginTop: 14, paddingTop: 12 }}>
          <button onClick={() => setShowAll(v => !v)} aria-expanded={showAll} className="ap-disclose">
            <ChevronRight size={14} className={showAll ? 'ap-chev-open' : undefined} />
            {met.length} at target
          </button>
          <div className={`os-expand${showAll ? ' open' : ''}`}>
            <div><div style={{ paddingTop: 12 }}>{met.map(row)}</div></div>
          </div>
        </div>
      )}
    </section>
  )
}

const groupLabel: React.CSSProperties = { fontSize: 11, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase' }

/**
 * Assessment signals, one card instead of three columns.
 *
 * Three equal columns stretched every box to the tallest, so a candidate with eight
 * strengths and nothing else wrong produced two large empty panels — and squeezed
 * the strengths into a 200px column where every item wrapped to three lines. Full
 * width fixes the wrapping; an empty group costs one line instead of a whole box.
 */
function Signals({ score }: { score: Applicant['score'] }) {
  const groups = [
    { key: 'strengths', label: 'Strengths', one: 'strength', many: 'strengths', items: score.strengths, tone: '#34d399' },
    { key: 'weaknesses', label: 'Weaknesses', one: 'weakness', many: 'weaknesses', items: score.weaknesses, tone: '#fbbf24' },
    { key: 'risks', label: 'Risk factors', one: 'risk factor', many: 'risk factors', items: score.riskFactors, tone: '#f87171' },
  ]
  const flagged = groups.filter(g => g.items.length > 0)
  const note = flagged.length
    ? flagged.map(g => `${g.items.length} ${g.items.length === 1 ? g.one : g.many}`).join(' · ')
    : 'Nothing flagged in either direction.'

  return (
    <Card title="Assessment signals" note={note}>
      {groups.map((g, i) => (
        <div key={g.key} className={i ? 'ap-hair' : undefined} style={{ marginTop: i ? 12 : 0, paddingTop: i ? 12 : 0 }}>
          {g.items.length === 0 ? (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
              <span style={{ ...groupLabel, color: 'var(--muted)' }}>{g.label}</span>
              <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>None flagged</span>
            </div>
          ) : (
            <>
              <p style={{ ...groupLabel, color: g.tone, marginBottom: 9 }}>{g.label}</p>
              <ul style={{ display: 'grid', gap: 7 }}>
                {g.items.map((it, j) => (
                  <li key={j} style={{ fontSize: 13, display: 'flex', gap: 9, color: 'var(--text)', lineHeight: 1.5 }}>
                    <span aria-hidden style={{ width: 5, height: 5, borderRadius: 99, background: g.tone, flexShrink: 0, marginTop: 6 }} />
                    {it}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ))}
    </Card>
  )
}
