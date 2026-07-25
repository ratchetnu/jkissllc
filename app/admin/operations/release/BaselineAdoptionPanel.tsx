'use client'

import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, ChevronDown, Loader2, ShieldCheck } from 'lucide-react'

type BaselineSource = 'installed_by_release' | 'adopted' | 'unknown'
type DryRun = {
  verdict: 'safe_to_adopt' | 'needs_review' | 'insufficient_evidence'
  proposedVersion?: string
  missingEvidence: string[]
  conflicts: string[]
  approvalToken?: string
}

type BaselineState = {
  baseline: {
    currentVersion: string | null
    deployedCommit: string | null
    confirmationPhrase: string
  }
}

const field: React.CSSProperties = {
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  borderRadius: 10,
  border: '1px solid var(--line)',
  background: 'color-mix(in srgb, var(--card) 88%, #000)',
  color: 'var(--text)',
  padding: '10px 11px',
  fontSize: 13,
}

const label: React.CSSProperties = {
  display: 'grid',
  gap: 5,
  minWidth: 0,
  color: 'var(--muted)',
  fontSize: 11.5,
  fontWeight: 700,
}

function parseFlags(value: string): Record<string, boolean> {
  const flags: Record<string, boolean> = {}
  for (const line of value.split(/\n|,/)) {
    const [rawName, rawState] = line.split('=')
    const name = rawName?.trim()
    const state = rawState?.trim().toLowerCase()
    if (name && (state === 'true' || state === 'false')) flags[name] = state === 'true'
  }
  return flags
}

