'use client'

// ── Optional features — the owner's switchboard ─────────────────────────────
//
// Every optional capability this business could run, in plain language, with four
// states that need four different responses:
//
//   Not in use     A decision, not a fault. Nothing to fix, nothing degraded.
//   Setup needed   Switched on, credentials missing. Names the VARIABLES.
//   On             Working.
//   Problem        Configured, and the last real call failed.
//
// Plus two the tenant did not choose and cannot fix here: `Not on your plan` and
// `Not in this product`. They are shown rather than hidden, because a control that
// silently disappears reads as a bug.
//
// The toggle is a REQUEST, not the decision. The server re-checks membership,
// permission and dependency closure and refuses anything impossible; this panel
// renders the refusal instead of pretending the change landed.

import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './settings.module.css'

type Capability = {
  id: string
  displayName: string
  kind: string
  domain: string
  provider?: string
  state: 'not_installed' | 'not_in_pack' | 'unavailable_on_plan' | 'disabled' | 'blocked' | 'setup_required' | 'ready' | 'degraded'
  code: string
  enabled: boolean
  configured: boolean | null
  operational: boolean
  selectionSource: string
  blockedBy: string[]
  missingVars: string[]
  configurable: boolean
  description: string
  disabledConsequence?: string
  mandatoryReason?: string
}
type Payload = { capabilities: Capability[]; usingDefaults: boolean; initialized: boolean; warnings: string[] }

const TONE: Record<Capability['state'], { label: string; color: string }> = {
  ready: { label: 'On', color: '#34d399' },
  disabled: { label: 'Not in use', color: 'var(--muted)' },
  setup_required: { label: 'Setup needed', color: '#fbbf24' },
  degraded: { label: 'Problem', color: '#f87171' },
  blocked: { label: 'Needs another feature first', color: '#fbbf24' },
  unavailable_on_plan: { label: 'Not on your plan', color: 'var(--muted)' },
  not_installed: { label: 'Not in this build', color: 'var(--muted)' },
  not_in_pack: { label: 'Not in this product', color: 'var(--muted)' },
}

/** Grouped so the screen reads as a business, not as a module list. */
const GROUPS: { title: string; blurb: string; match: (c: Capability) => boolean }[] = [
  {
    title: 'Getting paid',
    blurb: 'How money reaches you. Invoices, balances and offline payments work regardless of what is switched on here.',
    match: (c) => c.domain === 'Payments' || c.domain === 'Invoicing',
  },
  {
    title: 'Talking to customers and crew',
    blurb: 'How messages leave the building. Every message is still recorded either way — this is only about delivery.',
    match: (c) => c.domain === 'Comms',
  },
  {
    title: 'Taking work in',
    blurb: 'How jobs arrive and get priced.',
    match: (c) => c.domain === 'Sales/Booking' || c.domain === 'Sales' || c.domain === 'AI',
  },
  {
    title: 'Crew and the field',
    blurb: 'Hiring, pay, equipment and on-site evidence.',
    match: (c) => ['Workforce', 'Compensation', 'Compliance', 'Equipment', 'Claims'].includes(c.domain),
  },
]

