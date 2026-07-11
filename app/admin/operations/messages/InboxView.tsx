'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Search, ArrowDownLeft, ArrowUpRight, Archive, Check, Send, MessageSquare, Mail, Radio, Bell, ChevronLeft, ExternalLink } from 'lucide-react'
import { Avatar } from '../ui'
import { api, relTime } from './commsShared'

type Msg = {
  id: string; direction: 'inbound' | 'outbound'; channel: string; kind?: string | null; body: string; subject?: string
  from?: string; customerName?: string; customerPhone?: string; customerEmail?: string; bookingToken?: string; bookingNumber?: string
  staffId?: string; crewName?: string; crewAckKind?: string | null
  status: string; unread: boolean; createdAt: number; tags?: string[]
}

const isCrew = (m: Msg) => !!m.staffId || ['reminder', 'dispatch', 'crew_dm', 'broadcast'].includes(m.kind || '') || (m.tags ?? []).includes('route')
const who = (m: Msg) => m.crewName || m.customerName || m.customerPhone || m.from || m.customerEmail || 'Unknown'
const KIND_ICON: Record<string, typeof Bell> = { reminder: Bell, dispatch: Radio, crew_dm: MessageSquare, broadcast: Radio }

// Upgraded inbox (request Part 12). Split conversation list + detail on desktop,
// full-screen conversation on mobile. Customer + Crew streams in one hub — reuses the
// existing /api/admin/messages store, no second messaging system.
export default function InboxView() {
  const [items, setItems] = useState<Msg[]>([])
  const [cat, setCat] = useState<'customer' | 'crew'>('customer')
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [reply, setReply] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try { const d = await api<{ items: Msg[] }>('/api/admin/messages?tab=all'); setItems(d.items || []) }
    catch { /* ignore */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const shown = useMemo(() => {
    const query = q.trim().toLowerCase()
    return items.filter(m => (cat === 'crew') === isCrew(m)).filter(m => !query || who(m).toLowerCase().includes(query) || m.body.toLowerCase().includes(query))
  }, [items, cat, q])
  const unread = (c: 'customer' | 'crew') => items.filter(m => m.unread && ((c === 'crew') === isCrew(m))).length

  const open = items.find(m => m.id === openId) || null

  async function act(id: string, action: string) {
    setBusy(id)
    try { await fetch('/api/admin/messages', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ id, action }) }); await load() }
    finally { setBusy('') }
  }

  async function sendReply(m: Msg) {
    const text = reply.trim()
    if (!text) return
    setBusy('reply')
    try {
      if (m.staffId) {
        await api('/api/admin/comms/send', { method: 'POST', body: JSON.stringify({ origin: 'bulk', templateId: 'custom', title: 'Message from dispatch', message: text, channels: ['inapp', 'sms'], requireAck: false, staffIds: [m.staffId] }) })
      } else {
        await api('/api/admin/messages/reply', { method: 'POST', body: JSON.stringify({ text, channel: 'both', bookingToken: m.bookingToken, phone: m.customerPhone, email: m.customerEmail, customerName: m.customerName }) })
      }
      setReply(''); await load()
    } catch (e) { alert(e instanceof Error ? e.message : 'Reply failed') }
    finally { setBusy('') }
  }

  return (
    <div>
      {/* header controls */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        {(['customer', 'crew'] as const).map(c => (
          <button key={c} className="cc-seg" data-active={cat === c} onClick={() => { setCat(c); setOpenId('') }} style={{ textTransform: 'capitalize' }}>
            {c}{unread(c) > 0 && <span className="cc-seg-badge">{unread(c)}</span>}
          </button>
        ))}
        <a href="/admin/inbox" className="cc-seg" style={{ marginLeft: 'auto', textDecoration: 'none' }}><ExternalLink size={14} /> Full inbox</a>
      </div>
      <div style={{ position: 'relative', marginBottom: 14 }}>
        <Search size={16} style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search conversations…" style={{ width: '100%', padding: '11px 14px 11px 38px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 12, color: 'var(--text)', fontSize: 15, outline: 'none' }} />
      </div>

      <div className="cc-split">
        {/* list */}
        <div style={{ display: openId ? undefined : 'block' }}>
          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{[0, 1, 2].map(i => <div key={i} className="os-card" style={{ height: 64 }}><div className="skeleton" style={{ width: '55%', height: 14, margin: 14, borderRadius: 7 }} /></div>)}</div>
          ) : shown.length === 0 ? (
            <div className="os-card os-rise" style={{ padding: 34, textAlign: 'center' }}>
              <Check size={26} style={{ color: '#86efac' }} />
              <p className="jkos-h" style={{ fontSize: 17, marginTop: 8 }}>No {cat} messages</p>
              <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 4 }}>{cat === 'crew' ? 'Reminders, dispatch blasts and crew replies show here.' : 'Customer replies show here.'}</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {shown.map((m, i) => {
                const active = m.id === openId
                const K = KIND_ICON[m.kind || ''] || (m.channel === 'email' ? Mail : MessageSquare)
                return (
                  <button key={m.id} onClick={() => { setOpenId(m.id); setReply(''); if (m.unread) act(m.id, 'read') }} className="os-card os-tap"
                    style={{ textAlign: 'left', cursor: 'pointer', padding: 12, border: `1px solid ${active ? 'var(--red)' : 'var(--line)'}`, background: active ? 'color-mix(in srgb, var(--red) 7%, transparent)' : undefined, animationDelay: `${Math.min(i * 20, 160)}ms` }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <Avatar name={who(m)} size={36} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {m.direction === 'inbound' ? <ArrowDownLeft size={12} style={{ color: '#86efac', flexShrink: 0 }} /> : <ArrowUpRight size={12} style={{ color: 'var(--muted)', flexShrink: 0 }} />}
                          <span style={{ fontWeight: 700, fontSize: 14.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{who(m)}</span>
                          {m.unread && <span style={{ width: 7, height: 7, borderRadius: 99, background: 'var(--red)', flexShrink: 0 }} />}
                          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>{relTime(m.createdAt)}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3 }}>
                          <K size={11} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                          <span style={{ fontSize: 12.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.subject ? `${m.subject} — ` : ''}{m.body}</span>
                        </div>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* detail — desktop side panel */}
        <div className="cc-split-detail-desktop">
          {open ? <Detail m={open} busy={busy} reply={reply} setReply={setReply} onSend={() => sendReply(open)} onAct={act} /> : (
            <div className="os-card" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}><MessageSquare size={26} /><p style={{ marginTop: 8, fontSize: 14 }}>Select a conversation</p></div>
          )}
        </div>
      </div>

      {/* detail — mobile full-screen overlay */}
      {open && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 65, background: 'var(--bg)', overflowY: 'auto', padding: '16px 16px 120px', display: 'block' }} className="cc-mobile-detail">
          <button onClick={() => setOpenId('')} className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: 'var(--muted)', fontSize: 14, fontWeight: 700, cursor: 'pointer', marginBottom: 12 }}><ChevronLeft size={18} /> Back</button>
          <Detail m={open} busy={busy} reply={reply} setReply={setReply} onSend={() => sendReply(open)} onAct={act} />
        </div>
      )}
      <style>{`@media (min-width: 900px){ .cc-mobile-detail{ display:none !important; } }`}</style>
    </div>
  )
}

