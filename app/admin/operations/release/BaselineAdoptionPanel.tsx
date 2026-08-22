'use client'

// ── Recording a starting version, for a non-technical owner ─────────────────
//
// The previous form asked for a production commit, a capability manifest SHA-256, a
// schema state, a flag assessment and two verification references. An owner cannot
// know any of that, and the one field it pre-filled — the commit — came from the
// stored record, which is stale for anything deployed outside the pipeline. It
// therefore offered to record the WRONG commit as permanent provenance.
//
// Operion reads all of it now. The owner makes one decision (where numbering starts),
// reads a summary in plain language, and confirms. Hashes and raw diagnostics live
// under "Technical details" — available, never in the way.

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, HelpCircle, Loader2, RefreshCw, ShieldCheck, XCircle } from 'lucide-react'

type BaselineSource = 'installed_by_release' | 'adopted' | 'unknown'
type EvidenceStatus = 'ok' | 'missing' | 'contradictory'
type EvidenceSource = 'provider_verified' | 'repository_derived' | 'owner_attested' | 'unresolved'
type EvidenceItem = { id: string; label: string; status: EvidenceStatus; source: EvidenceSource; detail: string; action?: string; technical?: string; attestable?: boolean; warning?: boolean }
type VersionChoice = { id: string; version?: string; label: string; meaning: string; pickWhen: string }

type EvidenceReport = {
  ok: boolean
  items: EvidenceItem[]
  verifiedAt: number
  live?: { fullCommit: string; deploymentId: string; deployedAt?: number; url?: string }
  repo?: { owner: string; name: string; branch: string }
  capabilities: { id: string; evidence: string }[]
  capabilityManifestHash?: string
  schemaMigrationState: { state: string; evidence?: string }
  attestable: string[]
  attested: string[]
  summary: { ok: boolean; missing: number; contradictory: number; warnings: number; headline: string }
}

type DryRun = { verdict: string; proposedVersion?: string; missingEvidence: string[]; conflicts: string[]; approvalToken?: string }
type BaselineState = {
  baseline: {
    currentVersion: string | null
    confirmationPhrase: string
    startingVersionChoices: VersionChoice[]
    allowPrerelease: boolean
  }
}

const field: React.CSSProperties = {
  width: '100%', minWidth: 0, boxSizing: 'border-box', borderRadius: 10,
  border: '1px solid var(--line)', background: 'color-mix(in srgb, var(--card) 88%, #000)',
  color: 'var(--text)', padding: '10px 11px', fontSize: 13,
}
const mono: React.CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }

/** Where a fact came from — shown on every established item, so "we measured this" and
 *  "you told us this" never read the same. */
const SOURCE_LABEL: Record<EvidenceSource, string> = {
  provider_verified: 'Checked directly',
  repository_derived: 'Worked out from the code that is live',
  owner_attested: 'Your confirmation — Operion could not check this itself',
  unresolved: '',
}

const TONE: Record<EvidenceStatus, { color: string; Icon: typeof CheckCircle2 }> = {
  ok: { color: '#34d399', Icon: CheckCircle2 },
  missing: { color: '#fbbf24', Icon: HelpCircle },
  contradictory: { color: '#f87171', Icon: AlertTriangle },
}

function EvidenceRow({ item }: { item: EvidenceItem }) {
  const { color, Icon } = item.warning
    ? { color: '#fbbf24', Icon: AlertTriangle }
    : TONE[item.status]
  return (
    <li style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '8px 0', borderTop: '1px solid var(--line)' }}>
      <Icon size={15} style={{ color, flexShrink: 0, marginTop: 2 }} aria-hidden />
      <div style={{ minWidth: 0 }}>
        <p style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>{item.label}</p>
        <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '2px 0 0', lineHeight: 1.5 }}>{item.detail}</p>
        {item.status === 'ok' && (
          <p style={{ fontSize: 11, color: item.source === 'owner_attested' ? '#fcd34d' : 'var(--muted)', margin: '3px 0 0', opacity: item.source === 'owner_attested' ? 1 : 0.75 }}>
            {SOURCE_LABEL[item.source]}
          </p>
        )}
        {item.action && (
          <p style={{ fontSize: 12.5, margin: '4px 0 0', lineHeight: 1.5, color: item.status === 'contradictory' ? '#fca5a5' : '#fcd34d' }}>
            <strong>What to do:</strong> {item.action}
          </p>
        )}
      </div>
    </li>
  )
}

