'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, FileStack,
  Loader2, PackageCheck, Plus, RefreshCw, ShieldCheck,
} from 'lucide-react'
import { osField, osLabel } from '../ui'

type BaselineSource = 'installed_by_release' | 'adopted' | 'unknown'
type PackageStatus = 'draft' | 'blocked' | 'ready_for_approval' | 'cancelled' | 'superseded'
type ProductOption = {
  id: string
  name: string
  currentVersion: string | null
  baselineSource: BaselineSource
}
type UpdateOption = {
  key: string
  title: string
  summary: string
  status: string
  breakingChange: boolean
  migrationRequired: boolean
  eligible: boolean
  reasons: string[]
}
type ReleasePackage = {
  id: string
  targetProduct: string
  proposedVersion: string
  channel: 'internal' | 'alpha' | 'beta' | 'stable' | 'lts'
  classification: string
  breakingChange: boolean
  migration: 'none' | 'compatible' | 'incompatible'
  updateKeys: string[]
  name?: string
  releaseNotes?: string
  status: PackageStatus
  blockingReasons: string[]
  createdAt: number
  updatedAt: number
}
type Catalog = {
  packages: ReleasePackage[]
  products: ProductOption[]
  updates: UpdateOption[]
}
type Readiness = {
  ok: boolean
  blockers: string[]
  normalizedVersion?: string
}

const surface: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 16,
  background: 'color-mix(in srgb, var(--card) 92%, transparent)',
}
const primary: React.CSSProperties = {
  minHeight: 42,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: '9px 15px',
  border: '1px solid transparent',
  borderRadius: 11,
  color: '#fff',
  background: 'var(--red)',
  fontSize: 13,
  fontWeight: 750,
  cursor: 'pointer',
}
const secondary: React.CSSProperties = {
  ...primary,
  color: 'var(--text)',
  background: 'transparent',
  borderColor: 'var(--line)',
}
const fieldLabel: React.CSSProperties = {
  display: 'grid',
  gap: 6,
  minWidth: 0,
  color: 'var(--muted)',
  fontSize: 12,
  fontWeight: 700,
}

const STATUS: Record<PackageStatus, { label: string; color: string; background: string }> = {
  draft: { label: 'Draft', color: '#93c5fd', background: 'rgba(59,130,246,.14)' },
  blocked: { label: 'Needs attention', color: '#fcd34d', background: 'rgba(245,158,11,.14)' },
  ready_for_approval: { label: 'Ready for approval', color: '#86efac', background: 'rgba(34,197,94,.14)' },
  cancelled: { label: 'Cancelled', color: '#94a3b8', background: 'rgba(255,255,255,.06)' },
  superseded: { label: 'Replaced', color: '#94a3b8', background: 'rgba(255,255,255,.06)' },
}

const CLASSIFICATIONS = [
  ['fix', 'Fix', 'Corrects existing behavior'],
  ['ui', 'Design update', 'Changes presentation or usability'],
  ['tests', 'Test coverage', 'Strengthens automated verification'],
  ['observability', 'Monitoring', 'Improves visibility and alerts'],
  ['documentation', 'Documentation', 'Updates guidance or operating instructions'],
  ['capability', 'New capability', 'Adds something customers or staff can do'],
  ['workflow', 'Workflow change', 'Changes how work moves through the system'],
  ['breaking', 'Breaking change', 'Requires coordinated adoption'],
] as const

