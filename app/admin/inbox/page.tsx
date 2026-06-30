'use client'

import { useState, useEffect, useCallback } from 'react'
import AdminGate from '../AdminGate'
import { SkeletonList } from '../../components/Skeleton'

type Message = {
  id: string
  direction: 'inbound' | 'outbound'
  channel: 'sms' | 'email' | 'note' | 'system'
  from?: string
  to?: string
  subject?: string
  body: string
  customerName?: string
  customerPhone?: string
  customerEmail?: string
  bookingToken?: string
  bookingNumber?: string
  status: string
  unread: boolean
  reviewState?: 'needs_reply' | 'customer_responded' | 'waiting_on_customer' | 'resolved'
  tags?: string[]
  createdAt: number
}
type AlertConfig = { sms: boolean; email: boolean; smsTo: string; emailTo: string }

type Tab = 'unread' | 'all' | 'archived'
type Chan = '' | 'sms' | 'email'

const iStyle: React.CSSProperties = {
  width: '100%', padding: '11px 13px', background: 'rgba(255,255,255,.05)',
  border: '1px solid rgba(255,255,255,.10)', borderRadius: '9px', color: '#f3f4f6', fontSize: '16px', outline: 'none',
}
const chip = (active: boolean): React.CSSProperties => ({
  fontSize: '12px', fontWeight: 700, padding: '7px 13px', borderRadius: '999px', cursor: 'pointer',
  background: active ? 'var(--red)' : 'rgba(255,255,255,.05)',
  border: `1px solid ${active ? 'var(--red)' : 'rgba(255,255,255,.1)'}`,
  color: active ? '#fff' : 'var(--muted)',
})

