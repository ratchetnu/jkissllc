'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import AdminGate from '../AdminGate'
import { SkeletonList } from '../../components/Skeleton'
import {
  ConversationThread, MESSAGE_TEMPLATES, StatusPill, UnmatchedPill, ChannelPill,
  timeAgo, type ThreadMessage,
} from '../messaging'

type AlertConfig = { sms: boolean; email: boolean; smsTo: string; emailTo: string }
type Tab = 'unread' | 'all' | 'archived'
type Chan = '' | 'sms' | 'email'
type Matched = '' | '1' | '0'
type BookingLite = { token: string; bookingNumber: string; customerName: string; customerPhone?: string; customerEmail?: string; status: string }

type Thread = {
  key: string
  name: string
  phone?: string
  email?: string
  bookingToken?: string
  bookingNumber?: string
  status?: string
  messages: ThreadMessage[]
  lastAt: number
  unread: number
  channels: Set<string>
  last: ThreadMessage
}

const iStyle: React.CSSProperties = {
  width: '100%', padding: '11px 13px', background: 'rgba(255,255,255,.05)',
  border: '1px solid rgba(255,255,255,.10)', borderRadius: '10px', color: '#f3f4f6', fontSize: '16px', outline: 'none',
}
const chip = (active: boolean): React.CSSProperties => ({
  fontSize: '12px', fontWeight: 700, padding: '6px 12px', borderRadius: '999px', cursor: 'pointer',
  background: active ? 'var(--red)' : 'rgba(255,255,255,.05)',
  border: `1px solid ${active ? 'var(--red)' : 'rgba(255,255,255,.1)'}`,
  color: active ? '#fff' : 'var(--muted)', whiteSpace: 'nowrap',
})
const btn = (kind: 'primary' | 'ghost' | 'danger' = 'ghost'): React.CSSProperties => ({
  fontSize: '13px', fontWeight: 800, padding: '9px 14px', borderRadius: '10px', cursor: 'pointer',
  border: '1px solid', whiteSpace: 'nowrap',
  ...(kind === 'primary'
    ? { background: 'var(--red)', borderColor: 'var(--red)', color: '#fff' }
    : kind === 'danger'
      ? { background: 'rgba(248,113,113,.08)', borderColor: 'rgba(248,113,113,.3)', color: '#fca5a5' }
      : { background: 'rgba(255,255,255,.05)', borderColor: 'rgba(255,255,255,.1)', color: 'var(--text)' }),
})

// ── thread grouping ───────────────────────────────────────────────────────────
function phoneOf(m: ThreadMessage) {
  return m.customerPhone || (m.channel === 'sms' ? (m.direction === 'inbound' ? m.from : m.to) : undefined)
}
function emailOf(m: ThreadMessage) {
  return m.customerEmail || (m.channel === 'email' ? (m.direction === 'inbound' ? m.from : m.to) : undefined)
}
function keyOf(m: ThreadMessage) {
  return m.bookingToken || phoneOf(m) || emailOf(m) || m.from || m.id
}

function buildThreads(msgs: ThreadMessage[], byToken: Record<string, BookingLite>): Thread[] {
  const map = new Map<string, ThreadMessage[]>()
  for (const m of msgs) {
    const k = keyOf(m)
    const arr = map.get(k); if (arr) arr.push(m); else map.set(k, [m])
  }
  const threads: Thread[] = []
  for (const [key, list] of map) {
    list.sort((a, b) => a.createdAt - b.createdAt)
    const last = list[list.length - 1]
    const bookingToken = list.map(x => x.bookingToken).find(Boolean)
    const bk = bookingToken ? byToken[bookingToken] : undefined
    threads.push({
      key,
      name: list.map(x => x.customerName).find(Boolean) || bk?.customerName || phoneOf(last) || emailOf(last) || last.from || 'Unknown',
      phone: list.map(phoneOf).find(Boolean) || bk?.customerPhone,
      email: list.map(emailOf).find(Boolean) || bk?.customerEmail,
      bookingToken,
      bookingNumber: list.map(x => x.bookingNumber).find(Boolean) || bk?.bookingNumber,
      status: bk?.status,
      messages: list,
      lastAt: last.createdAt,
      unread: list.filter(x => x.unread).length,
      channels: new Set(list.map(x => x.channel)),
      last,
    })
  }
  threads.sort((a, b) => b.lastAt - a.lastAt)
  return threads
}