function Detail({ m, busy, reply, setReply, onSend, onAct }: { m: Msg; busy: string; reply: string; setReply: (v: string) => void; onSend: () => void; onAct: (id: string, a: string) => void }) {
  return (
    <div className="os-card os-rise" style={{ padding: 16 }}>
      <div style={{ display: 'flex', gap: 11, alignItems: 'center', marginBottom: 14 }}>
        <Avatar name={who(m)} size={44} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 16 }}>{who(m)}</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{m.staffId ? 'Crew' : 'Customer'}{m.bookingNumber ? ` · ${m.bookingNumber}` : ''}{m.crewAckKind ? ` · responded: ${m.crewAckKind.replace('_', ' ')}` : ''}</div>
        </div>
      </div>

      <div style={{ padding: 13, borderRadius: 14, background: m.direction === 'inbound' ? 'rgba(34,197,94,.08)' : 'rgba(255,255,255,.04)', border: '1px solid var(--line)' }}>
        {m.subject && <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>{m.subject}</div>}
        <div style={{ fontSize: 14.5, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{m.body}</div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>{new Date(m.createdAt).toLocaleString('en-US')}</div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {m.unread && <button onClick={() => onAct(m.id, 'read')} disabled={!!busy} className="os-tap" style={detailBtn}><Check size={13} /> Mark read</button>}
        <button onClick={() => onAct(m.id, 'archive')} disabled={!!busy} className="os-tap" style={detailBtn}><Archive size={13} /> Archive</button>
      </div>

      <div style={{ marginTop: 14 }}>
        <textarea value={reply} onChange={e => setReply(e.target.value)} rows={2} placeholder={m.staffId ? 'Message this crew member…' : 'Reply to customer…'} style={{ width: '100%', padding: '11px 13px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 12, color: 'var(--text)', fontSize: 14.5, outline: 'none', resize: 'vertical' }} />
        <button onClick={onSend} disabled={busy === 'reply' || !reply.trim()} className="os-tap" style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 7, background: 'var(--red)', color: '#fff', border: 'none', borderRadius: 12, padding: '10px 18px', fontSize: 14, fontWeight: 800, cursor: 'pointer', opacity: reply.trim() ? 1 : .5 }}><Send size={15} /> {busy === 'reply' ? 'Sending…' : 'Send'}</button>
      </div>
    </div>
  )
}
const detailBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', fontSize: 12.5, fontWeight: 700, borderRadius: 9, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: 'var(--muted)', cursor: 'pointer' }
