'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

type Estimate = { low: number; high: number; miles: number; fuelCharge?: number; promoCode?: string; promoPct?: number; confidence?: 'high' | 'medium' | 'low'; jobBased?: boolean; pickupLabel: string; deliveryLabel: string }

// ISO yyyy-mm-dd → "Fri, Jul 4, 2026" (parsed LOCAL so it never slips a day).
function fmtDateLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
}

// ── Instant booking: pick an open date + pay a deposit ───────────────────────
function InstantBook() {
  const [open, setOpen] = useState(false)
  const [avail, setAvail] = useState<{ dates: string[]; depositCents: number } | null>(null)
  const [service, setService] = useState('junk-removal')
  const [date, setDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [photos, setPhotos] = useState<string[]>([])
  const [photoBusy, setPhotoBusy] = useState(false)

  useEffect(() => {
    if (!open || avail) return
    fetch('/api/availability').then(r => r.json()).then(j => { if (j.ok) setAvail({ dates: j.dates, depositCents: j.depositCents }) }).catch(() => {})
  }, [open, avail])

  async function addPhotos(files: FileList) {
    setPhotoBusy(true); setErr('')
    try {
      for (const file of Array.from(files).slice(0, 6)) {
        const dataUrl = await downscaleToDataUrl(file)
        const res = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: dataUrl }) })
        const j = await res.json()
        if (res.ok && j.url) setPhotos(p => [...p, j.url])
      }
    } catch { setErr('A photo failed to upload — you can still book.') }
    finally { setPhotoBusy(false) }
  }

  const inp: React.CSSProperties = { width: '100%', padding: '12px 14px', background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.10)', borderRadius: 10, color: '#f3f4f6', fontSize: 16, outline: 'none' }
  const sel: React.CSSProperties = { ...inp, cursor: 'pointer', colorScheme: 'dark' }
  const lbl: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 6 }
  const deposit = avail ? (avail.depositCents / 100).toFixed(0) : '50'

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setErr('')
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>
    try {
      const res = await fetch('/api/book', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...f, service, date, photos }) })
      const j = await res.json()
      if (!res.ok) { setErr(j.error ?? 'Could not book that date.'); setBusy(false); return }
      if (j.url) { window.location.href = j.url; return }
      if (j.bookingUrl) { window.location.href = j.bookingUrl; return }
      setBusy(false)
    } catch { setErr('Connection error — please try again.'); setBusy(false) }
  }

  return (
    <div className="glass-card mb-8" style={{ borderRadius: 20, border: '1px solid rgba(224,0,42,.3)', overflow: 'hidden' }}>
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between gap-3 p-6 text-left" aria-expanded={open}>
        <div>
          <p className="text-lg font-black text-white">⚡ Book Instantly</p>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>Know what you need? Pick an open date and lock it in with a deposit.</p>
        </div>
        <span style={{ color: 'var(--red)', fontSize: 22 }}>{open ? '–' : '+'}</span>
      </button>
      {open && (
        <form onSubmit={submit} className="px-6 pb-6 space-y-3" style={{ borderTop: '1px solid var(--line)' }}>
          {!avail ? (
            <p className="text-sm pt-4" style={{ color: 'var(--muted)' }}>Loading open dates…</p>
          ) : avail.dates.length === 0 ? (
            <p className="text-sm pt-4" style={{ color: 'var(--muted)' }}>No online dates are open right now — submit the quote form below and we&apos;ll get you scheduled.</p>
          ) : (
            <>
              <div className="grid sm:grid-cols-2 gap-3 pt-4">
                <div><label style={lbl}>Service</label>
                  <select value={service} onChange={e => setService(e.target.value)} style={sel}>
                    <option value="junk-removal">Junk Removal</option>
                    <option value="eviction">Eviction / Property Cleanout</option>
                    <option value="moving">Moving / Delivery</option>
                    <option value="appliance-delivery">Appliance Delivery</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div><label style={lbl}>Date</label>
                  <select value={date} onChange={e => setDate(e.target.value)} required style={sel}>
                    <option value="">Choose an open date…</option>
                    {avail.dates.map(d => <option key={d} value={d}>{fmtDateLabel(d)}</option>)}
                  </select>
                </div>
                <div><label style={lbl}>Name</label><input name="name" required style={inp} /></div>
                <div><label style={lbl}>Phone</label><input name="phone" type="tel" style={inp} /></div>
                <div className="sm:col-span-2"><label style={lbl}>Email</label><input name="email" type="email" required style={inp} /></div>
                <div className="sm:col-span-2"><label style={lbl}>Service address</label><input name="address" style={inp} /></div>
                <div className="sm:col-span-2"><label style={lbl}>Notes <span style={{ fontWeight: 400 }}>(optional)</span></label><input name="notes" placeholder="What's the job?" style={inp} /></div>
                <div className="sm:col-span-2"><label style={lbl}>Promo code <span style={{ fontWeight: 400 }}>(optional)</span></label><input name="promo" style={{ ...inp, textTransform: 'uppercase' }} /></div>
              </div>

              <div>
                <label style={lbl}>Photos <span style={{ fontWeight: 400 }}>(optional — helps us prep the right crew & truck)</span></label>
                <label className="btn-ghost" style={{ padding: '10px 16px', fontSize: 14, cursor: photoBusy ? 'wait' : 'pointer', display: 'inline-flex' }}>
                  {photoBusy ? 'Uploading…' : photos.length ? '+ Add more' : '📷 Add photos'}
                  <input type="file" accept="image/*" multiple onChange={e => { const fs = e.target.files; e.target.value = ''; if (fs?.length) addPhotos(fs) }} disabled={photoBusy} style={{ display: 'none' }} />
                </label>
                {photos.length > 0 && (
                  <div className="grid grid-cols-4 sm:grid-cols-6 gap-2 mt-3">
                    {photos.map((url, i) => (
                      <div key={url} style={{ position: 'relative', aspectRatio: '1 / 1', borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(255,255,255,.1)' }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        <button type="button" onClick={() => setPhotos(p => p.filter((_, idx) => idx !== i))} aria-label="Remove photo"
                          style={{ position: 'absolute', top: 2, right: 2, width: 22, height: 22, borderRadius: 999, border: 'none', background: 'rgba(0,0,0,.65)', color: '#fff', cursor: 'pointer', fontSize: 13, lineHeight: '22px' }}>×</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {err && <p className="text-sm" role="alert" style={{ color: '#f87171' }}>{err}</p>}
              <button type="submit" disabled={busy || !date} className="btn w-full" style={{ justifyContent: 'center' }}>
                {busy ? 'Reserving…' : `Reserve & Pay $${deposit} Deposit →`}
              </button>
              <p className="text-xs text-center" style={{ color: 'rgba(255,255,255,.4)' }}>Your ${deposit} deposit holds the date and is <strong>fully refunded</strong> if we can&apos;t make it. The balance is settled after the job.</p>
            </>
          )}
        </form>
      )}
    </div>
  )
}

// Downscale an image to a small JPEG data URL for the AI photo estimate. Falls
// back to the original (e.g. HEIC the browser can't decode to canvas).
async function downscaleToDataUrl(file: File, maxDim = 1280, quality = 0.7): Promise<string> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
    const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no ctx')
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close?.()
    return canvas.toDataURL('image/jpeg', quality)
  } catch {
    return await new Promise((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result))
      fr.onerror = () => reject(new Error('read failed'))
      fr.readAsDataURL(file)
    })
  }
}

export default function QuotePage() {
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [service, setService] = useState('dock-to-dock')
  // AI photo estimate (junk-removal / cleanout)
  const [photoEst, setPhotoEst] = useState<{ loadSize: string; low: number; high: number; summary: string } | null>(null)
  const [photoBusy, setPhotoBusy] = useState(false)
  const [photoErr, setPhotoErr] = useState('')
  const isJunk = service === 'junk-removal'
  const isEviction = service === 'eviction'

  async function estimateFromPhoto(file: File) {
    setPhotoErr(''); setPhotoEst(null); setPhotoBusy(true)
    try {
      const dataUrl = await downscaleToDataUrl(file)
      const res = await fetch('/api/ai/photo-estimate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: dataUrl }),
      })
      const j = await res.json()
      if (!res.ok) { setPhotoErr(j.error ?? 'Could not estimate from that photo.'); return }
      setPhotoEst({ loadSize: j.loadSize, low: j.low, high: j.high, summary: j.summary })
    } catch { setPhotoErr('Could not read that photo. Try another, or request a custom quote below.') }
    finally { setPhotoBusy(false) }
  }
  // Junk removal and eviction/property cleanouts are single-site, priced per job —
  // same form shape and request-only flow (no instant price).
  const isJobBased = isJunk || isEviction
  const jobNoun = isEviction ? 'Property cleanout' : 'Junk removal'

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setStatus('sending')
    setErrorMsg('')
    const form = e.currentTarget
    const fd = new FormData(form)
    const data = Object.fromEntries(fd) as Record<string, string>
    const addOns = fd.getAll('addOns').map(String)
    // Job-based services (junk removal, eviction cleanouts) are single-site —
    // mirror the job ZIP into deliveryZip so route validation/lookup passes and
    // distance resolves to 0.
    if (isJobBased) data.deliveryZip = data.pickupZip
    try {
      const res = await fetch('/api/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, addOns }),
      })
      const j = await res.json()
      if (res.ok && (j.estimate || j.requested)) {
        // Delivery returns a price range; junk removal returns a request ack only.
        setEstimate(j.estimate ?? null)
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
          <div className="label mb-6">{isJobBased ? 'Request a Quote' : 'Instant Estimate'}</div>
          <h1 className="text-4xl md:text-5xl font-black text-white mb-5" style={{ letterSpacing: '-0.045em', lineHeight: 1.05, fontFamily: 'var(--font-display)' }}>
            {isEviction ? (
              <>Get a Property Cleanout Quote<br /><span style={{ color: 'var(--red)' }}>Priced for the Job.</span></>
            ) : isJunk ? (
              <>Get a Junk Removal Quote<br /><span style={{ color: 'var(--red)' }}>Priced for the Job.</span></>
            ) : (
              <>Get a Box-Truck Quote<br /><span style={{ color: 'var(--red)' }}>In 30 Seconds.</span></>
            )}
          </h1>
          <p className="text-lg mb-10" style={{ color: 'var(--muted)', lineHeight: 1.6 }}>
            {isJobBased
              ? `Tell us the job site, what needs to go, and how soon. ${jobNoun} is priced per job, so ops will send you a custom quote within 1 business day.`
              : 'Enter pickup and delivery ZIPs, load details, and service type. We’ll compute a price range right away and ops will follow up with a firm number within 1 business day.'}
          </p>

          {status !== 'sent' && <InstantBook />}

          {status === 'sent' && estimate ? (
            <div className="glass-card p-10" style={{ borderRadius: '20px' }}>
              <div className="text-center mb-8">
                <div className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)', letterSpacing: '0.14em' }}>Estimated Price Range</div>
                <p className="text-6xl md:text-7xl font-black tabular-nums" style={{ color: 'var(--red)', letterSpacing: '-0.05em', lineHeight: 1, fontFamily: 'var(--font-display)' }}>
                  ${estimate.low.toLocaleString()}–${estimate.high.toLocaleString()}
                </p>
                <p className="text-sm mt-4" style={{ color: 'var(--muted)' }}>
                  {estimate.jobBased
                    ? `${estimate.pickupLabel} · priced by load + disposal`
                    : `${estimate.pickupLabel} → ${estimate.deliveryLabel} · ${estimate.miles} mi (${estimate.miles * 2} mi round trip)`}
                </p>
                {!!estimate.fuelCharge && estimate.fuelCharge > 0 && (
                  <p className="text-xs mt-1" style={{ color: 'rgba(255,255,255,.45)' }}>Includes a ${estimate.fuelCharge} fuel charge for the round-trip distance.</p>
                )}
                {estimate.promoCode && (
                  <p className="text-xs mt-1 font-semibold" style={{ color: '#34d399' }}>✓ Promo {estimate.promoCode} applied{estimate.promoPct ? ` — ${estimate.promoPct}% off` : ''}.</p>
                )}
                {(estimate.confidence === 'medium' || estimate.confidence === 'low') && (
                  <p className="text-xs mt-2" style={{ color: 'rgba(255,255,255,.5)' }}>Instant estimate — the final price may need a photo or a quick review to confirm.</p>
                )}
              </div>
              <div className="pt-6" style={{ borderTop: '1px solid var(--line)' }}>
                <p className="text-sm text-center leading-relaxed" style={{ color: 'var(--muted)' }}>
                  Estimate based on distance, load size, and service type. Final quote depends on appointment windows, dock conditions, and any special handling — typically lands within this range. Our team will email you a firm number shortly.
                </p>
              </div>
              <div className="mt-8 flex justify-center gap-3 flex-wrap">
                <button onClick={() => { setStatus('idle'); setEstimate(null); setService('dock-to-dock') }} className="btn-ghost">Get Another Quote</button>
                <Link href="/" className="btn">← Back to Home</Link>
              </div>
            </div>
          ) : status === 'sent' ? (
            <div className="glass-card p-10 text-center" style={{ borderRadius: '20px' }}>
              <div className="text-5xl mb-5">✓</div>
              <h2 className="text-2xl font-black text-white mb-3" style={{ letterSpacing: '-0.02em' }}>Request Received</h2>
              <p className="text-base leading-relaxed mb-2" style={{ color: 'var(--muted)' }}>
                {`Thanks — we've got your ${jobNoun.toLowerCase()} details. Because every job is different, our team will review what's involved and email you a custom quote within 1 business day.`}
              </p>
              <p className="text-sm" style={{ color: 'rgba(255,255,255,.4)' }}>
                Need it handled fast? Call or email us at info@jkissllc.com.
              </p>
              <div className="mt-8 flex justify-center gap-3 flex-wrap">
                <button onClick={() => { setStatus('idle'); setEstimate(null); setService('dock-to-dock') }} className="btn-ghost">Submit Another Request</button>
                <Link href="/" className="btn">← Back to Home</Link>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="glass-card p-8 space-y-5" style={{ borderRadius: '20px' }}>
              <div>
                <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)', letterSpacing: '0.12em' }}>1. Service</p>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Service Type</label>
                    <select name="serviceType" value={service} onChange={(e) => setService(e.target.value)} style={{ ...iStyle, cursor: 'pointer' }}>
                      <option value="dock-to-dock">Dock-to-Dock</option>
                      <option value="last-mile-curbside">Last-Mile Curbside</option>
                      <option value="white-glove">White-Glove (room-of-choice)</option>
                      <option value="junk-removal">Junk Removal</option>
                      <option value="eviction">Eviction / Property Cleanout</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Timing</label>
                    <select name="timing" defaultValue="standard" style={{ ...iStyle, cursor: 'pointer' }}>
                      <option value="standard">Standard (2–4 business days)</option>
                      <option value="next-day">Next-Day</option>
                      <option value="same-day">Same-Day</option>
                      <option value="weekend">Weekend</option>
                      <option value="after-hours">After-Hours (evening)</option>
                      <option value="emergency">Emergency / ASAP</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="pt-3" style={{ borderTop: '1px solid var(--line)' }}>
                <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)', letterSpacing: '0.12em' }}>{isJobBased ? '2. Job Location' : '2. Route'}</p>
                {isJobBased ? (
                  <div>
                    <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Job ZIP*</label>
                    <input name="pickupZip" required maxLength={5} placeholder="75201" pattern="\d{5}" style={iStyle} />
                  </div>
                ) : (
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
                )}
              </div>

              <div className="pt-3" style={{ borderTop: '1px solid var(--line)' }}>
                <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)', letterSpacing: '0.12em' }}>{isJobBased ? '3. Load Size' : '3. Load'}</p>
                {isJobBased ? (
                  <div>
                    <div className="grid sm:grid-cols-2 gap-4 mb-3">
                      <div>
                        <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Estimated Load Size</label>
                        <select name="loadSize" defaultValue="quarter" style={{ ...iStyle, cursor: 'pointer' }}>
                          <option value="few-items">A few items</option>
                          <option value="quarter">About a quarter truck</option>
                          <option value="half">About a half truck</option>
                          <option value="three-quarter">About three-quarter truck</option>
                          <option value="full">Full truck load</option>
                          <option value="multiple">More than one truck</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>What are you removing?</label>
                        <select name="debris" defaultValue={isEviction ? 'eviction-cleanout' : 'general'} style={{ ...iStyle, cursor: 'pointer' }}>
                          <option value="general">General / mixed junk</option>
                          <option value="furniture">Furniture / bulky items</option>
                          <option value="appliance">Appliances</option>
                          <option value="mattress">Mattresses</option>
                          <option value="yard-waste">Yard waste / brush</option>
                          <option value="construction-debris">Construction debris</option>
                          <option value="eviction-cleanout">Eviction / full cleanout</option>
                        </select>
                      </div>
                    </div>
                    <p className="text-xs mt-2" style={{ color: 'rgba(255,255,255,.4)' }}>We&apos;ll give you an instant range based on load size, item type, and disposal. Add a photo below for a sharper estimate — final price confirmed on site.</p>

                    {/* AI photo estimate */}
                    <div className="mt-4 rounded-xl p-4" style={{ background: 'rgba(224,0,42,.06)', border: '1px solid rgba(224,0,42,.25)' }}>
                      <p className="text-sm font-bold text-white mb-1">✨ Instant estimate from a photo</p>
                      <p className="text-xs mb-3" style={{ color: 'rgba(255,255,255,.55)', lineHeight: 1.5 }}>Snap a pic of the pile and our AI will ballpark the load size + price. Final quote is confirmed on site.</p>
                      <label className="btn-ghost" style={{ padding: '10px 16px', fontSize: 14, cursor: photoBusy ? 'wait' : 'pointer', display: 'inline-flex' }}>
                        {photoBusy ? 'Analyzing…' : photoEst ? 'Try another photo' : '📷 Add a photo'}
                        <input type="file" accept="image/*" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) estimateFromPhoto(f) }} disabled={photoBusy} style={{ display: 'none' }} />
                      </label>
                      {photoErr && <p className="text-xs mt-2" role="alert" style={{ color: '#ff8a9b' }}>{photoErr}</p>}
                      {photoEst && (
                        <div className="mt-3 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,.1)' }}>
                          {photoEst.high > 0 ? (
                            <>
                              <p className="text-lg font-black text-white">${photoEst.low}–${photoEst.high} <span className="text-sm font-semibold" style={{ color: 'var(--muted)' }}>· {photoEst.loadSize}</span></p>
                              {photoEst.summary && <p className="text-xs mt-1" style={{ color: 'rgba(255,255,255,.6)', lineHeight: 1.5 }}>{photoEst.summary}</p>}
                              <p className="text-xs mt-2" style={{ color: 'rgba(255,255,255,.4)' }}>Estimate only — submit the form below to lock in your custom quote.</p>
                            </>
                          ) : (
                            <p className="text-sm" style={{ color: '#ff8a9b', lineHeight: 1.5 }}>{photoEst.summary || 'We may not be able to haul some of those items — please describe the job below and we’ll advise.'}</p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <>
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
                  </>
                )}
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
                <p className="text-xs mt-2" style={{ color: 'rgba(255,255,255,.4)', lineHeight: 1.5 }}>
                  By providing your phone number, you agree to receive booking and service-related text messages
                  (confirmations, scheduling, and updates) from J Kiss LLC at the number provided, including messages
                  sent by autodialer. Consent is not a condition of purchase. Message &amp; data rates may apply.
                  Reply STOP to opt out, HELP for help.
                </p>
              </div>

              {!isJobBased && (
                <div className="pt-3" style={{ borderTop: '1px solid var(--line)' }}>
                  <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)', letterSpacing: '0.12em' }}>Add-ons (optional)</p>
                  <div className="grid sm:grid-cols-2 gap-2">
                    {[
                      { v: 'stairs', l: 'Stairs / no elevator', p: 40 },
                      { v: 'extra-stop', l: 'Extra stop', p: 60 },
                      { v: 'packing', l: 'Packing / wrapping', p: 75 },
                      { v: 'disposal', l: 'Haul-away / disposal', p: 50 },
                      { v: 'extra-labor', l: 'Extra labor', p: 65 },
                      { v: 'assembly', l: 'Assembly / disassembly', p: 55 },
                    ].map(a => (
                      <label key={a.v} className="flex items-center gap-2.5 text-sm px-3 py-2.5 rounded-xl cursor-pointer" style={{ background: 'rgba(255,255,255,.04)', border: '1px solid var(--line)', color: 'var(--text)' }}>
                        <input type="checkbox" name="addOns" value={a.v} style={{ width: 16, height: 16, accentColor: '#E0002A', flexShrink: 0 }} />
                        <span className="flex-1">{a.l}</span>
                        <span style={{ color: 'var(--muted)' }}>+${a.p}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div className="pt-3" style={{ borderTop: '1px solid var(--line)' }}>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>{isJobBased ? 'What needs to go?' : 'Notes (optional)'}</label>
                <textarea name="notes" rows={3} placeholder={isEviction ? 'e.g. full apartment/house trash-out, tenant belongings left behind, furniture & appliances, number of bedrooms, stairs/elevator access…' : isJunk ? 'e.g. garage cleanout, old appliances & furniture, construction debris, stairs/elevator access, heavy items… (note: we can’t haul hazardous materials)' : 'Special handling, appointment requirements, dock conditions, etc.'} style={{ ...iStyle, resize: 'vertical' }} />
                <label className="block text-xs font-semibold mb-1.5 mt-3" style={{ color: 'var(--muted)' }}>How did you hear about us? <span style={{ fontWeight: 400 }}>(optional — referral name)</span></label>
                <input name="referral" placeholder="e.g. Google, or a friend's name" style={iStyle} />
                <label className="block text-xs font-semibold mb-1.5 mt-3" style={{ color: 'var(--muted)' }}>Promo code <span style={{ fontWeight: 400 }}>(optional)</span></label>
                <input name="promo" placeholder="Enter a code for a discount" style={{ ...iStyle, textTransform: 'uppercase' }} />
              </div>

              {status === 'error' && <p className="text-sm" style={{ color: '#f87171' }}>{errorMsg}</p>}

              <button type="submit" disabled={status === 'sending'} className="btn w-full" style={{ justifyContent: 'center' }}>
                {status === 'sending' ? (isJobBased ? 'Sending…' : 'Computing…') : (isJobBased ? 'Request My Quote →' : 'Get My Estimate →')}
              </button>
              <p className="text-xs text-center" style={{ color: 'rgba(255,255,255,.4)' }}>
                {isJobBased
                  ? 'No instant price — every job is different. We’ll review the details and send a custom quote within 1 business day.'
                  : 'Estimate is non-binding. Final quote depends on appointment windows, dock conditions, and handling needs.'}
              </p>
              <p className="text-xs text-center" style={{ color: 'rgba(255,255,255,.3)' }}>
                By submitting, you agree to our{' '}
                <a href="/terms" className="underline" style={{ color: 'rgba(255,255,255,.55)' }}>Terms</a> and{' '}
                <a href="/privacy" className="underline" style={{ color: 'rgba(255,255,255,.55)' }}>Privacy Policy</a>.
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
