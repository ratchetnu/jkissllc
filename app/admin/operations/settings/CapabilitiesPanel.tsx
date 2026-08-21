'use client'

// ── Optional features — the owner-facing view of the capability profile ─────
//
// Four states, deliberately distinguishable at a glance, because they need four
// different responses:
//
//   Not in use        A decision, not a fault. Nothing to fix, nothing degraded.
//   Setup needed      Switched on, credentials missing. Names the VARIABLES.
//   On                Working.
//   Problem           Configured, and the last real call failed.
//
// The toggle is a REQUEST, not the decision: the server re-checks membership,
// permission and dependency closure, and refuses anything impossible. This panel
// renders the refusal rather than pretending the change landed.

import { useCallback, useEffect, useRef, useState } from 'react'

type Capability = {
  id: string
  displayName: string
  kind: string
  provider?: string
  state: 'not_installed' | 'not_in_pack' | 'disabled' | 'blocked' | 'setup_required' | 'ready' | 'degraded'
  code: string
  enabled: boolean
  configured: boolean | null
  operational: boolean
  selectionSource: string
  blockedBy: string[]
  missingVars: string[]
  configurable: boolean
}
type Payload = { capabilities: Capability[]; usingDefaults: boolean; warnings: string[] }

const TONE: Record<Capability['state'], { label: string; color: string }> = {
  ready: { label: 'On', color: '#34d399' },
  disabled: { label: 'Not in use', color: 'var(--muted)' },
  setup_required: { label: 'Setup needed', color: '#fbbf24' },
  degraded: { label: 'Problem', color: '#f87171' },
  blocked: { label: 'Needs another feature', color: '#fbbf24' },
  not_installed: { label: 'Not in this build', color: 'var(--muted)' },
  not_in_pack: { label: 'Not part of this product', color: 'var(--muted)' },
}

export default function CapabilitiesPanel() {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const inflight = useRef(false)

  const load = useCallback(async () => {
    if (inflight.current) return
    inflight.current = true
    try {
      const res = await fetch('/api/admin/capabilities', { credentials: 'same-origin', cache: 'no-store' })
      if (res.status === 403) { setData(null); setError('Only an admin can see or change optional features.'); return }
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'Could not load optional features.')
      setData(j); setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load optional features.')
    } finally { inflight.current = false }
  }, [])

  useEffect(() => { void load() }, [load])

  const toggle = async (c: Capability) => {
    setSaving(c.id); setError('')
    try {
      const res = await fetch('/api/admin/capabilities', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capabilities: { [c.id]: { selection: c.enabled ? 'disabled' : 'enabled' } } }),
      })
      const j = await res.json()
      if (!res.ok) {
        // A refused configuration is shown as its own sentence, not a generic failure.
        setError(j.errors?.map((e: { message: string }) => e.message).join(' · ') || j.error || 'That change was refused.')
        return
      }
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That change was refused.')
    } finally { setSaving(null) }
  }

  // Only the OPTIONAL provider adapters are offered here. Core capabilities are the
  // product; putting a switch next to them would suggest a choice that does not exist.
  const optional = (data?.capabilities ?? []).filter(c => c.provider)

  return (
    <div className="os-card os-rise" style={{ padding: 22 }}>
      <h2 className="jkos-h" style={{ fontSize: 18, marginBottom: 4 }}>Optional features</h2>
      <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16, lineHeight: 1.55 }}>
        Card payments, text messages and email are optional. Turning one off is a choice, not a fault:
        the app stays healthy, bookings and invoices keep working, and software updates keep arriving.
      </p>

      {error && <p role="alert" style={{ fontSize: 13, color: '#fca5a5', marginBottom: 12, fontWeight: 600 }}>{error}</p>}
      {data?.usingDefaults && (
        <p role="alert" style={{ fontSize: 12.5, color: '#fbbf24', marginBottom: 12 }}>
          Your saved settings could not be read, so these are the defaults. Nothing has been changed.
        </p>
      )}
      {!data && !error && <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p>}

      <div style={{ display: 'grid', gap: 10 }}>
        {optional.map(c => {
          const tone = TONE[c.state]
          const busy = saving === c.id
          return (
            <div key={c.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 0', borderTop: '1px solid var(--line)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontWeight: 700, fontSize: 14.5 }}>{c.displayName}</p>
                <p style={{ fontSize: 12.5, color: tone.color, fontWeight: 600, marginTop: 2 }}>{tone.label}</p>
                {c.state === 'setup_required' && c.missingVars.length > 0 && (
                  <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                    Still needed: <code>{c.missingVars.join('</code>, <code>')}</code>. Add these in your hosting
                    settings — they are never stored here.
                  </p>
                )}
                {c.state === 'blocked' && (
                  <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>Turn on {c.blockedBy.join(', ')} first.</p>
                )}
                {c.selectionSource === 'credential-inferred' && (
                  <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>
                    Set automatically from whether the credentials are present. Choosing here overrides that.
                  </p>
                )}
              </div>
              <button
                role="switch"
                aria-checked={c.enabled}
                aria-label={`${c.displayName}: ${c.enabled ? 'on' : 'off'}`}
                disabled={busy || !c.configurable || c.state === 'not_installed' || c.state === 'not_in_pack'}
                onClick={() => toggle(c)}
                className="os-tap"
                style={{
                  width: 50, height: 30, borderRadius: 999, border: 'none', padding: 3, flexShrink: 0,
                  cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1,
                  background: c.enabled ? 'var(--red)' : 'rgba(255,255,255,.14)',
                }}
              >
                <span style={{ display: 'block', width: 24, height: 24, borderRadius: 999, background: '#fff', transform: c.enabled ? 'translateX(20px)' : 'translateX(0)', transition: 'transform .2s var(--os-spring)' }} />
              </button>
            </div>
          )
        })}
        {data && optional.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 13 }}>No optional features are available in this build.</p>}
      </div>
    </div>
  )
}
