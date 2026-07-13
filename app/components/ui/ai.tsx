'use client'
// ── AI-specific surfaces ─────────────────────────────────────────────────────
//
// The cards that make AI explainable and approvable: an explanation block (always
// shows confidence + evidence), an insight card, and an approval card with the
// approve/reject affordance. Presentational only — the caller wires real domain
// data + handlers. Consistent with the governance model in 07-ai-operating-layer.md.

import { type ReactNode } from 'react'
import { Card, StatusBadge, Button, type Tone } from './primitives'

const INK = 'var(--ink, #f3f4f6)'
const INK_MUTED = 'var(--ink-muted, #9ca3af)'

function confidenceTone(c: number): Tone {
  return c >= 0.8 ? 'green' : c >= 0.5 ? 'amber' : 'grey'
}

// ── AiExplanation ────────────────────────────────────────────────────────────
export function AiExplanation({ explanation, confidence, evidence }: { explanation: string; confidence: number; evidence?: string[] }) {
  return (
    <div style={{ borderLeft: '3px solid var(--red, #E0002A)', paddingLeft: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: INK_MUTED }}>AI</span>
        <StatusBadge tone={confidenceTone(confidence)}>{Math.round(confidence * 100)}% confidence</StatusBadge>
      </div>
      <div style={{ color: INK, fontSize: 14 }}>{explanation}</div>
      {evidence && evidence.length > 0 && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: INK_MUTED, fontSize: 12 }}>
          {evidence.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
    </div>
  )
}

const SEV_TONE: Record<string, Tone> = { critical: 'red', high: 'red', medium: 'amber', low: 'blue', info: 'grey' }

// ── InsightCard ──────────────────────────────────────────────────────────────
export function InsightCard({ insight, action }: {
  insight: { title: string; severity: string; explanation: string; evidence: string[]; confidence: number; recommendedAction: string; category: string }
  action?: ReactNode
}) {
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={{ fontWeight: 700, color: INK }}>{insight.title}</div>
        <StatusBadge tone={SEV_TONE[insight.severity] ?? 'grey'}>{insight.severity}</StatusBadge>
      </div>
      <div style={{ marginTop: 8 }}>
        <AiExplanation explanation={insight.explanation} confidence={insight.confidence} evidence={insight.evidence} />
      </div>
      <div style={{ marginTop: 10, fontSize: 13, color: INK }}>
        <span style={{ color: INK_MUTED }}>Recommended: </span>{insight.recommendedAction}
      </div>
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </Card>
  )
}

// ── ApprovalCard ─────────────────────────────────────────────────────────────
export function ApprovalCard({ request, onApprove, onReject }: {
  request: { requestedAction: string; requestingWorkerId: string; actionPreview: string; explanation: string; confidence: number; expectedImpact: string; riskClass: string; status: string }
  onApprove?: () => void
  onReject?: () => void
}) {
  const decided = request.status !== 'pending'
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={{ fontWeight: 700, color: INK }}>{request.requestedAction}</div>
        <StatusBadge tone={request.riskClass === 'restricted' ? 'red' : request.riskClass === 'high' ? 'amber' : 'grey'}>{request.riskClass}</StatusBadge>
      </div>
      <div style={{ fontSize: 12, color: INK_MUTED, marginTop: 2 }}>Requested by {request.requestingWorkerId}</div>
      <div style={{ marginTop: 10, padding: 10, background: 'color-mix(in srgb, var(--ink,#fff) 6%, transparent)', borderRadius: 10, fontSize: 13, color: INK }}>{request.actionPreview}</div>
      <div style={{ marginTop: 10 }}>
        <AiExplanation explanation={request.explanation} confidence={request.confidence} evidence={[`Expected impact: ${request.expectedImpact}`]} />
      </div>
      {!decided && (onApprove || onReject) && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          {onApprove && <Button size="sm" onClick={onApprove}>Approve</Button>}
          {onReject && <Button size="sm" variant="danger" onClick={onReject}>Reject</Button>}
        </div>
      )}
    </Card>
  )
}
