'use client'

import { useEffect, useState } from 'react'
import { COMPANY, CREDENTIALS_DOT } from '../lib/company';
import Link from 'next/link'
import {
  Trash2, Truck, Refrigerator, Sofa, Boxes, Trees, HardHat, Building2, KeyRound, HelpCircle,
  Zap, DoorOpen, PlugZap, Wrench, Users, Recycle, CalendarClock, ShieldCheck,
  Camera, Check, ArrowLeft, ArrowRight, X, MapPin, Loader2, Star,
  type LucideIcon,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// A guided, concierge-style quote experience for the company. Same premium
// multi-step FLOW as our best work — rendered entirely in the J Kiss brand
// (red #E0002A on near-black, Space Grotesk display). All existing business
// logic is preserved: the primary CTA files a lead via /api/quote, and eligible
// jobs can optionally lock a date via /api/book + Stripe.
// ─────────────────────────────────────────────────────────────────────────────

const RED = '#E0002A'
const STEP_LABELS = ['Service', 'The job', 'Photos', 'Upgrades', 'Your info', 'Review']
const WINDOWS = ['8am–10am', '10am–12pm', '12pm–2pm', '2pm–4pm', '4pm–6pm']

type Svc = {
  id: string
  label: string
  icon: LucideIcon
  desc: string
  turnaround: string
  starting?: string
  quoteType: string       // → /api/quote serviceType (drives pricing)
  bookType: string        // → /api/book service (booking enum)
  jobBased: boolean       // single-site, disposal-priced
  debris?: string
}

// Card catalog. Each card carries BOTH vocabularies so pricing (quoteType) and
// booking (bookType) stay correct while the customer only ever sees one choice.
const SERVICES: Svc[] = [
  { id: 'junk-removal', label: 'Junk Removal', icon: Trash2, desc: 'A few items up to a full truck — hauled away and gone.', turnaround: 'Same / next-day', starting: 'from $99', quoteType: 'junk-removal', bookType: 'junk-removal', jobBased: true, debris: 'general' },
  { id: 'moving', label: 'Moving Services', icon: Truck, desc: 'Homes and offices — loaded, moved, and set in place.', turnaround: '2–4 days', quoteType: 'moving', bookType: 'moving', jobBased: false },
  { id: 'appliance-delivery', label: 'Appliance Delivery', icon: Refrigerator, desc: 'Fridges, washers, ranges — delivered and positioned.', turnaround: 'Next-day', quoteType: 'appliance-delivery', bookType: 'appliance-delivery', jobBased: false },
  { id: 'furniture-delivery', label: 'Furniture Delivery', icon: Sofa, desc: 'White-glove furniture delivery to the room of your choice.', turnaround: 'Next-day', quoteType: 'white-glove', bookType: 'moving', jobBased: false },
  { id: 'freight', label: 'Freight Delivery', icon: Boxes, desc: 'Palletized freight, dock-to-dock across the metroplex.', turnaround: '2–4 days', quoteType: 'dock-to-dock', bookType: 'freight', jobBased: false },
  { id: 'brush-debris', label: 'Brush & Debris Removal', icon: Trees, desc: 'Yard waste, branches, and storm debris cleared out.', turnaround: 'Same / next-day', starting: 'from $99', quoteType: 'junk-removal', bookType: 'junk-removal', jobBased: true, debris: 'yard-waste' },
  { id: 'construction-hauling', label: 'Construction Material Hauling', icon: HardHat, desc: 'Building materials delivered — or jobsite debris hauled off.', turnaround: '1–3 days', quoteType: 'last-mile-curbside', bookType: 'freight', jobBased: false },
  { id: 'commercial-delivery', label: 'Commercial Delivery', icon: Building2, desc: 'Retail replenishment and B2B box-truck runs.', turnaround: 'Scheduled', quoteType: 'dock-to-dock', bookType: 'freight', jobBased: false },
  { id: 'eviction', label: 'Property Cleanout', icon: KeyRound, desc: 'Eviction, foreclosure, and estate clear-outs, start to finish.', turnaround: '1–2 days', quoteType: 'eviction', bookType: 'eviction', jobBased: true, debris: 'eviction-cleanout' },
  { id: 'other', label: 'Something Else', icon: HelpCircle, desc: "Not sure which fits? Tell us the job and we'll advise.", turnaround: "We'll advise", quoteType: 'other', bookType: 'other', jobBased: false },
]

// Shared load-size scale. `pallets` feeds distance pricing for delivery services;
// `id` feeds the disposal engine + scheduling units for job-based services.
const SIZES = [
  { id: 'few-items', label: 'A few items', hint: '1–3 pieces', pallets: 1 },
  { id: 'quarter', label: 'Quarter load', hint: 'A small room', pallets: 2 },
  { id: 'half', label: 'Half load', hint: 'A room or two', pallets: 3 },
  { id: 'three-quarter', label: 'Three-quarter', hint: 'Most of a home', pallets: 4 },
  { id: 'full', label: 'Full truck', hint: 'A whole home or office', pallets: 6 },
  { id: 'multiple', label: 'Multiple loads', hint: 'More than one truck', pallets: 10 },
]

// Optional upgrades. Prices MUST match PRICING.addOns in /api/quote so the range
// the customer sees equals what the server computes.
const UPGRADES: { id: string; label: string; price: number; icon: LucideIcon; why: string }[] = [
  { id: 'same-day', label: 'Same-Day Service', price: 120, icon: Zap, why: 'Jump the queue — we come today when a slot is open.' },
  { id: 'inside-placement', label: 'Inside Placement', price: 60, icon: DoorOpen, why: 'Carried inside to the exact room, not left at the curb.' },
  { id: 'appliance-hookup', label: 'Appliance Hookup', price: 45, icon: PlugZap, why: 'Connect and test washers, dryers, ranges, and fridges.' },
  { id: 'assembly', label: 'Furniture Assembly', price: 55, icon: Wrench, why: 'Beds, tables, and shelving assembled and ready to use.' },
  { id: 'extra-labor', label: 'Extra Labor', price: 65, icon: Users, why: 'An extra mover for heavy, tight, or high-volume jobs.' },
  { id: 'disposal', label: 'Dump Run / Haul-Away', price: 50, icon: Recycle, why: 'We take the old stuff away and dispose of it for you.' },
  { id: 'priority', label: 'Priority Scheduling', price: 40, icon: CalendarClock, why: 'First arrival window and a tighter time promise.' },
  { id: 'packing', label: 'Protective Wrapping', price: 75, icon: ShieldCheck, why: 'Blankets and shrink-wrap so nothing gets scratched.' },
]

// ISO yyyy-mm-dd → "Fri, Jul 4, 2026" (parsed LOCAL so it never slips a day).
function fmtDateLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
}

