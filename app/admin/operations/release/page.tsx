'use client'

import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, GitCommitHorizontal, Server, CalendarClock, Flag, AlertTriangle, CheckCircle2, XCircle, MinusCircle, Clock, Rocket, ShieldCheck } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { osLabel } from '../ui'

// ── Read-only Release Center ─────────────────────────────────────────────────
// Displays the current build, resolved feature-flag states, and the curated release
// snapshot from GET /api/admin/release (admin-only). READ-ONLY: the only action is a
// re-fetch. No control here deploys, rolls back, merges, or mutates anything.

type CheckState = 'passed' | 'failed' | 'skipped' | 'pending' | 'not_applicable'
type VerificationLine = { label: string; state: CheckState; note?: string }
type ReleaseEntry = {
  version: string; date: string; environment: string; summary: string
  highlights: string[]; flagChanges: string[]; migrations: string
  knownIssues: string[]; rollback: string; verification: VerificationLine[]; current?: boolean
}
type FlagView = {
  name: string; label: string; description: string; category: string
  enabled: boolean; defaultEnabled: boolean; overridden: boolean; retired: boolean
}
type BuildInfo = {
  environment: string; commitSha: string | null; commitShort: string | null
  deploymentId: string | null; deploymentUrl: string | null; deployDate: string | null; available: boolean
}
type Snapshot = {
  generatedAt: number; build: BuildInfo; current: ReleaseEntry | null; history: ReleaseEntry[]
  flags: FlagView[]; flagSummary: { total: number; enabled: number; disabled: number; overridden: number }
  migration: { state: string; headline: string; detail: string }; knownIssues: string[]
}

const CATEGORY_ORDER = ['Release Automation', 'AI & Vision', 'Book Now / Intake', 'Tenancy', 'Shadow Analytics', 'Platform']

const card: React.CSSProperties = { padding: 18 }
const dash = '—'

function Chip({ children, fg, bg }: { children: React.ReactNode; fg: string; bg: string }) {
  return <span style={{ fontSize: 11, fontWeight: 800, padding: '3px 9px', borderRadius: 99, background: bg, color: fg, whiteSpace: 'nowrap' }}>{children}</span>
}

function EnvChip({ env }: { env: string }) {
  const map: Record<string, { fg: string; bg: string }> = {
    production: { fg: '#fca5a5', bg: 'rgba(239,68,68,.16)' },
    preview: { fg: '#fcd34d', bg: 'rgba(245,158,11,.15)' },
    development: { fg: '#93c5fd', bg: 'rgba(59,130,246,.15)' },
    local: { fg: '#94a3b8', bg: 'rgba(255,255,255,.06)' },
  }
  const c = map[env] ?? map.local
  return <Chip fg={c.fg} bg={c.bg}>{env}</Chip>
}

function FlagState({ enabled }: { enabled: boolean }) {
  return enabled
    ? <Chip fg="#86efac" bg="rgba(34,197,94,.16)">ON</Chip>
    : <Chip fg="#94a3b8" bg="rgba(255,255,255,.06)">OFF</Chip>
}

const CHECK: Record<CheckState, { Icon: typeof CheckCircle2; color: string; label: string }> = {
  passed: { Icon: CheckCircle2, color: '#86efac', label: 'Passed' },
  failed: { Icon: XCircle, color: '#fca5a5', label: 'Failed' },
  skipped: { Icon: MinusCircle, color: '#94a3b8', label: 'Skipped' },
  pending: { Icon: Clock, color: '#fcd34d', label: 'Pending' },
  not_applicable: { Icon: MinusCircle, color: '#94a3b8', label: 'N/A' },
}

function Section({ title, icon: Icon, children }: { title: string; icon: typeof Flag; children: React.ReactNode }) {
  return (
    <div className="os-card os-rise" style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <Icon size={17} style={{ color: 'var(--muted)' }} />
        <h2 className="jkos-h" style={{ fontSize: 16, margin: 0 }}>{title}</h2>
      </div>
      {children}
    </div>
  )
}

