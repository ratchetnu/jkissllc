'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, CircleOff, RefreshCw } from 'lucide-react'
import { Button, EmptyState, StatusBadge } from '../../../components/ui'
import type { ActivationReadiness, ActivationStage } from '../../../lib/platform/release/activation-readiness'

const STATE = {
  ready: { label: 'Ready', tone: 'good' as const, Icon: CheckCircle2 },
  disabled: { label: 'Ready · Currently off', tone: 'neutral' as const, Icon: CircleOff },
  blocked: { label: 'Needs attention', tone: 'bad' as const, Icon: AlertTriangle },
}

function Stage({ stage }: { stage: ActivationStage }) {
  const state = STATE[stage.state]
  return (
    <section style={{ border: '1px solid var(--line)', borderRadius: 14, padding: 14, display: 'grid', gap: 11, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>{stage.label}</h3>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 12.5, lineHeight: 1.45 }}>{stage.description}</p>
        </div>
        <StatusBadge tone={state.tone}><state.Icon size={12} /> {state.label}</StatusBadge>
      </div>
      <details>
        <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--muted)' }}>View {stage.checks.length} checks</summary>
        <div style={{ display: 'grid', gap: 7, marginTop: 10 }}>
          {stage.checks.map((item) => (
            <div key={`${stage.id}-${item.id}`} style={{ display: 'grid', gridTemplateColumns: '18px minmax(0,1fr)', gap: 8, alignItems: 'start' }}>
              {item.ok ? <CheckCircle2 size={15} color="#86efac" /> : <AlertTriangle size={15} color={item.kind === 'flag' ? '#94a3b8' : '#fca5a5'} />}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{item.label}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.4, overflowWrap: 'anywhere' }}>{item.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </details>
    </section>
  )
}

export function ActivationReadinessPanel() {
  const [data, setData] = useState<ActivationReadiness | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const response = await fetch('/api/admin/release/activation-readiness', { credentials: 'same-origin', cache: 'no-store' })
      const body = await response.json().catch(() => null)
      if (!response.ok || !body?.readiness) throw new Error(body?.message || 'Activation readiness is unavailable.')
      setData(body.readiness)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Activation readiness is unavailable.')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  if (loading && !data) return <div className="skeleton" style={{ height: 130, borderRadius: 14 }} />
  if (error && !data) return <EmptyState title="Readiness check unavailable" description={error} />
  if (!data) return null

  return (
    <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ fontSize: 15, margin: 0 }}>Is everything ready?</h3>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '4px 0 0', lineHeight: 1.45 }}>
            Check the test and live release setup. Nothing changes from this screen.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}><RefreshCw size={13} /> {loading ? 'Checking…' : 'Recheck'}</Button>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <StatusBadge tone={data.safeToEnablePreview ? 'good' : 'bad'}>Testing {data.safeToEnablePreview ? 'is ready' : 'needs attention'}</StatusBadge>
        <StatusBadge tone={data.safeToEnableProduction ? 'good' : 'bad'}>Live publishing {data.safeToEnableProduction ? 'is ready' : 'needs attention'}</StatusBadge>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,280px),1fr))', gap: 10 }}>
        {data.stages.map((stage) => <Stage key={stage.id} stage={stage} />)}
      </div>

      <section style={{ border: '1px solid var(--line)', borderRadius: 14, padding: 14, display: 'grid', gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>Businesses</h3>
        {data.businesses.length === 0 ? <p style={{ margin: 0, color: 'var(--muted)', fontSize: 12.5 }}>No active businesses have been added.</p> : data.businesses.map((business) => (
          <details key={business.id} style={{ borderTop: '1px solid var(--line)', paddingTop: 9 }}>
            <summary style={{ cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', overflowWrap: 'anywhere' }}>
              <strong style={{ fontSize: 12.5 }}>{business.name}</strong>
              <StatusBadge tone={business.readyForPreview ? 'good' : 'bad'}>Test</StatusBadge>
              <StatusBadge tone={business.readyForProduction ? 'good' : 'bad'}>Live</StatusBadge>
            </summary>
            <div style={{ display: 'grid', gap: 6, marginTop: 9 }}>
              {business.checks.map((item) => <div key={item.id} style={{ fontSize: 12, color: item.ok ? 'var(--muted)' : '#fca5a5', overflowWrap: 'anywhere' }}>{item.ok ? '✓' : '✕'} {item.label} — {item.detail}</div>)}
            </div>
          </details>
        ))}
      </section>
    </div>
  )
}