export default function CapabilitiesPanel() {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const [activeGroup, setActiveGroup] = useState('')
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
        // A refused configuration gets its own sentence, not a generic failure.
        setError(j.errors?.map((e: { message: string }) => e.message).join(' · ') || j.error || 'That change was refused.')
        return
      }
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That change was refused.')
    } finally { setSaving(null) }
  }

  // Core capabilities are the product; a switch beside them would suggest a choice
  // that does not exist. The ones a business genuinely chooses are shown.
  const optional = (data?.capabilities ?? []).filter(c => c.kind !== 'core' && c.state !== 'not_installed')
  const grouped = GROUPS.map(g => ({ ...g, items: optional.filter(g.match) }))
    .filter(g => g.items.length > 0)
  const ungrouped = optional.filter(c => !GROUPS.some(g => g.match(c)))
  const availableGroups = [
    ...grouped.map(g => ({ id: g.title, title: g.title, blurb: g.blurb, items: g.items })),
    ...(ungrouped.length > 0 ? [{ id: 'Everything else', title: 'Everything else', blurb: 'Additional choices for this product.', items: ungrouped }] : []),
  ]
  const selectedGroup = availableGroups.find(group => group.id === activeGroup) ?? availableGroups[0]

  const row = (c: Capability) => {
    const tone = TONE[c.state]
    const busy = saving === c.id
    const fixedHere = !c.configurable || c.state === 'not_in_pack' || c.state === 'unavailable_on_plan'
    return (
      <div key={c.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '13px 0', borderTop: '1px solid var(--line)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontWeight: 700, fontSize: 14.5 }}>{c.displayName}</p>
          <p style={{ fontSize: 12.5, color: tone.color, fontWeight: 600, marginTop: 2 }}>{tone.label}</p>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>{c.description}</p>

          {c.state === 'setup_required' && c.missingVars.length > 0 && (
            <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 5 }}>
              Still needed: <code>{c.missingVars.join('</code>, <code>')}</code>. Add these in your hosting settings —
              they are never stored here, and you can add them whenever you are ready.
            </p>
          )}
          {c.state === 'blocked' && (
            <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 5 }}>Turn on {c.blockedBy.join(', ')} first.</p>
          )}
          {c.state === 'unavailable_on_plan' && (
            <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 5 }}>Your current plan does not include this.</p>
          )}
          {/* The question an owner actually has before flipping a switch. */}
          {c.enabled && c.disabledConsequence && (
            <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 5, lineHeight: 1.5 }}>
              <strong style={{ color: 'var(--text)' }}>If you turn this off: </strong>{c.disabledConsequence}
            </p>
          )}
          {!c.configurable && c.mandatoryReason && (
            <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 5, lineHeight: 1.5 }}>{c.mandatoryReason}</p>
          )}
          {c.selectionSource === 'legacy-uninitialized' && (
            <p style={{ fontSize: 11.5, color: '#fbbf24', marginTop: 5 }}>
              Set automatically from whether the credentials exist. Choosing here records a real decision.
            </p>
          )}
        </div>
        <button
          role="switch"
          aria-checked={c.enabled}
          aria-label={`${c.displayName}: ${c.enabled ? 'on' : 'off'}`}
          disabled={busy || fixedHere}
          onClick={() => toggle(c)}
          className="os-tap"
          style={{
            width: 50, height: 30, borderRadius: 999, border: 'none', padding: 3, flexShrink: 0,
            cursor: busy ? 'wait' : fixedHere ? 'not-allowed' : 'pointer',
            opacity: busy ? 0.6 : fixedHere ? 0.35 : 1,
            background: c.enabled ? 'var(--red)' : 'rgba(255,255,255,.14)',
          }}
        >
          <span style={{ display: 'block', width: 24, height: 24, borderRadius: 999, background: '#fff', transform: c.enabled ? 'translateX(20px)' : 'translateX(0)', transition: 'transform .2s var(--os-spring)' }} />
        </button>
      </div>
    )
  }

  return (
    <div>
      <div className={styles.panelHeading}><h2 className="jkos-h" style={{ fontSize: 22 }}>Optional features</h2><p>Choose what this business uses. Disabled providers never block software updates.</p></div>
      <div className="os-card os-rise" style={{ padding: 22 }}>
      <h3 className="jkos-h" style={{ fontSize: 18, marginBottom: 4 }}>Feature choices</h3>
      <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16, lineHeight: 1.55 }}>
        These are yours to choose. Turning one off is a decision, not a fault: the app stays healthy,
        your bookings and invoices keep working, your existing records are kept, and software updates
        keep arriving exactly as before. You can set a provider up later without redeploying anything.
      </p>

      {error && <p role="alert" style={{ fontSize: 13, color: '#fca5a5', marginBottom: 12, fontWeight: 600 }}>{error}</p>}
      {data?.usingDefaults && (
        <p role="alert" style={{ fontSize: 12.5, color: '#fbbf24', marginBottom: 12 }}>
          Your saved settings could not be read, so these are the defaults. Nothing has been changed.
        </p>
      )}
      {data && !data.initialized && (
        <p style={{ fontSize: 12.5, color: '#fbbf24', marginBottom: 12, lineHeight: 1.5 }}>
          Nothing has been decided yet for this business — payments, texts and email are still being worked
          out from which credentials exist. Flipping any switch here records a real decision for that feature.
        </p>
      )}
      {!data && !error && <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p>}

      {availableGroups.length > 0 && <div className={styles.groupPicker} aria-label="Feature groups">
        {availableGroups.map(group => <button key={group.id} type="button" aria-pressed={selectedGroup?.id === group.id} className={`${styles.groupButton} os-tap`} onClick={() => setActiveGroup(group.id)}>{group.title}</button>)}
      </div>}
      {selectedGroup && <section aria-label={selectedGroup.title}>
        <h3 style={{ fontSize: 14.5, fontWeight: 800 }}>{selectedGroup.title}</h3>
        <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3, lineHeight: 1.5 }}>{selectedGroup.blurb}</p>
        <div style={{ marginTop: 6 }}>{selectedGroup.items.map(row)}</div>
      </section>}
      {data && optional.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 13 }}>No optional features are available in this build.</p>}
      </div>
    </div>
  )
}
