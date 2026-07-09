'use client'

import { useState } from 'react'
import { COMPANY, CREDENTIALS_DOT } from '../lib/company';
import Link from 'next/link'

type LookupResult =
  | { found: true; bol: string; status: string; statusLabel: string; statusDesc: string; pickupCity: string | null; deliveryCity: string | null; updatedAt: number; dispatchedAt: number | null; deliveredAt: number | null }
  | { found: false; bol: string }

const STATUS_ORDER = ['created', 'dispatched', 'out-for-delivery', 'delivered']
const STATUS_LABEL_MAP: Record<string, string> = {
  'created': 'Scheduled',
  'dispatched': 'On The Way',
  'out-for-delivery': 'Crew On Site',
  'delivered': 'Complete',
}

function relative(ts: number) {
  const diff = Date.now() - ts
  const min = Math.round(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr} hr ago`
  const d = Math.round(hr / 24)
  return `${d} day${d === 1 ? '' : 's'} ago`
}

export default function TrackPage() {
  const [status, setStatus] = useState<'idle' | 'looking' | 'done' | 'error'>('idle')
  const [result, setResult] = useState<LookupResult | null>(null)
  const [errorMsg, setErrorMsg] = useState('')

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setStatus('looking')
    setErrorMsg('')
    setResult(null)
    const data = Object.fromEntries(new FormData(e.currentTarget))
    try {
      const res = await fetch('/api/shipments/lookup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      const j = await res.json()
      if (res.ok) { setResult(j as LookupResult); setStatus('done') }
      else { setStatus('error'); setErrorMsg(j.error ?? 'Lookup failed.') }
    } catch {
      setStatus('error'); setErrorMsg(`Connection error. Please email ${COMPANY.email}.`)
    }
  }

  const iStyle: React.CSSProperties = {
    width: '100%', padding: '14px 18px',
    background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.10)',
    borderRadius: '12px', color: '#f3f4f6', fontSize: '18px', outline: 'none',
    fontFamily: 'var(--font-mono)', letterSpacing: '0.05em', textTransform: 'uppercase',
  }

  const stepIndex = result?.found ? STATUS_ORDER.indexOf(result.status) : -1

  return (
    <main className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="fixed top-0 left-0 right-0 z-50" style={{ background: 'rgba(11,11,12,0.95)', backdropFilter: 'blur(12px)', borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="text-xl font-black tracking-tight" style={{ color: '#fff', letterSpacing: '-0.03em' }}>
            {COMPANY.nameLead} <span style={{ color: 'var(--red)' }}>{COMPANY.nameAccent}</span>
          </Link>
          <Link href="/" className="text-sm font-semibold transition hover:text-white" style={{ color: 'var(--muted)' }}>← Back to Home</Link>
        </div>
      </header>

      <section className="pt-32 pb-20 px-6">
        <div className="max-w-2xl mx-auto">
          <div className="label mb-6">Pickup Tracking</div>
          <h1 className="text-4xl md:text-5xl font-black text-white mb-5" style={{ letterSpacing: '-0.045em', lineHeight: 1.05, fontFamily: 'var(--font-display)' }}>
            Where&apos;s My <span style={{ color: 'var(--red)' }}>Pickup?</span>
          </h1>
          <p className="text-base mb-8" style={{ color: 'var(--muted)' }}>
            Enter your job code and the name on the booking to see live status. Updated as our crew schedules, loads up, and clears your junk.
          </p>

          <form onSubmit={handleSubmit} className="glass-card p-6 mb-8" style={{ borderRadius: '20px' }}>
            <label className="block text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)', letterSpacing: '0.14em' }}>Job Code</label>
            <input name="bol" required placeholder="JK-1042" style={iStyle} autoFocus />
            <label className="block text-xs font-bold uppercase tracking-widest mb-3 mt-4" style={{ color: 'var(--muted)', letterSpacing: '0.14em' }}>Name on the Booking</label>
            <input name="name" required placeholder="Customer or company name" maxLength={200}
              style={{ ...iStyle, textTransform: 'none', letterSpacing: 'normal', fontFamily: 'inherit' }} />
            <p className="text-xs mt-2" style={{ color: 'rgba(255,255,255,.4)' }}>
              The customer or company name on the booking — this confirms the shipment is yours.
            </p>
            <button type="submit" disabled={status === 'looking'} className="btn w-full mt-4" style={{ justifyContent: 'center' }}>
              {status === 'looking' ? 'Looking…' : 'Track My Pickup →'}
            </button>
            {status === 'error' && <p className="text-sm mt-4" style={{ color: '#f87171' }}>{errorMsg}</p>}
          </form>

          {/* Result */}
          {result && result.found && (
            <div className="glass-card p-8" style={{ borderRadius: '20px' }}>
              <div className="flex items-baseline justify-between flex-wrap gap-2 mb-1">
                <p className="text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--muted)', letterSpacing: '0.14em' }}>
                  JOB · <span style={{ fontFamily: 'var(--font-mono)' }}>{result.bol}</span>
                </p>
                <p className="text-xs" style={{ color: 'rgba(255,255,255,.4)' }}>updated {relative(result.updatedAt)}</p>
              </div>
              <p className="text-4xl font-black text-white mt-2 mb-2" style={{ letterSpacing: '-0.035em', fontFamily: 'var(--font-display)' }}>
                {result.statusLabel}
              </p>
              <p className="text-base mb-6" style={{ color: 'var(--muted)' }}>{result.statusDesc}</p>

              {(result.pickupCity || result.deliveryCity) && (
                <div className="flex items-center gap-3 text-sm mb-6 py-3" style={{ borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)', color: 'var(--muted)' }}>
                  <span className="font-mono">{result.pickupCity ?? '—'}</span>
                  <span style={{ color: 'var(--red)' }}>→</span>
                  <span className="font-mono">{result.deliveryCity ?? '—'}</span>
                </div>
              )}

              {/* Progress steps */}
              <div className="flex items-center gap-2">
                {STATUS_ORDER.map((s, i) => {
                  const reached = i <= stepIndex
                  return (
                    <div key={s} className="flex-1 flex flex-col items-center gap-2">
                      <div className="w-full h-1 rounded-full" style={{ background: reached ? 'var(--red)' : 'rgba(255,255,255,.10)' }} />
                      <span className="text-[10px] font-bold uppercase tracking-wide text-center" style={{ color: reached ? '#fff' : 'rgba(255,255,255,.3)', letterSpacing: '0.08em' }}>
                        {STATUS_LABEL_MAP[s]}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {result && !result.found && (
            <div className="glass-card p-8 text-center" style={{ borderRadius: '20px' }}>
              <p className="text-2xl font-black text-white mb-2" style={{ fontFamily: 'var(--font-display)' }}>Not found</p>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>
                No pickup matches job code <span className="font-mono" style={{ color: '#fff' }}>{result.bol}</span> with that name. Double-check both the code and the name on the booking, or text us at{' '}
                <a href={"tel:" + COMPANY.phoneE164} className="font-semibold transition hover:text-white" style={{ color: 'var(--red)' }}>(817) 909-4312</a> or{' '}
                <a href={"mailto:" + COMPANY.email} className="font-semibold transition hover:text-white" style={{ color: 'var(--red)' }}>info@jkissllc.com</a>.
              </p>
            </div>
          )}
        </div>
      </section>

      <footer className="py-10 px-6 text-center text-xs" style={{ borderTop: '1px solid var(--line)', color: 'rgba(255,255,255,.3)' }}>
        © {new Date().getFullYear()} {COMPANY.legalName} · {CREDENTIALS_DOT}
      </footer>
    </main>
  )
}
