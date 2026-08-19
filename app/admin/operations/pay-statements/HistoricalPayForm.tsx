'use client'

import { useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { osField as field, osLabel, money } from '../ui'

type Staff = { id: string; name: string; active: boolean }
type PeriodUnit = 'day' | 'week' | 'month' | 'custom'
type EarningKind = 'hourly' | 'daily' | 'fixed'
type EarningRow = { id: number; kind: EarningKind; description: string; quantity: string; rate: string; amount: string }
type DeductionRow = { id: number; label: string; amount: string }

const today = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date())
const toYmd = (d: Date) => d.toISOString().slice(0, 10)

function rangeFor(unit: PeriodUnit, anchor: string): { start: string; end: string } {
  if (unit === 'custom') return { start: anchor, end: anchor }
  const d = new Date(`${anchor}T00:00:00Z`)
  if (unit === 'day') return { start: anchor, end: anchor }
  if (unit === 'week') {
    const offset = (d.getUTCDay() + 6) % 7
    const start = new Date(d); start.setUTCDate(d.getUTCDate() - offset)
    const end = new Date(start); end.setUTCDate(start.getUTCDate() + 6)
    if (toYmd(end) > today()) {
      start.setUTCDate(start.getUTCDate() - 7)
      end.setUTCDate(end.getUTCDate() - 7)
    }
    return { start: toYmd(start), end: toYmd(end) }
  }
  let start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
  let end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
  if (toYmd(end) > today()) {
    start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1))
    end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0))
  }
  return { start: toYmd(start), end: toYmd(end) }
}

