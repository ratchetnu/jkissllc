'use client'

// The prompt shown after a pricing or pay rate changes: does this apply only to
// future routes, to specific upcoming ones, or to nothing already on the board?
//
// Completed routes are never an option. They keep the money they ran at — that's
// enforced on the server (lib/route-reprice), not just hidden here.
import { useCallback, useEffect, useState } from 'react'
import { CalendarClock, Check, ListChecks, MinusCircle } from 'lucide-react'
import { fmtDay, money, osLabel } from './ui'

export type ApplyTo = 'none' | 'future' | 'selected'

export type Candidate = {
  token: string
  routeNumber: string
  routeDate: string
  businessName: string
  status: string
  currentPriceCents?: number
  currentPayCents?: number
}

type Choice = { applyTo: ApplyTo; routeTokens: string[] }

const OPTIONS: { key: ApplyTo; label: string; hint: string; Icon: typeof Check }[] = [
  { key: 'none', label: 'Only future routes', hint: 'Nothing already on the board changes.', Icon: MinusCircle },
  { key: 'future', label: 'All upcoming routes', hint: 'Re-price every live route dated today or later.', Icon: CalendarClock },
  { key: 'selected', label: 'Pick specific routes', hint: 'Choose exactly which upcoming routes to re-price.', Icon: ListChecks },
]

export default function ApplyScope({ candidatesUrl, mode, onCancel, onConfirm, busy }: {
  candidatesUrl: string                    // GET → { items: Candidate[] }
  mode: 'price' | 'pay'                    // which column to preview
  onCancel: () => void
  onConfirm: (c: Choice) => void
  busy?: boolean
}) {
  // Default to re-pricing live routes: a rate/pay change almost always means "from
  // now on," and the old 'none' default silently left every scheduled route at the
  // stale number until the owner noticed to switch it.
  const [applyTo, setApplyTo] = useState<ApplyTo>('future')
  const [cands, setCands] = useState<Candidate[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await fetch(candidatesUrl, { credentials: 'same-origin' }).then(r => r.json())
      setCands(d.items || [])
    } catch { setCands([]) } finally { setLoading(false) }
  }, [candidatesUrl])

  // Only fetch the route list when the admin actually wants to pick from it.
  useEffect(() => { if (applyTo === 'selected' && !cands.length && !loading) load() }, [applyTo, cands.length, loading, load])

  const toggle = (t: string) => setPicked(p => { const n = new Set(p); if (n.has(t)) n.delete(t); else n.add(t); return n })
  const cur = (c: Candidate) => (mode === 'price' ? c.currentPriceCents : c.currentPayCents)

  return (
    <div className="os-card" style={{ padding: 16, marginTop: 12, border: '1px solid var(--red)' }}>
      <p style={{ fontSize: 13.5, fontWeight: 800 }}>This rate changed. What should it apply to?</p>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3, marginBottom: 12 }}>
        Completed routes always keep the {mode === 'price' ? 'price' : 'pay'} they ran at — they&rsquo;re never changed.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {OPTIONS.map(o => {
          const on = applyTo === o.key
          return (
            <button key={o.key} type="button" onClick={() => setApplyTo(o.key)} className="os-tap"
              style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 13px', borderRadius: 12, cursor: 'pointer', textAlign: 'left', background: on ? 'rgba(224,0,42,.10)' : 'rgba(255,255,255,.03)', border: `1px solid ${on ? 'var(--red)' : 'var(--line)'}`, color: 'var(--text)' }}>
              <o.Icon size={17} style={{ color: on ? 'var(--red-glow)' : 'var(--muted)', flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700 }}>{o.label}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{o.hint}</div>
              </div>
              <div style={{ width: 20, height: 20, borderRadius: 999, flexShrink: 0, border: `2px solid ${on ? 'var(--red)' : 'var(--line)'}`, background: on ? 'var(--red)' : 'transparent', display: 'grid', placeItems: 'center' }}>{on && <Check size={13} color="#fff" />}</div>
            </button>
          )
        })}
      </div>

      {applyTo === 'selected' && (
        <div style={{ marginTop: 12 }}>
          <div style={{ ...osLabel, marginBottom: 7 }}>Upcoming routes</div>
          {loading ? (
            <div className="skeleton" style={{ width: '100%', height: 44, borderRadius: 10 }} />
          ) : cands.length === 0 ? (
            <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>No upcoming routes to re-price.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
              {cands.map(c => {
                const on = picked.has(c.token)
                return (
                  <label key={c.token} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px', borderRadius: 10, cursor: 'pointer', background: on ? 'rgba(224,0,42,.08)' : 'rgba(255,255,255,.03)', border: `1px solid ${on ? 'var(--red)' : 'var(--line)'}` }}>
                    <input type="checkbox" checked={on} onChange={() => toggle(c.token)} style={{ accentColor: 'var(--red)', width: 16, height: 16, flexShrink: 0 }} />
                    <span style={{ fontSize: 12.5, color: 'var(--muted)', minWidth: 62 }}>{fmtDay(c.routeDate)}</span>
                    <span style={{ flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.businessName}</span>
                    <span className="tabular-nums" style={{ fontSize: 12.5, color: 'var(--muted)' }}>{typeof cur(c) === 'number' ? money(cur(c) as number) : 'unset'}</span>
                  </label>
                )
              })}
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
        <button
          onClick={() => onConfirm({ applyTo, routeTokens: applyTo === 'selected' ? [...picked] : [] })}
          disabled={busy || (applyTo === 'selected' && picked.size === 0)}
          className="btn os-tap"
          style={{ borderRadius: 11, height: 40, flex: 1, justifyContent: 'center', opacity: busy || (applyTo === 'selected' && picked.size === 0) ? .55 : 1 }}>
          {busy ? 'Saving…' : applyTo === 'selected' ? `Save & re-price ${picked.size} route${picked.size === 1 ? '' : 's'}` : 'Save'}
        </button>
        <button onClick={onCancel} disabled={busy} className="btn-ghost os-tap" style={{ borderRadius: 11, height: 40 }}>Cancel</button>
      </div>
    </div>
  )
}
