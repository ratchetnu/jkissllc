'use client'

import { useCallback, useEffect, useState } from 'react'
import AdminGate from '../../AdminGate'

type Line = { routeToken?: string; routeNumber?: string; routeDate?: string; description: string; amountCents: number }
type Invoice = {
  token: string; invoiceNumber: string; businessName: string; clientName?: string; clientEmail?: string
  periodStart?: string; periodEnd?: string; lines: Line[]; notes?: string
  status: 'draft' | 'sent' | 'paid' | 'void'; subtotalCents: number; amountPaidCents: number
  sentAt?: number; paidAt?: number; paidMethod?: string
}

const money = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const fmtDate = (iso?: string) => { if (!iso) return ''; const d = new Date(`${iso}T12:00:00Z`); return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) }
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const CHIP: Record<Invoice['status'], { bg: string; fg: string; label: string }> = {
  draft: { bg: 'rgba(255,255,255,.08)', fg: '#cbd5e1', label: 'Draft' },
  sent: { bg: 'rgba(59,130,246,.15)', fg: '#93c5fd', label: 'Sent' },
  paid: { bg: 'rgba(34,197,94,.16)', fg: '#86efac', label: 'Paid' },
  void: { bg: 'rgba(255,255,255,.06)', fg: '#94a3b8', label: 'Void' },
}
const iStyle: React.CSSProperties = { width: '100%', padding: '9px 11px', background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 9, color: '#f3f4f6', fontSize: 13.5, outline: 'none' }
const btn: React.CSSProperties = { padding: '6px 12px', fontSize: 12, fontWeight: 700, borderRadius: 8, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: 'var(--muted)', cursor: 'pointer' }

function Invoices() {
  const [items, setItems] = useState<Invoice[]>([])
  const [businessNames, setBusinessNames] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [openId, setOpenId] = useState('')

  const now = new Date()
  const [gen, setGen] = useState({ businessName: '', start: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), end: ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0)), clientName: '', clientEmail: '' })
  const [preview, setPreview] = useState<{ count: number; suggestedCents: number } | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [inv, routes] = await Promise.all([
        fetch('/api/admin/route-invoices', { credentials: 'same-origin' }).then(r => r.json()),
        fetch('/api/admin/routes', { credentials: 'same-origin' }).then(r => r.json()),
      ])
      if (inv.error) setError(inv.error === 'UPSTASH_NOT_CONFIGURED' ? 'Redis is not configured.' : inv.error)
      setItems(inv.items || [])
      setBusinessNames([...new Set(((routes.items || []) as { businessName?: string }[]).map(r => r.businessName).filter((b): b is string => !!b))].sort())
    } catch { setError('Failed to load invoices.') } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  // Live preview of billable routes for the chosen client + period.
  useEffect(() => {
    const { businessName, start, end } = gen
    if (!businessName || !start || !end) { setPreview(null); return }
    let alive = true
    const q = new URLSearchParams({ preview: '1', business: businessName, start, end })
    fetch(`/api/admin/route-invoices?${q}`, { credentials: 'same-origin' }).then(r => r.json())
      .then(d => { if (alive) setPreview({ count: d.count || 0, suggestedCents: d.suggestedCents || 0 }) }).catch(() => {})
    return () => { alive = false }
  }, [gen])

  async function generate(e: React.FormEvent) {
    e.preventDefault(); setCreating(true); setMsg('')
    try {
      const res = await fetch('/api/admin/route-invoices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ action: 'generate', ...gen }) })
      const d = await res.json()
      if (!res.ok) { setMsg(d.error || 'Could not generate.'); return }
      setMsg(`Invoice ${d.invoice.invoiceNumber} created from ${d.count} route(s) — review the amounts, then send.`)
      setGen(g => ({ ...g, clientName: '', clientEmail: '' }))
      await load(); setOpenId(d.invoice.token)
    } catch { setMsg('Network error.') } finally { setCreating(false) }
  }

  const setG = (k: keyof typeof gen) => (e: React.ChangeEvent<HTMLInputElement>) => setGen(g => ({ ...g, [k]: e.target.value }))

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-3xl font-black text-white" style={{ letterSpacing: '-0.03em' }}>Client Invoices</h1>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>Bill contract clients for completed routes.</p>
        </div>
        <a href="/admin/routes" style={{ ...btn, textDecoration: 'none' }}>← Dispatch</a>
      </div>

      {msg && <div className="mt-4 text-sm" style={{ padding: '10px 14px', borderRadius: 10, background: 'rgba(224,35,58,.08)', border: '1px solid rgba(224,35,58,.2)', color: '#fca5a5' }}>{msg}</div>}

      {/* Generate */}
      <form onSubmit={generate} className="glass-card my-6" style={{ borderRadius: 16, padding: 20 }}>
        <p className="text-sm font-bold text-white mb-3">New invoice from completed routes</p>
        <div className="grid sm:grid-cols-2 gap-3">
          <input required list="inv-bn" placeholder="Client / business name *" value={gen.businessName} onChange={setG('businessName')} style={iStyle} />
          <datalist id="inv-bn">{businessNames.map(b => <option key={b} value={b} />)}</datalist>
          <input placeholder="Client contact name" value={gen.clientName} onChange={setG('clientName')} style={iStyle} />
          <input type="email" placeholder="Client email (to send + pay)" value={gen.clientEmail} onChange={setG('clientEmail')} style={iStyle} />
          <div />
          <label className="flex flex-col gap-1" style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>Period from
            <input type="date" required value={gen.start} max={gen.end} onChange={setG('start')} style={iStyle} /></label>
          <label className="flex flex-col gap-1" style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>Period to
            <input type="date" required value={gen.end} min={gen.start} onChange={setG('end')} style={iStyle} /></label>
        </div>
        {preview && (
          <p className="text-sm mt-3" style={{ color: preview.count ? '#86efac' : 'var(--muted)' }}>
            {preview.count ? `${preview.count} billable route(s) · suggested ${money(preview.suggestedCents)} (from contractor rates — edit before sending)` : 'No completed, un-billed routes for that client in this period.'}
          </p>
        )}
        <button type="submit" disabled={creating || !preview?.count} className="btn mt-3" style={{ justifyContent: 'center', opacity: preview?.count ? 1 : .5 }}>{creating ? 'Generating…' : 'Generate invoice'}</button>
      </form>

      {/* List */}
      {loading ? <p style={{ color: 'var(--muted)' }}>Loading…</p>
        : error ? <p style={{ color: '#f87171' }}>{error}</p>
        : items.length === 0 ? <p style={{ color: 'var(--muted)' }}>No invoices yet.</p>
        : (
        <div className="flex flex-col gap-3">
          {items.map(inv => (
            <InvoiceRow key={inv.token} inv={inv} open={openId === inv.token} onToggle={() => setOpenId(o => o === inv.token ? '' : inv.token)} onChanged={load} setMsg={setMsg} />
          ))}
        </div>
      )}
    </div>
  )
}