const REVIEW_LABEL: Record<NonNullable<Message['reviewState']>, string> = {
  needs_reply: 'Needs Reply', customer_responded: 'Customer Responded',
  waiting_on_customer: 'Waiting on Customer', resolved: 'Resolved',
}
const timeAgo = (ms: number) => {
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function Inbox() {
  const [items, setItems] = useState<Message[]>([])
  const [unread, setUnread] = useState(0)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('unread')
  const [chan, setChan] = useState<Chan>('')
  const [q, setQ] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const p = new URLSearchParams({ tab, ...(chan ? { channel: chan } : {}), ...(q ? { q } : {}) })
      const res = await fetch(`/api/admin/messages?${p}`, { credentials: 'same-origin' })
      if (res.status === 401) return
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'Failed')
      setItems(j.items ?? []); setUnread(j.unread ?? 0)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
    finally { setLoading(false) }
  }, [tab, chan, q])

  useEffect(() => { load() }, [load])
  // light auto-refresh so new replies surface without a manual reload
  useEffect(() => { const t = setInterval(load, 30000); return () => clearInterval(t) }, [load])

  async function act(id: string, action: string, reviewState?: string) {
    try {
      const res = await fetch('/api/admin/messages', {
        method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action, reviewState }),
      })
      const j = await res.json()
      if (res.ok) setUnread(j.unread ?? unread)
    } catch { /* ignore */ }
    await load()
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-black text-white" style={{ letterSpacing: '-0.03em' }}>Customer Replies</h1>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            {unread > 0 ? <span style={{ color: 'var(--red)' }}>{unread} unread</span> : 'All caught up'} · texts &amp; emails from customers
          </p>
        </div>
        <button onClick={load} className="text-xs font-semibold px-3 py-2 rounded-lg"
          style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--text)' }}>Refresh</button>
      </div>

      <AlertSettings />

      {/* filters */}
      <div className="flex flex-wrap items-center gap-2 mt-4 mb-3">
        {(['unread', 'all', 'archived'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)} style={chip(tab === t)}>
            {t === 'unread' ? `Unread${unread ? ` (${unread})` : ''}` : t === 'all' ? 'All' : 'Archived'}
          </button>
        ))}
        <span style={{ width: 1, height: 20, background: 'rgba(255,255,255,.1)' }} />
        {([['', 'All'], ['sms', 'SMS'], ['email', 'Email']] as [Chan, string][]).map(([c, label]) => (
          <button key={c} onClick={() => setChan(c)} style={chip(chan === c)}>{label}</button>
        ))}
      </div>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, phone, email, message…" style={{ ...iStyle, marginBottom: 14 }} />

      {err && <p className="text-sm mb-3" style={{ color: '#f87171' }}>{err}</p>}

      {loading ? (
        <SkeletonList rows={4} />
      ) : items.length === 0 ? (
        <div className="glass-card p-8 text-center" style={{ borderRadius: '16px' }}>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            {tab === 'unread' ? 'No unread replies. New customer texts and emails appear here.' : 'No messages here.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {items.map(m => (
            <div key={m.id} className="glass-card p-4" style={{ borderRadius: '14px', borderLeft: m.unread ? '3px solid var(--red)' : '3px solid transparent' }}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-black text-white flex items-center gap-2 flex-wrap">
                    {m.unread && <span style={{ width: 8, height: 8, borderRadius: 99, background: 'var(--red)', display: 'inline-block' }} />}
                    {m.customerName || m.customerPhone || m.from || 'Unknown'}
                    <span className="text-xs font-semibold px-2 py-0.5 rounded" style={{ background: 'rgba(255,255,255,.06)', color: 'var(--muted)' }}>
                      {m.channel === 'sms' ? 'SMS' : m.channel === 'email' ? 'Email' : m.channel}
                    </span>
                    {m.tags?.includes('opt-out') && <span className="text-xs font-bold" style={{ color: '#fbbf24' }}>OPT-OUT</span>}
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
                    {m.customerPhone || m.customerEmail || m.from || ''}
                    {m.bookingNumber && <> · <a href="/admin/bookings" className="font-semibold" style={{ color: 'var(--red)' }}>{m.bookingNumber}</a></>}
                    {' · '}{timeAgo(m.createdAt)}
                  </p>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  {m.unread && (
                    <button onClick={() => act(m.id, 'read')} className="text-xs font-semibold px-3 py-1.5 rounded-lg"
                      style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--text)' }}>Mark read</button>
                  )}
                  {m.status !== 'archived' && (
                    <button onClick={() => act(m.id, 'archive')} className="text-xs font-semibold px-3 py-1.5 rounded-lg"
                      style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--muted)' }}>Archive</button>
                  )}
                </div>
              </div>
              {m.subject && <p className="text-sm font-semibold text-white mt-2">{m.subject}</p>}
              <p className="text-sm mt-1.5" style={{ color: '#d1d5db', whiteSpace: 'pre-wrap' }}>{m.body}</p>
              <div className="flex items-center gap-2 mt-3 flex-wrap">
                <span className="text-xs" style={{ color: 'var(--muted)' }}>Status:</span>
                {(['needs_reply', 'customer_responded', 'waiting_on_customer', 'resolved'] as const).map(s => (
                  <button key={s} onClick={() => act(m.id, 'review', s)}
                    style={{ ...chip(m.reviewState === s), fontSize: 11, padding: '4px 9px' }}>{REVIEW_LABEL[s]}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Owner alert settings (editable: text me / email me) ──────────────────────
function AlertSettings() {
  const [cfg, setCfg] = useState<AlertConfig | null>(null)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch('/api/admin/alerts', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null).then(j => j && setCfg(j.config)).catch(() => {})
  }, [])

  async function save(patch: Partial<AlertConfig>) {
    if (!cfg) return
    setSaving(true)
    try {
      const res = await fetch('/api/admin/alerts', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const j = await res.json()
      if (res.ok) setCfg(j.config)
    } catch { /* ignore */ } finally { setSaving(false) }
  }

  if (!cfg) return null
  return (
    <div className="glass-card p-4" style={{ borderRadius: '14px' }}>
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between gap-3 text-left">
        <span className="text-sm font-bold text-white">When a customer replies, alert me by…</span>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          {[cfg.sms && 'Text', cfg.email && 'Email'].filter(Boolean).join(' + ') || 'Off'} {open ? '▲' : '▼'}
        </span>
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          <Toggle label={`Text me${cfg.smsTo ? ` (${cfg.smsTo})` : ' — set a phone below'}`} on={cfg.sms} disabled={saving} onChange={v => save({ sms: v })} />
          <Toggle label={`Email me${cfg.emailTo ? ` (${cfg.emailTo})` : ''}`} on={cfg.email} disabled={saving} onChange={v => save({ email: v })} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input defaultValue={cfg.smsTo} placeholder="Alert phone (+1…)" style={iStyle}
              onBlur={e => e.target.value !== cfg.smsTo && save({ smsTo: e.target.value })} />
            <input defaultValue={cfg.emailTo} placeholder="Alert email" style={iStyle}
              onBlur={e => e.target.value !== cfg.emailTo && save({ emailTo: e.target.value })} />
          </div>
        </div>
      )}
    </div>
  )
}

function Toggle({ label, on, disabled, onChange }: { label: string; on: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => !disabled && onChange(!on)} disabled={disabled}
      className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg"
      style={{ background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)' }}>
      <span className="text-sm" style={{ color: 'var(--text)' }}>{label}</span>
      <span style={{ width: 40, height: 22, borderRadius: 99, background: on ? 'var(--red)' : 'rgba(255,255,255,.15)', position: 'relative', transition: 'all .15s', flexShrink: 0 }}>
        <span style={{ position: 'absolute', top: 2, left: on ? 20 : 2, width: 18, height: 18, borderRadius: 99, background: '#fff', transition: 'all .15s' }} />
      </span>
    </button>
  )
}

export default function InboxPage() {
  return <AdminGate title="Customer Replies"><Inbox /></AdminGate>
}
