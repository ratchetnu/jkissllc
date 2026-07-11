'use client'

import { useCallback, useEffect, useState } from 'react'
import { Sparkles, RefreshCw, AlertTriangle, ThumbsUp, ThumbsDown, Gauge, DollarSign, Activity, ShieldCheck } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { Stat, fmtTs } from '../ui'

type OutcomeCounts = Record<string, number>
type PromptVersionStats = {
  taskId: string; promptVersion: number; calls: number; ok: number; errors: number
  successRate: number; avgLatencyMs: number; avgOutputTokens: number; estCostUsd: number
  helpful: number; notHelpful: number
}
type FeatureStats = {
  feature: string; calls: number; ok: number; errors: number; successRate: number
  avgLatencyMs: number; totalTokens: number; estCostUsd: number; helpful: number; notHelpful: number
  versions: PromptVersionStats[]
}
type RecentCall = {
  id: string; at: number; feature: string; taskId: string; promptVersion: number; model: string
  role: string; actor: string; outcome: string; ok: boolean; latencyMs: number; totalTokens: number
  estCostUsd: number; feedback?: 'helpful' | 'not_helpful'
}
type Analytics = {
  generatedAt: number
  window: { count: number; sampledFrom: number }
  totals: {
    calls: number; ok: number; errors: number; successRate: number; avgLatencyMs: number
    totalTokens: number; inputTokens: number; outputTokens: number; estCostUsd: number
    helpful: number; notHelpful: number; feedbackRate: number
  }
  outcomes: OutcomeCounts
  today: { estCostUsd: number; capUsd: number; overBudget: boolean }
  features: FeatureStats[]
  recent: RecentCall[]
  registeredPrompts: Array<{ id: string; version: number; description: string }>
}

