'use client'

import { useEffect, useState } from 'react'
import { Mail, Phone, Check } from 'lucide-react'
import PortalShell from '../PortalShell'

const iStyle: React.CSSProperties = {
  width: '100%', padding: '12px 14px', background: 'color-mix(in srgb, var(--card) 90%, transparent)',
  border: '1px solid var(--line)', borderRadius: 12, color: 'var(--text)', fontSize: 15, outline: 'none',
}
const labelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }

type Crew = { name: string; email: string | null; phone: string | null; role: string | null; photoUrl: string | null }

function Profile() {
  const [crew, setCrew] = useState<Crew | null>(null)
  const [loading, setLoading] = useState(true)

  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => {
    fetch('/api/portal/me', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(d => setCrew(d.crew ?? null))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  async function changePw(e: React.FormEvent) {
    e.preventDefault()
    setErr(''); setDone(false)
    if (next !== confirm) { setErr('New passwords do not match.'); return }
    setBusy(true)
    try {
      const res = await fetch('/api/portal/password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify({ current: cur, next }),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) { setErr(d.error ?? 'Could not update password.'); return }
      setDone(true); setCur(''); setNext(''); setConfirm(''); setTimeout(() => setDone(false), 2500)
    } catch { setErr('Connection error — try again.') } finally { setBusy(false) }
  }

  const initials = (crew?.name ?? '').trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h1 className="jkos-h" style={{ fontSize: 24 }}>Profile</h1>
      {loading && <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading…</p>}

      {!loading && crew && (
        <>
          <div className="os-card os-rise" style={{ padding: 22, display: 'flex', alignItems: 'center', gap: 16 }}>
            {crew.photoUrl
              ? <img src={crew.photoUrl} alt="" style={{ width: 60, height: 60, borderRadius: 999, objectFit: 'cover' }} />
              : <div style={{ width: 60, height: 60, borderRadius: 999, background: 'var(--red)', color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 22 }}>{initials || '—'}</div>}
            <div style={{ minWidth: 0 }}>
              <p className="jkos-h" style={{ fontSize: 20 }}>{crew.name}</p>
              {crew.role && <p style={{ color: 'var(--muted)', fontSize: 13.5 }}>{crew.role}</p>}
            </div>
          </div>

          <div className="os-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {crew.email && <p style={{ display: 'inline-flex', alignItems: 'center', gap: 9, fontSize: 14 }}><Mail size={15} style={{ color: 'var(--muted)' }} /> {crew.email}</p>}
            {crew.phone && <p style={{ display: 'inline-flex', alignItems: 'center', gap: 9, fontSize: 14 }}><Phone size={15} style={{ color: 'var(--muted)' }} /> {crew.phone}</p>}
            <p style={{ color: 'var(--muted)', fontSize: 12.5 }}>To update your contact details, ask your manager.</p>
          </div>

          <form onSubmit={changePw} className="os-card os-rise" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <h2 className="jkos-h" style={{ fontSize: 17 }}>Change password</h2>
            <div>
              <label style={labelStyle}>Current password</label>
              <input type="password" autoComplete="current-password" value={cur} onChange={e => setCur(e.target.value)} style={{ ...iStyle, marginTop: 6 }} required />
            </div>
            <div>
              <label style={labelStyle}>New password</label>
              <input type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} style={{ ...iStyle, marginTop: 6 }} required minLength={8} />
            </div>
            <div>
              <label style={labelStyle}>Confirm new password</label>
              <input type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} style={{ ...iStyle, marginTop: 6 }} required minLength={8} />
            </div>
            {err && <p style={{ color: '#f87171', fontSize: 14 }}>{err}</p>}
            <button type="submit" disabled={busy} className="btn os-tap" style={{ justifyContent: 'center', borderRadius: 12, height: 46, gap: 8 }}>
              {done ? <><Check size={17} /> Updated</> : busy ? 'Saving…' : 'Update password'}
            </button>
          </form>
        </>
      )}
    </div>
  )
}

export default function ProfilePage() {
  return <PortalShell><Profile /></PortalShell>
}