export function BaselineAdoptionPanel({
  businessId,
  businessName,
  baselineSource,
  onAdopted,
}: {
  businessId: string
  businessName: string
  baselineSource: BaselineSource
  onAdopted: () => void
}) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<BaselineState | null>(null)
  const [version, setVersion] = useState('')
  const [commit, setCommit] = useState('')
  const [manifestHash, setManifestHash] = useState('')
  const [capabilities, setCapabilities] = useState('')
  const [schemaState, setSchemaState] = useState<'unknown' | 'verified' | 'not_applicable'>('unknown')
  const [schemaEvidence, setSchemaEvidence] = useState('')
  const [flagsAssessed, setFlagsAssessed] = useState(false)
  const [flags, setFlags] = useState('')
  const [deploymentReference, setDeploymentReference] = useState('')
  const [healthReference, setHealthReference] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [dryRun, setDryRun] = useState<DryRun | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || state) return
    let live = true
    fetch(`/api/admin/release/businesses/${businessId}/baseline-adoption`, { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Starting-point details could not be loaded.')
        return response.json()
      })
      .then((result: BaselineState) => {
        if (!live) return
        setState(result)
        setCommit(result.baseline.deployedCommit ?? '')
      })
      .catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : 'Something went wrong.') })
    return () => { live = false }
  }, [businessId, open, state])

  const evidence = useMemo(() => ({
    proposedVersion: version,
    deployedCommit: commit,
    capabilityManifestHash: manifestHash,
    capabilities: capabilities.split(',').map((value) => value.trim()).filter(Boolean)
      .map((id) => ({ id, evidence: 'Confirmed in the reviewed capability record' })),
    schemaMigrationState: {
      state: schemaState,
      evidence: schemaEvidence,
    },
    relevantFlagState: {
      assessed: flagsAssessed,
      flags: parseFlags(flags),
    },
    verificationEvidence: [
      ...(deploymentReference.trim()
        ? [{ kind: 'production_deployment', reference: deploymentReference.trim() }]
        : []),
      ...(healthReference.trim()
        ? [{ kind: 'health_check', reference: healthReference.trim() }]
        : []),
    ],
  }), [
    capabilities, commit, deploymentReference, flags, flagsAssessed, healthReference,
    manifestHash, schemaEvidence, schemaState, version,
  ])

  function invalidateCheck() {
    if (dryRun) setDryRun(null)
    if (confirmation) setConfirmation('')
  }

  async function checkEvidence() {
    setBusy(true)
    setError('')
    setDryRun(null)
    try {
      const response = await fetch(`/api/admin/release/businesses/${businessId}/baseline-adoption`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dry_run', evidence }),
      })
      const result = await response.json()
      if (!response.ok && !result?.dryRun) throw new Error(result?.error || 'The evidence check could not be completed.')
      setDryRun(result.dryRun)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The evidence check could not be completed.')
    } finally {
      setBusy(false)
    }
  }

  async function adopt() {
    if (!dryRun?.approvalToken || !state) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/admin/release/businesses/${businessId}/baseline-adoption`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'adopt',
          evidence,
          approvalToken: dryRun.approvalToken,
          confirmationPhrase: confirmation,
        }),
      })
      const result = await response.json()
      if (!response.ok || !result?.ok) throw new Error(result?.error || 'The starting point was not saved.')
      onAdopted()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The starting point was not saved.')
    } finally {
      setBusy(false)
    }
  }

  if (baselineSource === 'installed_by_release') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#86efac', fontSize: 12.5 }}>
        <CheckCircle2 size={15} /> Starting version verified by an Operion release.
      </div>
    )
  }
  if (baselineSource === 'adopted') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#93c5fd', fontSize: 12.5 }}>
        <ShieldCheck size={15} /> Starting version verified from approved production evidence.
      </div>
    )
  }

  const phrase = state?.baseline.confirmationPhrase ?? ''
  const safe = dryRun?.verdict === 'safe_to_adopt' && !!dryRun.approvalToken

  return (
    <div style={{ border: '1px solid rgba(245,158,11,.28)', borderRadius: 12, overflow: 'hidden', background: 'rgba(245,158,11,.05)' }}>
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}
        style={{ width: '100%', minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '12px 13px', border: 0, color: 'var(--text)', background: 'transparent', cursor: 'pointer', textAlign: 'left' }}>
        <ShieldCheck size={17} style={{ color: '#fcd34d', flex: '0 0 auto' }} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <strong style={{ display: 'block', fontSize: 13 }}>Verify the starting version</strong>
          <span style={{ display: 'block', marginTop: 2, color: 'var(--muted)', fontSize: 11.5, lineHeight: 1.4 }}>
            {businessName} existed before Operion started tracking releases.
          </span>
        </span>
        <ChevronDown size={16} style={{ color: 'var(--muted)', transform: open ? 'rotate(180deg)' : undefined }} />
      </button>

      {open && (
        <div style={{ borderTop: '1px solid rgba(245,158,11,.2)', padding: 13, display: 'grid', gap: 12 }}>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
            Record the version already running in Production. Operion will check the evidence without changing the site.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 210px), 1fr))', gap: 10 }}>
            <label style={label}>Starting version
              <input value={version} onChange={(event) => { setVersion(event.target.value); invalidateCheck() }} placeholder="1.0.0" style={field} />
            </label>
            <label style={label}>Production commit
              <input value={commit} onChange={(event) => { setCommit(event.target.value); invalidateCheck() }} placeholder="Verified commit ID" style={field} />
            </label>
          </div>

          <label style={label}>Capabilities confirmed
            <textarea value={capabilities} onChange={(event) => { setCapabilities(event.target.value); invalidateCheck() }}
              placeholder="booking, scheduling, crew portal" rows={2} style={{ ...field, resize: 'vertical' }} />
          </label>

          <details>
            <summary style={{ color: 'var(--muted)', fontSize: 11.5, fontWeight: 700, cursor: 'pointer' }}>Evidence details</summary>
            <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
              <label style={label}>Capability record fingerprint
                <input value={manifestHash} onChange={(event) => { setManifestHash(event.target.value); invalidateCheck() }}
                  placeholder="SHA-256 fingerprint" style={field} />
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 210px), 1fr))', gap: 10 }}>
                <label style={label}>Data setup
                  <select value={schemaState} onChange={(event) => { setSchemaState(event.target.value as typeof schemaState); invalidateCheck() }} style={field}>
                    <option value="unknown">Not checked</option>
                    <option value="verified">Verified</option>
                    <option value="not_applicable">Not applicable</option>
                  </select>
                </label>
                <label style={label}>Data setup evidence
                  <input value={schemaEvidence} onChange={(event) => { setSchemaEvidence(event.target.value); invalidateCheck() }} placeholder="Migration or review reference" style={field} />
                </label>
              </div>
              <label style={{ ...label, display: 'flex', gridTemplateColumns: undefined, alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={flagsAssessed} onChange={(event) => { setFlagsAssessed(event.target.checked); invalidateCheck() }} />
                Feature settings were reviewed
              </label>
              <label style={label}>Feature settings (optional)
                <textarea value={flags} onChange={(event) => { setFlags(event.target.value); invalidateCheck() }}
                  placeholder={'BOOKING_ENABLED=true\nLEGACY_MODE=false'} rows={2} style={{ ...field, resize: 'vertical' }} />
              </label>
              <label style={label}>Production deployment evidence
                <input value={deploymentReference} onChange={(event) => { setDeploymentReference(event.target.value); invalidateCheck() }} placeholder="Deployment ID or reviewed record" style={field} />
              </label>
              <label style={label}>Production health evidence
                <input value={healthReference} onChange={(event) => { setHealthReference(event.target.value); invalidateCheck() }} placeholder="Health check or smoke-test record" style={field} />
              </label>
            </div>
          </details>

          <button type="button" onClick={checkEvidence} disabled={busy}
            style={{ justifySelf: 'start', display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 13px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--text)', fontSize: 12.5, fontWeight: 800, cursor: busy ? 'default' : 'pointer', opacity: busy ? .65 : 1 }}>
            {busy && <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />}
            Check evidence
          </button>

          {dryRun && (
            <div role="status" style={{ borderRadius: 10, padding: 11, background: safe ? 'rgba(34,197,94,.09)' : 'rgba(239,68,68,.08)', border: `1px solid ${safe ? 'rgba(34,197,94,.25)' : 'rgba(239,68,68,.22)'}` }}>
              <strong style={{ fontSize: 12.5, color: safe ? '#86efac' : '#fca5a5' }}>
                {safe ? 'Evidence is ready for approval.' : dryRun.verdict === 'needs_review' ? 'A conflict needs review.' : 'More evidence is needed.'}
              </strong>
              {[...dryRun.missingEvidence, ...dryRun.conflicts].length > 0 && (
                <ul style={{ margin: '7px 0 0', paddingLeft: 18, color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>
                  {[...dryRun.missingEvidence, ...dryRun.conflicts].map((item) => <li key={item}>{item}</li>)}
                </ul>
              )}
            </div>
          )}

          {safe && (
            <div style={{ display: 'grid', gap: 8 }}>
              <p style={{ margin: 0, color: 'var(--muted)', fontSize: 11.5, lineHeight: 1.45 }}>
                To approve this starting point, type <strong style={{ color: 'var(--text)', overflowWrap: 'anywhere' }}>{phrase}</strong>.
              </p>
              <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} aria-label="Confirmation phrase" style={field} />
              <button type="button" onClick={adopt} disabled={busy || confirmation !== phrase}
                style={{ justifySelf: 'start', padding: '9px 13px', borderRadius: 10, border: 0, background: '#2563eb', color: '#fff', fontSize: 12.5, fontWeight: 800, cursor: busy || confirmation !== phrase ? 'default' : 'pointer', opacity: busy || confirmation !== phrase ? .5 : 1 }}>
                Save verified starting point
              </button>
            </div>
          )}

          {error && <p role="alert" style={{ margin: 0, color: '#fca5a5', fontSize: 12 }}>{error}</p>}
        </div>
      )}
    </div>
  )
}