function parseZip(s: string): string {
  const m = s.match(/\b(\d{5})\b/)
  return m ? m[1] : ''
}

// Downscale an image to a small JPEG data URL before upload. Falls back to the
// original (e.g. a HEIC the browser can't decode to canvas).
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

// ── Small shared styles (J Kiss brand) ──────────────────────────────────────
const inp: React.CSSProperties = { width: '100%', padding: '13px 15px', background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.10)', borderRadius: 12, color: '#f3f4f6', fontSize: 16, outline: 'none' }
const lbl: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 8 }

export default function QuotePage() {
  // Flow state
  const [step, setStep] = useState(0)
  const [svcId, setSvcId] = useState('')
  const svc = SERVICES.find(s => s.id === svcId)
  const singleSite = !!svc && (svc.jobBased || svc.id === 'other')

  // Step 1 — the job
  const [pickupText, setPickupText] = useState('')
  const [deliveryText, setDeliveryText] = useState('')
  const [sizeId, setSizeId] = useState('')
  const [heavy, setHeavy] = useState<boolean | null>(null)
  const [stairs, setStairs] = useState<boolean | null>(null)
  const [elevator, setElevator] = useState<boolean | null>(null)
  const [prefDate, setPrefDate] = useState('')

  // Step 2 — photos
  const [photos, setPhotos] = useState<string[]>([])
  const [photoBusy, setPhotoBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  // Step 3 — upgrades
  const [upgrades, setUpgrades] = useState<string[]>([])

  // Step 4 — contact
  const [name, setName] = useState(''); const [company, setCompany] = useState('')
  const [phone, setPhone] = useState(''); const [email, setEmail] = useState('')
  const [contactMethod, setContactMethod] = useState('Text message')
  const [promo, setPromo] = useState('')

  // Estimate + reserve
  const [est, setEst] = useState<{ hasPrice: boolean; low?: number; high?: number; depositCents: number; confidence?: string; units: number } | null>(null)
  const [reserveOpen, setReserveOpen] = useState(false)
  const [avail, setAvail] = useState<{ dates: string[]; depositCents: number } | null>(null)
  const [bookDate, setBookDate] = useState(''); const [bookWin, setBookWin] = useState('')

  const [busy, setBusy] = useState(false); const [err, setErr] = useState('')
  const [sent, setSent] = useState<{ estimate?: Estimate } | null>(null)

  // Deep-link: /quote?service=junk-removal preselects a card and jumps to step 2.
  // Always land at the top — Next's client navigation keeps the homepage's scroll
  // position, so reset it on mount whether or not a service was deep-linked.
  useEffect(() => {
    window.scrollTo(0, 0)
    const q = new URLSearchParams(window.location.search).get('service')
    if (!q) return
    const match = SERVICES.find(s => s.id === q || s.quoteType === q || s.bookType === q)
    if (match) { setSvcId(match.id); setStep(1) }
  }, [])

  // Scroll to top on each step change, AFTER the new step renders. A scrollTo in
  // the click handler runs before the re-render and gets undone by the step swap.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [step])

  const size = SIZES.find(s => s.id === sizeId)
  const upgradeTotal = UPGRADES.filter(u => upgrades.includes(u.id)).reduce((s, u) => s + u.price, 0)
  const deposit = ((est?.depositCents ?? avail?.depositCents ?? 5000) / 100).toFixed(0)
  const showLow = est?.hasPrice && est.low != null ? est.low + upgradeTotal : null
  const showHigh = est?.hasPrice && est.high != null ? est.high + upgradeTotal : null

  function toggleUpgrade(id: string) {
    setUpgrades(u => u.includes(id) ? u.filter(x => x !== id) : [...u, id])
  }

  async function addPhotos(files: FileList) {
    setPhotoBusy(true); setErr('')
    try {
      for (const file of Array.from(files).slice(0, 8)) {
        if (!file.type.startsWith('image/')) continue
        const dataUrl = await downscaleToDataUrl(file)
        const res = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: dataUrl }) })
        const j = await res.json()
        if (res.ok && j.url) setPhotos(p => [...p, j.url].slice(0, 8))
      }
    } catch { setErr('A photo failed to upload — you can still continue without it.') }
    finally { setPhotoBusy(false) }
  }

  // Instant, email-free price/deposit preview once service + size are known.
  async function loadEstimate() {
    if (!svc) return
    try {
      const res = await fetch('/api/estimate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service: svc.quoteType, loadSize: sizeId, debris: svc.debris }) })
      const j = await res.json()
      if (res.ok) setEst(j)
    } catch { /* non-blocking — the summary just omits a live range */ }
  }

  function validate(): string {
    if (step === 0 && !svcId) return 'Choose the service you need to continue.'
    if (step === 1) {
      if (!parseZip(pickupText)) return singleSite ? 'Add the job address or ZIP so we can price it.' : 'Add the pickup address or ZIP so we can price the route.'
      if (!singleSite && !parseZip(deliveryText)) return 'Add the delivery address or ZIP.'
      if (!sizeId) return 'Tell us roughly how much there is.'
    }
    if (step === 4) {
      if (!name.trim()) return 'Please add your name.'
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Please add a valid email so we can send your quote.'
    }
    return ''
  }

  function next() {
    const v = validate()
    if (v) { setErr(v); return }
    setErr('')
    if (step === 1) loadEstimate()          // fetch as we leave the job-details step
    setStep(s => Math.min(5, s + 1))        // scroll handled by the [step] effect
  }
  function back() {
    setErr(''); setReserveOpen(false)
    setStep(s => Math.max(0, s - 1))
  }

  function buildNotes(): string {
    return [
      !singleSite && deliveryText ? `Delivery: ${deliveryText}` : '',
      size ? `Size: ${size.label}` : '',
      heavy ? 'Has large / heavy items' : '',
      stairs ? 'Stairs on site' : '',
      elevator ? 'Elevator available' : '',
      prefDate ? `Preferred date: ${fmtDateLabel(prefDate)}` : '',
      contactMethod ? `Best contact: ${contactMethod}` : '',
    ].filter(Boolean).join(' · ')
  }

  // Primary CTA — file the quote request (lead) via the existing engine.
  async function submitLead() {
    if (!svc) return
    setBusy(true); setErr('')
    const pickupZip = parseZip(pickupText)
    const deliveryZip = singleSite ? pickupZip : parseZip(deliveryText)
    try {
      const res = await fetch('/api/quote', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serviceType: svc.quoteType, timing: 'standard',
          pickupZip, deliveryZip,
          pallets: String(size?.pallets ?? 1), weight: '',
          loadSize: sizeId, debris: svc.debris ?? 'general',
          name, email, phone, company,
          notes: buildNotes(), referral: '', promo,
          addOns: upgrades, photos,
        }),
      })
      const j = await res.json()
      if (res.ok && j.estimate) { setSent({ estimate: j.estimate }); window.scrollTo({ top: 0, behavior: 'smooth' }) }
      else setErr(j.error ?? 'Could not submit your request. Please try again.')
    } catch { setErr(`Connection error — please try again or email ${COMPANY.email}.`) }
    setBusy(false)
  }

  // Secondary CTA — lock a real open date + pay the deposit via /api/book.
  async function openReserve() {
    setReserveOpen(true); setErr(''); setAvail(null)
    try {
      const res = await fetch(`/api/availability?loadSize=${encodeURIComponent(sizeId)}`)
      const j = await res.json()
      setAvail({ dates: j.dates ?? [], depositCents: j.depositCents ?? 5000 })
    } catch { setErr('Could not load open dates — you can still request a quote above.') }
  }
  async function submitBooking() {
    if (!svc) return
    setBusy(true); setErr('')
    try {
      const res = await fetch('/api/book', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service: svc.bookType, loadSize: sizeId, debris: svc.debris,
          address: pickupText, notes: buildNotes(), photos,
          date: bookDate, window: bookWin, name, phone, email, promo,
        }),
      })
      const j = await res.json()
      if (!res.ok) { setErr(j.error ?? 'Could not complete your reservation.'); setBusy(false); return }
      if (j.url) { window.location.href = j.url; return }
      if (j.bookingUrl) { window.location.href = j.bookingUrl; return }
      setBusy(false)
    } catch { setErr('Connection error — please try again.'); setBusy(false) }
  }

  return (
    <main className="min-h-screen" style={{ background: 'var(--bg)' }}>
      {/* Restrained brand glow — J Kiss red, not an all-over wash */}
      <div aria-hidden className="pointer-events-none fixed inset-0" style={{ background: 'radial-gradient(900px 520px at 82% -6%, rgba(224,0,42,.14), transparent 60%), radial-gradient(760px 520px at 6% 108%, rgba(224,0,42,.06), transparent 60%)', zIndex: 0 }} />

      <header className="fixed top-0 left-0 right-0 z-50" style={{ background: 'rgba(11,11,12,0.9)', backdropFilter: 'blur(12px)', borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="text-xl font-black tracking-tight" style={{ color: '#fff', letterSpacing: '-0.03em' }}>
            J Kiss <span style={{ color: RED }}>LLC</span>
          </Link>
          <Link href="/" className="text-sm font-semibold transition hover:text-white" style={{ color: 'var(--muted)' }}>← Back to Home</Link>
        </div>
      </header>

      <section className="relative z-10 pt-28 md:pt-32 pb-28 lg:pb-20 px-5 sm:px-6">
        <div className="max-w-6xl mx-auto">
          {sent ? (
            <SuccessView sent={sent} deposit={deposit} onReset={() => { setSent(null); setStep(0); setSvcId(''); setPickupText(''); setDeliveryText(''); setSizeId(''); setHeavy(null); setStairs(null); setElevator(null); setPrefDate(''); setPhotos([]); setUpgrades([]); setName(''); setCompany(''); setPhone(''); setEmail(''); setPromo(''); setEst(null); window.scrollTo({ top: 0, behavior: 'smooth' }) }} />
          ) : (
            <>
              {/* Intro */}
              <div className="max-w-2xl mb-8">
                <div className="label mb-5">Book a Job</div>
                <h1 className="text-4xl md:text-5xl font-black text-white mb-4" style={{ letterSpacing: '-0.045em', lineHeight: 1.05, fontFamily: 'var(--font-display)' }}>
                  Let&apos;s Plan Your <span style={{ color: RED }}>Move.</span>
                </h1>
                <p className="text-lg" style={{ color: 'var(--muted)', lineHeight: 1.6 }}>
                  Answer a few quick questions and our team will price your job by hand — most quotes come back within one business hour during operating hours.
                </p>
              </div>

              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px] items-start">
                {/* ── Wizard column ── */}
                <div className="glass-card wiz-fade" style={{ border: '1px solid rgba(224,0,42,.22)', borderRadius: 24, overflow: 'hidden' }}>
                  <ProgressBar step={step} setStep={setStep} />

                  <div className="px-5 sm:px-8 py-7">
                    <div key={step} className="wiz-reveal">
                      {step === 0 && <StepService svcId={svcId} onPick={setSvcId} />}
                      {step === 1 && (
                        <StepJob
                          svc={svc!} singleSite={singleSite}
                          pickupText={pickupText} setPickupText={setPickupText}
                          deliveryText={deliveryText} setDeliveryText={setDeliveryText}
                          sizeId={sizeId} setSizeId={setSizeId}
                          heavy={heavy} setHeavy={setHeavy}
                          stairs={stairs} setStairs={setStairs}
                          elevator={elevator} setElevator={setElevator}
                          prefDate={prefDate} setPrefDate={setPrefDate}
                        />
                      )}
                      {step === 2 && (
                        <StepPhotos
                          photos={photos} photoBusy={photoBusy} dragOver={dragOver} setDragOver={setDragOver}
                          onAdd={addPhotos} onRemove={(i) => setPhotos(p => p.filter((_, idx) => idx !== i))}
                        />
                      )}
                      {step === 3 && <StepUpgrades selected={upgrades} onToggle={toggleUpgrade} />}
                      {step === 4 && (
                        <StepContact
                          name={name} setName={setName} company={company} setCompany={setCompany}
                          phone={phone} setPhone={setPhone} email={email} setEmail={setEmail}
                          contactMethod={contactMethod} setContactMethod={setContactMethod}
                          promo={promo} setPromo={setPromo}
                        />
                      )}
                      {step === 5 && svc && (
                        <StepReview
                          svc={svc} singleSite={singleSite} pickupText={pickupText} deliveryText={deliveryText}
                          size={size} photos={photos} upgrades={upgrades} prefDate={prefDate}
                          name={name} company={company} email={email} phone={phone} contactMethod={contactMethod}
                          showLow={showLow} showHigh={showHigh} deposit={deposit} est={est}
                          reserveOpen={reserveOpen} avail={avail} bookDate={bookDate} setBookDate={setBookDate}
                          bookWin={bookWin} setBookWin={setBookWin} onOpenReserve={openReserve} onReserve={submitBooking}
                          jobBased={svc.jobBased}
                        />
                      )}
                    </div>

                    {err && <p role="alert" className="mt-5 text-sm rounded-xl px-4 py-3" style={{ color: '#ffb3c0', background: 'rgba(224,0,42,.10)', border: '1px solid rgba(224,0,42,.35)' }}>{err}</p>}

                    {/* Nav */}
                    <div className="flex items-center gap-3 mt-7">
                      {step > 0 && (
                        <button type="button" onClick={back} className="btn-ghost wiz-ease" style={{ padding: '13px 20px' }}>
                          <ArrowLeft size={16} /> Back
                        </button>
                      )}
                      {step < 5 ? (
                        <button type="button" onClick={next} className="btn wiz-ease" style={{ flex: 1, justifyContent: 'center', padding: '15px 24px', fontSize: 15 }}>
                          {step === 2 && photos.length === 0 ? 'Skip for now' : 'Continue'} <ArrowRight size={16} />
                        </button>
                      ) : (
                        <button type="button" onClick={submitLead} disabled={busy} className="btn wiz-ease" style={{ flex: 1, justifyContent: 'center', padding: '16px 24px', fontSize: 16 }}>
                          {busy ? <Loader2 size={18} className="animate-spin" /> : <>Request My Quote <ArrowRight size={16} /></>}
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* ── Sticky desktop summary ── */}
                <aside className="hidden lg:block lg:sticky lg:top-28 self-start">
                  <SummaryCard
                    svc={svc} size={size} singleSite={singleSite} pickupText={pickupText} deliveryText={deliveryText}
                    photos={photos} upgrades={upgrades} prefDate={prefDate}
                    showLow={showLow} showHigh={showHigh} deposit={deposit} est={est}
                  />
                </aside>
              </div>
            </>
          )}
        </div>
      </section>

      {/* ── Mobile sticky summary bar ── */}
      {!sent && svc && (
        <div className="lg:hidden fixed inset-x-0 bottom-0 z-40 px-4 py-3" style={{ background: 'rgba(11,11,12,0.96)', backdropFilter: 'blur(14px)', borderTop: '1px solid var(--line)' }}>
          <div className="flex items-center justify-between gap-3">
            <div style={{ minWidth: 0 }}>
              <p className="text-xs" style={{ color: 'var(--muted)' }}>Step {step + 1} of 6 · {STEP_LABELS[step]}</p>
              <p className="text-sm font-bold text-white truncate">{svc.label}{size ? ` · ${size.label}` : ''}</p>
            </div>
            <div className="text-right" style={{ flexShrink: 0 }}>
              {showLow != null ? (
                <p className="text-base font-black" style={{ color: RED }}>${showLow.toLocaleString()}–${showHigh!.toLocaleString()}</p>
              ) : (
                <p className="text-xs" style={{ color: 'var(--muted)' }}>Quoted by our team</p>
              )}
              <p className="text-[11px]" style={{ color: 'rgba(255,255,255,.4)' }}>Deposit ${deposit}</p>
            </div>
          </div>
        </div>
      )}

      <footer className="relative z-10 py-10 px-6 text-center text-xs" style={{ borderTop: '1px solid var(--line)', color: 'rgba(255,255,255,.3)' }}>
        © {new Date().getFullYear()} {COMPANY.legalName} · {CREDENTIALS_DOT}
      </footer>
    </main>
  )
}

type Estimate = { low: number; high: number; miles: number; fuelCharge?: number; promoCode?: string; promoPct?: number; confidence?: string; jobBased?: boolean; pickupLabel?: string; deliveryLabel?: string }

// ── Progress indicator ───────────────────────────────────────────────────────
function ProgressBar({ step, setStep }: { step: number; setStep: (n: number) => void }) {
  return (
    <div className="px-5 sm:px-8 pt-6 pb-5" style={{ borderBottom: '1px solid var(--line)' }}>
      {/* Mobile: label + fill bar */}
      <div className="sm:hidden">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>Step {step + 1} of 6</span>
          <span className="text-xs font-bold" style={{ color: RED }}>{STEP_LABELS[step]}</span>
        </div>
        <div style={{ height: 6, borderRadius: 999, background: 'rgba(255,255,255,.08)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${((step + 1) / 6) * 100}%`, borderRadius: 999, background: `linear-gradient(90deg, ${RED}, #ff6680)`, transition: 'width .5s cubic-bezier(.16,1,.3,1)' }} />
        </div>
      </div>
      {/* Desktop: clickable step chips */}
      <ol className="hidden sm:flex gap-2">
        {STEP_LABELS.map((label, i) => {
          const state = i === step ? 'current' : i < step ? 'done' : 'future'
          return (
            <li key={label} className="flex-1">
              <button
                type="button"
                disabled={i > step}
                onClick={() => i < step && setStep(i)}
                className="w-full text-left rounded-xl px-3 py-2.5 wiz-ease"
                style={{
                  cursor: i < step ? 'pointer' : 'default',
                  border: `1px solid ${state === 'current' ? RED : state === 'done' ? 'rgba(255,255,255,.14)' : 'rgba(255,255,255,.06)'}`,
                  background: state === 'current' ? 'rgba(224,0,42,.10)' : 'transparent',
                }}
              >
                <div className="flex items-center gap-2">
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, borderRadius: 999, fontSize: 11, fontWeight: 800, border: `1px solid ${state === 'future' ? 'rgba(255,255,255,.2)' : RED}`, background: state === 'done' ? RED : 'transparent', color: state === 'done' ? '#fff' : state === 'current' ? RED : 'rgba(255,255,255,.35)' }}>
                    {state === 'done' ? <Check size={11} /> : i + 1}
                  </span>
                  <span className="text-xs font-semibold truncate" style={{ color: state === 'future' ? 'rgba(255,255,255,.3)' : state === 'current' ? '#fff' : 'var(--muted)' }}>{label}</span>
                </div>
              </button>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

// ── Step 1: Service ──────────────────────────────────────────────────────────
function StepService({ svcId, onPick }: { svcId: string; onPick: (id: string) => void }) {
  return (
    <>
      <StepHeading kicker="What can we handle for you?" title="What do you need moved?" sub="Pick the closest fit — you can add details next." />
      <div className="grid sm:grid-cols-2 gap-3">
        {SERVICES.map(s => {
          const active = svcId === s.id
          const Icon = s.icon
          return (
            <button
              key={s.id} type="button" onClick={() => onPick(s.id)}
              className="text-left rounded-2xl p-4 wiz-ease group"
              style={{
                border: `1px solid ${active ? RED : 'rgba(255,255,255,.08)'}`,
                background: active ? 'rgba(224,0,42,.07)' : 'rgba(255,255,255,.02)',
                boxShadow: active ? '0 0 0 1px rgba(224,0,42,.35), 0 18px 50px -22px rgba(224,0,42,.4)' : 'none',
              }}
            >
              <div className="flex items-start gap-3">
                <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 42, height: 42, borderRadius: 12, flexShrink: 0, background: active ? RED : 'rgba(255,255,255,.06)', color: active ? '#fff' : RED, transition: 'background .25s, color .25s' }}>
                  <Icon size={20} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <p className="font-bold text-white leading-tight">{s.label}</p>
                  <p className="text-sm mt-1" style={{ color: 'var(--muted)', lineHeight: 1.4 }}>{s.desc}</p>
                </div>
                <span style={{ marginLeft: 'auto', flexShrink: 0, width: 20, height: 20, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${active ? RED : 'rgba(255,255,255,.2)'}`, background: active ? RED : 'transparent', color: '#fff' }}>
                  {active && <Check size={12} />}
                </span>
              </div>
              <div className="flex items-center gap-3 mt-3 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,.06)' }}>
                <span className="text-xs font-semibold flex items-center gap-1" style={{ color: 'var(--muted)' }}><CalendarClock size={13} /> {s.turnaround}</span>
                {s.starting && <span className="text-xs font-bold ml-auto" style={{ color: RED }}>{s.starting}</span>}
              </div>
            </button>
          )
        })}
      </div>
    </>
  )
}

// ── Step 2: The job ──────────────────────────────────────────────────────────
function StepJob(props: {
  svc: Svc; singleSite: boolean
  pickupText: string; setPickupText: (v: string) => void
  deliveryText: string; setDeliveryText: (v: string) => void
  sizeId: string; setSizeId: (v: string) => void
  heavy: boolean | null; setHeavy: (v: boolean) => void
  stairs: boolean | null; setStairs: (v: boolean) => void
  elevator: boolean | null; setElevator: (v: boolean) => void
  prefDate: string; setPrefDate: (v: string) => void
}) {
  const { svc, singleSite } = props
  const today = new Date(); const min = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  return (
    <>
      <StepHeading kicker={svc.label} title="Tell us about the job." sub="Just the essentials — we'll confirm the rest when we reach out." />

      <div className="grid gap-4">
        <div>
          <label style={lbl}>{singleSite ? 'Where is the job?' : 'Where are we picking up?'}</label>
          <div style={{ position: 'relative' }}>
            <MapPin size={16} style={{ position: 'absolute', left: 14, top: 15, color: 'var(--muted)' }} />
            <input value={props.pickupText} onChange={e => props.setPickupText(e.target.value)} placeholder="Address or ZIP — e.g. 123 Main St, Dallas 75201" style={{ ...inp, paddingLeft: 40 }} />
          </div>
        </div>
        {!singleSite && (
          <div>
            <label style={lbl}>Where are we delivering?</label>
            <div style={{ position: 'relative' }}>
              <MapPin size={16} style={{ position: 'absolute', left: 14, top: 15, color: 'var(--muted)' }} />
              <input value={props.deliveryText} onChange={e => props.setDeliveryText(e.target.value)} placeholder="Address or ZIP — e.g. 456 Oak Ave, Fort Worth 76102" style={{ ...inp, paddingLeft: 40 }} />
            </div>
          </div>
        )}

        <div>
          <label style={lbl}>How much are we moving?</label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {SIZES.map(s => {
              const active = props.sizeId === s.id
              return (
                <button key={s.id} type="button" onClick={() => props.setSizeId(s.id)} className="text-left rounded-xl px-3 py-2.5 wiz-ease"
                  style={{ border: `1px solid ${active ? RED : 'rgba(255,255,255,.08)'}`, background: active ? 'rgba(224,0,42,.07)' : 'rgba(255,255,255,.02)' }}>
                  <p className="text-sm font-bold text-white leading-tight">{s.label}</p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{s.hint}</p>
                </button>
              )
            })}
          </div>
        </div>

        <div className="grid sm:grid-cols-3 gap-3">
          <YesNo label="Large or heavy items?" value={props.heavy} onChange={props.setHeavy} />
          <YesNo label="Any stairs?" value={props.stairs} onChange={props.setStairs} />
          <YesNo label="Elevator access?" value={props.elevator} onChange={props.setElevator} />
        </div>

        <div>
          <label style={lbl}>Preferred date <span style={{ textTransform: 'none', fontWeight: 400 }}>(optional)</span></label>
          <input type="date" min={min} value={props.prefDate} onChange={e => props.setPrefDate(e.target.value)} style={{ ...inp, colorScheme: 'dark', cursor: 'pointer' }} />
        </div>
      </div>
    </>
  )
}

function YesNo({ label, value, onChange }: { label: string; value: boolean | null; onChange: (v: boolean) => void }) {
  return (
    <div>
      <label style={lbl}>{label}</label>
      <div className="flex gap-2">
        {[['Yes', true], ['No', false]].map(([t, v]) => {
          const active = value === v
          return (
            <button key={String(v)} type="button" onClick={() => onChange(v as boolean)} className="flex-1 rounded-xl py-2.5 text-sm font-bold wiz-ease"
              style={{ border: `1px solid ${active ? RED : 'rgba(255,255,255,.1)'}`, background: active ? 'rgba(224,0,42,.10)' : 'rgba(255,255,255,.02)', color: active ? '#fff' : 'var(--muted)' }}>
              {t as string}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Step 3: Photos ───────────────────────────────────────────────────────────
function StepPhotos(props: {
  photos: string[]; photoBusy: boolean; dragOver: boolean; setDragOver: (v: boolean) => void
  onAdd: (f: FileList) => void; onRemove: (i: number) => void
}) {
  return (
    <>
      <StepHeading kicker="Help us see the job" title="Show us what we're moving." sub="The more photos you provide, the more accurate your quote will be. This step is optional — but it really helps." />
      <label
        onDragOver={e => { e.preventDefault(); props.setDragOver(true) }}
        onDragLeave={() => props.setDragOver(false)}
        onDrop={e => { e.preventDefault(); props.setDragOver(false); if (e.dataTransfer.files?.length) props.onAdd(e.dataTransfer.files) }}
        className="flex flex-col items-center justify-center text-center rounded-2xl wiz-ease"
        style={{ padding: '38px 20px', cursor: props.photoBusy ? 'wait' : 'pointer', border: `1.5px dashed ${props.dragOver ? RED : 'rgba(255,255,255,.18)'}`, background: props.dragOver ? 'rgba(224,0,42,.06)' : 'rgba(255,255,255,.02)' }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 52, height: 52, borderRadius: 999, background: 'rgba(224,0,42,.12)', color: RED, marginBottom: 12 }}>
          {props.photoBusy ? <Loader2 size={24} className="animate-spin" /> : <Camera size={24} />}
        </span>
        <p className="font-bold text-white">{props.photoBusy ? 'Uploading…' : 'Drag photos here, or tap to browse'}</p>
        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>JPG, PNG or HEIC · up to 8 photos</p>
        <input type="file" accept="image/*" multiple onChange={e => { const fs = e.target.files; e.target.value = ''; if (fs?.length) props.onAdd(fs) }} disabled={props.photoBusy} style={{ display: 'none' }} />
      </label>

      {props.photos.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2.5 mt-4">
          {props.photos.map((url, i) => (
            <div key={url} style={{ position: 'relative', aspectRatio: '1 / 1', borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(255,255,255,.1)' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt="Job photo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              <button type="button" onClick={() => props.onRemove(i)} aria-label="Remove photo" style={{ position: 'absolute', top: 4, right: 4, width: 24, height: 24, borderRadius: 999, border: 'none', background: 'rgba(0,0,0,.7)', color: '#fff', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

// ── Step 4: Upgrades ─────────────────────────────────────────────────────────
function StepUpgrades({ selected, onToggle }: { selected: string[]; onToggle: (id: string) => void }) {
  return (
    <>
      <StepHeading kicker="Make it effortless" title="Customize your service." sub="Optional upgrades that save you time and hassle. Add what you need — skip the rest." />
      <div className="grid sm:grid-cols-2 gap-3">
        {UPGRADES.map(u => {
          const active = selected.includes(u.id)
          const Icon = u.icon
          return (
            <button key={u.id} type="button" onClick={() => onToggle(u.id)} className="text-left rounded-2xl p-4 wiz-ease"
              style={{ border: `1px solid ${active ? RED : 'rgba(255,255,255,.08)'}`, background: active ? 'rgba(224,0,42,.07)' : 'rgba(255,255,255,.02)', boxShadow: active ? '0 0 0 1px rgba(224,0,42,.35)' : 'none' }}>
              <div className="flex items-start gap-3">
                <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 38, height: 38, borderRadius: 10, flexShrink: 0, background: active ? RED : 'rgba(255,255,255,.06)', color: active ? '#fff' : RED, transition: 'background .25s, color .25s' }}>
                  <Icon size={18} />
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="flex items-center gap-2">
                    <p className="font-bold text-white leading-tight">{u.label}</p>
                    <span className="text-xs font-bold ml-auto" style={{ color: active ? RED : 'var(--muted)' }}>+${u.price}</span>
                  </div>
                  <p className="text-sm mt-1" style={{ color: 'var(--muted)', lineHeight: 1.4 }}>{u.why}</p>
                </div>
              </div>
            </button>
          )
        })}
      </div>
      <p className="text-xs mt-4 text-center" style={{ color: 'rgba(255,255,255,.4)' }}>Add-on prices are estimates — your final quote confirms everything. No upgrades? Just continue.</p>
    </>
  )
}

// ── Step 5: Your info ────────────────────────────────────────────────────────
function StepContact(props: {
  name: string; setName: (v: string) => void; company: string; setCompany: (v: string) => void
  phone: string; setPhone: (v: string) => void; email: string; setEmail: (v: string) => void
  contactMethod: string; setContactMethod: (v: string) => void; promo: string; setPromo: (v: string) => void
}) {
  return (
    <>
      <StepHeading kicker="Almost there" title="Where should we send your quote?" sub="We'll only use this to send your quote and coordinate the job." />
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2"><label style={lbl}>Full name</label><input value={props.name} onChange={e => props.setName(e.target.value)} autoCapitalize="words" placeholder="Jordan Kiss" style={inp} /></div>
        <div><label style={lbl}>Company <span style={{ textTransform: 'none', fontWeight: 400 }}>(optional)</span></label><input value={props.company} onChange={e => props.setCompany(e.target.value)} placeholder="Company name" style={inp} /></div>
        <div><label style={lbl}>Phone</label><input value={props.phone} onChange={e => props.setPhone(e.target.value)} type="tel" placeholder="(555) 000-0000" style={inp} /></div>
        <div><label style={lbl}>Email</label><input value={props.email} onChange={e => props.setEmail(e.target.value)} type="email" placeholder="you@email.com" style={inp} /></div>
        <div>
          <label style={lbl}>Best way to reach you</label>
          <select value={props.contactMethod} onChange={e => props.setContactMethod(e.target.value)} style={{ ...inp, cursor: 'pointer', colorScheme: 'dark' }}>
            <option>Text message</option>
            <option>Phone call</option>
            <option>Email</option>
          </select>
        </div>
        <div className="sm:col-span-2"><label style={lbl}>Promo code <span style={{ textTransform: 'none', fontWeight: 400 }}>(optional)</span></label><input value={props.promo} onChange={e => props.setPromo(e.target.value.toUpperCase())} placeholder="Have a code?" style={{ ...inp, textTransform: 'uppercase' }} /></div>
      </div>
      <p className="text-xs mt-4" style={{ color: 'rgba(255,255,255,.4)', lineHeight: 1.5 }}>
        By providing your phone number, you agree to receive booking and service-related text messages from {COMPANY.legalName} at the number provided, including messages sent by autodialer. Consent is not a condition of purchase. Message &amp; data rates may apply. Reply STOP to opt out, HELP for help.
      </p>
    </>
  )
}

// ── Step 6: Review ───────────────────────────────────────────────────────────
function StepReview(props: {
  svc: Svc; singleSite: boolean; pickupText: string; deliveryText: string
  size?: { label: string }; photos: string[]; upgrades: string[]; prefDate: string
  name: string; company: string; email: string; phone: string; contactMethod: string
  showLow: number | null; showHigh: number | null; deposit: string
  est: { hasPrice: boolean } | null
  reserveOpen: boolean; avail: { dates: string[]; depositCents: number } | null
  bookDate: string; setBookDate: (v: string) => void; bookWin: string; setBookWin: (v: string) => void
  onOpenReserve: () => void; onReserve: () => void; jobBased: boolean
}) {
  const rows: [string, string][] = [
    ['Service', props.svc.label],
    [props.singleSite ? 'Job location' : 'Pickup', props.pickupText || '—'],
    ...(!props.singleSite ? [['Delivery', props.deliveryText || '—'] as [string, string]] : []),
    ['Size', props.size?.label ?? '—'],
    ['Photos', props.photos.length ? `${props.photos.length} attached` : 'None'],
    ['Upgrades', props.upgrades.length ? props.upgrades.map(id => UPGRADES.find(u => u.id === id)?.label).filter(Boolean).join(', ') : 'None'],
    ['Preferred date', props.prefDate ? fmtDateLabel(props.prefDate) : 'Flexible'],
    ['Name', props.name || '—'],
    ...(props.company ? [['Company', props.company] as [string, string]] : []),
    ['Contact', [props.email, props.phone].filter(Boolean).join(' · ') || '—'],
    ['Preferred contact', props.contactMethod],
  ]
  return (
    <>
      <StepHeading kicker="One last look" title="Review & request." sub="Confirm the details below — then we'll get to work on your number." />

      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--line)' }}>
        {props.showLow != null && (
          <div className="px-5 py-4 text-center" style={{ background: 'rgba(224,0,42,.07)', borderBottom: '1px solid var(--line)' }}>
            <p className="text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>Estimated range</p>
            <p className="text-3xl font-black mt-1" style={{ color: RED, letterSpacing: '-0.03em' }}>${props.showLow.toLocaleString()}–${props.showHigh!.toLocaleString()}</p>
            <p className="text-xs mt-1" style={{ color: 'rgba(255,255,255,.5)' }}>Instant estimate — your team confirms the firm number.</p>
          </div>
        )}
        <div className="px-5 py-2">
          {rows.map(([k, v], i) => (
            <div key={k} className="flex justify-between gap-4 py-2.5 text-sm" style={i > 0 ? { borderTop: '1px solid rgba(255,255,255,.06)' } : undefined}>
              <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{k}</span>
              <span className="text-white text-right" style={{ minWidth: 0 }}>{v}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-start gap-3 mt-5 rounded-xl px-4 py-3" style={{ background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
        <Star size={16} style={{ color: RED, flexShrink: 0, marginTop: 2 }} />
        <p className="text-sm" style={{ color: 'var(--muted)', lineHeight: 1.5 }}>
          <strong className="text-white">Most quotes are returned within one business hour</strong> during operating hours. We&apos;ll reach out by your preferred method with a firm number.
        </p>
      </div>

      {/* Optional: lock a date now (eligible job-based services) */}
      {props.jobBased && (
        <div className="mt-5 rounded-2xl" style={{ border: '1px solid rgba(224,0,42,.22)', overflow: 'hidden' }}>
          {!props.reserveOpen ? (
            <button type="button" onClick={props.onOpenReserve} className="w-full text-left px-5 py-4 wiz-ease" style={{ background: 'rgba(224,0,42,.05)' }}>
              <p className="font-bold text-white flex items-center gap-2"><Zap size={15} style={{ color: RED }} /> Rather lock your date now?</p>
              <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>Reserve an open date with a fully-refundable ${props.deposit} deposit — skip the callback.</p>
            </button>
          ) : (
            <div className="px-5 py-4 wiz-fade">
              <p className="font-bold text-white mb-3 flex items-center gap-2"><Zap size={15} style={{ color: RED }} /> Reserve your date</p>
              {!props.avail ? (
                <p className="text-sm flex items-center gap-2" style={{ color: 'var(--muted)' }}><Loader2 size={14} className="animate-spin" /> Loading open dates…</p>
              ) : props.avail.dates.length === 0 ? (
                <p className="text-sm" style={{ color: 'var(--muted)' }}>No online dates are open for a job this size right now — request your quote above and we&apos;ll schedule you.</p>
              ) : (
                <>
                  <label style={lbl}>Open dates</label>
                  <div className="flex flex-wrap gap-2 mb-4" style={{ maxHeight: 150, overflowY: 'auto' }}>
                    {props.avail.dates.map(d => {
                      const active = props.bookDate === d
                      return <button key={d} type="button" onClick={() => props.setBookDate(d)} className="rounded-xl px-3 py-2 text-sm font-semibold wiz-ease" style={{ border: `1px solid ${active ? RED : 'rgba(255,255,255,.12)'}`, background: active ? RED : 'rgba(255,255,255,.04)', color: active ? '#fff' : 'var(--text)' }}>{fmtDateLabel(d)}</button>
                    })}
                  </div>
                  {props.bookDate && (
                    <>
                      <label style={lbl}>Arrival window</label>
                      <div className="flex flex-wrap gap-2 mb-4">
                        {WINDOWS.map(w => {
                          const active = props.bookWin === w
                          return <button key={w} type="button" onClick={() => props.setBookWin(w)} className="rounded-xl px-3 py-2 text-sm font-semibold wiz-ease" style={{ border: `1px solid ${active ? RED : 'rgba(255,255,255,.12)'}`, background: active ? RED : 'rgba(255,255,255,.04)', color: active ? '#fff' : 'var(--text)' }}>{w}</button>
                        })}
                      </div>
                    </>
                  )}
                  <button type="button" onClick={props.onReserve} disabled={!props.bookDate || !props.bookWin} className="btn w-full wiz-ease" style={{ justifyContent: 'center', opacity: props.bookDate && props.bookWin ? 1 : 0.5 }}>
                    Reserve &amp; Pay ${props.deposit} <ArrowRight size={16} />
                  </button>
                  <p className="text-xs text-center mt-2" style={{ color: 'rgba(255,255,255,.4)' }}>Your deposit holds the date and is fully refunded if we can&apos;t make it.</p>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </>
  )
}

// ── Sticky summary card ──────────────────────────────────────────────────────
function SummaryCard(props: {
  svc?: Svc; size?: { label: string }; singleSite: boolean; pickupText: string; deliveryText: string
  photos: string[]; upgrades: string[]; prefDate: string
  showLow: number | null; showHigh: number | null; deposit: string; est: { hasPrice: boolean } | null
}) {
  const { svc } = props
  const Row = ({ k, v }: { k: string; v: string }) => (
    <div className="flex justify-between gap-3 py-1.5 text-sm">
      <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{k}</span>
      <span className="text-white text-right" style={{ minWidth: 0 }}>{v}</span>
    </div>
  )
  return (
    <div className="glass-card" style={{ borderRadius: 20, overflow: 'hidden' }}>
      <div className="px-5 py-4" style={{ background: 'linear-gradient(135deg, rgba(224,0,42,.12), rgba(255,255,255,.02))', borderBottom: '1px solid var(--line)' }}>
        <p className="text-xs font-bold uppercase tracking-widest" style={{ color: RED }}>Your job</p>
        <p className="text-lg font-black text-white mt-0.5">{svc?.label ?? 'Choose a service'}</p>
      </div>
      <div className="px-5 py-4">
        {!svc ? (
          <p className="text-sm" style={{ color: 'var(--muted)', lineHeight: 1.5 }}>Pick a service to see your quote take shape here.</p>
        ) : (
          <>
            {props.size && <Row k="Size" v={props.size.label} />}
            {props.pickupText && <Row k={props.singleSite ? 'Location' : 'Pickup'} v={props.pickupText} />}
            {!props.singleSite && props.deliveryText && <Row k="Delivery" v={props.deliveryText} />}
            {props.photos.length > 0 && <Row k="Photos" v={`${props.photos.length} attached`} />}
            {props.upgrades.length > 0 && <Row k="Upgrades" v={`${props.upgrades.length} selected`} />}
            {props.prefDate && <Row k="Preferred" v={fmtDateLabel(props.prefDate)} />}

            <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--line)' }}>
              {props.showLow != null ? (
                <>
                  <p className="text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>Estimated range</p>
                  <p className="text-2xl font-black mt-0.5" style={{ color: RED, letterSpacing: '-0.02em' }}>${props.showLow.toLocaleString()}–${props.showHigh!.toLocaleString()}</p>
                </>
              ) : (
                <p className="text-sm" style={{ color: 'var(--muted)' }}>Priced by our team — most quotes back within <strong className="text-white">one business hour</strong>.</p>
              )}
              <p className="text-xs mt-1.5" style={{ color: 'rgba(255,255,255,.45)' }}>Refundable deposit to reserve: <strong style={{ color: '#fff' }}>${props.deposit}</strong></p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Success ──────────────────────────────────────────────────────────────────
function SuccessView({ sent, deposit, onReset }: { sent: { estimate?: Estimate }; deposit: string; onReset: () => void }) {
  const e = sent.estimate
  return (
    <div className="max-w-2xl mx-auto wiz-reveal">
      <div className="glass-card p-8 sm:p-10 text-center" style={{ borderRadius: 24, border: '1px solid rgba(224,0,42,.25)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 64, height: 64, borderRadius: 999, background: 'rgba(224,0,42,.12)', color: RED, marginBottom: 18 }}>
          <Check size={32} />
        </span>
        <h1 className="text-3xl md:text-4xl font-black text-white mb-3" style={{ letterSpacing: '-0.03em', fontFamily: 'var(--font-display)' }}>Request received.</h1>
        {e && e.low > 0 ? (
          <>
            <p className="text-base mb-4" style={{ color: 'var(--muted)', lineHeight: 1.6 }}>Here&apos;s your instant estimate. Our team is already reviewing the details and will confirm a firm number shortly.</p>
            <div className="inline-block rounded-2xl px-8 py-5 mb-4" style={{ background: 'rgba(224,0,42,.07)', border: '1px solid rgba(224,0,42,.25)' }}>
              <p className="text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>Estimated range</p>
              <p className="text-5xl font-black tabular-nums mt-1" style={{ color: RED, letterSpacing: '-0.04em', fontFamily: 'var(--font-display)' }}>${e.low.toLocaleString()}–${e.high.toLocaleString()}</p>
              {e.promoCode && <p className="text-xs mt-2 font-semibold" style={{ color: '#34d399' }}>✓ Promo {e.promoCode} applied{e.promoPct ? ` — ${e.promoPct}% off` : ''}.</p>}
            </div>
          </>
        ) : (
          <p className="text-base mb-4" style={{ color: 'var(--muted)', lineHeight: 1.6 }}>Because every job is a little different, our team will review your details and send a custom quote — most come back within one business hour during operating hours.</p>
        )}
        <p className="text-sm" style={{ color: 'rgba(255,255,255,.5)', lineHeight: 1.6 }}>Need it handled fast? Call or email us at <a href={"mailto:" + COMPANY.email} className="underline" style={{ color: '#fff' }}>info@jkissllc.com</a>.</p>
        <div className="mt-8 flex justify-center gap-3 flex-wrap">
          <button onClick={onReset} className="btn wiz-ease">Request Another Quote</button>
          <Link href="/" className="btn-ghost wiz-ease">Back to Home</Link>
        </div>
      </div>
    </div>
  )
}

// ── Shared heading ───────────────────────────────────────────────────────────
function StepHeading({ kicker, title, sub }: { kicker: string; title: string; sub: string }) {
  return (
    <div className="mb-6">
      <p className="text-xs font-bold uppercase tracking-widest mb-2" style={{ color: RED, letterSpacing: '0.14em' }}>{kicker}</p>
      <h2 className="text-2xl font-black text-white" style={{ letterSpacing: '-0.02em', fontFamily: 'var(--font-display)' }}>{title}</h2>
      <p className="text-sm mt-2" style={{ color: 'var(--muted)', lineHeight: 1.55 }}>{sub}</p>
    </div>
  )
}