const usd = (n: number) => n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`
const pct = (n: number) => `${Math.round(n * 100)}%`
const OUTCOME_LABEL: Record<string, string> = {
  success: 'Success', invalid_response: 'Invalid response', provider_error: 'Provider error',
  forbidden: 'Blocked (RBAC)', budget_exceeded: 'Budget reached',
}
const OUTCOME_TONE: Record<string, string> = {
  success: '#86efac', invalid_response: '#fcd34d', provider_error: '#fca5a5',
  forbidden: '#94a3b8', budget_exceeded: '#fdba74',
}

function AiControlCenter() {
  const [data, setData] = useState<Analytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = await fetch('/api/admin/ai/analytics', { credentials: 'same-origin' })
      const d = await res.json()
      if (!res.ok || !d.analytics) { setErr(d.error || 'Failed to load AI analytics.'); return }
      setData(d.analytics as Analytics); setErr('')
    } catch { setErr('Failed to load AI analytics.') }
    finally { setLoading(false); setRefreshing(false) }
  }, [])
  useEffect(() => { load() }, [load])

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <div className="os-rise" style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
        <Sparkles size={26} style={{ color: 'var(--red-glow)' }} />
        <h1 className="jkos-h" style={{ fontSize: 'clamp(28px,6vw,40px)', flex: 1 }}>AI Control Center</h1>
        <button onClick={load} disabled={refreshing} className="os-tap" aria-label="Refresh"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 14px', borderRadius: 11, background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', color: 'var(--muted)', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
          <RefreshCw size={15} style={{ animation: refreshing ? 'spin 1s linear infinite' : undefined }} /> Refresh
        </button>
      </div>
      <p className="os-rise" style={{ fontSize: 13.5, color: 'var(--muted)', marginBottom: 20 }}>
        Read-only observability for every AI feature — usage, estimated cost, latency, reliability, and quality feedback. AI here is draft-only; it never changes bookings, pay, or claims.
      </p>

      {loading ? (
        <div className="skeleton" style={{ width: '100%', height: 120, borderRadius: 16 }} />
      ) : err ? (
        <div className="os-card os-rise" style={{ padding: 22, display: 'flex', gap: 10, alignItems: 'center', color: '#fca5a5' }}>
          <AlertTriangle size={18} /> {err}
        </div>
      ) : data ? (
        <>
          {/* Budget banner */}
          {data.today.capUsd > 0 && (
            <div className="os-card os-rise" style={{ padding: '14px 18px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, borderColor: data.today.overBudget ? '#fca5a5' : 'var(--line)' }}>
              <Gauge size={18} style={{ color: data.today.overBudget ? '#fca5a5' : 'var(--red-glow)' }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>Today&rsquo;s AI spend (estimated)</div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                  {usd(data.today.estCostUsd)} of {usd(data.today.capUsd)} daily cap
                  {data.today.overBudget && ' — cap reached; AI features pause until tomorrow'}
                </div>
              </div>
              <div style={{ minWidth: 120 }}>
                <div style={{ height: 8, borderRadius: 999, background: 'rgba(255,255,255,.1)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.min(100, (data.today.estCostUsd / data.today.capUsd) * 100)}%`, background: data.today.overBudget ? '#fca5a5' : 'var(--red)' }} />
                </div>
              </div>
            </div>
          )}

          {/* Headline stats */}
          <div className="os-rise" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: 12, marginBottom: 18 }}>
            <Stat label="Total AI calls" value={String(data.totals.calls)} sub={`${data.window.count} recent`} />
            <Stat label="Success rate" value={pct(data.totals.successRate)} sub={`${data.totals.errors} errors`} tone={data.totals.successRate >= 0.9 ? '#86efac' : '#fcd34d'} />
            <Stat label="Avg latency" value={`${data.totals.avgLatencyMs}ms`} />
            <Stat label="Est. cost (window)" value={usd(data.totals.estCostUsd)} sub={`${(data.totals.totalTokens / 1000).toFixed(1)}k tokens`} />
            <Stat label="Today (est.)" value={usd(data.today.estCostUsd)} sub={data.today.capUsd > 0 ? `cap ${usd(data.today.capUsd)}` : 'no cap set'} />
            <Stat label="Feedback" value={data.totals.helpful + data.totals.notHelpful > 0 ? pct(data.totals.feedbackRate) : '—'} sub={`👍 ${data.totals.helpful} · 👎 ${data.totals.notHelpful}`} />
          </div>

          {/* Outcomes */}
          <div className="os-card os-rise" style={{ padding: 20, marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
              <Activity size={17} style={{ color: 'var(--red-glow)' }} />
              <h2 className="jkos-h" style={{ fontSize: 17 }}>Outcomes</h2>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {Object.entries(data.outcomes).filter(([, n]) => n > 0).map(([k, n]) => (
                <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 13px', borderRadius: 10, background: 'rgba(255,255,255,.04)', border: '1px solid var(--line)' }}>
                  <span style={{ width: 9, height: 9, borderRadius: 999, background: OUTCOME_TONE[k] || '#94a3b8' }} />
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{OUTCOME_LABEL[k] || k}</span>
                  <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--muted)' }}>{n}</span>
                </div>
              ))}
              {Object.values(data.outcomes).every(n => n === 0) && <span style={{ fontSize: 13, color: 'var(--muted)' }}>No AI calls recorded yet.</span>}
            </div>
          </div>

          {/* Per-feature breakdown with prompt versions */}
          <div className="os-card os-rise" style={{ padding: 20, marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <DollarSign size={17} style={{ color: 'var(--red-glow)' }} />
              <h2 className="jkos-h" style={{ fontSize: 17 }}>By feature &amp; prompt version</h2>
            </div>
            <p style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 16 }}>Metrics split per prompt version so you can diff a new prompt against the one it replaced.</p>
            {data.features.length === 0 ? (
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>No feature activity yet.</span>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {data.features.map(f => (
                  <div key={f.feature} style={{ padding: 14, borderRadius: 13, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
                      <span style={{ fontWeight: 800, fontSize: 15, fontFamily: 'var(--mono, ui-monospace)' }}>{f.feature}</span>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{f.calls} calls</span>
                      <span style={{ fontSize: 12, color: f.successRate >= 0.9 ? '#86efac' : '#fcd34d' }}>{pct(f.successRate)} ok</span>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{f.avgLatencyMs}ms avg</span>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{usd(f.estCostUsd)}</span>
                      {(f.helpful + f.notHelpful) > 0 && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
                          <ThumbsUp size={12} />{f.helpful} <ThumbsDown size={12} />{f.notHelpful}
                        </span>
                      )}
                    </div>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 460 }}>
                        <thead>
                          <tr style={{ color: 'var(--muted)', textAlign: 'left' }}>
                            <th style={{ padding: '4px 8px', fontWeight: 700 }}>Version</th>
                            <th style={{ padding: '4px 8px', fontWeight: 700 }}>Calls</th>
                            <th style={{ padding: '4px 8px', fontWeight: 700 }}>Success</th>
                            <th style={{ padding: '4px 8px', fontWeight: 700 }}>Latency</th>
                            <th style={{ padding: '4px 8px', fontWeight: 700 }}>Out tok</th>
                            <th style={{ padding: '4px 8px', fontWeight: 700 }}>Cost</th>
                            <th style={{ padding: '4px 8px', fontWeight: 700 }}>👍/👎</th>
                          </tr>
                        </thead>
                        <tbody>
                          {f.versions.map(v => (
                            <tr key={v.promptVersion} style={{ borderTop: '1px solid var(--line)' }}>
                              <td style={{ padding: '5px 8px', fontWeight: 700 }}>v{v.promptVersion}</td>
                              <td style={{ padding: '5px 8px' }}>{v.calls}</td>
                              <td style={{ padding: '5px 8px', color: v.successRate >= 0.9 ? '#86efac' : '#fcd34d' }}>{pct(v.successRate)}</td>
                              <td style={{ padding: '5px 8px' }}>{v.avgLatencyMs}ms</td>
                              <td style={{ padding: '5px 8px' }}>{v.avgOutputTokens}</td>
                              <td style={{ padding: '5px 8px' }}>{usd(v.estCostUsd)}</td>
                              <td style={{ padding: '5px 8px' }}>{v.helpful}/{v.notHelpful}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Registered prompts */}
          <div className="os-card os-rise" style={{ padding: 20, marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
              <ShieldCheck size={17} style={{ color: 'var(--red-glow)' }} />
              <h2 className="jkos-h" style={{ fontSize: 17 }}>Registered prompts</h2>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {data.registeredPrompts.map(p => (
                <div key={p.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '9px 12px', borderRadius: 10, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
                  <span style={{ fontWeight: 700, fontSize: 13, fontFamily: 'var(--mono, ui-monospace)' }}>{p.id}</span>
                  <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--red-glow)' }}>v{p.version}</span>
                  <span style={{ fontSize: 12.5, color: 'var(--muted)', flex: 1 }}>{p.description}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Recent calls */}
          <div className="os-card os-rise" style={{ padding: 20 }}>
            <h2 className="jkos-h" style={{ fontSize: 17, marginBottom: 14 }}>Recent AI calls</h2>
            {data.recent.length === 0 ? (
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>No recent activity.</span>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 640 }}>
                  <thead>
                    <tr style={{ color: 'var(--muted)', textAlign: 'left' }}>
                      <th style={{ padding: '5px 8px', fontWeight: 700 }}>When</th>
                      <th style={{ padding: '5px 8px', fontWeight: 700 }}>Feature</th>
                      <th style={{ padding: '5px 8px', fontWeight: 700 }}>Ver</th>
                      <th style={{ padding: '5px 8px', fontWeight: 700 }}>Role</th>
                      <th style={{ padding: '5px 8px', fontWeight: 700 }}>Outcome</th>
                      <th style={{ padding: '5px 8px', fontWeight: 700 }}>Latency</th>
                      <th style={{ padding: '5px 8px', fontWeight: 700 }}>Tokens</th>
                      <th style={{ padding: '5px 8px', fontWeight: 700 }}>Cost</th>
                      <th style={{ padding: '5px 8px', fontWeight: 700 }}>FB</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.map(r => (
                      <tr key={r.id} style={{ borderTop: '1px solid var(--line)' }}>
                        <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{fmtTs(r.at)}</td>
                        <td style={{ padding: '6px 8px', fontFamily: 'var(--mono, ui-monospace)' }}>{r.feature}</td>
                        <td style={{ padding: '6px 8px' }}>v{r.promptVersion}</td>
                        <td style={{ padding: '6px 8px' }}>{r.role}</td>
                        <td style={{ padding: '6px 8px' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ width: 8, height: 8, borderRadius: 999, background: OUTCOME_TONE[r.outcome] || '#94a3b8' }} />
                            {OUTCOME_LABEL[r.outcome] || r.outcome}
                          </span>
                        </td>
                        <td style={{ padding: '6px 8px' }}>{r.latencyMs}ms</td>
                        <td style={{ padding: '6px 8px' }}>{r.totalTokens}</td>
                        <td style={{ padding: '6px 8px' }}>{usd(r.estCostUsd)}</td>
                        <td style={{ padding: '6px 8px' }}>{r.feedback === 'helpful' ? '👍' : r.feedback === 'not_helpful' ? '👎' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <p className="os-rise" style={{ fontSize: 11.5, color: 'var(--muted)', textAlign: 'center', marginTop: 18 }}>
            Costs are list-price estimates for visibility only — the AI Gateway is the source of truth. Generated {fmtTs(data.generatedAt)}.
          </p>
        </>
      ) : null}
    </div>
  )
}

export default function AiControlCenterPage() {
  return <OperationsShell><AiControlCenter /></OperationsShell>
}
