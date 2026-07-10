'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Send, Bell, Radio, MessageSquare } from 'lucide-react'
import PortalShell from '../PortalShell'

// The crew inbox (request Part 12, crew side). Full conversation with dispatch —
// reminders, blasts, and two-way messages — in one clean, mobile-first thread.
type Msg = { id: string; direction: string; channel: string; kind: string | null; subject?: string; body: string; createdAt: number; crewAckKind: string | null }

const KIND_ICON: Record<string, typeof Bell> = { reminder: Bell, dispatch: Radio, broadcast: Radio }

function fmt(t: number) { return new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }

function Inbox() {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/portal/messages', { credentials: 'same-origin' })
      if (r.ok) { const d = await r.json(); setMsgs(d.messages || []) }
      await fetch('/api/portal/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ action: 'read' }) })
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => { endRef.current?.scrollIntoView() }, [msgs])

  async function send() {
    const t = text.trim()
    if (!t) return
    setSending(true)
    try {
      await fetch('/api/portal/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ action: 'reply', text: t }) })
      setText(''); await load()
    } finally { setSending(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 'calc(100dvh - 200px)' }}>
      <div style={{ marginBottom: 14 }}>
        <h1 className="jkos-h" style={{ fontSize: 26 }}>Messages</h1>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 3 }}>Everything from dispatch, in one place.</p>
      </div>

      {loading ? (
        <p style={{ color: 'var(--muted)' }}>Loading…</p>
      ) : msgs.length === 0 ? (
        <div className="os-card os-rise" style={{ padding: 34, textAlign: 'center' }}>
          <MessageSquare size={28} style={{ color: 'var(--muted)' }} />
          <p className="jkos-h" style={{ fontSize: 18, marginTop: 10 }}>No messages yet</p>
          <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 4 }}>Reminders and dispatch messages will show up here.</p>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {msgs.map(m => {
            const inbound = m.direction === 'inbound' // from crew (me)
            const K = KIND_ICON[m.kind || '']
            return (
              <div key={m.id} style={{ display: 'flex', justifyContent: inbound ? 'flex-end' : 'flex-start' }}>
                <div className="os-rise" style={{ maxWidth: '82%', padding: '11px 14px', borderRadius: 16, background: inbound ? 'var(--red)' : 'color-mix(in srgb, var(--card) 92%, transparent)', color: inbound ? '#fff' : 'var(--text)', border: inbound ? 'none' : '1px solid var(--line)' }}>
                  {!inbound && K && <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4, fontSize: 10.5, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}><K size={11} /> {m.kind}</div>}
                  {m.subject && <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 3 }}>{m.subject}</div>}
                  <div style={{ fontSize: 14.5, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{m.body}</div>
                  <div style={{ fontSize: 10.5, opacity: .7, marginTop: 5 }}>{fmt(m.createdAt)}{m.crewAckKind ? ` · ${m.crewAckKind.replace('_', ' ')}` : ''}</div>
                </div>
              </div>
            )
          })}
          <div ref={endRef} />
        </div>
      )}

      {/* Composer */}
      <div className="os-glass" style={{ position: 'sticky', bottom: 0, marginTop: 14, padding: 10, borderRadius: 16, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={1} placeholder="Message dispatch…" onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          style={{ flex: 1, padding: '11px 13px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 12, color: 'var(--text)', fontSize: 15, outline: 'none', resize: 'none', maxHeight: 120 }} />
        <button onClick={send} disabled={sending || !text.trim()} aria-label="Send" className="os-tap" style={{ width: 46, height: 46, borderRadius: 12, background: 'var(--red)', color: '#fff', border: 'none', display: 'grid', placeItems: 'center', cursor: 'pointer', flexShrink: 0, opacity: text.trim() ? 1 : .5 }}><Send size={18} /></button>
      </div>
    </div>
  )
}

export default function PortalMessagesPage() {
  return <PortalShell><Inbox /></PortalShell>
}
