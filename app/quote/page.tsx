'use client'

import { useState } from 'react'
import Link from 'next/link'

type Estimate = { low: number; high: number; miles: number; pickupLabel: string; deliveryLabel: string }

export default function QuotePage() {
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  const [errorMsg, setErrorMsg] = useState('')

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setStatus('sending')
    setErrorMsg('')
    const form = e.currentTarget
    const data = Object.fromEntries(new FormData(form))
    try {
      const res = await fetch('/api/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      const j = await res.json()
      if (res.ok && j.estimate) {
        setEstimate(j.estimate)
        setStatus('sent')
        form.reset()
      } else {
        setStatus('error')
        setErrorMsg(j.error ?? 'Failed to compute quote.')
      }
    } catch {
      setStatus('error')
      setErrorMsg('Connection error. Please email info@jkissllc.com directly.')
    }
  }

  const iStyle: React.CSSProperties = {
    width: '100%', padding: '12px 14px',
    background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.10)',
    borderRadius: '10px', color: '#f3f4f6', fontSize: '14px', outline: 'none',
  }

  return (
    <main className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="fixed top-0 left-0 right-0 z-50" style={{ background: 'rgba(11,11,12,0.95)', backdropFilter: 'blur(12px)', borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="text-xl font-black tracking-tight" style={{ color: '#fff', letterSpacing: '-0.03em' }}>
            J Kiss <span style={{ color: 'var(--red)' }}>LLC</span>
          </Link>
          <Link href="/" className="text-sm font-semibold transition hover:text-white" style={{ color: 'var(--muted)' }}>← Back to Home</Link>
        </div>
      </header>

      <section className="pt-32 pb-20 px-6">
        <div className="max-w-3xl mx-auto">
          <div className="label mb-6">Instant Estimate</div>
          <h1 className="text-4xl md:text-5xl font-black text-white mb-5" style={{ letterSpacing: '-0.045em', lineHeight: 1.05, fontFamily: 'var(--font-display)' }}>
            Get a Box-Truck Quote<br />
            <span style={{ color: 'var(--red)' }}>In 30 Seconds.</span>
          </h1>
          <p className="text-lg mb-10" style={{ color: 'var(--muted)', lineHeight: 1.6 }}>
            Enter pickup and delivery ZIPs, load details, and service type. We&apos;ll compute a price range right away and ops will follow up with a firm number within 1 business day.
          </p>

          {status === 'sent' && estimate ? (
            <div className="glass-card p-10" style={{ borderRadius: '20px' }}>
              <div className="text-center mb-8">
                <div className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)', letterSpacing: '0.14em' }}>Estimated Price Range</div>
                <p className="text-6xl md:text-7xl font-black tabular-nums" style={{ color: 'var(--red)', letterSpacing: '-0.05em', lineHeight: 1, fontFamily: 'var(--font-display)' }}>
                  ${estimate.low.toLocaleString()}–${estimate.high.toLocaleString()}
                </p>
                <p className="text-sm mt-4" style={{ color: 'var(--muted)' }}>
                  {estimate.pickupLabel} → {estimate.deliveryLabel} · {estimate.miles} mi
                </p>
              </div>
              <div className="pt-6" style={{ borderTop: '1px solid var(--line)' }}>
                <p className="text-sm text-center leading-relaxed" style={{ color: 'var(--muted)' }}>
                  Estimate based on distance, load size, and service type. Final quote depends on appointment windows, dock conditions, and any special handling — typically lands within this range. Our team will email you a firm number shortly.
                </p>
              </div>
              <div className="mt-8 flex justify-center gap-3 flex-wrap">
                <button onClick={() => { setStatus('idle'); setEstimate(null) }} className="btn-ghost">Get Another Quote</button>
                <Link href="/" className="btn">← Back to Home</Link>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="glass-card p-8 space-y-5" style={{ borderRadius: '20px' }}>
              <div>
                <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)', letterSpacing: '0.12em' }}>1. Route</p>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Pickup ZIP*</label>
                    <input name="pickupZip" required maxLength={5} placeholder="75201" pattern="\d{5}" style={iStyle} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Delivery ZIP*</label>
                    <input name="deliveryZip" required maxLength={5} placeholder="76102" pattern="\d{5}" style={iStyle} />
                  </div>
                </div>
              </div>

              <div className="pt-3" style={{ borderTop: '1px solid var(--line)' }}>
                <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)', letterSpacing: '0.12em' }}>2. Load</p>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Pallets</label>
                    <input name="pallets" type="number" min={0} max={20} defaultValue={1} style={iStyle} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Total Weight (lbs)</label>
                    <input name="weight" type="number" min={0} max={20000} step={50} placeholder="2000" style={iStyle} />
                  </div>
                </div>
                <p className="text-xs mt-2" style={{ color: 'rgba(255,255,255,.4)' }}>Box-truck capacity is ~10,000 lb usable payload. Larger loads contact ops for multi-truck options.</p>
              </div>

              <div className="pt-3" style={{ borderTop: '1px solid var(--line)' }}>
                <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)', letterSpacing: '0.12em' }}>3. Service</p>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Service Type</label>
                    <select name="serviceType" defaultValue="dock-to-dock" style={{ ...iStyle, cursor: 'pointer' }}>
                      <option value="dock-to-dock">Dock-to-Dock</option>
                      <option value="last-mile-curbside">Last-Mile Curbside</option>
                      <option value="white-glove">White-Glove (room-of-choice)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Timing</label>
                    <select name="timing" defaultValue="standard" style={{ ...iStyle, cursor: 'pointer' }}>
                      <option value="standard">Standard (2–4 business days)</option>
                      <option value="next-day">Next-Day</option>
                      <option value="same-day">Same-Day</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="pt-3" style={{ borderTop: '1px solid var(--line)' }}>
                <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)', letterSpacing: '0.12em' }}>4. Contact</p>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Name*</label>
                    <input name="name" required placeholder="Your name" style={iStyle} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Company</label>
                    <input name="company" placeholder="Company name" style={iStyle} />
                  </div>
                </div>
                <div className="grid sm:grid-cols-2 gap-4 mt-4">
                  <div>
                    <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Email*</label>
                    <input name="email" type="email" required placeholder="you@company.com" style={iStyle} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Phone</label>
                    <input name="phone" type="tel" placeholder="(555) 000-0000" style={iStyle} />
                  </div>
                </div>
              </div>

              <div className="pt-3" style={{ borderTop: '1px solid var(--line)' }}>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Notes (optional)</label>
                <textarea name="notes" rows={3} placeholder="Special handling, appointment requirements, dock conditions, etc." style={{ ...iStyle, resize: 'vertical' }} />
              </div>

              {status === 'error' && <p className="text-sm" style={{ color: '#f87171' }}>{errorMsg}</p>}

              <button type="submit" disabled={status === 'sending'} className="btn w-full" style={{ justifyContent: 'center' }}>
                {status === 'sending' ? 'Computing…' : 'Get My Estimate →'}
              </button>
              <p className="text-xs text-center" style={{ color: 'rgba(255,255,255,.4)' }}>
                Estimate is non-binding. Final quote depends on appointment windows, dock conditions, and handling needs.
              </p>
            </form>
          )}
        </div>
      </section>

      <footer className="py-10 px-6 text-center text-xs" style={{ borderTop: '1px solid var(--line)', color: 'rgba(255,255,255,.3)' }}>
        © {new Date().getFullYear()} J Kiss LLC · US DOT 3484556 · MC 01155352
      </footer>
    </main>
  )
}
