'use client'

import { useEffect, useState } from 'react'
import { Mail, Phone, Check, MapPin } from 'lucide-react'

const iStyle: React.CSSProperties = {
  width: '100%', padding: '12px 14px', background: 'color-mix(in srgb, var(--card) 90%, transparent)',
  border: '1px solid var(--line)', borderRadius: 12, color: 'var(--text)', fontSize: 15, outline: 'none',
}
const labelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }

type Address = { line1: string; line2?: string; city: string; state: string; postalCode: string }
type Crew = { name: string; email: string | null; phone: string | null; role: string | null; photoUrl: string | null; address: Address | null }

function Profile() {
  const [crew, setCrew] = useState<Crew | null>(null)
  const [loading, setLoading] = useState(true)

  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState(false)
  const [address, setAddress] = useState({ line1: '', line2: '', city: '', state: '', postalCode: '' })
  const [addressBusy, setAddressBusy] = useState(false)
  const [addressErr, setAddressErr] = useState('')
  const [addressDone, setAddressDone] = useState(false)

  useEffect(() => {
    fetch('/api/portal/me', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(d => {
        setCrew(d.crew ?? null)
        const a = d.crew?.address
        if (a) setAddress({ line1: a.line1 ?? '', line2: a.line2 ?? '', city: a.city ?? '', state: a.state ?? '', postalCode: a.postalCode ?? '' })
      })
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

  async function saveAddress(e: React.FormEvent) {
    e.preventDefault(); setAddressErr(''); setAddressDone(false); setAddressBusy(true)
    try {
      const res = await fetch('/api/portal/me', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ address }),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) { setAddressErr(d.error ?? 'Could not update address.'); return }
      setCrew(c => c ? { ...c, address: d.address } : c)
      setAddressDone(true); setTimeout(() => setAddressDone(false), 2500)
    } catch { setAddressErr('Connection error — try again.') } finally { setAddressBusy(false) }
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
              // A 60px avatar is never the LCP element, and crew.photoUrl is a remote Blob
              // URL. next/image would throw on it unless images.remotePatterns is added to
              // next.config — a wider change than this warning justifies.
              // eslint-disable-next-line @next/next/no-img-element
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
            <p style={{ color: 'var(--muted)', fontSize: 12.5 }}>Ask an administrator to update your name, phone, or email.</p>
          </div>

          <form onSubmit={saveAddress} className="os-card os-rise" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 11 }}>
            <h2 className="jkos-h" style={{ fontSize: 17, display: 'flex', alignItems: 'center', gap: 8 }}><MapPin size={17} /> Mailing address</h2>
            <p style={{ color: 'var(--muted)', fontSize: 12.5 }}>You can update your own address here whenever it changes.</p>
            <div><label htmlFor="crew-address-1" style={labelStyle}>Street address</label><input id="crew-address-1" autoComplete="street-address" value={address.line1} onChange={e => setAddress(a => ({ ...a, line1: e.target.value }))} style={{ ...iStyle, marginTop: 6 }} /></div>
            <div><label htmlFor="crew-address-2" style={labelStyle}>Apartment, suite, or unit</label><input id="crew-address-2" autoComplete="address-line2" value={address.line2} onChange={e => setAddress(a => ({ ...a, line2: e.target.value }))} style={{ ...iStyle, marginTop: 6 }} /></div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 9 }}>
              <div><label htmlFor="crew-city" style={labelStyle}>City</label><input id="crew-city" autoComplete="address-level2" value={address.city} onChange={e => setAddress(a => ({ ...a, city: e.target.value }))} style={{ ...iStyle, marginTop: 6 }} /></div>
              <div><label htmlFor="crew-state" style={labelStyle}>State</label><input id="crew-state" autoComplete="address-level1" value={address.state} onChange={e => setAddress(a => ({ ...a, state: e.target.value }))} style={{ ...iStyle, marginTop: 6 }} /></div>
              <div><label htmlFor="crew-zip" style={labelStyle}>ZIP code</label><input id="crew-zip" autoComplete="postal-code" inputMode="numeric" value={address.postalCode} onChange={e => setAddress(a => ({ ...a, postalCode: e.target.value }))} style={{ ...iStyle, marginTop: 6 }} /></div>
            </div>
            {addressErr && <p role="alert" style={{ color: '#f87171', fontSize: 14 }}>{addressErr}</p>}
            <button type="submit" disabled={addressBusy} className="btn os-tap" style={{ justifyContent: 'center', borderRadius: 12, height: 46, gap: 8 }}>
              {addressDone ? <><Check size={17} /> Address updated</> : addressBusy ? 'Saving…' : 'Save address'}
            </button>
          </form>

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
  return <Profile />
}
