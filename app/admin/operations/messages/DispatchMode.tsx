'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Send, Search, Zap, Users } from 'lucide-react'
import { Avatar } from '../ui'
import {
  api, Icon, Sheet, SEGMENTS,
  type CrewCardT, type DispatchActionT,
} from './commsShared'

// Dispatch Mode (request Part 13). One-tap urgent blasts that bypass reminder
// schedules and suppression. Pick an action, pick who, fire — SMS + in-app + a
// one-tap ack link, immediately.
const TONE_BG: Record<string, string> = { urgent: 'rgba(224,0,42,.14)', alert: 'rgba(245,158,11,.14)', info: 'rgba(59,130,246,.14)' }
const TONE_FG: Record<string, string> = { urgent: '#fca5a5', alert: '#fcd34d', info: '#93c5fd' }

export default function DispatchMode({ dispatch }: { dispatch: DispatchActionT[] }) {
  const [crew, setCrew] = useState<CrewCardT[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [action, setAction] = useState<DispatchActionT | null>(null)

  const load = useCallback(async (alive?: { on: boolean }) => {
    try {
      const d = await api<{ crew: CrewCardT[]; counts: Record<string, number> }>('/api/admin/crew-directory')
      if (!alive || alive.on) { setCrew(d.crew); setCounts(d.counts) }
    } catch { /* ignore */ }
  }, [])
  useEffect(() => { const a = { on: true }; load(a); return () => { a.on = false } }, [load])

  return (
    <div>
      <div className="os-card os-rise" style={{ padding: 16, marginBottom: 16, display: 'flex', gap: 12, alignItems: 'center', background: 'linear-gradient(135deg, color-mix(in srgb, var(--red) 10%, transparent), transparent)' }}>
        <div style={{ width: 42, height: 42, borderRadius: 12, display: 'grid', placeItems: 'center', background: 'var(--red)', color: '#fff', flexShrink: 0 }}><Zap size={22} /></div>
        <div>
          <h2 className="jkos-h" style={{ fontSize: 19 }}>Dispatch Mode</h2>
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>Instant crew blasts. Bypasses reminder schedules — sends now.</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
        {dispatch.map((d, i) => (
          <button key={d.id} onClick={() => setAction(d)} className="os-card os-rise os-tap"
            style={{ textAlign: 'left', cursor: 'pointer', padding: 15, animationDelay: `${Math.min(i * 30, 220)}ms`, border: '1px solid var(--line)' }}>
            <div style={{ width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center', background: TONE_BG[d.tone], color: TONE_FG[d.tone], marginBottom: 10 }}>
              <Icon name={d.icon} size={19} />
            </div>
            <div style={{ fontWeight: 800, fontSize: 15 }}>{d.label}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{d.message}</div>
          </button>
        ))}
      </div>

      {action && <DispatchSheet action={action} crew={crew} counts={counts} onClose={() => setAction(null)} onSent={() => { setAction(null); load() }} />}
    </div>
  )
}

function DispatchSheet({ action, crew, counts, onClose, onSent }: {
  action: DispatchActionT; crew: CrewCardT[]; counts: Record<string, number>
  onClose: () => void; onSent: (n: number) => void
}) {
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [seg, setSeg] = useState('all')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const shown = useMemo(() => {
    const query = q.trim().toLowerCase()
    return crew.filter(c => seg === 'all' || c.flags.includes(seg)).filter(c => !query || c.name.toLowerCase().includes(query))
  }, [crew, seg, q])

  const toggle = (id: string) => setSel(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const selectSeg = () => setSel(new Set(shown.map(c => c.id)))

  async function send() {
    if (!sel.size) { setError('Select at least one crew member.'); return }
    setBusy(true); setError('')
    try {
      const res = await api<{ sent: number }>('/api/admin/comms/send', {
        method: 'POST',
        body: JSON.stringify({ origin: 'dispatch', dispatchId: action.id, staffIds: [...sel], channels: ['inapp', 'sms'], requireAck: true }),
      })
      onSent(res.sent)
    } catch (e) { setError(e instanceof Error ? e.message : 'Send failed.') }
    finally { setBusy(false) }
  }

  return (
    <Sheet title={action.label} onClose={onClose} footer={
      <button onClick={send} disabled={busy} className="cc-action os-tap" style={{ width: '100%', background: 'var(--red)', color: '#fff', opacity: busy ? .6 : 1 }}>
        <Send size={17} /> {busy ? 'Sending…' : `Send now to ${sel.size}`}
      </button>
    }>
      <div style={{ padding: 14, borderRadius: 12, background: TONE_BG[action.tone], marginBottom: 14 }}>
        <div style={{ fontSize: 14.5, fontWeight: 700, color: TONE_FG[action.tone] }}>{action.message}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>Sends via SMS + in-app with a one-tap response link.</div>
      </div>

      <div style={{ position: 'relative', marginBottom: 10 }}>
        <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search crew…" style={{ width: '100%', padding: '10px 12px 10px 34px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 10, color: 'var(--text)', fontSize: 14, outline: 'none' }} />
      </div>

      <div className="cc-subnav" style={{ marginBottom: 10 }}>
        {SEGMENTS.slice(0, 6).map(s => (
          <button key={s.id} className="cc-seg" data-active={seg === s.id} onClick={() => setSeg(s.id)}>{s.label}{counts[s.id] != null && <span className="cc-seg-badge">{counts[s.id]}</span>}</button>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <button onClick={selectSeg} className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', fontSize: 12.5, fontWeight: 700, borderRadius: 9, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: 'var(--muted)', cursor: 'pointer' }}><Users size={13} /> Select all shown</button>
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{sel.size} selected</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {shown.map(c => {
          const on = sel.has(c.id)
          return (
            <button key={c.id} onClick={() => toggle(c.id)} className="os-tap" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 9, borderRadius: 12, cursor: 'pointer', border: `1px solid ${on ? 'var(--red)' : 'var(--line)'}`, background: on ? 'color-mix(in srgb, var(--red) 8%, transparent)' : 'transparent', textAlign: 'left' }}>
              <Avatar name={c.name} photoUrl={c.photoUrl} size={34} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{c.name}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{c.businessNames[0] || c.role || '—'}{c.activeNow ? ' · active now' : ''}</div>
              </div>
              <span style={{ width: 20, height: 20, borderRadius: 6, border: `1.5px solid ${on ? 'var(--red)' : 'var(--line)'}`, background: on ? 'var(--red)' : 'transparent' }} />
            </button>
          )
        })}
      </div>
      {error && <p style={{ color: '#fca5a5', fontSize: 13.5, marginTop: 10 }}>{error}</p>}
    </Sheet>
  )
}
