'use client'

// ── Operion — AI Alert detail + owner response workflow ──────────────────────
// Owner-only. Reads GET /api/admin/shadow-alerts/[id] and posts owner actions back to the
// same route (every one authorized server-side and audited). This page renders the API and
// never re-derives alert math. No customer impact.

import { use, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import OperationsShell from '../../../OperationsShell'
import { SEV_COLOR, Chip, type Alert } from '../page'

const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 16 }
const lab: React.CSSProperties = { display: 'block', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', marginBottom: 4 }
const btn: React.CSSProperties = { fontSize: 12.5, fontWeight: 700, padding: '7px 13px', borderRadius: 9, cursor: 'pointer', border: '1px solid var(--line)', background: 'transparent', color: 'var(--text)' }
const nice = (s: string) => s.replace(/_/g, ' ')
const fmtTs = (t: number) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

type Policy = { id: string; type: string; kind: string; severity: string; threshold: number; minSampleSize: number; cooldownMs: number; description: string; requiresAck: boolean } | null
type Related = {
  bookingId: string; bookingNumber?: string; status: string; model?: string; promptVersion?: number
  completedAt?: number; latencyMs?: number; traceId?: string; classification?: string
  outcome?: string; shadowManualReview?: boolean; authoritativeDecision?: string; quoteDeltaUsd?: number
}
type AuditEvent = { id: string; at: number; actor: string; actorType: string; action: string; summary: string; priorStatus?: string; newStatus?: string }
type Payload = { enabled: boolean; alert?: Alert; policy?: Policy; related?: Related[]; audit?: AuditEvent[]; error?: string }

const MUTES = [{ k: '1h', label: '1 hour' }, { k: '24h', label: '24 hours' }, { k: '7d', label: '7 days' }, { k: '30d', label: '30 days' }]

export default function AlertDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [data, setData] = useState<Payload | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [resolveReason, setResolveReason] = useState('')

  const load = useCallback(() => {
    setErr('')
    return fetch(`/api/admin/shadow-alerts/${id}`, { credentials: 'same-origin' })
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) { setErr('Owner access required.'); return }
        if (res.status === 404) { setErr('Alert not found.'); return }
        setData(await res.json())
      })
      .catch(() => setErr('Could not load alert.'))
  }, [id])

  useEffect(() => { load() }, [load])

  // Mark read on open — the only implicit action, and it changes nothing an owner
  // would care about beyond the unread dot.
  useEffect(() => {
    if (data?.alert?.unread) {
      fetch(`/api/admin/shadow-alerts/${id}`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'mark_read' }),
      }).catch(() => { /* the dot is cosmetic — never block the view on it */ })
    }
  }, [data?.alert?.unread, id])

  const act = async (body: Record<string, unknown>) => {
    setBusy(true); setErr('')
    try {
      const res = await fetch(`/api/admin/shadow-alerts/${id}`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(j.error ?? 'Action failed.'); return }
      setNote(''); setResolveReason('')
      await load()
    } catch { setErr('Action failed.') } finally { setBusy(false) }
  }

  const a = data?.alert
  const sev = a ? SEV_COLOR[a.severity] : undefined

  return (
    <OperationsShell>
      <div style={{ display: 'grid', gap: 14, paddingBottom: 40, maxWidth: 980 }}>
        <Link href="/admin/operations/ai/alerts" style={{ fontSize: 12, color: 'var(--muted)', textDecoration: 'none' }}>← All alerts</Link>
        {err && <div style={{ ...card, borderColor: '#f87171', color: '#f87171', fontSize: 13 }}>{err}</div>}
        {data && !data.enabled && <div style={{ ...card, fontSize: 13, color: 'var(--muted)' }}>Alerting is off (SHADOW_ALERTING_ENABLED).</div>}

        {a && (
          <>
            {/* Plain-language summary */}
            <div style={{ ...card, borderLeft: `3px solid ${sev}`, display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <Chip text={a.severity} color={sev} />
                <Chip text={a.status} />
                {a.escalatedAt && <Chip text="ESCALATED" color="#fb923c" />}
                <strong style={{ fontSize: 15 }}>{nice(a.policyType)}</strong>
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)' }}>{a.id}</span>
              </div>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5 }}>{a.reason}</p>
              {data.policy && <p style={{ margin: 0, fontSize: 11.5, color: 'var(--muted)' }}>Policy: {data.policy.description}</p>}
            </div>

            {/* The measurement */}
            <div style={{ ...card, display: 'grid', gap: 10 }}>
              <span style={lab}>Measurement</span>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 10 }}>
                <Field label="Observed" value={String(a.observed)} tone={sev} />
                <Field label="Threshold" value={String(a.threshold)} />
                <Field label="Previous baseline" value={a.comparison !== null ? String(a.comparison) : '—'} />
                <Field label="Sample size" value={String(a.sampleSize)} />
                <Field label="Occurrences" value={String(a.occurrences)} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
                <Field label="First detected" value={fmtTs(a.firstDetectedAt)} />
                <Field label="Most recent" value={fmtTs(a.lastDetectedAt)} />
                <Field label="Scope" value={a.scopeKey} />
                <Field label="Model" value={a.model ?? '—'} />
                <Field label="Deployment" value={a.deployment ?? '—'} />
                <Field label="Business" value={a.business ?? '—'} />
              </div>
              {a.deliveredChannels?.length ? (
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Delivered via: {a.deliveredChannels.join(', ')}</div>
              ) : null}
            </div>

            {/* Readiness impact */}
            {a.readiness && (
              <div style={{ ...card, display: 'grid', gap: 6 }}>
                <span style={lab}>Readiness at detection</span>
                <div style={{ fontSize: 14, fontWeight: 800 }}>{nice(a.readiness.tier)}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Score {a.readiness.score} · {a.readiness.evaluated} evaluated · {a.readiness.agreementPct}% agreement
                </div>
                {a.readiness.blockers.length > 0 && (
                  <div style={{ fontSize: 12, color: '#f87171' }}>Remaining blockers: {a.readiness.blockers.join(' ')}</div>
                )}
              </div>
            )}

            {/* Recommended action — never a claimed root cause. */}
            <div style={{ ...card, display: 'grid', gap: 6 }}>
              <span style={lab}>Recommended owner action</span>
              <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5 }}>{recommendation(a)}</p>
              <p style={{ margin: 0, fontSize: 11, color: 'var(--muted)' }}>
                Any cause named above is a <strong>hypothesis</strong> drawn from the metrics shown — the data shows the
                gap, not its cause. No model is promoted or demoted automatically.
              </p>
            </div>

            {/* Owner actions */}
            <div style={{ ...card, display: 'grid', gap: 10 }}>
              <span style={lab}>Respond</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {a.status === 'OPEN' && <button disabled={busy} onClick={() => act({ action: 'acknowledge' })} style={{ ...btn, borderColor: '#fbbf24', color: '#fbbf24' }}>Acknowledge</button>}
                {a.status === 'MUTED' && <button disabled={busy} onClick={() => act({ action: 'unmute' })} style={btn}>Unmute</button>}
                {(a.status === 'OPEN' || a.status === 'ACKNOWLEDGED') && MUTES.map((m) => (
                  <button key={m.k} disabled={busy} onClick={() => act({ action: 'mute', duration: m.k })} style={btn}>Mute {m.label}</button>
                ))}
              </div>
              {(a.status === 'OPEN' || a.status === 'ACKNOWLEDGED' || a.status === 'MUTED') && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  <input value={resolveReason} onChange={(e) => setResolveReason(e.target.value)} placeholder="Why is this resolved?"
                         style={{ flex: '1 1 240px', padding: '7px 10px', background: 'transparent', border: '1px solid var(--line)', borderRadius: 9, color: 'var(--text)', fontSize: 12.5 }} />
                  <button disabled={busy} onClick={() => act({ action: 'resolve', reason: resolveReason })} style={{ ...btn, borderColor: '#34d399', color: '#34d399' }}>Resolve</button>
                </div>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note…"
                       style={{ flex: '1 1 240px', padding: '7px 10px', background: 'transparent', border: '1px solid var(--line)', borderRadius: 9, color: 'var(--text)', fontSize: 12.5 }} />
                <button disabled={busy || !note.trim()} onClick={() => act({ action: 'note', note })} style={btn}>Add note</button>
              </div>
              {data.policy?.requiresAck && (a.status === 'OPEN' || a.status === 'ACKNOWLEDGED') && (
                <p style={{ margin: 0, fontSize: 11, color: '#fbbf24' }}>
                  This is a safety alert. It will not clear on its own — it stays open until you resolve it.
                </p>
              )}
            </div>

            {/* Related evaluations */}
            {(data.related?.length ?? 0) > 0 && (
              <div style={{ ...card, display: 'grid', gap: 8 }}>
                <span style={lab}>Related evaluations ({data.related!.length})</span>
                <div style={{ display: 'grid', gap: 6 }}>
                  {data.related!.map((r) => (
                    <Link key={r.bookingId} href={`/admin/operations/ai/shadow/${r.bookingId}`}
                          style={{ textDecoration: 'none', color: 'inherit', border: '1px solid var(--line)', borderRadius: 10, padding: '8px 10px', display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', fontSize: 11.5 }}>
                      <strong style={{ fontSize: 12 }}>{r.bookingNumber ?? r.bookingId.slice(0, 10)}</strong>
                      <Chip text={r.status} />
                      {r.outcome && <span style={{ color: 'var(--muted)' }}>{nice(r.outcome)}</span>}
                      {r.classification && <Chip text={r.classification} color="#93c5fd" />}
                      {typeof r.quoteDeltaUsd === 'number' && <span style={{ color: 'var(--muted)' }}>Δ ${Math.round(r.quoteDeltaUsd)}</span>}
                      {r.authoritativeDecision && <span style={{ color: 'var(--muted)' }}>V1: {nice(r.authoritativeDecision)}</span>}
                      <span style={{ marginLeft: 'auto', color: 'var(--muted)' }}>{r.completedAt ? fmtTs(r.completedAt) : ''} →</span>
                    </Link>
                  ))}
                </div>
                {a.relatedTraceIds.length > 0 && (
                  <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>Trace ids: {a.relatedTraceIds.slice(0, 10).join(', ')}</div>
                )}
              </div>
            )}

            {/* Notes */}
            {a.notes.length > 0 && (
              <div style={{ ...card, display: 'grid', gap: 6 }}>
                <span style={lab}>Notes</span>
                {a.notes.map((n, i) => (
                  <div key={i} style={{ fontSize: 12, borderLeft: '2px solid var(--line)', paddingLeft: 8 }}>
                    <div>{n.note}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{n.by} · {fmtTs(n.at)}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Audit timeline */}
            <div style={{ ...card, display: 'grid', gap: 6 }}>
              <span style={lab}>Audit timeline</span>
              {(data.audit?.length ?? 0) === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>No owner actions recorded yet.</div>
              ) : data.audit!.map((e) => (
                <div key={e.id} style={{ fontSize: 11.5, display: 'flex', flexWrap: 'wrap', gap: 8, borderBottom: '1px solid var(--line)', padding: '5px 0' }}>
                  <span style={{ color: 'var(--muted)', minWidth: 110 }}>{fmtTs(e.at)}</span>
                  <strong>{e.actor}</strong>
                  <span>{e.summary}</span>
                  {e.priorStatus && e.newStatus && e.priorStatus !== e.newStatus && (
                    <span style={{ color: 'var(--muted)' }}>{e.priorStatus} → {e.newStatus}</span>
                  )}
                  <span style={{ marginLeft: 'auto', color: 'var(--muted)' }}>{e.id}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </OperationsShell>
  )
}

function Field({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <span style={lab}>{label}</span>
      <div style={{ fontSize: 13, fontWeight: 700, color: tone ?? 'var(--text)', wordBreak: 'break-word' }}>{value}</div>
    </div>
  )
}

/** Deterministic, policy-driven guidance. Deliberately NOT an inferred root cause — where a
 *  cause is suggested it is labelled a hypothesis both here and in the alert text. */
function recommendation(a: Alert): string {
  switch (a.policyType) {
    case 'critical_false_negative':
      return 'Open the related evaluation and decide whether V2 genuinely missed a blocker. If it did, V2 is not safe to widen — classify it a false negative so readiness reflects it. If V1 was over-cautious, classify it and resolve this alert with that reason.'
    case 'readiness_milestone_lost':
      return 'Readiness moved backwards. Review the blockers above and the evaluations behind them before any further rollout. Do not widen shadow traffic while this is open.'
    case 'readiness_milestone_reached':
      return 'Readiness improved. Review the supporting evidence in Shadow Analytics and decide whether to widen shadow traffic. This is your decision — nothing is promoted automatically.'
    case 'high_severity_disagreement':
      return 'Review the evaluation and classify it. If the gap is understood and acceptable, mark it an expected difference so it stops counting against the model.'
    case 'agreement_rate_drop':
    case 'confidence_drop':
    case 'auto_quote_rate_drop':
      return 'Compare the current and previous windows in Shadow Analytics, and check whether a model or prompt version changed between them. If the change was deliberate, resolve this with that reason.'
    case 'manual_review_spike':
      return 'V2 is escalating more work to humans. Check the review-reason frequency in Shadow Analytics — a single dominant reason usually points at one rule, not a general regression.'
    case 'latency_regression':
    case 'cost_per_evaluation_spike':
      return 'Check whether the model or prompt changed between windows, and whether image counts per booking moved. This affects shadow cost only — no customer is waiting on it.'
    case 'evaluation_failure_spike':
      return 'Check the failure categories in Shadow Analytics. Provider timeouts usually clear on their own; invalid-output or image-access failures usually do not.'
    case 'model_prompt_regression':
      return 'One deployment is underperforming its peer. Confirm the sample sizes are comparable before concluding anything, then decide whether to retire the weaker prompt version.'
    case 'queue_backlog':
      return 'Shadow jobs are queuing faster than the worker drains them. This affects shadow throughput only. Check whether the worker flag is on and the cron is running.'
    case 'stale_shadow_telemetry':
      return 'No evaluation has completed recently. Check that the shadow worker flag is on and /api/cron/vision-shadow is running — the pipeline may be silently dead.'
    case 'insufficient_sample_volume':
      return 'There is not enough evidence to judge the model. Select more bookings for shadow analysis, or widen shadow eligibility, before expecting readiness to progress.'
    default:
      return 'Review the measurement above and the related evaluations, then acknowledge or resolve.'
  }
}
