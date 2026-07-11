'use client'

import { useState } from 'react'
import { ThumbsUp, ThumbsDown } from 'lucide-react'

// Shared 👍/👎 control for AI drafts. Attaches helpful/not-helpful feedback to a prior
// AI call by its callId (returned from the AI routes) — the signal the AI Control
// Center trends per feature and prompt version. Renders nothing without a callId, and
// is fully fail-soft: a failed write just leaves the buttons enabled.
export default function AiFeedback({ callId, label = 'Was this draft helpful?' }: { callId?: string; label?: string }) {
  const [choice, setChoice] = useState<'helpful' | 'not_helpful' | null>(null)
  const [busy, setBusy] = useState(false)
  if (!callId) return null

  async function rate(helpful: boolean) {
    if (busy || choice) return
    const next = helpful ? 'helpful' : 'not_helpful'
    setBusy(true); setChoice(next)
    try {
      const res = await fetch('/api/admin/ai/feedback', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId, helpful }),
      })
      if (!res.ok) setChoice(null)   // let them try again
    } catch { setChoice(null) } finally { setBusy(false) }
  }

  const btn = (active: boolean): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 8,
    border: '1px solid var(--line, rgba(255,255,255,.12))', cursor: choice ? 'default' : 'pointer',
    background: active ? 'rgba(134,239,172,.15)' : 'rgba(255,255,255,.04)',
    color: active ? '#86efac' : 'var(--muted, #94a3b8)', fontSize: 12, fontWeight: 600,
  })

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
      {choice ? (
        <span style={{ fontSize: 12, color: 'var(--muted, #94a3b8)' }}>Thanks for the feedback.</span>
      ) : (
        <>
          <span style={{ fontSize: 12, color: 'var(--muted, #94a3b8)' }}>{label}</span>
          <button type="button" onClick={() => rate(true)} disabled={busy} aria-label="Helpful" style={btn(choice === 'helpful')}><ThumbsUp size={13} /></button>
          <button type="button" onClick={() => rate(false)} disabled={busy} aria-label="Not helpful" style={btn(false)}><ThumbsDown size={13} /></button>
        </>
      )}
    </div>
  )
}