export function BaselineAdoptionPanel({
  businessId, businessName, baselineSource, onAdopted,
}: {
  businessId: string; businessName: string; baselineSource: BaselineSource; onAdopted: () => void
}) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<BaselineState | null>(null)
  const [choice, setChoice] = useState<string>('')          // deliberately no default
  const [customVersion, setCustomVersion] = useState('')
  const [report, setReport] = useState<EvidenceReport | null>(null)
  const [dryRun, setDryRun] = useState<DryRun | null>(null)
  const [versionError, setVersionError] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [stage, setStage] = useState<'choose' | 'confirm'>('choose')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showTechnical, setShowTechnical] = useState(false)
  const [attestSchema, setAttestSchema] = useState(false)
  const [capNote, setCapNote] = useState('')
  // The phrase ESCALATES when a fact is attested, so it comes from the check response —
  // the GET cannot know what the owner will attest to.
  const [phrase, setPhrase] = useState('')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/admin/release/businesses/${businessId}/baseline-adoption`, { credentials: 'same-origin' })
        const result = await res.json()
        if (!cancelled && result?.baseline) setState(result)
      } catch { /* fail-soft */ }
    })()
    return () => { cancelled = true }
  }, [businessId, open])

  // Any change to the decision invalidates a completed check — the owner must not be
  // able to confirm a version that was never checked against the evidence.
  const invalidate = useCallback(() => { setReport(null); setDryRun(null); setStage('choose'); setConfirmation('') }, [])

  async function checkEvidence() {
    setBusy(true); setError(''); setVersionError('')
    try {
      const res = await fetch(`/api/admin/release/businesses/${businessId}/baseline-adoption`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'check_evidence', startingVersionChoice: choice, customVersion, attestations: { schema: attestSchema } }),
      })
      const result = await res.json()
      if (!res.ok) { setError(result?.error ?? 'Could not check the evidence.'); return }
      setReport(result.evidence ?? null)
      setPhrase(typeof result.confirmationPhrase === 'string' ? result.confirmationPhrase : '')
      setDryRun(result.dryRun ?? null)
      if (result.versionChoice && !result.versionChoice.ok) setVersionError(result.versionChoice.detail ?? '')
      if (result.ok) setStage('confirm')
    } catch { setError('Could not reach Operion to check the evidence.') }
    finally { setBusy(false) }
  }

  async function adopt() {
    if (!dryRun?.approvalToken || !report?.live) return
    setBusy(true); setError('')
    try {
      const res = await fetch(`/api/admin/release/businesses/${businessId}/baseline-adoption`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        // No evidence is sent. The server re-reads it at write time and binds the
        // receipt to a digest of what it found, so evidence that moved since the check
        // is rejected rather than replayed.
        body: JSON.stringify({
          action: 'adopt',
          approvalToken: dryRun.approvalToken,
          confirmationPhrase: confirmation,
          startingVersionChoice: choice,
          customVersion,
          attestations: { schema: attestSchema },
        }),
      })
      const result = await res.json()
      if (!res.ok || !result.ok) { setError(result?.error ?? 'Could not record the starting version.'); return }
      setOpen(false); onAdopted()
    } catch { setError('Could not reach Operion to record the starting version.') }
    finally { setBusy(false) }
  }

  if (baselineSource !== 'unknown') return null
  const choices = state?.baseline.startingVersionChoices ?? []
  const chosen = choices.find((c) => c.id === choice)
  const resolvedVersion = dryRun?.proposedVersion ?? chosen?.version ?? customVersion

  return (
    <div style={{ marginTop: 12 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 0, color: '#a5b4fc', fontSize: 13, fontWeight: 700, cursor: 'pointer', padding: 0 }}
      >
        <ShieldCheck size={15} aria-hidden />
        Record a starting version for {businessName}
        <ChevronDown size={14} style={{ transform: open ? 'rotate(180deg)' : undefined }} aria-hidden />
      </button>

      {open && (
        <div style={{ marginTop: 10, display: 'grid', gap: 14 }}>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55, margin: 0 }}>
            {businessName} is running, but has no version number recorded. Choose where numbering should start —
            Operion will check everything else itself, and show you what it found before anything is saved.
          </p>

          {/* ── 1. The one decision ─────────────────────────────────────── */}
          <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            <legend style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', padding: 0 }}>Where should numbering start?</legend>
            {choices.map((c) => (
              <label key={c.id} style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: 10, borderRadius: 10, cursor: 'pointer', border: `1px solid ${choice === c.id ? 'rgba(129,140,248,.5)' : 'var(--line)'}`, background: choice === c.id ? 'rgba(129,140,248,.08)' : 'transparent' }}>
                <input
                  type="radio" name={`starting-version-${businessId}`} value={c.id} checked={choice === c.id}
                  onChange={() => { setChoice(c.id); invalidate() }}
                  style={{ marginTop: 3, flexShrink: 0 }}
                />
                <span style={{ minWidth: 0 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700, display: 'block' }}>{c.label}</span>
                  <span style={{ fontSize: 12.5, color: 'var(--muted)', display: 'block', marginTop: 2, lineHeight: 1.5 }}>{c.meaning}</span>
                  <span style={{ fontSize: 12.5, color: 'var(--muted)', display: 'block', marginTop: 3, lineHeight: 1.5, fontStyle: 'italic' }}>{c.pickWhen}</span>
                </span>
              </label>
            ))}
            {choice === 'custom' && (
              <label style={{ display: 'grid', gap: 5, fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}>
                Version number
                <input
                  value={customVersion} onChange={(e) => { setCustomVersion(e.target.value); invalidate() }}
                  placeholder="2.3.0" style={field} aria-label="Starting version number"
                />
              </label>
            )}
            {versionError && <p role="alert" style={{ fontSize: 12.5, color: '#fca5a5', margin: 0 }}>{versionError}</p>}
          </fieldset>

          {/* ── 2. Check ────────────────────────────────────────────────── */}
          <div>
            <button
              onClick={checkEvidence} disabled={busy || !choice}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--text)', padding: '9px 14px', fontSize: 13, fontWeight: 700, cursor: busy || !choice ? 'not-allowed' : 'pointer', opacity: busy || !choice ? 0.6 : 1 }}
            >
              {busy ? <Loader2 size={14} className="spin" aria-hidden /> : <RefreshCw size={14} aria-hidden />}
              Check evidence
            </button>
            <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '6px 0 0', lineHeight: 1.5 }}>
              Reads the live site and the connected repository. Nothing is saved by checking.
            </p>
          </div>

          {error && <p role="alert" style={{ fontSize: 12.5, color: '#fca5a5', margin: 0 }}>{error}</p>}

          {/* ── 3. What Operion found ───────────────────────────────────── */}
          {report && (
            <div>
              <p style={{ fontSize: 13, fontWeight: 700, margin: '0 0 2px', color: report.ok && !report.summary.warnings ? '#34d399' : report.summary.contradictory ? '#f87171' : '#fbbf24' }}>
                {report.summary.headline}
              </p>
              <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0 0' }}>
                {report.items.map((i) => <EvidenceRow key={i.id} item={i} />)}
              </ul>

              {report.attestable.includes('schema') && (
                <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', marginTop: 10, padding: 10, borderRadius: 10, border: '1px solid rgba(251,191,36,.35)', background: 'rgba(251,191,36,.07)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={attestSchema} onChange={(e) => { setAttestSchema(e.target.checked); invalidate() }} style={{ marginTop: 3, flexShrink: 0 }} />
                  <span style={{ fontSize: 12.5, lineHeight: 1.55 }}>
                    <strong>I confirm this myself.</strong> Operion cannot check whether this site’s data changes were
                    applied. Ticking this records it on your word, marked as unverified, and you will be asked to type a
                    different confirmation phrase because of it.
                  </span>
                </label>
              )}
              {report.items.some((i) => i.id === 'capabilities' && i.status !== 'ok') && (
                <div style={{ marginTop: 10, padding: 10, borderRadius: 10, border: '1px solid var(--line)' }}>
                  <p style={{ fontSize: 12.5, margin: 0, lineHeight: 1.55 }}>
                    Operion has not recorded which features {businessName} is running. That is a one-time step, and it is
                    separate from this check — it records today’s effective settings and turns nothing on.
                  </p>
                  <button
                    onClick={async () => {
                      setBusy(true); setCapNote('')
                      try {
                        const res = await fetch(`/api/admin/release/businesses/${businessId}/baseline-adoption`, {
                          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ action: 'initialize_capabilities' }),
                        })
                        const r = await res.json()
                        setCapNote(r?.message ?? 'Done.'); invalidate()
                      } catch { setCapNote('Could not record the features.') }
                      finally { setBusy(false) }
                    }}
                    disabled={busy}
                    style={{ marginTop: 8, fontSize: 12.5, fontWeight: 700, padding: '7px 12px', borderRadius: 9, color: 'var(--text)', background: 'transparent', border: '1px solid var(--line)', cursor: busy ? 'not-allowed' : 'pointer' }}
                  >
                    Record today’s features
                  </button>
                  {capNote && <p style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 0 0' }}>{capNote}</p>}
                </div>
              )}

              <button
                onClick={() => setShowTechnical((v) => !v)} aria-expanded={showTechnical}
                style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 0, color: 'var(--muted)', fontSize: 11.5, fontWeight: 700, cursor: 'pointer', padding: '9px 0 0' }}
              >
                <ChevronDown size={13} style={{ transform: showTechnical ? 'rotate(180deg)' : undefined }} aria-hidden />
                Technical details
              </button>
              {showTechnical && (
                <div style={{ marginTop: 6, padding: 10, borderRadius: 8, background: 'color-mix(in srgb, var(--card) 88%, #000)', overflowX: 'auto' }}>
                  {report.items.filter((i) => i.technical).map((i) => (
                    <p key={i.id} style={{ ...mono, color: 'var(--muted)', margin: '0 0 4px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                      {i.id}: {i.technical}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── 4. Confirm ──────────────────────────────────────────────── */}
          {stage === 'confirm' && report?.ok && report.live && (
            <div style={{ padding: 12, borderRadius: 10, border: '1px solid rgba(52,211,153,.35)', background: 'rgba(52,211,153,.06)' }}>
              <p style={{ fontSize: 14, fontWeight: 800, margin: '0 0 8px' }}>Ready to record</p>
              {report.attested.length > 0 && (
                <p style={{ fontSize: 12.5, color: '#fcd34d', margin: '0 0 8px', lineHeight: 1.55 }}>
                  <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 5 }} aria-hidden />
                  Part of this baseline rests on your confirmation rather than on something Operion measured. That is
                  recorded permanently alongside it.
                </p>
              )}
              <dl style={{ margin: 0, display: 'grid', gap: 6 }}>
                {[
                  ['Starting version', `v${resolvedVersion}`],
                  ['Live commit', `${report.live.fullCommit.slice(0, 12)}…`],
                  ['Production deployment', report.live.deploymentId],
                  ['Verified', new Date(report.verifiedAt).toISOString().slice(0, 10)],
                  ['Features detected', report.capabilities.map((c) => c.id).join(', ') || 'none'],
                  ['Data structure', report.schemaMigrationState.state === 'verified' ? 'Up to date' : 'Not applicable'],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <dt style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 700, minWidth: 150 }}>{k}</dt>
                    <dd style={{ ...(k === 'Starting version' ? {} : mono), margin: 0, fontSize: 12.5, wordBreak: 'break-all', minWidth: 0 }}>{v}</dd>
                  </div>
                ))}
              </dl>
              <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '10px 0 0', lineHeight: 1.55 }}>
                Recording this <strong>does not deploy anything and does not change the site</strong>. It only tells
                Operion which version {businessName} is on today, so future updates can be numbered from it.
              </p>
              <label style={{ display: 'grid', gap: 5, fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', marginTop: 10 }}>
                Type <span style={mono}>{phrase || state?.baseline.confirmationPhrase}</span> to confirm
                <input
                  value={confirmation} onChange={(e) => setConfirmation(e.target.value)}
                  style={field} aria-label="Confirmation phrase"
                />
              </label>
              <button
                onClick={adopt}
                disabled={busy || !phrase || confirmation !== phrase}
                style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 7, borderRadius: 10, border: 0, background: '#e11d48', color: '#fff', padding: '10px 16px', fontSize: 13, fontWeight: 800, cursor: busy || confirmation !== phrase ? 'not-allowed' : 'pointer', opacity: busy || confirmation !== phrase ? 0.55 : 1 }}
              >
                {busy ? <Loader2 size={14} className="spin" aria-hidden /> : <CheckCircle2 size={14} aria-hidden />}
                Record v{resolvedVersion} as the starting version
              </button>
            </div>
          )}

          {report && !report.ok && (
            <p style={{ display: 'flex', gap: 7, alignItems: 'flex-start', fontSize: 12.5, color: 'var(--muted)', margin: 0, lineHeight: 1.55 }}>
              <XCircle size={14} style={{ color: '#f87171', flexShrink: 0, marginTop: 2 }} aria-hidden />
              A starting version can only be recorded once everything above checks out — otherwise Operion would be
              recording something it could not verify.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
