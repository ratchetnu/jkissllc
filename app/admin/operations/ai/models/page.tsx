'use client'

// ── AI Command Center — Models & Versions (canonical, read-only) ─────────────
// A calm registry distinguishing the live V1 production estimator from the V2 shadow estimator,
// with model / prompt / estimator versions, state, and promotion eligibility. Reuses
// /api/admin/ai-config (ZERO AI). Read-only by design — no inline editing of production model
// configuration; promotion is never implied here.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import OperationsShell from '../../OperationsShell'
import AICommandShell, { aiCard, aiLabel, AISkeleton, AIError, AIEmpty } from '../AICommandShell'

const fmtTs = (t?: number | null) => (t ? new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')
const READINESS: Record<string, { c: string; label: string }> = {
  NOT_READY: { c: '#f87171', label: 'Not ready' }, PILOT_READY: { c: '#fbbf24', label: 'Pilot ready' },
  LIMITED_PRODUCTION: { c: '#a3e635', label: 'Limited production' }, PRODUCTION_READY: { c: '#34d399', label: 'Production ready' },
}

type Prod = { role: string; model: string; feature: string; state: string; note: string }
type Shadow = { role: string; model: string; estimatorVersion: number; promptVersion: string; lastRecordedModel: string | null; lastRecordedPromptVersion: number | null; lastEvaluationAt: number | null; state: string; promotable: boolean; readinessTier: string; note: string }
type Payload = { enabled: boolean; models?: { production: Prod; shadow: Shadow }; flags?: Record<string, boolean> }

export default function ModelsPage() {
  return <OperationsShell><AICommandShell section="models" title="Models & Versions"><Models /></AICommandShell></OperationsShell>
}

function Models() {
  const [res, setRes] = useState<{ payload: Payload | null; err: string } | null>(null)
  useEffect(() => {
    const c = new AbortController()
    fetch('/api/admin/ai-config', { credentials: 'same-origin', signal: c.signal })
      .then(async (r) => { if (r.status === 401 || r.status === 403) return setRes({ payload: null, err: 'Owner access required.' }); setRes({ payload: await r.json(), err: '' }) })
      .catch((e) => { if ((e as { name?: string })?.name !== 'AbortError') setRes({ payload: null, err: 'Could not load the model registry.' }) })
    return () => c.abort()
  }, [])

  if (!res) return <AISkeleton rows={3} />
  if (res.err) return <AIError message={res.err} />
  const d = res.payload
  if (d && !d.enabled) return <AIEmpty title="AI evaluation is off" detail="Enable SHADOW_ANALYTICS_ENABLED to view the registry." />
  if (!d?.models) return <AISkeleton rows={3} />
  const { production: p, shadow: sh } = d.models
  const rd = READINESS[sh.readinessTier] ?? { c: 'var(--muted)', label: sh.readinessTier }

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
        {/* Live V1 */}
        <div style={{ ...aiCard, display: 'grid', gap: 8, borderColor: '#34d39944' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: 999, background: '#34d399' }} />
            <span style={aiLabel}>Production estimator</span>
            <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 800, color: '#34d399' }}>LIVE</span>
          </div>
          <div style={{ fontSize: 16, fontWeight: 800 }}>{p.role}</div>
          <Field k="Model" v={p.model} mono />
          <Field k="Feature" v={p.feature} mono />
          <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: 0 }}>{p.note}</p>
        </div>

        {/* Shadow V2 */}
        <div style={{ ...aiCard, display: 'grid', gap: 8, borderColor: `${rd.c}44` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: 999, background: sh.state === 'active' ? '#fbbf24' : '#94a3b8' }} />
            <span style={aiLabel}>Shadow estimator</span>
            <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 800, color: sh.state === 'active' ? '#fbbf24' : '#94a3b8' }}>{sh.state.toUpperCase()}</span>
          </div>
          <div style={{ fontSize: 16, fontWeight: 800 }}>{sh.role}</div>
          <Field k="Model" v={sh.model} mono />
          <Field k="Estimator version" v={`v${sh.estimatorVersion}`} />
          <Field k="Prompt version" v={sh.promptVersion} />
          <Field k="Last evaluation" v={fmtTs(sh.lastEvaluationAt)} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>Readiness</span>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: rd.c }}>{rd.label}</span>
            <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 6, color: sh.promotable ? '#34d399' : 'var(--muted)', background: sh.promotable ? 'color-mix(in srgb, #34d399 14%, transparent)' : 'transparent', border: '1px solid var(--line)' }}>
              {sh.promotable ? 'Eligible for review' : 'Not promotable'}
            </span>
          </div>
          <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: 0 }}>{sh.note}</p>
        </div>
      </div>

      {/* Configuration drift check */}
      {sh.lastRecordedModel && sh.lastRecordedModel !== sh.model && (
        <div style={{ ...aiCard, borderColor: '#fbbf2455', fontSize: 12.5 }}>
          ⚠ The most recent evaluation ran on <code>{sh.lastRecordedModel}</code>, which differs from the current shadow model <code>{sh.model}</code>. Confirm this is intended.
        </div>
      )}

      {/* Feature flags (read-only; deployment-configured) */}
      <div style={{ ...aiCard, display: 'grid', gap: 8 }}>
        <span style={aiLabel}>Deployment flags (read-only)</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {Object.entries(d.flags ?? {}).map(([k, on]) => (
            <span key={k} style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 999, color: on ? '#34d399' : '#94a3b8', background: `color-mix(in srgb, ${on ? '#34d399' : '#94a3b8'} 14%, transparent)` }}>
              {k.replace(/([A-Z])/g, ' $1').toLowerCase()}: {on ? 'on' : 'off'}
            </span>
          ))}
        </div>
        <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0 }}>
          These change only through deployment configuration — never inline. Operational usage &amp; the kill switch live in <Link href="/admin/operations/ai/usage" style={{ color: '#93c5fd', textDecoration: 'none' }}>Usage &amp; Controls</Link>.
        </p>
      </div>

      <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0 }}>
        Read-only registry — no model is promoted from here. V2 promotion, if ever, is a separate explicit owner action outside the Command Center.
      </p>
    </>
  )
}

function Field({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5 }}>
      <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{k}</span>
      <span style={{ fontWeight: 600, textAlign: 'right', wordBreak: 'break-word', fontFamily: mono ? 'ui-monospace, monospace' : undefined, fontSize: mono ? 11.5 : undefined }}>{v}</span>
    </div>
  )
}