function KeyVal({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
      <span style={{ ...osLabel, fontSize: 10.5 }}>{k}</span>
      <span className={mono ? 'tabular-nums' : undefined} style={{ fontSize: 13, color: 'var(--text)', fontWeight: 600, textAlign: 'right', wordBreak: 'break-word' }}>{v}</span>
    </div>
  )
}

function Bullets({ items }: { items: string[] }) {
  if (!items?.length) return <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>None.</p>
  return (
    <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
      {items.map((t, i) => <li key={i} style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.45 }}>{t}</li>)}
    </ul>
  )
}

function ReleaseCard({ r }: { r: ReleaseEntry }) {
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 17, fontWeight: 900 }}>{r.version}</span>
        <EnvChip env={r.environment} />
        <span style={{ ...osLabel, fontSize: 10.5 }}>{r.date}</span>
      </div>
      <p style={{ fontSize: 14, color: 'var(--text)', margin: 0, lineHeight: 1.5 }}>{r.summary}</p>

      <div><div style={{ ...osLabel, marginBottom: 6 }}>Highlights</div><Bullets items={r.highlights} /></div>
      <div><div style={{ ...osLabel, marginBottom: 6 }}>Feature flags</div><Bullets items={r.flagChanges} /></div>
      <div><div style={{ ...osLabel, marginBottom: 6 }}>Migrations</div><p style={{ fontSize: 13, color: 'var(--text)', margin: 0 }}>{r.migrations}</p></div>
      <div><div style={{ ...osLabel, marginBottom: 6 }}>Known issues</div><Bullets items={r.knownIssues} /></div>
      <div><div style={{ ...osLabel, marginBottom: 6 }}>Rollback</div><p style={{ fontSize: 13, color: 'var(--text)', margin: 0 }}>{r.rollback}</p></div>

      <div>
        <div style={{ ...osLabel, marginBottom: 8 }}>Verification</div>
        <div style={{ display: 'grid', gap: 6 }}>
          {r.verification.map((v, i) => {
            const c = CHECK[v.state]
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <c.Icon size={15} style={{ color: c.color, flexShrink: 0 }} />
                <span style={{ fontSize: 13, color: 'var(--text)' }}>{v.label}</span>
                <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 700, color: c.color }}>{c.label}</span>
                {v.note && <span className="hidden sm:inline" style={{ fontSize: 11.5, color: 'var(--muted)', flexBasis: '100%', paddingLeft: 24 }}>{v.note}</span>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function ReleaseCenter() {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'error' | 'forbidden'>('loading')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/admin/release', { credentials: 'same-origin' })
      if (res.status === 401 || res.status === 403) { setState('forbidden'); return }
      if (!res.ok) { setState('error'); return }
      setSnap(await res.json()); setState('ok')
    } catch { setState('error') }
    finally { setBusy(false) }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 className="jkos-h" style={{ fontSize: 24, margin: 0 }}>Release Center</h1>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: '4px 0 0' }}>Read-only build, feature-flag, and release status. No deploy or rollback controls.</p>
        </div>
        <button onClick={load} disabled={busy} className="os-tap" aria-label="Refresh"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 13px', borderRadius: 999, fontSize: 12.5, fontWeight: 700, color: 'var(--muted)', background: 'var(--card)', border: '1px solid var(--line)', cursor: 'pointer' }}>
          <RefreshCw size={14} style={{ animation: busy ? 'spin 1s linear infinite' : undefined }} /> Refresh
        </button>
      </div>

      {state === 'loading' && (
        <div className="os-card" style={{ ...card, display: 'grid', placeItems: 'center', minHeight: 120 }}>
          <div className="skeleton" style={{ width: 160, height: 14, borderRadius: 7 }} />
        </div>
      )}

      {state === 'forbidden' && (
        <Section title="Admin access required" icon={ShieldCheck}>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>The Release Center is admin-only. Sign in with an admin account to view it.</p>
        </Section>
      )}

      {state === 'error' && (
        <Section title="Couldn't load release data" icon={AlertTriangle}>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>Something went wrong fetching the snapshot. Try refreshing.</p>
        </Section>
      )}

      {state === 'ok' && snap && (
        <>
          {/* Build info — graceful when metadata is unavailable */}
          <Section title="Current build" icon={Server}>
            {!snap.build.available && (
              <p style={{ fontSize: 12.5, color: '#fcd34d', margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: 7 }}>
                <AlertTriangle size={14} /> Deployment metadata is unavailable (running outside a Vercel deployment). Showing what is known.
              </p>
            )}
            <div style={{ display: 'grid', gap: 0 }}>
              <KeyVal k="Environment" v={<EnvChip env={snap.build.environment} />} />
              <KeyVal k="Commit" mono v={snap.build.commitShort
                ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><GitCommitHorizontal size={14} style={{ color: 'var(--muted)' }} />{snap.build.commitShort}</span>
                : dash} />
              <KeyVal k="Deployment ID" mono v={snap.build.deploymentId ?? dash} />
              <KeyVal k="Deploy / release date" v={snap.build.deployDate
                ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><CalendarClock size={14} style={{ color: 'var(--muted)' }} />{snap.build.deployDate}</span>
                : dash} />
            </div>
          </Section>

          {/* Current release */}
          <Section title="Current release" icon={Rocket}>
            {snap.current ? <ReleaseCard r={snap.current} /> : <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>No release notes on record yet.</p>}
          </Section>

          {/* Feature flags */}
          <Section title="Feature flags" icon={Flag}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              <Chip fg="#86efac" bg="rgba(34,197,94,.16)">{snap.flagSummary.enabled} on</Chip>
              <Chip fg="#94a3b8" bg="rgba(255,255,255,.06)">{snap.flagSummary.disabled} off</Chip>
              <Chip fg="#fcd34d" bg="rgba(245,158,11,.15)">{snap.flagSummary.overridden} non-default</Chip>
            </div>
            <div style={{ display: 'grid', gap: 16 }}>
              {CATEGORY_ORDER.filter(cat => snap.flags.some(f => f.category === cat)).map(cat => (
                <div key={cat}>
                  <div style={{ ...osLabel, marginBottom: 8 }}>{cat}</div>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {snap.flags.filter(f => f.category === cat).map(f => (
                      <div key={f.name} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderRadius: 12, background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 13.5, fontWeight: 700 }}>{f.label}</span>
                            {f.retired && <Chip fg="#fca5a5" bg="rgba(239,68,68,.16)">retired</Chip>}
                            {f.overridden && !f.retired && <Chip fg="#fcd34d" bg="rgba(245,158,11,.15)">non-default</Chip>}
                          </div>
                          <p style={{ fontSize: 12, color: 'var(--muted)', margin: '3px 0 0', lineHeight: 1.4 }}>{f.description}</p>
                          <p className="tabular-nums" style={{ fontSize: 10.5, color: 'var(--muted)', margin: '4px 0 0', opacity: .7 }}>{f.name} · default {f.defaultEnabled ? 'ON' : 'OFF'}</p>
                        </div>
                        <FlagState enabled={f.enabled} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Section>

          {/* Migration status */}
          <Section title="Migration status" icon={GitCommitHorizontal}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
              <CheckCircle2 size={16} style={{ color: snap.migration.state === 'none_pending' ? '#86efac' : '#fcd34d' }} />
              <span style={{ fontSize: 14, fontWeight: 700 }}>{snap.migration.headline}</span>
            </div>
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0, lineHeight: 1.5 }}>{snap.migration.detail}</p>
          </Section>

          {/* Standing known issues */}
          <Section title="Known issues & notes" icon={AlertTriangle}>
            <Bullets items={snap.knownIssues} />
          </Section>

          {/* History */}
          {snap.history.length > 0 && (
            <Section title="Earlier releases" icon={Clock}>
              <div style={{ display: 'grid', gap: 20 }}>
                {snap.history.map((r, i) => <ReleaseCard key={i} r={r} />)}
              </div>
            </Section>
          )}

          <p style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', margin: '4px 0 0' }}>
            Snapshot generated {new Date(snap.generatedAt).toLocaleString()} · read-only
          </p>
        </>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}

export default function ReleaseCenterPage() {
  return <OperationsShell><ReleaseCenter /></OperationsShell>
}