function Inbox() {
  const [msgs, setMsgs] = useState<ThreadMessage[]>([])
  const [bookings, setBookings] = useState<BookingLite[]>([])
  const [unread, setUnread] = useState(0)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('all')
  const [chan, setChan] = useState<Chan>('')
  const [matched, setMatched] = useState<Matched>('')
  const [q, setQ] = useState('')
  const [err, setErr] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [showAlerts, setShowAlerts] = useState(false)

  const serverTab = tab === 'archived' ? 'archived' : 'all'

  const load = useCallback(async () => {
    setErr('')
    try {
      const [mRes, bRes] = await Promise.all([
        fetch(`/api/admin/messages?tab=${serverTab}`, { credentials: 'same-origin' }),
        fetch('/api/admin/bookings', { credentials: 'same-origin' }),
      ])
      if (mRes.status === 401) return
      const mj = await mRes.json()
      if (!mRes.ok) throw new Error(mj.error ?? 'Failed')
      setMsgs(mj.items ?? []); setUnread(mj.unread ?? 0)
      if (bRes.ok) {
        const bj = await bRes.json()
        setBookings(((bj.items ?? []) as Array<Record<string, unknown>>).map(b => ({
          token: String(b.token), bookingNumber: String(b.bookingNumber ?? ''), customerName: String(b.customerName ?? ''),
          customerPhone: b.customerPhone ? String(b.customerPhone) : undefined,
          customerEmail: b.customerEmail ? String(b.customerEmail) : undefined,
          status: String(b.status ?? ''),
        })))
      }
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
    finally { setLoading(false) }
  }, [serverTab])

  useEffect(() => { setLoading(true); load() }, [load])
  useEffect(() => { const t = setInterval(load, 30000); return () => clearInterval(t) }, [load])

  const byToken = useMemo(() => Object.fromEntries(bookings.map(b => [b.token, b])), [bookings])
  const allThreads = useMemo(() => buildThreads(msgs, byToken), [msgs, byToken])

  const threads = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return allThreads.filter(t => {
      if (tab === 'unread' && t.unread === 0) return false
      if (chan && !t.channels.has(chan)) return false
      if (matched === '1' && !t.bookingToken) return false
      if (matched === '0' && t.bookingToken) return false
      if (needle) {
        const hay = [t.name, t.phone, t.email, t.bookingNumber, ...t.messages.map(m => m.body)].join(' ').toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [allThreads, tab, chan, matched, q])

  const selected = useMemo(() => allThreads.find(t => t.key === selectedKey) ?? null, [allThreads, selectedKey])

  // keep a valid selection on desktop as data refreshes; clear if it disappears
  useEffect(() => {
    if (selectedKey && !allThreads.some(t => t.key === selectedKey)) setSelectedKey(null)
  }, [allThreads, selectedKey])

  async function patchMsg(id: string, action: string, extra: Record<string, unknown> = {}) {
    try {
      await fetch('/api/admin/messages', {
        method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action, ...extra }),
      })
    } catch { /* ignore */ }
  }

  async function markThreadRead(t: Thread) {
    await Promise.all(t.messages.filter(m => m.unread).map(m => patchMsg(m.id, 'read')))
    await load()
  }
  async function archiveThread(t: Thread) {
    if (!confirm(`Archive this conversation with ${t.name}?`)) return
    await Promise.all(t.messages.map(m => patchMsg(m.id, 'archive')))
    setSelectedKey(null); await load()
  }
  async function notCustomer(t: Thread) {
    if (!confirm('Mark these messages as not customer-related? They’ll be archived and hidden.')) return
    await Promise.all(t.messages.map(m => patchMsg(m.id, 'not_customer')))
    setSelectedKey(null); await load()
  }
  async function attachThread(t: Thread, bookingToken: string) {
    await Promise.all(t.messages.map(m => patchMsg(m.id, 'attach', { bookingToken })))
    await load()
  }

  return (
    <div className="mx-auto" style={{ maxWidth: 1180 }}>
      {/* header */}
      <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-black text-white" style={{ letterSpacing: '-0.03em' }}>Inbox</h1>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            {unread > 0 ? <span style={{ color: 'var(--red)' }}>{unread} unread</span> : 'All caught up'} · customer texts &amp; emails
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowAlerts(s => !s)} style={btn('ghost')}>⚙ Alerts</button>
          <button onClick={load} style={btn('ghost')}>↻ Refresh</button>
        </div>
      </div>

      {showAlerts && <div className="mb-3"><AlertSettings /></div>}

      {/* filters */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {(['unread', 'all', 'archived'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)} style={chip(tab === t)}>
            {t === 'unread' ? `Unread${unread ? ` (${unread})` : ''}` : t === 'all' ? 'All' : 'Archived'}
          </button>
        ))}
        <span style={{ width: 1, height: 18, background: 'rgba(255,255,255,.1)' }} />
        {([['', 'All'], ['sms', 'SMS'], ['email', 'Email']] as [Chan, string][]).map(([c, label]) => (
          <button key={c || 'all'} onClick={() => setChan(c)} style={chip(chan === c)}>{label}</button>
        ))}
        <span style={{ width: 1, height: 18, background: 'rgba(255,255,255,.1)' }} />
        {([['', 'Any'], ['1', 'Matched'], ['0', 'Unmatched']] as [Matched, string][]).map(([mv, label]) => (
          <button key={mv || 'any'} onClick={() => setMatched(mv)} style={chip(matched === mv)}>{label}</button>
        ))}
      </div>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, phone, email, message…" style={{ ...iStyle, marginBottom: 14 }} />

      {err && <p className="text-sm mb-3" style={{ color: '#f87171' }}>{err}</p>}

      {/* two-pane: list + detail */}
      <div className="flex gap-4" style={{ alignItems: 'flex-start' }}>
        {/* LIST — hidden on mobile when a thread is open */}
        <div className={`${selected ? 'hidden md:block' : 'block'} w-full`} style={{ maxWidth: '100%', flex: '0 0 360px', minWidth: 0 }}>
          {loading ? (
            <SkeletonList rows={5} />
          ) : threads.length === 0 ? (
            <div className="glass-card p-8 text-center" style={{ borderRadius: 16 }}>
              <div style={{ fontSize: 30, marginBottom: 8, opacity: .5 }}>📭</div>
              <p className="text-sm" style={{ color: 'var(--muted)' }}>
                {tab === 'unread' ? 'No unread conversations. New customer texts & emails land here.'
                  : tab === 'archived' ? 'Nothing archived.'
                  : 'No conversations yet.'}
              </p>
            </div>
          ) : (
            <div className="space-y-2" style={{ maxHeight: 'calc(100vh - 230px)', overflowY: 'auto' }}>
              {threads.map(t => (
                <ThreadRow key={t.key} t={t} active={t.key === selectedKey}
                  onClick={() => { setSelectedKey(t.key); if (t.unread) markThreadRead(t) }} />
              ))}
            </div>
          )}
        </div>

        {/* DETAIL — full width on mobile when open */}
        <div className={`${selected ? 'block' : 'hidden md:block'} w-full`} style={{ flex: 1, minWidth: 0 }}>
          {selected ? (
            <ThreadDetail
              t={selected}
              bookings={bookings}
              onBack={() => setSelectedKey(null)}
              onMarkRead={async (id) => { await patchMsg(id, 'read'); await load() }}
              onMarkAllRead={() => markThreadRead(selected)}
              onArchive={() => archiveThread(selected)}
              onNotCustomer={() => notCustomer(selected)}
              onAttach={(token) => attachThread(selected, token)}
              onSent={load}
            />
          ) : (
            <div className="glass-card p-10 text-center" style={{ borderRadius: 16 }}>
              <div style={{ fontSize: 34, marginBottom: 10, opacity: .4 }}>💬</div>
              <p className="text-sm font-bold text-white">Select a conversation</p>
              <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>Pick a customer on the left to read the thread and reply.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── left list row ─────────────────────────────────────────────────────────────
function ThreadRow({ t, active, onClick }: { t: Thread; active: boolean; onClick: () => void }) {
  const initial = (t.name || '?').trim().charAt(0).toUpperCase()
  return (
    <button onClick={onClick} className="w-full text-left glass-card" style={{
      borderRadius: 13, padding: '11px 12px', display: 'flex', gap: 10, alignItems: 'flex-start',
      border: active ? '1px solid var(--red)' : '1px solid rgba(255,255,255,.07)',
      borderLeft: t.unread ? '3px solid var(--red)' : (active ? '1px solid var(--red)' : '3px solid transparent'),
      background: active ? 'rgba(224,0,42,.08)' : undefined,
    }}>
      <span style={{ flexShrink: 0, width: 34, height: 34, borderRadius: 99, background: 'rgba(255,255,255,.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, color: '#e5e7eb', fontSize: 14 }}>{initial}</span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span className="flex items-center justify-between gap-2">
          <span className="text-sm font-bold text-white truncate" style={{ maxWidth: '70%' }}>{t.name}</span>
          <span className="text-xs shrink-0" style={{ color: 'var(--muted)', fontSize: 10.5 }}>{timeAgo(t.lastAt)}</span>
        </span>
        <span className="flex items-center gap-1.5 flex-wrap" style={{ margin: '3px 0' }}>
          {t.bookingNumber ? <StatusPill status={t.status} label={t.bookingNumber} /> : <UnmatchedPill />}
        </span>
        <span className="flex items-center gap-1.5">
          <span style={{ fontSize: 11 }}>{t.last.channel === 'sms' ? '💬' : t.last.channel === 'email' ? '✉️' : '•'}</span>
          <span className="text-xs truncate" style={{ color: t.unread ? '#e5e7eb' : 'var(--muted)', flex: 1, minWidth: 0 }}>
            {t.last.direction === 'outbound' && <span style={{ color: 'var(--muted)' }}>You: </span>}
            {t.last.body}
          </span>
          {t.unread > 0 && <span style={{ flexShrink: 0, minWidth: 18, height: 18, padding: '0 5px', borderRadius: 99, background: 'var(--red)', color: '#fff', fontSize: 10, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{t.unread}</span>}
        </span>
      </span>
    </button>
  )
}

// ── right detail panel ────────────────────────────────────────────────────────
function ThreadDetail({
  t, bookings, onBack, onMarkRead, onMarkAllRead, onArchive, onNotCustomer, onAttach, onSent,
}: {
  t: Thread
  bookings: BookingLite[]
  onBack: () => void
  onMarkRead: (id: string) => void
  onMarkAllRead: () => void
  onArchive: () => void
  onNotCustomer: () => void
  onAttach: (token: string) => void
  onSent: () => Promise<void> | void
}) {
  const [text, setText] = useState('')
  const [tpl, setTpl] = useState('')
  const [busy, setBusy] = useState('')
  const [info, setInfo] = useState('')
  const [err, setErr] = useState('')
  const [attachTo, setAttachTo] = useState('')

  // reset composer when switching threads
  useEffect(() => { setText(''); setTpl(''); setInfo(''); setErr(''); setAttachTo('') }, [t.key])

  const firstName = (t.name || '').trim().split(/\s+/)[0] || 'there'
  function applyTemplate(key: string) {
    setTpl(key); setErr(''); setInfo('')
    const tt = MESSAGE_TEMPLATES.find(x => x.key === key)
    if (tt) setText(tt.build({ firstName, bookingNumber: t.bookingNumber }))
  }

  async function send(channel: 'sms' | 'email' | 'both' | 'note') {
    if (!text.trim()) { setErr('Write a message first.'); return }
    setBusy(channel); setErr(''); setInfo('')
    try {
      const res = await fetch('/api/admin/messages/reply', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, text, bookingToken: t.bookingToken, phone: t.phone, email: t.email, customerName: t.name }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'Failed to send.')
      const via = channel === 'note' ? 'Note added'
        : [j.channels?.sms && 'text', j.channels?.email && 'email'].filter(Boolean).join(' + ') || 'Sent'
      setInfo(channel === 'note' ? 'Internal note added.' : `Sent via ${via}.`)
      setText(''); setTpl('')
      await onSent()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed to send.') }
    finally { setBusy('') }
  }

  const createHref = `/admin/bookings?new=1${t.name ? `&name=${encodeURIComponent(t.name)}` : ''}${t.phone ? `&phone=${encodeURIComponent(t.phone)}` : ''}${t.email ? `&email=${encodeURIComponent(t.email)}` : ''}`
  const canSms = !!t.phone
  const canEmail = !!t.email

  return (
    <div className="glass-card" style={{ borderRadius: 16, padding: 0, display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 200px)' }}>
      {/* header */}
      <div style={{ padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,.08)' }}>
        <div className="flex items-center gap-2 mb-2">
          <button onClick={onBack} className="md:hidden" style={{ ...btn('ghost'), padding: '6px 10px' }}>← Back</button>
          <div className="min-w-0 flex-1">
            <p className="text-base font-black text-white truncate">{t.name}</p>
            <p className="text-xs truncate" style={{ color: 'var(--muted)' }}>
              {[t.phone, t.email].filter(Boolean).join(' · ') || 'No contact info on file'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {t.bookingNumber ? (
            <>
              <a href="/admin/bookings" style={{ textDecoration: 'none' }}><StatusPill status={t.status} label={`${t.bookingNumber} ↗`} /></a>
              {t.status && <StatusPill status={t.status} />}
            </>
          ) : <UnmatchedPill />}
          {[...t.channels].filter(c => c === 'sms' || c === 'email').map(c => <ChannelPill key={c} channel={c} />)}
        </div>
      </div>

      {/* thread */}
      <div style={{ padding: 16, overflowY: 'auto', flex: 1, minHeight: 120 }}>
        <ConversationThread messages={t.messages} customerName={t.name} onMarkRead={onMarkRead} />
      </div>

      {/* unmatched workflow */}
      {!t.bookingToken && (
        <div style={{ padding: '12px 16px', borderTop: '1px solid rgba(255,255,255,.08)', background: 'rgba(251,191,36,.04)' }}>
          <p className="text-xs font-bold mb-2" style={{ color: '#fcd34d' }}>⚠ Not linked to a booking</p>
          <div className="flex flex-wrap gap-2 items-center">
            <select value={attachTo} onChange={e => setAttachTo(e.target.value)} style={{ ...iStyle, width: 'auto', flex: '1 1 200px', fontSize: 14, padding: '8px 10px' }}>
              <option value="">Attach to booking…</option>
              {bookings.map(b => <option key={b.token} value={b.token}>{b.bookingNumber} — {b.customerName || 'No name'}</option>)}
            </select>
            <button disabled={!attachTo} onClick={() => attachTo && onAttach(attachTo)} style={{ ...btn('primary'), opacity: attachTo ? 1 : .5 }}>Attach</button>
            <a href={createHref} style={{ ...btn('ghost'), textDecoration: 'none' }}>+ New booking</a>
            <button onClick={onNotCustomer} style={btn('ghost')}>Not a customer</button>
          </div>
        </div>
      )}

      {/* composer */}
      <div style={{ padding: '12px 16px', borderTop: '1px solid rgba(255,255,255,.08)', position: 'sticky', bottom: 0, background: 'rgba(17,17,19,.96)', backdropFilter: 'blur(8px)' }}>
        <div className="flex flex-wrap gap-2 items-center mb-2">
          <select value={tpl} onChange={e => applyTemplate(e.target.value)} style={{ ...iStyle, width: 'auto', flex: '1 1 180px', fontSize: 14, padding: '8px 10px' }}>
            <option value="">Insert a template…</option>
            {MESSAGE_TEMPLATES.map(x => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
          <button onClick={onMarkAllRead} disabled={t.unread === 0} style={{ ...btn('ghost'), opacity: t.unread ? 1 : .5 }}>✓ Mark read</button>
          <button onClick={onArchive} style={btn('ghost')}>Archive</button>
        </div>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={3}
          placeholder={`Reply to ${firstName}…`} style={{ ...iStyle, resize: 'vertical', minHeight: 64 }} />
        {(info || err) && <p className="text-xs mt-1.5" style={{ color: err ? '#fca5a5' : '#6ee7b7' }}>{err || info}</p>}
        <div className="flex flex-wrap gap-2 mt-2">
          <button onClick={() => send('sms')} disabled={!canSms || !!busy} style={{ ...btn('primary'), flex: '1 1 100px', opacity: canSms && !busy ? 1 : .5 }}>
            {busy === 'sms' ? 'Sending…' : '💬 Text'}
          </button>
          <button onClick={() => send('email')} disabled={!canEmail || !!busy} style={{ ...btn('primary'), flex: '1 1 100px', opacity: canEmail && !busy ? 1 : .5 }}>
            {busy === 'email' ? 'Sending…' : '✉️ Email'}
          </button>
          <button onClick={() => send('both')} disabled={(!canSms && !canEmail) || !!busy} style={{ ...btn('primary'), flex: '1 1 100px', opacity: (canSms || canEmail) && !busy ? 1 : .5 }}>
            {busy === 'both' ? 'Sending…' : 'Both'}
          </button>
          <button onClick={() => send('note')} disabled={!!busy} style={{ ...btn('ghost'), flex: '1 1 100px' }}>
            {busy === 'note' ? 'Saving…' : '📝 Note'}
          </button>
        </div>
        {!canSms && !canEmail && <p className="text-xs mt-1.5" style={{ color: 'var(--muted)' }}>No phone or email on this conversation — attach it to a booking or add a note.</p>}
      </div>
    </div>
  )
}

// ── Owner alert settings (editable: text me / email me) ──────────────────────
function AlertSettings() {
  const [cfg, setCfg] = useState<AlertConfig | null>(null)
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
    <div className="glass-card p-4" style={{ borderRadius: 14 }}>
      <p className="text-sm font-bold text-white mb-3">When a customer replies, alert me by…</p>
      <div className="space-y-3">
        <Toggle label={`Text me${cfg.smsTo ? ` (${cfg.smsTo})` : ' — set a phone below'}`} on={cfg.sms} disabled={saving} onChange={v => save({ sms: v })} />
        <Toggle label={`Email me${cfg.emailTo ? ` (${cfg.emailTo})` : ''}`} on={cfg.email} disabled={saving} onChange={v => save({ email: v })} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input defaultValue={cfg.smsTo} placeholder="Alert phone (+1…)" style={iStyle}
            onBlur={e => e.target.value !== cfg.smsTo && save({ smsTo: e.target.value })} />
          <input defaultValue={cfg.emailTo} placeholder="Alert email" style={iStyle}
            onBlur={e => e.target.value !== cfg.emailTo && save({ emailTo: e.target.value })} />
        </div>
      </div>
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
  return <AdminGate title="Inbox"><Inbox /></AdminGate>
}
