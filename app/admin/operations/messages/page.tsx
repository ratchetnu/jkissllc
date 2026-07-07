'use client'

import { useCallback, useEffect, useState } from 'react'
import { MessageSquare, Mail, ArrowDownLeft, ArrowUpRight, Archive, Check, ExternalLink } from 'lucide-react'
import OperationsShell from './../OperationsShell'

type Msg = {
  id: string; direction: 'inbound' | 'outbound'; channel: string; body: string; subject?: string
  from?: string; customerName?: string; customerPhone?: string; customerEmail?: string
  bookingNumber?: string; status: string; unread: boolean; createdAt: number
}

const fmtTs = (t: number) => {
  const d = new Date(t), now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
const who = (m: Msg) => m.customerName || m.customerPhone || m.from || m.customerEmail || 'Unknown'

function Messages() {
  const [tab, setTab] = useState<'unread' | 'all'>('unread')
  const [items, setItems] = useState<Msg[]>([])
  const [unread, setUnread] = useState(0)
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState('')
  const [busy, setBusy] = useState('')

  const load = useCallback(async (t: 'unread' | 'all') => {
    setLoading(true)
    try { const d = await fetch(`/api/admin/messages?tab=${t}`, { credentials: 'same-origin' }).then(r => r.json()); setItems(d.items || []); setUnread(d.unread ?? 0) }
    catch { /* ignore */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { load(tab) }, [load, tab])

  async function act(id: string, action: string) {
    setBusy(id)
    try { const d = await fetch('/api/admin/messages', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ id, action }) }).then(r => r.json()); if (d.unread != null) setUnread(d.unread); load(tab) }
    finally { setBusy('') }
  }

  return (
    <div style={{ maxWidth: 640, margin: '0 auto' }}>
      <div className="os-rise" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--muted)' }}>{unread} unread</p>
          <h1 className="jkos-h" style={{ fontSize: 'clamp(28px,6vw,40px)' }}>Messages</h1>
        </div>
        <a href="/admin/inbox" className="btn-ghost os-tap" style={{ borderRadius: 999, height: 40, fontSize: 13 }}><ExternalLink size={15} /> Full inbox</a>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {(['unread', 'all'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className="os-tap"
            style={{ padding: '8px 16px', borderRadius: 999, fontSize: 13.5, fontWeight: 700, cursor: 'pointer', textTransform: 'capitalize', border: `1px solid ${tab === t ? 'var(--red)' : 'var(--line)'}`, background: tab === t ? 'var(--red)' : 'transparent', color: tab === t ? '#fff' : 'var(--muted)' }}>{t}</button>
        ))}
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{[0, 1, 2].map(i => <div key={i} className="os-card" style={{ padding: 15 }}><div className="skeleton" style={{ width: '40%', height: 14, borderRadius: 7 }} /><div className="skeleton" style={{ width: '75%', height: 12, borderRadius: 6, marginTop: 9 }} /></div>)}</div>
      ) : items.length === 0 ? (
        <div className="os-card os-rise" style={{ padding: 34, textAlign: 'center' }}>
          <Check size={28} style={{ color: '#86efac' }} />
          <p className="jkos-h" style={{ fontSize: 18, marginTop: 10 }}>{tab === 'unread' ? 'All caught up' : 'No messages'}</p>
          <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 6 }}>{tab === 'unread' ? 'No unread messages right now.' : 'Customer replies will show here.'}</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {items.map((m, i) => {
            const open = openId === m.id
            const Ch = m.channel === 'email' ? Mail : MessageSquare
            const Dir = m.direction === 'inbound' ? ArrowDownLeft : ArrowUpRight
            return (
              <div key={m.id} className="os-card os-rise" style={{ overflow: 'hidden', animationDelay: `${Math.min(i * 30, 200)}ms` }}>
                <button onClick={() => { setOpenId(o => o === m.id ? '' : m.id); if (m.unread) act(m.id, 'read') }} className="os-tap" style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: 15 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <Dir size={14} style={{ color: m.direction === 'inbound' ? '#86efac' : 'var(--muted)', flexShrink: 0 }} />
                    <Ch size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                    <span style={{ fontWeight: 700, fontSize: 15, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{who(m)}</span>
                    {m.bookingNumber && <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>{m.bookingNumber}</span>}
                    {m.unread && <span style={{ width: 8, height: 8, borderRadius: 99, background: 'var(--red)', flexShrink: 0 }} />}
                    <span style={{ fontSize: 12, color: 'var(--muted)', flexShrink: 0 }}>{fmtTs(m.createdAt)}</span>
                  </div>
                  <p style={{ fontSize: 13.5, color: 'var(--muted)', marginTop: 7, marginLeft: 23, ...(open ? {} : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) }}>{m.subject ? `${m.subject} — ` : ''}{m.body}</p>
                </button>
                {open && (
                  <div style={{ padding: '0 15px 15px 38px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {m.unread && <button onClick={() => act(m.id, 'read')} disabled={busy === m.id} className="os-tap" style={btn}><Check size={13} /> Mark read</button>}
                    <button onClick={() => act(m.id, 'archive')} disabled={busy === m.id} className="os-tap" style={btn}><Archive size={13} /> Archive</button>
                    <a href="/admin/inbox" className="os-tap" style={{ ...btn, textDecoration: 'none', color: '#93c5fd' }}><ExternalLink size={13} /> Reply</a>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const btn: React.CSSProperties = { padding: '6px 12px', fontSize: 12.5, fontWeight: 700, borderRadius: 9, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: 'var(--muted)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }

export default function MessagesPage() {
  return <OperationsShell><Messages /></OperationsShell>
}
