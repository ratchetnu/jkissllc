'use client'

import { useMemo, useState } from 'react'
import type { StoredAiEstimate } from '../../lib/ai/estimate-store'

// ── Owner "Modify Estimate" editor ───────────────────────────────────────────
//
// A dedicated, richer alternative to the quick price override: lets an authorized
// owner adjust the final amount, truck-load range, labor, disposal, trips, item
// notes, and the customer-facing explanation — each shown beside its original AI
// value. Requires a reason, validates every number (no negatives, min ≤ max, whole
// trips), and does NOT send the quote (that stays a separate Approve & send).
// Preserves the original AI analysis + reviewer output (server stores this as an
// additive override). Mobile = stacked; desktop = two-column.

type Props = {
  est: StoredAiEstimate
  busy: string
  run: (action: string, body?: Record<string, unknown>) => void
  onClose: () => void
}

const numOrUndef = (s: string): number | undefined => {
  const t = s.trim()
  if (t === '') return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : NaN // NaN signals "invalid input"
}

export default function ModifyEstimate({ est, busy, run, onClose }: Props) {
  const p = est.pricing
  const a = est.analysis
  const o = est.override
  const aiLoadMin = a?.estimatedTruckLoads?.minimum
  const aiLoadMax = a?.estimatedTruckLoads?.maximum
  const aiDisposalUsd = p.breakdown?.disposalCents != null ? Math.round(p.breakdown.disposalCents / 100) : undefined
  const aiTrips = p.breakdown?.disposalTrips
  const aiLaborLabel = a?.laborEstimate ? `${a.laborEstimate.crewSize} crew · ~${Math.round(a.laborEstimate.likelyMinutes)} min` : '—'

  const [finalUsd, setFinalUsd] = useState(String(o?.overriddenUsd ?? p.recommendedUsd ?? ''))
  const [loadMin, setLoadMin] = useState(String(o?.loadMin ?? aiLoadMin ?? ''))
  const [loadMax, setLoadMax] = useState(String(o?.loadMax ?? aiLoadMax ?? ''))
  const [laborUsd, setLaborUsd] = useState(String(o?.laborUsd ?? ''))
  const [disposalUsd, setDisposalUsd] = useState(String(o?.disposalUsd ?? aiDisposalUsd ?? ''))
  const [trips, setTrips] = useState(String(o?.trips ?? aiTrips ?? ''))
  const [itemNotes, setItemNotes] = useState(o?.itemNotes ?? '')
  const [customerExplanation, setCustomerExplanation] = useState(o?.customerExplanation ?? '')
  const [reason, setReason] = useState('')

  const parsed = useMemo(() => ({
    finalUsd: numOrUndef(finalUsd), loadMin: numOrUndef(loadMin), loadMax: numOrUndef(loadMax),
    laborUsd: numOrUndef(laborUsd), disposalUsd: numOrUndef(disposalUsd), trips: numOrUndef(trips),
  }), [finalUsd, loadMin, loadMax, laborUsd, disposalUsd, trips])

  const error = useMemo(() => {
    const nums: [string, number | undefined][] = [
      ['Final quote', parsed.finalUsd], ['Load minimum', parsed.loadMin], ['Load maximum', parsed.loadMax],
      ['Labor', parsed.laborUsd], ['Disposal', parsed.disposalUsd], ['Trip count', parsed.trips],
    ]
    for (const [label, v] of nums) if (v !== undefined && Number.isNaN(v)) return `${label} must be a number.`
    if (!(parsed.finalUsd && parsed.finalUsd > 0)) return 'Enter a final quote amount greater than 0.'
    for (const [label, v] of nums) if (typeof v === 'number' && !Number.isNaN(v) && v < 0) return `${label} cannot be negative.`
    if (parsed.loadMin !== undefined && parsed.loadMax !== undefined && !Number.isNaN(parsed.loadMin) && !Number.isNaN(parsed.loadMax) && parsed.loadMin > parsed.loadMax) return 'Load minimum cannot exceed the maximum.'
    if (parsed.trips !== undefined && !Number.isNaN(parsed.trips) && !Number.isInteger(parsed.trips)) return 'Trip count must be a whole number.'
    if (!reason.trim()) return 'A reason is required.'
    return ''
  }, [parsed, reason])

  const save = () => {
    if (error || busy === 'ai-modify') return
    const body: Record<string, unknown> = { overriddenUsd: parsed.finalUsd, reason: reason.trim() }
    if (parsed.loadMin !== undefined && !Number.isNaN(parsed.loadMin)) body.loadMin = parsed.loadMin
    if (parsed.loadMax !== undefined && !Number.isNaN(parsed.loadMax)) body.loadMax = parsed.loadMax
    if (parsed.laborUsd !== undefined && !Number.isNaN(parsed.laborUsd)) body.laborUsd = parsed.laborUsd
    if (parsed.disposalUsd !== undefined && !Number.isNaN(parsed.disposalUsd)) body.disposalUsd = parsed.disposalUsd
    if (parsed.trips !== undefined && !Number.isNaN(parsed.trips)) body.trips = parsed.trips
    if (itemNotes.trim()) body.itemNotes = itemNotes.trim()
    if (customerExplanation.trim()) body.customerExplanation = customerExplanation.trim()
    run('ai-modify', body)
    onClose()
  }

  return (
    <div className="mt-3 p-3" style={{ borderRadius: 12, border: '1px solid var(--line)', background: 'rgba(255,255,255,.03)' }}>
      <p className="text-[11px] font-bold uppercase tracking-wide mb-2" style={{ color: 'var(--muted)' }}>Modify estimate</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Final quote ($)" ai={`AI: $${(p.recommendedUsd ?? 0).toLocaleString()}`} value={finalUsd} onChange={setFinalUsd} mode="decimal" />
        <Field label="Load min (trucks)" ai={`AI: ${aiLoadMin ?? '—'}`} value={loadMin} onChange={setLoadMin} mode="decimal" />
        <Field label="Load max (trucks)" ai={`AI: ${aiLoadMax ?? '—'}`} value={loadMax} onChange={setLoadMax} mode="decimal" />
        <Field label="Labor ($)" ai={`AI: ${aiLaborLabel}`} value={laborUsd} onChange={setLaborUsd} mode="decimal" />
        <Field label="Disposal ($)" ai={`AI: ${aiDisposalUsd != null ? `$${aiDisposalUsd}` : '—'}`} value={disposalUsd} onChange={setDisposalUsd} mode="decimal" />
        <Field label="Trip count" ai={`AI: ${aiTrips ?? '—'}`} value={trips} onChange={setTrips} mode="numeric" />
      </div>
      <TextArea label="Item notes / classifications" value={itemNotes} onChange={setItemNotes} placeholder="e.g. reclassify the shed as a single bulky item" />
      <TextArea label="Customer-facing explanation" value={customerExplanation} onChange={setCustomerExplanation} placeholder="What the customer sees with the quote (no internal notes)" />
      <TextArea label="Reason for the change (required)" value={reason} onChange={setReason} placeholder="Why you are modifying the AI estimate" />

      {error && <p className="text-xs mt-1" style={{ color: '#f87171' }}>{error}</p>}
      <p className="text-[11px] mt-2" style={{ color: 'var(--muted)' }}>Saving records an immutable change on the timeline. It does not send the quote — use Approve &amp; send.</p>
      <div className="flex gap-2 mt-2">
        <button type="button" disabled={!!error || busy === 'ai-modify'} onClick={save}
          className="text-xs font-bold px-3 py-2 rounded-lg" style={{ background: 'var(--red)', color: '#fff', opacity: (error || busy === 'ai-modify') ? 0.5 : 1 }}>
          {busy === 'ai-modify' ? '…' : 'Save changes'}
        </button>
        <button type="button" onClick={onClose} className="text-xs font-semibold px-3 py-2 rounded-lg" style={{ background: 'rgba(255,255,255,.08)', color: 'var(--muted)' }}>Cancel</button>
      </div>
    </div>
  )
}

function Field({ label, ai, value, onChange, mode }: { label: string; ai: string; value: string; onChange: (v: string) => void; mode: 'decimal' | 'numeric' }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="flex items-baseline justify-between gap-2">
        <label className="text-[11px] font-semibold" style={{ color: 'var(--muted)' }}>{label}</label>
        <span className="text-[10px]" style={{ color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ai}</span>
      </div>
      <input value={value} inputMode={mode} onChange={e => onChange(e.target.value.replace(mode === 'numeric' ? /[^0-9]/g : /[^0-9.]/g, ''))}
        style={{ display: 'block', width: '100%', maxWidth: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', borderRadius: 8, color: '#fff', padding: '7px 10px', fontSize: 14, marginTop: 3 }} />
    </div>
  )
}

function TextArea({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="mt-2" style={{ minWidth: 0 }}>
      <label className="text-[11px] font-semibold" style={{ color: 'var(--muted)' }}>{label}</label>
      <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={2}
        style={{ display: 'block', width: '100%', maxWidth: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', borderRadius: 8, color: '#fff', padding: '7px 10px', fontSize: 14, marginTop: 3, resize: 'vertical' }} />
    </div>
  )
}