function StatusPill({ status }: { status: PackageStatus }) {
  const view = STATUS[status]
  return (
    <span style={{ padding: '4px 9px', borderRadius: 999, color: view.color, background: view.background, fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap' }}>
      {view.label}
    </span>
  )
}

function friendlyReason(reason: string): string {
  if (reason.includes('installed version has no verified provenance')) return 'Verify this customer’s current version before creating a release.'
  if (reason.includes('baseline is required') || reason.includes('baseline_required')) return 'A verified starting version is required.'
  if (reason.includes('tests not passed')) return 'One or more updates still need passing tests.'
  if (reason.includes('build not passed')) return 'One or more updates still need a successful build.'
  if (reason.includes('duplicate')) return 'That version is already in use by another active package.'
  if (reason.includes('major')) return 'This change requires a major version increase.'
  if (reason.includes('minor')) return 'This change requires a minor version increase.'
  if (reason.includes('semantic version')) return 'Enter a complete version such as 1.2.0.'
  return reason.charAt(0).toUpperCase() + reason.slice(1)
}

function stepTitle(step: number): string {
  if (step === 1) return 'Choose what ships'
  if (step === 2) return 'Describe the release'
  return 'Review the package'
}

export function ReleasePackageBuilder() {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [step, setStep] = useState(1)
  const [productId, setProductId] = useState('')
  const [selectedUpdates, setSelectedUpdates] = useState<string[]>([])
  const [version, setVersion] = useState('')
  const [channel, setChannel] = useState<ReleasePackage['channel']>('stable')
  const [classification, setClassification] = useState('capability')
  const [migration, setMigration] = useState<ReleasePackage['migration']>('none')
  const [breakingChange, setBreakingChange] = useState(false)
  const [name, setName] = useState('')
  const [releaseNotes, setReleaseNotes] = useState('')
  const [activePackage, setActivePackage] = useState<ReleasePackage | null>(null)
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/admin/platform/releases', { credentials: 'same-origin' })
      const result = await response.json().catch(() => null)
      if (!response.ok || !result) throw new Error(result?.error || 'Release packages could not be loaded.')
      setCatalog(result)
      setProductId((current) => current || result.products?.[0]?.id || '')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Release packages could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const product = useMemo(
    () => catalog?.products.find((item) => item.id === productId) ?? null,
    [catalog, productId],
  )
  const eligibleCount = catalog?.updates.filter((item) => item.eligible).length ?? 0

  function toggleUpdate(key: string) {
    setSelectedUpdates((current) => current.includes(key)
      ? current.filter((item) => item !== key)
      : [...current, key])
  }

  function resetBuilder() {
    setStep(1)
    setSelectedUpdates([])
    setVersion('')
    setChannel('stable')
    setClassification('capability')
    setMigration('none')
    setBreakingChange(false)
    setName('')
    setReleaseNotes('')
    setActivePackage(null)
    setReadiness(null)
    setError('')
  }

  async function saveDraft() {
    if (!productId || !version.trim() || selectedUpdates.length === 0) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/admin/platform/releases', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetProduct: productId,
          proposedVersion: version,
          channel,
          classification,
          migration,
          breakingChange,
          updateKeys: selectedUpdates,
          name,
          releaseNotes,
        }),
      })
      const result = await response.json().catch(() => null)
      if (!response.ok || !result?.package) throw new Error(result?.error || 'The draft could not be saved.')
      setActivePackage(result.package)
      setCatalog((current) => current
        ? { ...current, packages: [result.package, ...current.packages] }
        : current)
      setReadiness(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The draft could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  async function checkReadiness() {
    if (!activePackage) return
    setBusy(true)
    setError('')
    setReadiness(null)
    try {
      const response = await fetch(`/api/admin/platform/releases/${activePackage.id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark-ready' }),
      })
      const result = await response.json().catch(() => null)
      if (result?.readiness) setReadiness(result.readiness)
      if (!response.ok) {
        if (result?.readiness) return
        throw new Error(result?.error || 'Readiness could not be checked.')
      }
      setActivePackage(result.package)
      setCatalog((current) => current
        ? { ...current, packages: current.packages.map((item) => item.id === result.package.id ? result.package : item) }
        : current)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Readiness could not be checked.')
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div style={{ ...surface, minHeight: 180, display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Loader2 size={16} className="animate-spin" /> Loading release packages…</span>
      </div>
    )
  }

  if (!catalog) {
    return (
      <div style={{ ...surface, padding: 18 }}>
        <p role="alert" style={{ margin: 0, color: '#fca5a5', fontSize: 13 }}>{error || 'Release packages could not be loaded.'}</p>
        <button type="button" onClick={load} style={{ ...secondary, marginTop: 12 }}><RefreshCw size={15} /> Try again</button>
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(230px, 300px)', gap: 14, alignItems: 'start' }} className="release-package-grid">
      <section style={{ ...surface, minWidth: 0, overflow: 'hidden' }} aria-labelledby="release-package-heading">
        <div style={{ padding: '17px 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <span style={{ width: 36, height: 36, borderRadius: 11, display: 'grid', placeItems: 'center', color: '#93c5fd', background: 'rgba(59,130,246,.13)', flexShrink: 0 }}>
            <FileStack size={18} />
          </span>
          <div style={{ minWidth: 0 }}>
            <h2 id="release-package-heading" className="jkos-h" style={{ margin: 0, fontSize: 17 }}>Build a release</h2>
            <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 12.5, lineHeight: 1.45 }}>
              Group reviewed updates, choose a version, then let Operion run the safety check.
            </p>
          </div>
        </div>

        {!activePackage ? (
          <>
            <div aria-label={`Step ${step} of 3: ${stepTitle(step)}`} style={{ display: 'flex', gap: 5, padding: '13px 18px 0' }}>
              {[1, 2, 3].map((item) => (
                <span key={item} style={{ height: 4, flex: 1, borderRadius: 99, background: item <= step ? 'var(--red)' : 'var(--line)' }} />
              ))}
            </div>

            <div style={{ padding: 18, display: 'grid', gap: 16 }}>
              <div>
                <div style={{ ...osLabel, marginBottom: 4 }}>Step {step} of 3</div>
                <h3 className="jkos-h" style={{ margin: 0, fontSize: 18 }}>{stepTitle(step)}</h3>
              </div>

              {step === 1 && (
                <>
                  <label style={fieldLabel}>Customer
                    <select aria-label="Release customer" value={productId} onChange={(event) => setProductId(event.target.value)} style={osField}>
                      {catalog.products.map((item) => (
                        <option key={item.id} value={item.id}>{item.name}</option>
                      ))}
                    </select>
                  </label>

                  {product && (
                    <div style={{ padding: 12, borderRadius: 12, border: '1px solid var(--line)', background: 'rgba(255,255,255,.025)', fontSize: 12.5 }}>
                      <strong>{product.name}</strong>
                      <span style={{ color: 'var(--muted)' }}> · Current version {product.currentVersion ?? 'not verified'}</span>
                      {product.baselineSource === 'unknown' && (
                        <p style={{ margin: '6px 0 0', color: '#fcd34d' }}>A verified starting version will be required before this package can pass.</p>
                      )}
                    </div>
                  )}

                  <div>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
                      <span style={fieldLabel}>Updates</span>
                      <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>{selectedUpdates.length} selected · {eligibleCount} available</span>
                    </div>
                    <div style={{ display: 'grid', gap: 8, maxHeight: 310, overflow: 'auto', paddingRight: 2 }}>
                      {catalog.updates.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 13 }}>No reviewed updates are available yet.</p>}
                      {catalog.updates.map((item) => {
                        const selected = selectedUpdates.includes(item.key)
                        return (
                          <label key={item.key} style={{
                            display: 'flex', alignItems: 'flex-start', gap: 10, padding: 12,
                            borderRadius: 12, border: `1px solid ${selected ? 'rgba(59,130,246,.55)' : 'var(--line)'}`,
                            background: selected ? 'rgba(59,130,246,.08)' : 'transparent',
                            cursor: item.eligible ? 'pointer' : 'not-allowed',
                            opacity: item.eligible ? 1 : .62,
                          }}>
                            <input type="checkbox" checked={selected} disabled={!item.eligible} onChange={() => toggleUpdate(item.key)} style={{ marginTop: 2 }} />
                            <span style={{ minWidth: 0, flex: 1 }}>
                              <span style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
                                <strong style={{ fontSize: 13 }}>{item.title}</strong>
                                <span style={{ color: 'var(--muted)', fontSize: 10.5 }}>{item.key}</span>
                              </span>
                              <span style={{ display: 'block', marginTop: 3, color: 'var(--muted)', fontSize: 11.5, lineHeight: 1.4 }}>{item.summary}</span>
                              {!item.eligible && <span style={{ display: 'block', marginTop: 4, color: '#fcd34d', fontSize: 11 }}>{friendlyReason(item.reasons[0] ?? 'This update is not ready yet.')}</span>}
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  </div>
                </>
              )}

              {step === 2 && (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 190px), 1fr))', gap: 12 }}>
                    <label style={fieldLabel}>Release version
                      <input aria-label="Release version" value={version} onChange={(event) => setVersion(event.target.value)} placeholder="1.2.0" autoCapitalize="off" autoCorrect="off" style={osField} />
                    </label>
                    <label style={fieldLabel}>Release channel
                      <select aria-label="Release channel" value={channel} onChange={(event) => setChannel(event.target.value as ReleasePackage['channel'])} style={osField}>
                        <option value="internal">Internal</option>
                        <option value="alpha">Alpha</option>
                        <option value="beta">Beta</option>
                        <option value="stable">Stable</option>
                        <option value="lts">Long-term support</option>
                      </select>
                    </label>
                  </div>

                  <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                    <legend style={{ ...fieldLabel, marginBottom: 8 }}>Main change</legend>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))', gap: 8 }}>
                      {CLASSIFICATIONS.map(([value, title, description]) => (
                        <label key={value} style={{
                          display: 'grid', gap: 4, padding: 11, borderRadius: 11,
                          border: `1px solid ${classification === value ? 'rgba(59,130,246,.55)' : 'var(--line)'}`,
                          background: classification === value ? 'rgba(59,130,246,.08)' : 'transparent',
                          cursor: 'pointer',
                        }}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 750 }}>
                            <input type="radio" name="classification" value={value} checked={classification === value} onChange={() => setClassification(value)} />
                            {title}
                          </span>
                          <span style={{ paddingLeft: 20, color: 'var(--muted)', fontSize: 10.5, lineHeight: 1.35 }}>{description}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 190px), 1fr))', gap: 12 }}>
                    <label style={fieldLabel}>Data changes
                      <select aria-label="Data changes" value={migration} onChange={(event) => setMigration(event.target.value as ReleasePackage['migration'])} style={osField}>
                        <option value="none">No data change</option>
                        <option value="compatible">Compatible data change</option>
                        <option value="incompatible">Breaking data change</option>
                      </select>
                    </label>
                    <label style={{ ...fieldLabel, alignContent: 'end' }}>
                      <span style={{ minHeight: 18 }}>Compatibility</span>
                      <span style={{ minHeight: 46, display: 'flex', alignItems: 'center', gap: 9, padding: '0 12px', border: '1px solid var(--line)', borderRadius: 12 }}>
                        <input type="checkbox" checked={breakingChange} onChange={(event) => setBreakingChange(event.target.checked)} />
                        Breaking change
                      </span>
                    </label>
                  </div>
                </>
              )}

              {step === 3 && (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 190px), 1fr))', gap: 12 }}>
                    <label style={fieldLabel}>Release name (optional)
                      <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Summer operations update" style={osField} />
                    </label>
                    <label style={fieldLabel}>Customer
                      <input value={product?.name ?? productId} readOnly style={{ ...osField, opacity: .75 }} />
                    </label>
                  </div>
                  <label style={fieldLabel}>What changed (optional)
                    <textarea value={releaseNotes} onChange={(event) => setReleaseNotes(event.target.value)} placeholder="A short, plain-language summary for the review." rows={4} style={{ ...osField, resize: 'vertical' }} />
                  </label>
                  <div style={{ ...surface, padding: 13, display: 'grid', gap: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span style={{ color: 'var(--muted)', fontSize: 12 }}>Version</span><strong>{version || 'Not entered'}</strong></div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span style={{ color: 'var(--muted)', fontSize: 12 }}>Updates</span><strong>{selectedUpdates.length}</strong></div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span style={{ color: 'var(--muted)', fontSize: 12 }}>Channel</span><strong style={{ textTransform: 'capitalize' }}>{channel}</strong></div>
                  </div>
                  <p style={{ margin: 0, color: 'var(--muted)', fontSize: 11.5, lineHeight: 1.45 }}>
                    Saving creates a draft only. It cannot approve, publish, or change a live site.
                  </p>
                </>
              )}

              {error && <p role="alert" style={{ margin: 0, color: '#fca5a5', fontSize: 12.5 }}>{error}</p>}

              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => setStep((current) => Math.max(1, current - 1))} disabled={step === 1 || busy}
                  style={{ ...secondary, visibility: step === 1 ? 'hidden' : 'visible' }}>
                  <ArrowLeft size={15} /> Back
                </button>
                {step < 3 ? (
                  <button type="button" onClick={() => setStep((current) => Math.min(3, current + 1))}
                    disabled={(step === 1 && (!productId || selectedUpdates.length === 0)) || (step === 2 && !version.trim())}
                    style={{ ...primary, opacity: ((step === 1 && (!productId || selectedUpdates.length === 0)) || (step === 2 && !version.trim())) ? .5 : 1 }}>
                    Continue <ArrowRight size={15} />
                  </button>
                ) : (
                  <button type="button" onClick={saveDraft} disabled={busy || !version.trim() || selectedUpdates.length === 0}
                    style={{ ...primary, opacity: busy ? .65 : 1 }}>
                    {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                    {busy ? 'Saving…' : 'Save draft'}
                  </button>
                )}
              </div>
            </div>
          </>
        ) : (
          <div style={{ padding: 18, display: 'grid', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ ...osLabel, marginBottom: 5 }}>{activePackage.id}</div>
                <h3 className="jkos-h" style={{ margin: 0, fontSize: 19 }}>{activePackage.name || `${activePackage.proposedVersion} release`}</h3>
                <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 12.5 }}>
                  {catalog.products.find((item) => item.id === activePackage.targetProduct)?.name ?? activePackage.targetProduct}
                </p>
              </div>
              <StatusPill status={activePackage.status} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 130px), 1fr))', gap: 9 }}>
              {[
                ['Version', activePackage.proposedVersion],
                ['Updates', String(activePackage.updateKeys.length)],
                ['Channel', activePackage.channel],
              ].map(([label, value]) => (
                <div key={label} style={{ ...surface, padding: 12 }}>
                  <div style={osLabel}>{label}</div>
                  <div style={{ marginTop: 5, fontSize: 14, fontWeight: 800, textTransform: label === 'Channel' ? 'capitalize' : undefined }}>{value}</div>
                </div>
              ))}
            </div>

            <div>
              <div style={{ ...osLabel, marginBottom: 8 }}>Included updates</div>
              <div style={{ display: 'grid', gap: 6 }}>
                {activePackage.updateKeys.map((key) => {
                  const item = catalog.updates.find((update) => update.key === key)
                  return (
                    <div key={key} style={{ padding: '9px 11px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 12.5 }}>
                      <strong>{item?.title ?? key}</strong>
                      <span style={{ marginLeft: 7, color: 'var(--muted)', fontSize: 10.5 }}>{key}</span>
                    </div>
                  )
                })}
              </div>
            </div>

            {activePackage.status === 'ready_for_approval' ? (
              <div role="status" style={{ padding: 14, borderRadius: 13, border: '1px solid rgba(34,197,94,.28)', background: 'rgba(34,197,94,.07)', display: 'flex', gap: 10 }}>
                <CheckCircle2 size={18} style={{ color: '#86efac', flexShrink: 0 }} />
                <div>
                  <strong style={{ display: 'block', fontSize: 13 }}>All readiness checks passed</strong>
                  <span style={{ display: 'block', marginTop: 3, color: 'var(--muted)', fontSize: 11.5, lineHeight: 1.4 }}>
                    This package can move to the separate owner-approval stage. Nothing has been published.
                  </span>
                </div>
              </div>
            ) : (
              <>
                {readiness && !readiness.ok && (
                  <div role="alert" style={{ padding: 14, borderRadius: 13, border: '1px solid rgba(245,158,11,.3)', background: 'rgba(245,158,11,.07)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#fcd34d', fontSize: 13, fontWeight: 800 }}>
                      <AlertTriangle size={16} /> This package needs attention
                    </div>
                    <ul style={{ margin: '9px 0 0', paddingLeft: 20, display: 'grid', gap: 5 }}>
                      {readiness.blockers.map((blocker) => <li key={blocker} style={{ color: 'var(--text)', fontSize: 12.5, lineHeight: 1.4 }}>{friendlyReason(blocker)}</li>)}
                    </ul>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
                  <button type="button" onClick={checkReadiness} disabled={busy} style={{ ...primary, opacity: busy ? .65 : 1 }}>
                    {busy ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
                    {busy ? 'Checking…' : 'Run readiness check'}
                  </button>
                  <button type="button" onClick={resetBuilder} disabled={busy} style={secondary}>Start a revised package</button>
                </div>
              </>
            )}

            {error && <p role="alert" style={{ margin: 0, color: '#fca5a5', fontSize: 12.5 }}>{error}</p>}
          </div>
        )}
      </section>

      <aside style={{ ...surface, padding: 14, minWidth: 0 }} aria-label="Recent release packages">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div>
            <div style={osLabel}>Recent packages</div>
            <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 11.5 }}>Drafts and packages waiting for approval.</p>
          </div>
          <button type="button" onClick={load} aria-label="Refresh release packages" style={{ ...secondary, minHeight: 34, padding: 7 }}>
            <RefreshCw size={14} />
          </button>
        </div>
        <div style={{ display: 'grid', gap: 7, marginTop: 12 }}>
          {catalog.packages.length === 0 && (
            <div style={{ padding: 13, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
              <PackageCheck size={20} style={{ margin: '0 auto 7px' }} />
              No packages yet.
            </div>
          )}
          {catalog.packages.slice(0, 8).map((item) => (
            <button key={item.id} type="button" onClick={() => { setActivePackage(item); setReadiness(null); setError('') }}
              style={{
                width: '100%', display: 'grid', gap: 6, padding: 11, borderRadius: 11, textAlign: 'left',
                color: 'var(--text)', background: activePackage?.id === item.id ? 'rgba(59,130,246,.08)' : 'transparent',
                border: `1px solid ${activePackage?.id === item.id ? 'rgba(59,130,246,.45)' : 'var(--line)'}`,
                cursor: 'pointer',
              }}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 7 }}>
                <strong style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>{item.name || item.proposedVersion}</strong>
                <StatusPill status={item.status} />
              </span>
              <span style={{ color: 'var(--muted)', fontSize: 10.5 }}>
                {catalog.products.find((product) => product.id === item.targetProduct)?.name ?? item.targetProduct} · {item.updateKeys.length} update{item.updateKeys.length === 1 ? '' : 's'}
              </span>
            </button>
          ))}
        </div>
        {activePackage && (
          <button type="button" onClick={resetBuilder} style={{ ...secondary, width: '100%', marginTop: 10 }}>
            <Plus size={14} /> New package
          </button>
        )}
      </aside>

      <style>{`
        @media (max-width: 780px) {
          .release-package-grid { grid-template-columns: minmax(0, 1fr) !important; }
        }
      `}</style>
    </div>
  )
}
