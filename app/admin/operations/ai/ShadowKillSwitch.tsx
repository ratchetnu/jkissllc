'use client'

// ── Compact V2 inference kill switch ─────────────────────────────────────────
// The emergency stop, kept one tap from the operational Queue. Self-contained: reads/writes the
// existing owner-gated /api/admin/shadow-kill-switch (no behavior change — same API, same audit).
// The full budget + usage surface lands in Usage & Controls (Increment 3); this preserves the
// safety control in the meantime. Halts ONLY new V2 inference — V1, analytics, and ground-truth
// editing are never affected.

import { useEffect, useState } from 'react'

type State = { enabled: boolean; envKilled?: boolean; override?: boolean | null; effective?: boolean }

export default function ShadowKillSwitch() {
  const [s, setS] = useState<State | null>(null)
  const [busy, setBusy] = useState(false)

  const load = () => fetch('/api/admin/shadow-kill-switch', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null)).then(setS).catch(() => {})
  useEffect(() => { load() }, [])

  if (s && !s.enabled) return null
  if (!s) return null

  const killed = !!s.effective
  const envForced = !!s.envKilled
  const toggle = async () => {
    setBusy(true)
    try {
      await fetch('/api/admin/shadow-kill-switch', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: !killed }) })
      await load()
    } finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', background: 'var(--card)', border: `1px solid ${killed ? '#f8717155' : 'var(--line)'}`, borderRadius: 12, padding: '10px 14px' }}>
      <span style={{ fontSize: 11.5, fontWeight: 800, color: killed ? '#f87171' : '#34d399' }}>
        {killed ? '● V2 inference HALTED' : '● V2 inference running'}
      </span>
      <span style={{ fontSize: 11, color: 'var(--muted)' }}>V1, analytics &amp; ground truth are never affected.</span>
      <button disabled={busy || envForced} onClick={toggle}
        title={envForced ? 'Forced off by the SHADOW_V2_KILL_SWITCH environment flag' : ''}
        style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, padding: '7px 13px', borderRadius: 9, cursor: envForced ? 'not-allowed' : 'pointer', border: `1px solid ${killed ? '#34d39955' : '#f8717155'}`, background: 'transparent', color: killed ? '#34d399' : '#f87171', opacity: envForced ? 0.5 : 1 }}>
        {busy ? '…' : killed ? 'Resume V2' : 'Emergency stop'}
      </button>
    </div>
  )
}
