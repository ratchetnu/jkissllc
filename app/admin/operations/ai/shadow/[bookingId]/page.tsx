'use client'

// ── Operion — Shadow Evaluation Workspace (owner drill-down + actions) ────────
// Owner-only. Reads GET /api/admin/shadow-analytics/[bookingId] (photos + full V2ShadowJob +
// audit trail) and posts audited owner actions. Renders persisted data only — no analytics
// re-derivation, no customer impact. Theme-aware, mobile-responsive.

import { useCallback, useEffect, useState, use } from 'react'
import Link from 'next/link'
import OperationsShell from '../../../OperationsShell'
import type { V2ShadowJob } from '../../../../../lib/estimation/shadow-types'

type AuditEntry = { id: string; summary: string; actor: string; at: number }
type Detail = { enabled?: boolean; job?: V2ShadowJob; photos?: string[]; audit?: AuditEntry[] }

const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 16 }
const lab: React.CSSProperties = { display: 'block', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', marginBottom: 4 }
const btn = (primary?: boolean): React.CSSProperties => ({ fontSize: 12, fontWeight: 700, padding: '7px 12px', borderRadius: 9, cursor: 'pointer', border: '1px solid ' + (primary ? 'var(--red)' : 'var(--line)'), background: primary ? 'var(--red)' : 'transparent', color: primary ? '#fff' : 'var(--text)' })
const nice = (s?: string) => (s ? s.replace(/_/g, ' ') : '—')
const usd = (n?: number | null) => (typeof n === 'number' ? `$${Math.round(n)}` : '—')

const CLASSES: { key: string; label: string; c: string }[] = [
  { key: 'false_positive', label: 'False positive', c: '#fbbf24' },
  { key: 'false_negative', label: 'False negative', c: '#f87171' },
  { key: 'needs_investigation', label: 'Needs investigation', c: '#93c5fd' },
  { key: 'expected_difference', label: 'Expected difference', c: '#a3e635' },
  { key: 'accepted_v2', label: 'Accept V2', c: '#34d399' },
  { key: 'ignored', label: 'Ignore', c: 'var(--muted)' },
]

export default function ShadowEvaluationPage({ params }: { params: Promise<{ bookingId: string }> }) {
  const { bookingId } = use(params)
  const [d, setD] = useState<Detail | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [assignee, setAssignee] = useState('')

  const load = useCallback(async () => {
    setErr('')
    try {
      const res = await fetch(`/api/admin/shadow-analytics/${bookingId}`, { credentials: 'same-origin' })
      if (res.status === 404) { setErr('Evaluation not found.'); return }
      if (res.status === 401 || res.status === 403) { setErr('Owner access required.'); return }
      setD(await res.json())
    } catch { setErr('Could not load.') }
  }, [bookingId])
  useEffect(() => { load() }, [load])

  const act = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true); setErr('')
    try {
      const res = await fetch(`/api/admin/shadow-analytics/${bookingId}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const j = await res.json()
      if (!res.ok) setErr(j.error ?? 'Action failed.')
      else { setNote(''); await load() }
    } catch { setErr('Action failed.') } finally { setBusy(false) }
  }, [bookingId, load])

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(d?.job ?? {}, null, 2)], { type: 'application/json' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `shadow-${bookingId}.json`; a.click()
  }

  const job = d?.job
  const c = job?.comparison
  const est = job?.result?.estimate

  return (
    <OperationsShell>
      <div style={{ display: 'grid', gap: 14, maxWidth: 1000, margin: '0 auto' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <Link href="/admin/operations/ai/shadow" style={{ fontSize: 12, color: 'var(--muted)', textDecoration: 'none' }}>← Shadow Analytics</Link>
          <h1 style={{ fontSize: 19, fontWeight: 800 }}>Evaluation {bookingId.slice(0, 12)}</h1>
          {job?.classification && <span style={{ fontSize: 11, fontWeight: 700, color: '#34d399', padding: '3px 9px', borderRadius: 999, background: 'rgba(52,211,153,.14)' }}>{nice(job.classification)}</span>}
          <button style={{ ...btn(), marginLeft: 'auto' }} onClick={exportJson} disabled={!job}>Export</button>
        </div>
        {err && <div style={{ ...card, color: '#f87171', fontSize: 13 }}>{err}</div>}
        {d?.enabled === false && <div style={{ ...card, fontSize: 12.5, color: 'var(--muted)' }}>Shadow Analytics is off (SHADOW_ANALYTICS_ENABLED).</div>}

        {job && (
          <>
            {/* Photos */}
            {d.photos && d.photos.length > 0 && (
              <div style={card}>
                <span style={lab}>Photos ({d.photos.length})</span>
                <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingTop: 6 }}>
                  {d.photos.map((p: string, i: number) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={i} src={p} alt={`photo ${i + 1}`} style={{ width: 140, height: 140, objectFit: 'cover', borderRadius: 10, border: '1px solid var(--line)', flexShrink: 0 }} />
                  ))}
                </div>
              </div>
            )}

            {/* V1 vs V2 */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
              <div style={card}>
                <span style={lab}>V1 (production)</span>
                <Row k="Decision" v={nice(c?.authoritativeDecision)} />
                <Row k="Recommended" v={usd(c?.authoritativeRecommendedUsd)} />
              </div>
              <div style={card}>
                <span style={lab}>V2 (shadow)</span>
                <Row k="Decision" v={nice(c?.shadowDecision)} />
                <Row k="Range" v={est?.pricing?.rangeCents ? `${usd(est.pricing.rangeCents.low / 100)}–${usd(est.pricing.rangeCents.high / 100)}` : '—'} />
                <Row k="Volume" v={est?.volume?.cubicYards?.expected != null ? `${est.volume.cubicYards.expected} cu-yd` : '—'} />
                <Row k="Confidence" v={est?.confidenceScore != null ? `${Math.round(est.confidenceScore * 100)}% (${c?.shadowConfidenceBand ?? '—'})` : '—'} />
                <Row k="Load tier" v={nice(c?.shadowLoadTier)} />
              </div>
              <div style={card}>
                <span style={lab}>Difference</span>
                <Row k="Price Δ" v={c?.quoteDeltaUsd != null ? `${usd(c.quoteDeltaUsd)} (${c.quoteDeltaPct ?? '—'}%)` : '—'} />
                <Row k="Review differs" v={c?.manualReviewDiffers ? 'yes' : 'no'} />
                <Row k="Outcome" v={nice(c?.outcome)} />
                <Row k="V2 review" v={c?.shadowManualReview ? 'yes' : 'no'} />
              </div>
            </div>

            {/* Review reasons */}
            {est && est.manualReviewReasons.length > 0 && (
              <div style={card}>
                <span style={lab}>V2 review reasons</span>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5, color: 'var(--text)' }}>
                  {est.manualReviewReasons.map((r: string, i: number) => <li key={i}>{r}</li>)}
                </ul>
              </div>
            )}

            {/* Telemetry */}
            <div style={card}>
              <span style={lab}>Telemetry & versions</span>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, marginTop: 6 }}>
                <Mini k="Model" v={(job.model ?? '—').split('/').pop()} />
                <Mini k="Prompt" v={`v2-${job.promptVersion ?? '?'}`} />
                <Mini k="Estimator" v={`v${job.estimatorVersion ?? '?'}`} />
                <Mini k="Latency" v={job.latencyMs != null ? `${(job.latencyMs / 1000).toFixed(1)}s` : '—'} />
                <Mini k="Cost" v={job.estimatedCostUsd != null ? `$${job.estimatedCostUsd.toFixed(4)}` : '—'} />
                <Mini k="Tokens" v={job.providerUsage?.totalTokens ?? '—'} />
                <Mini k="Attempts" v={job.attempts} />
                <Mini k="Trace" v={(job.traceId ?? '—').slice(0, 10)} />
              </div>
            </div>

            {/* Owner actions */}
            <div style={card}>
              <span style={lab}>Owner actions (audited)</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                {CLASSES.map((x) => (
                  <button key={x.key} disabled={busy} onClick={() => act({ action: 'classify', classification: x.key })}
                    style={{ ...btn(job.classification === x.key), borderColor: x.c, color: job.classification === x.key ? '#fff' : x.c, background: job.classification === x.key ? x.c : 'transparent' }}>{x.label}</button>
                ))}
                {job.classification && <button style={btn()} disabled={busy} onClick={() => act({ action: 'clear_classification' })}>Clear</button>}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                <input value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="Assign engineer…" style={{ flex: '1 1 160px', padding: '7px 10px', background: 'transparent', border: '1px solid var(--line)', borderRadius: 9, color: 'var(--text)', fontSize: 12.5 }} />
                <button style={btn()} disabled={busy || !assignee.trim()} onClick={() => act({ action: 'assign', assignee })}>Assign</button>
              </div>
              {job.assignee && <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>Assigned to <strong>{job.assignee}</strong></p>}
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note…" style={{ flex: '1 1 220px', padding: '7px 10px', background: 'transparent', border: '1px solid var(--line)', borderRadius: 9, color: 'var(--text)', fontSize: 12.5 }} />
                <button style={btn(true)} disabled={busy || !note.trim()} onClick={() => act({ action: 'note', note })}>Add note</button>
              </div>
              {job.ownerNotes && job.ownerNotes.length > 0 && (
                <div style={{ display: 'grid', gap: 5, marginTop: 10 }}>
                  {job.ownerNotes.map((n, i: number) => (
                    <div key={i} style={{ fontSize: 12, padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 8 }}>
                      <span>{n.note}</span> <span style={{ color: 'var(--muted)', fontSize: 10.5 }}>— {n.by}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Audit timeline */}
            <div style={card}>
              <span style={lab}>Audit timeline</span>
              {!d.audit || d.audit.length === 0 ? <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>No audit entries yet.</p> : (
                <div style={{ display: 'grid', gap: 5, marginTop: 6 }}>
                  {d.audit.map((e) => (
                    <div key={e.id} style={{ fontSize: 11.5, color: 'var(--muted)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ color: 'var(--text)' }}>{e.summary}</span>
                      <span style={{ marginLeft: 'auto' }}>{e.actor} · {new Date(e.at).toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </OperationsShell>
  )
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12.5, padding: '3px 0' }}><span style={{ color: 'var(--muted)' }}>{k}</span><span style={{ fontWeight: 600, textAlign: 'right' }}>{v}</span></div>
}
function Mini({ k, v }: { k: string; v: React.ReactNode }) {
  return <div><div style={{ fontSize: 9.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{k}</div><div style={{ fontSize: 12.5, fontWeight: 700 }}>{v}</div></div>
}
