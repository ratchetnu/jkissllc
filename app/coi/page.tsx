'use client'

import { useState } from 'react'
import { COMPANY, CREDENTIALS_DOT } from '../lib/company';
import Link from 'next/link'

export default function CoiPage() {
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setStatus('sending')
    setErrorMsg('')
    const form = e.currentTarget
    const data = Object.fromEntries(new FormData(form))
    try {
      const res = await fetch('/api/coi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      const j = await res.json()
      if (res.ok) { setStatus('sent'); form.reset() }
      else { setStatus('error'); setErrorMsg(j.error ?? 'Failed to submit.') }
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
            {COMPANY.nameLead} <span style={{ color: 'var(--red)' }}>{COMPANY.nameAccent}</span>
          </Link>
          <Link href="/" className="text-sm font-semibold transition hover:text-white" style={{ color: 'var(--muted)' }}>← Back to Home</Link>
        </div>
      </header>

      <section className="pt-32 pb-20 px-6">
        <div className="max-w-3xl mx-auto">
          <div className="label mb-6">Insurance · COI</div>
          <h1 className="text-4xl md:text-5xl font-black text-white mb-5" style={{ letterSpacing: '-0.045em', lineHeight: 1.05, fontFamily: 'var(--font-display)' }}>
            Request a Certificate of Insurance
          </h1>
          <p className="text-lg mb-10" style={{ color: 'var(--muted)', lineHeight: 1.6 }}>
            Need a COI naming your company as Certificate Holder (or Additional Insured)? Fill this out and our broker will issue an ACORD 25 directly to you within 1 business day.
          </p>

          {status === 'sent' ? (
            <div className="glass-card p-10 text-center" style={{ borderRadius: '20px' }}>
              <div className="text-5xl mb-4">✓</div>
              <p className="text-xl font-black text-white mb-2" style={{ fontFamily: 'var(--font-display)' }}>Request submitted</p>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>
                Our broker has been notified. You&apos;ll receive the ACORD 25 by email within 1 business day. We&apos;ve sent you a confirmation as well.
              </p>
              <Link href="/" className="btn mt-8 inline-flex">← Back to Home</Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="glass-card p-8 space-y-5" style={{ borderRadius: '20px' }}>
              <div>
                <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)', letterSpacing: '0.12em' }}>1. Certificate Holder</p>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Company Name (Certificate Holder)*</label>
                    <input name="holderName" required placeholder="Acme Logistics Inc." style={iStyle} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Holder Address</label>
                    <textarea name="holderAddress" rows={3} placeholder="123 Main St&#10;Dallas, TX 75201" style={{ ...iStyle, resize: 'vertical' }} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>List as Additional Insured?</label>
                    <select name="additionalInsured" style={{ ...iStyle, cursor: 'pointer' }}>
                      <option value="no">No — Certificate Holder only</option>
                      <option value="yes">Yes — list as Additional Insured</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Project / PO # (optional)</label>
                    <input name="project" placeholder="e.g., PO-12345 / DFW expansion contract" style={iStyle} />
                  </div>
                </div>
              </div>

              <div className="pt-3" style={{ borderTop: '1px solid var(--line)' }}>
                <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)', letterSpacing: '0.12em' }}>2. Where to Send the COI</p>
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Delivery Email (broker will send ACORD 25 here)</label>
                  <input name="deliveryEmail" type="email" placeholder="compliance@yourcompany.com" style={iStyle} />
                  <p className="text-xs mt-1.5" style={{ color: 'rgba(255,255,255,.4)' }}>If blank, we&apos;ll send to your contact email below.</p>
                </div>
              </div>

              <div className="pt-3" style={{ borderTop: '1px solid var(--line)' }}>
                <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)', letterSpacing: '0.12em' }}>3. Your Info</p>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Your Name*</label>
                    <input name="requesterName" required placeholder="Jane Doe" style={iStyle} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Phone</label>
                    <input name="requesterPhone" type="tel" placeholder="(555) 000-0000" style={iStyle} />
                  </div>
                </div>
                <div className="mt-4">
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Your Email*</label>
                  <input name="requesterEmail" type="email" required placeholder="you@yourcompany.com" style={iStyle} />
                </div>
              </div>

              <div className="pt-3" style={{ borderTop: '1px solid var(--line)' }}>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Notes (optional)</label>
                <textarea name="notes" rows={3} placeholder="Specific limit requirements, waiver of subrogation needed, etc." style={{ ...iStyle, resize: 'vertical' }} />
              </div>

              {status === 'error' && (
                <p className="text-sm" style={{ color: '#f87171' }}>{errorMsg}</p>
              )}

              <button type="submit" disabled={status === 'sending'} className="btn w-full" style={{ justifyContent: 'center' }}>
                {status === 'sending' ? 'Submitting…' : 'Request COI →'}
              </button>

              <p className="text-xs text-center" style={{ color: 'rgba(255,255,255,.4)' }}>
                We don&apos;t store this data — it&apos;s forwarded directly to our insurance broker.
              </p>
            </form>
          )}
        </div>
      </section>

      <footer className="py-10 px-6 text-center text-xs" style={{ borderTop: '1px solid var(--line)', color: 'rgba(255,255,255,.3)' }}>
        © {new Date().getFullYear()} {COMPANY.legalName} · {CREDENTIALS_DOT}
      </footer>
    </main>
  )
}