function dollars(value: string): number | null {
  const cleaned = value.trim().replace(/[$,\s]/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

function lineAmount(row: EarningRow): number {
  if (row.kind === 'fixed') return dollars(row.amount) ?? 0
  const q = Number(row.quantity)
  const rate = dollars(row.rate)
  return Number.isFinite(q) && q > 0 && rate != null ? Math.round((Math.round(q * 100) * rate) / 100) : 0
}

const rowButton: React.CSSProperties = {
  minHeight: 40, padding: '0 12px', borderRadius: 10, border: '1px solid var(--line)',
  background: 'rgba(255,255,255,.04)', color: 'var(--text)', cursor: 'pointer', fontWeight: 700, fontSize: 12.5,
}

type HistoricalPayInitial = {
  staffId: string
  periodStart?: string
  periodEnd?: string
  periodUnit?: PeriodUnit
  note?: string
}

export default function HistoricalPayForm({ staff, onCreated, initial }: {
  staff: Staff[]
  onCreated: () => Promise<void> | void
  initial?: HistoricalPayInitial
}) {
  const todayValue = today()
  const seededUnit = initial?.periodUnit ?? (initial?.periodStart ? 'custom' : 'week')
  const initialRange = initial?.periodStart && initial?.periodEnd
    ? { start: initial.periodStart, end: initial.periodEnd }
    : rangeFor('week', todayValue)
  const [staffId, setStaffId] = useState(initial?.staffId ?? '')
  const [periodUnit, setPeriodUnit] = useState<PeriodUnit>(seededUnit)
  const [anchor, setAnchor] = useState(initial?.periodStart ?? todayValue)
  const [start, setStart] = useState(initialRange.start)
  const [end, setEnd] = useState(initialRange.end)
  const [paymentDate, setPaymentDate] = useState(todayValue)
  const [paymentMethod, setPaymentMethod] = useState('')
  const [paymentReference, setPaymentReference] = useState('')
  const [note, setNote] = useState(initial?.note ?? '')
  const [lines, setLines] = useState<EarningRow[]>([
    { id: 1, kind: 'hourly', description: 'Regular hours', quantity: '', rate: '', amount: '' },
  ])
  const [deductions, setDeductions] = useState<DeductionRow[]>([])
  const [nextId, setNextId] = useState(2)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reviewing, setReviewing] = useState(false)

  const grossCents = useMemo(() => lines.reduce((sum, row) => sum + lineAmount(row), 0), [lines])
  const deductionCents = useMemo(() => deductions.reduce((sum, row) => sum + (dollars(row.amount) ?? 0), 0), [deductions])
  const netCents = grossCents - deductionCents

  function setPreset(unit: PeriodUnit, value = anchor) {
    setPeriodUnit(unit)
    if (unit !== 'custom') {
      const range = rangeFor(unit, value)
      setStart(range.start); setEnd(range.end)
    }
  }

  function setAnchorAndRange(value: string) {
    setAnchor(value)
    if (periodUnit !== 'custom') {
      const range = rangeFor(periodUnit, value)
      setStart(range.start); setEnd(range.end)
    }
  }

  function updateLine(id: number, patch: Partial<EarningRow>) {
    setLines(current => current.map(row => row.id === id ? { ...row, ...patch } : row))
  }

  function addLine() {
    setLines(current => [...current, { id: nextId, kind: 'fixed', description: 'Prior-period compensation', quantity: '', rate: '', amount: '' }])
    setNextId(id => id + 1)
  }

  function addDeduction() {
    setDeductions(current => [...current, { id: nextId, label: '', amount: '' }])
    setNextId(id => id + 1)
  }

  function review(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!staffId) { setError('Select a crew member.'); return }
    if (grossCents <= 0) { setError('Enter at least one valid earnings amount.'); return }
    if (deductionCents > grossCents) { setError('Deductions cannot exceed gross pay.'); return }
    setReviewing(true)
  }

  async function issue() {
    setBusy(true)
    try {
      const res = await fetch('/api/admin/pay-statements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          action: 'historical', staffId, periodUnit, periodStart: start, periodEnd: end,
          paymentDate, paymentMethod, paymentReference, note,
          lines: lines.map(({ kind, description, quantity, rate, amount }) => ({ kind, description, quantity, rate, amount })),
          deductions: deductions.map(({ label, amount }) => ({ label, amount })),
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) { setError(data.error ?? 'Could not issue the historical statement.'); return }
      await onCreated()
    } catch {
      setError('Connection error — try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={review} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="os-card os-rise" style={{ padding: 20 }}>
        <h2 className="jkos-h" style={{ fontSize: 18 }}>Add prior pay</h2>
        <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>Create a real pay stub for compensation paid before it was tracked in Operion. No job, route, booking, or timeclock entry is required.</p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 12, marginTop: 18 }}>
          <div>
            <label htmlFor="history-staff" style={osLabel}>Crew member</label>
            <select id="history-staff" value={staffId} onChange={e => setStaffId(e.target.value)} required style={{ ...field, marginTop: 6 }}>
              <option value="">Select…</option>
              {staff.map(person => <option key={person.id} value={person.id}>{person.name}{person.active ? '' : ' (inactive)'}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="history-anchor" style={osLabel}>Period containing</label>
            <input id="history-anchor" type="date" value={anchor} onChange={e => setAnchorAndRange(e.target.value)} style={{ ...field, marginTop: 6 }} />
          </div>
          <div>
            <label htmlFor="history-paid" style={osLabel}>Date paid</label>
            <input id="history-paid" type="date" value={paymentDate} onChange={e => setPaymentDate(e.target.value)} required style={{ ...field, marginTop: 6 }} />
          </div>
        </div>

        <fieldset style={{ border: 0, padding: 0, margin: '16px 0 0' }}>
          <legend style={osLabel}>Pay-period scale</legend>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 7 }}>
            {(['day', 'week', 'month', 'custom'] as PeriodUnit[]).map(unit => (
              <button key={unit} type="button" onClick={() => setPreset(unit)} aria-pressed={periodUnit === unit}
                style={{ ...rowButton, textTransform: 'capitalize', color: periodUnit === unit ? '#fff' : 'var(--muted)', background: periodUnit === unit ? 'var(--red)' : rowButton.background }}>
                {unit}
              </button>
            ))}
          </div>
        </fieldset>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12, marginTop: 14 }}>
          <div><label htmlFor="history-start" style={osLabel}>Period start</label><input id="history-start" type="date" value={start} onChange={e => setStart(e.target.value)} disabled={periodUnit !== 'custom'} style={{ ...field, marginTop: 6 }} /></div>
          <div><label htmlFor="history-end" style={osLabel}>Period end</label><input id="history-end" type="date" value={end} onChange={e => setEnd(e.target.value)} disabled={periodUnit !== 'custom'} style={{ ...field, marginTop: 6 }} /></div>
        </div>
      </div>

      <div className="os-card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div><h2 className="jkos-h" style={{ fontSize: 17 }}>Earnings</h2><p style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 2 }}>Mix hourly, daily-rate, and fixed earnings on the same stub.</p></div>
          <button type="button" onClick={addLine} style={rowButton}><Plus size={14} style={{ verticalAlign: -2, marginRight: 5 }} />Add line</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 15 }}>
          {lines.map((row, index) => (
            <div key={row.id} style={{ padding: 14, border: '1px solid var(--line)', borderRadius: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,180px),1fr))', gap: 10 }}>
                <div><label htmlFor={`history-kind-${row.id}`} style={osLabel}>Calculation</label><select id={`history-kind-${row.id}`} value={row.kind} onChange={e => updateLine(row.id, { kind: e.target.value as EarningKind })} style={{ ...field, marginTop: 6 }}><option value="hourly">Hourly rate</option><option value="daily">Daily rate</option><option value="fixed">Fixed amount</option></select></div>
                <div><label htmlFor={`history-description-${row.id}`} style={osLabel}>Description</label><input id={`history-description-${row.id}`} value={row.description} onChange={e => updateLine(row.id, { description: e.target.value })} maxLength={120} placeholder="Regular hours" style={{ ...field, marginTop: 6 }} /></div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10, marginTop: 10, alignItems: 'end' }}>
                {row.kind === 'fixed' ? (
                  <div><label htmlFor={`history-amount-${row.id}`} style={osLabel}>Amount</label><input id={`history-amount-${row.id}`} inputMode="decimal" value={row.amount} onChange={e => updateLine(row.id, { amount: e.target.value })} placeholder="0.00" style={{ ...field, marginTop: 6 }} /></div>
                ) : <>
                  <div><label htmlFor={`history-quantity-${row.id}`} style={osLabel}>{row.kind === 'hourly' ? 'Hours' : 'Days'}</label><input id={`history-quantity-${row.id}`} inputMode="decimal" value={row.quantity} onChange={e => updateLine(row.id, { quantity: e.target.value })} placeholder="0" style={{ ...field, marginTop: 6 }} /></div>
                  <div><label htmlFor={`history-rate-${row.id}`} style={osLabel}>{row.kind === 'hourly' ? 'Hourly rate' : 'Daily rate'}</label><input id={`history-rate-${row.id}`} inputMode="decimal" value={row.rate} onChange={e => updateLine(row.id, { rate: e.target.value })} placeholder="0.00" style={{ ...field, marginTop: 6 }} /></div>
                </>}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 }}>
                  <span><span style={osLabel}>Line total</span><strong className="tabular-nums" style={{ display: 'block', marginTop: 3 }}>{money(lineAmount(row))}</strong></span>
                  {lines.length > 1 && <button type="button" aria-label={`Remove earnings line ${index + 1}`} onClick={() => setLines(current => current.filter(item => item.id !== row.id))} style={{ ...rowButton, color: '#fca5a5' }}><Trash2 size={14} /></button>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="os-card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div><h2 className="jkos-h" style={{ fontSize: 17 }}>Deductions</h2><p style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 2 }}>Optional. Leave empty when the amount paid equals gross pay.</p></div>
          <button type="button" onClick={addDeduction} style={rowButton}><Plus size={14} style={{ verticalAlign: -2, marginRight: 5 }} />Add deduction</button>
        </div>
        {deductions.map((row, index) => (
          <div key={row.id} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,160px),1fr))', gap: 10, marginTop: 12, alignItems: 'end' }}>
            <div><label htmlFor={`history-deduction-label-${row.id}`} style={osLabel}>Label</label><input id={`history-deduction-label-${row.id}`} value={row.label} onChange={e => setDeductions(current => current.map(item => item.id === row.id ? { ...item, label: e.target.value } : item))} placeholder="Deduction" style={{ ...field, marginTop: 6 }} /></div>
            <div><label htmlFor={`history-deduction-amount-${row.id}`} style={osLabel}>Amount</label><input id={`history-deduction-amount-${row.id}`} inputMode="decimal" value={row.amount} onChange={e => setDeductions(current => current.map(item => item.id === row.id ? { ...item, amount: e.target.value } : item))} placeholder="0.00" style={{ ...field, marginTop: 6 }} /></div>
            <button type="button" aria-label={`Remove deduction ${index + 1}`} onClick={() => setDeductions(current => current.filter(item => item.id !== row.id))} style={{ ...rowButton, color: '#fca5a5' }}><Trash2 size={14} /></button>
          </div>
        ))}
      </div>

      <div className="os-card" style={{ padding: 20 }}>
        <h2 className="jkos-h" style={{ fontSize: 17 }}>Payment record</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 12, marginTop: 14 }}>
          <div><label htmlFor="history-method" style={osLabel}>Payment method (optional)</label><select id="history-method" value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)} style={{ ...field, marginTop: 6 }}><option value="">Not recorded</option><option value="cash">Cash</option><option value="check">Check</option><option value="direct_deposit">Direct deposit</option><option value="zelle">Zelle</option><option value="other">Other</option></select></div>
          <div><label htmlFor="history-reference" style={osLabel}>Reference (optional)</label><input id="history-reference" value={paymentReference} onChange={e => setPaymentReference(e.target.value)} maxLength={120} placeholder="Check number or note" style={{ ...field, marginTop: 6 }} /></div>
        </div>
        <div style={{ marginTop: 12 }}><label htmlFor="history-note" style={osLabel}>Internal admin note (optional)</label><textarea id="history-note" value={note} onChange={e => setNote(e.target.value)} maxLength={1000} rows={3} placeholder="Source of the historical payroll information…" style={{ ...field, marginTop: 6, resize: 'vertical' }} /><p style={{ color: 'var(--muted)', fontSize: 11.5, marginTop: 5 }}>Visible to administrators only; never shown on the crew member’s stub.</p></div>
      </div>

      <div className="os-card" style={{ padding: 20 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 12 }}>
          <div><span style={osLabel}>Gross</span><strong className="tabular-nums" style={{ display: 'block', fontSize: 18, marginTop: 4 }}>{money(grossCents)}</strong></div>
          <div><span style={osLabel}>Deductions</span><strong className="tabular-nums" style={{ display: 'block', fontSize: 18, marginTop: 4 }}>{money(deductionCents)}</strong></div>
          <div><span style={osLabel}>Net paid</span><strong className="jkos-h tabular-nums" style={{ display: 'block', fontSize: 24, marginTop: 1 }}>{money(netCents)}</strong></div>
        </div>
        {error && <p role="alert" style={{ color: '#fca5a5', fontSize: 13.5, marginTop: 13 }}>{error}</p>}
        {reviewing ? (
          <div role="group" aria-label="Confirm historical statement" style={{ padding: 14, border: '1px solid rgba(252,211,77,.45)', borderRadius: 12, marginTop: 15 }}>
            <p style={{ fontSize: 13.5 }}>Issue {money(netCents)} net to {staff.find(person => person.id === staffId)?.name ?? 'this crew member'}? Once issued, this statement can only be voided and replaced.</p>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button type="button" onClick={() => setReviewing(false)} disabled={busy} style={rowButton}>Back</button>
              <button type="button" onClick={issue} disabled={busy} className="btn os-tap" style={{ flex: 1, height: 42, borderRadius: 10, justifyContent: 'center' }}>{busy ? 'Issuing…' : 'Issue statement'}</button>
            </div>
          </div>
        ) : (
          <button type="submit" disabled={busy || netCents < 0} className="btn os-tap" style={{ width: '100%', height: 46, borderRadius: 12, marginTop: 15, justifyContent: 'center' }}>Review statement</button>
        )}
        <p style={{ color: 'var(--muted)', fontSize: 11.5, marginTop: 9, textAlign: 'center' }}>Historical statements are immutable. To correct one later, void it and issue a replacement.</p>
      </div>
    </form>
  )
}