function InvoiceRow({ inv, open, onToggle, onChanged, setMsg }: { inv: Invoice; open: boolean; onToggle: () => void; onChanged: () => void; setMsg: (s: string) => void }) {
  const chip = CHIP[inv.status]
  const [lines, setLines] = useState(() => inv.lines.map(l => ({ ...l, amount: (l.amountCents / 100).toFixed(2) })))
  const [clientName, setClientName] = useState(inv.clientName || '')
  const [clientEmail, setClientEmail] = useState(inv.clientEmail || '')
  const [notes, setNotes] = useState(inv.notes || '')
  const [busy, setBusy] = useState('')
  const editable = inv.status === 'draft' || inv.status === 'sent'
  const subtotal = lines.reduce((s, l) => s + Math.round((parseFloat(l.amount) || 0) * 100), 0)

  async function patch(body: Record<string, unknown>, tag: string) {
    setBusy(tag)
    try {
      const res = await fetch(`/api/admin/route-invoices/${inv.token}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) })
      const d = await res.json()
      if (!res.ok) setMsg(d.error || 'Action failed.')
      else { setMsg(tag === 'send' ? 'Invoice emailed to the client.' : tag === 'save' ? 'Saved.' : tag === 'paid' ? 'Marked paid.' : tag === 'void' ? 'Invoice voided.' : 'Done.'); onChanged() }
    } catch { setMsg('Network error.') } finally { setBusy('') }
  }
  const save = () => patch({ action: 'update', clientName, clientEmail, notes, lines: lines.map(l => ({ routeToken: l.routeToken, routeNumber: l.routeNumber, routeDate: l.routeDate, description: l.description, amountCents: Math.round((parseFloat(l.amount) || 0) * 100) })) }, 'save')
  async function del() { if (!confirm('Delete this invoice? Its routes become billable again.')) return; setBusy('del'); try { await fetch(`/api/admin/route-invoices/${inv.token}`, { method: 'DELETE', credentials: 'same-origin' }); onChanged() } finally { setBusy('') } }
  function copyLink() { navigator.clipboard?.writeText(`${location.origin}/invoice/${inv.token}`); setMsg('Invoice link copied.') }

  return (
    <div className="glass-card" style={{ borderRadius: 14, padding: 16 }}>
      <button onClick={onToggle} className="w-full flex items-center justify-between gap-3" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}>
        <div className="flex items-center gap-2 flex-wrap">
          <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: '#e5e7eb', fontWeight: 700 }}>{inv.invoiceNumber}</span>
          <span style={{ fontSize: 11, fontWeight: 800, padding: '2px 9px', borderRadius: 99, background: chip.bg, color: chip.fg }}>{chip.label}</span>
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>{inv.businessName}</span>
        </div>
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 15, fontWeight: 800, color: '#fff' }}>{money(inv.subtotalCents)}</span>
          <span style={{ color: 'var(--muted)' }}>{open ? '▲' : '▼'}</span>
        </div>
      </button>

      {open && (
        <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--line)' }}>
          <div className="grid sm:grid-cols-2 gap-2.5 mb-3">
            <input placeholder="Client contact name" value={clientName} onChange={e => setClientName(e.target.value)} disabled={!editable} style={iStyle} />
            <input type="email" placeholder="Client email" value={clientEmail} onChange={e => setClientEmail(e.target.value)} disabled={!editable} style={iStyle} />
          </div>

          <div className="flex flex-col gap-2">
            {lines.map((l, i) => (
              <div key={i} className="flex items-center gap-2">
                <div style={{ minWidth: 96, fontSize: 11.5, color: 'var(--muted)' }}>{l.routeNumber || 'Manual'}<br />{fmtDate(l.routeDate)}</div>
                <input value={l.description} onChange={e => setLines(ls => ls.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} disabled={!editable} style={{ ...iStyle, flex: 1 }} />
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 9, top: 9, color: 'var(--muted)', fontSize: 13.5 }}>$</span>
                  <input value={l.amount} onChange={e => setLines(ls => ls.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} disabled={!editable} inputMode="decimal" style={{ ...iStyle, width: 92, paddingLeft: 20, textAlign: 'right' }} />
                </div>
                {editable && <button onClick={() => setLines(ls => ls.filter((_, j) => j !== i))} aria-label="Remove line" style={{ ...btn, padding: '6px 9px', color: '#f87171' }}>×</button>}
              </div>
            ))}
          </div>
          {editable && <button onClick={() => setLines(ls => [...ls, { description: '', amountCents: 0, amount: '0.00' }])} style={{ ...btn, marginTop: 8 }}>+ Add line</button>}

          <textarea placeholder="Notes shown on the invoice (optional)" value={notes} onChange={e => setNotes(e.target.value)} disabled={!editable} rows={2} style={{ ...iStyle, marginTop: 12, resize: 'vertical' }} />

          <div className="flex items-center justify-between mt-3" style={{ fontSize: 15 }}>
            <span style={{ color: 'var(--muted)', fontWeight: 700 }}>Subtotal</span>
            <span style={{ fontWeight: 900, color: '#fff' }}>{money(subtotal)}</span>
          </div>

          <div className="flex items-center gap-2 flex-wrap mt-4 pt-3" style={{ borderTop: '1px solid var(--line)' }}>
            {editable && <button onClick={save} disabled={busy !== ''} className="btn" style={{ height: 34 }}>{busy === 'save' ? 'Saving…' : 'Save'}</button>}
            {editable && <button onClick={() => patch({ action: 'send' }, 'send')} disabled={busy !== ''} style={{ ...btn, color: '#93c5fd' }}>{busy === 'send' ? 'Sending…' : 'Save & send'}</button>}
            {inv.status !== 'paid' && inv.status !== 'void' && <button onClick={() => patch({ action: 'mark_paid' }, 'paid')} disabled={busy !== ''} style={{ ...btn, color: '#86efac' }}>Mark paid</button>}
            <button onClick={copyLink} style={btn}>Copy link</button>
            <a href={`/invoice/${inv.token}`} target="_blank" rel="noopener noreferrer" style={{ ...btn, textDecoration: 'none' }}>Open</a>
            {inv.status !== 'void' && inv.status !== 'paid' && <button onClick={() => patch({ action: 'void' }, 'void')} disabled={busy !== ''} style={{ ...btn, color: '#fca5a5' }}>Void</button>}
            <button onClick={del} disabled={busy !== ''} style={{ ...btn, color: '#f87171', marginLeft: 'auto' }}>Delete</button>
          </div>
          {!editable && inv.status === 'paid' && <p className="text-xs mt-2" style={{ color: 'var(--muted)' }}>Paid{inv.paidMethod ? ` by ${inv.paidMethod}` : ''} — locked.</p>}
        </div>
      )}
    </div>
  )
}

export default function InvoicesPage() {
  return <AdminGate title="Client Invoices"><Invoices /></AdminGate>
}
