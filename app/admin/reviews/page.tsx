'use client'

import { useState, useEffect, useCallback } from 'react'
import AdminGate from '../AdminGate'

type Review = {
  token: string
  bookingNumber: string
  authorName: string
  rating: number
  text?: string
  createdAt: number
  hidden?: boolean
}

function fmtTs(ts: number): string {
  return new Date(ts).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
}

function ReviewsManager() {
  const [reviews, setReviews] = useState<Review[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const res = await fetch('/api/admin/reviews', { credentials: 'same-origin' })
      if (res.status === 401) return
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'Failed')
      setReviews(j.reviews ?? [])
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function toggleHidden(r: Review) {
    setBusy(r.token); setErr('')
    try {
      const res = await fetch('/api/admin/reviews', {
        method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: r.token, hidden: !r.hidden }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Failed')
      await load()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
    finally { setBusy('') }
  }

  async function remove(r: Review) {
    if (!confirm(`Permanently delete the ${r.rating}★ review from ${r.authorName}?`)) return
    setBusy(r.token); setErr('')
    try {
      const res = await fetch('/api/admin/reviews', {
        method: 'DELETE', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: r.token }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Failed')
      await load()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
    finally { setBusy('') }
  }

  const visible = reviews.filter(r => !r.hidden)
  const avg = visible.length ? (visible.reduce((s, r) => s + r.rating, 0) / visible.length) : 0

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-end justify-between gap-3 mb-5">
        <div>
          <p className="text-2xl font-black text-white" style={{ letterSpacing: '-0.03em' }}>Reviews</p>
          <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
            {reviews.length} total · {visible.length} shown publicly{visible.length > 0 && ` · ${avg.toFixed(1)}★ average`}
          </p>
        </div>
        <a href="/reviews" target="_blank" rel="noreferrer" className="text-xs font-semibold px-3 py-2 rounded-lg"
          style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--muted)' }}>View public page →</a>
      </div>

      {err && <p className="text-sm mb-3" style={{ color: '#f87171' }}>{err}</p>}
      {loading ? (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>Loading…</p>
      ) : reviews.length === 0 ? (
        <div className="glass-card p-8 text-center" style={{ borderRadius: '16px' }}>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>No reviews yet. They arrive once a customer rates a paid-in-full booking from their receipt.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {reviews.map(r => (
            <div key={r.token} className="glass-card p-4" style={{ borderRadius: '14px', opacity: r.hidden ? 0.55 : 1 }}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-white">
                    <span style={{ color: '#FFC93C', letterSpacing: '2px' }}>{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}</span>
                    <span className="ml-2">{r.authorName}</span>
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
                    <span className="font-mono">{r.bookingNumber}</span> · {fmtTs(r.createdAt)}{r.hidden && ' · hidden'}
                  </p>
                  {r.text && <p className="text-sm mt-2" style={{ color: 'var(--text)', lineHeight: 1.5 }}>“{r.text}”</p>}
                </div>
                <div className="flex flex-col gap-1.5 shrink-0">
                  <button onClick={() => toggleHidden(r)} disabled={busy === r.token}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg"
                    style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: 'var(--text)' }}>
                    {r.hidden ? 'Show' : 'Hide'}
                  </button>
                  <button onClick={() => remove(r)} disabled={busy === r.token}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg"
                    style={{ background: 'rgba(224,0,42,.08)', border: '1px solid rgba(224,0,42,.3)', color: '#ff6680' }}>
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function ReviewsAdminPage() {
  return <AdminGate title="Reviews"><ReviewsManager /></AdminGate>
}
