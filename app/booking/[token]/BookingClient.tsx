'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'

// ── Local types (mirror the customer-safe projection from the API) ───────────
type PaymentLite = {
  type: string; method: string; status: string
  amountCents: number; feeCents: number; totalChargedCents: number
  createdAt: number; confirmedAt?: number
}
export type CustomerBooking = {
  token: string
  bookingNumber: string
  customerName: string
  customerPhone?: string
  customerEmail?: string
  invoiceNumber?: string
  invoiceDate?: string
  serviceType: string
  pickupAddress?: string
  dropoffAddress?: string
  jobSiteAddress?: string
  description?: string
  items: string[]
  invoiceAmountCents: number
  depositAmountCents: number
  amountPaidCents: number
  collectInPerson?: boolean
  crewSize?: number
  estimatedHours?: number
  availableDates: string[]
  availableWindows: string[]
  selectedDate?: string
  selectedWindow?: string
  customerNotes?: string
  gateCode?: string
  parkingNotes?: string
  accessNotes?: string
  specialInstructions?: string
  agreementAccepted?: boolean
  agreementAcceptedAt?: number
  agreementPolicyVersion?: number
  status: string
  payments: PaymentLite[]
  confirmationLinkSentAt?: number
  customerViewedAt?: number
  customerTimeVerifiedAt?: number
  customerConfirmedAt?: number
  createdAt: number
  balanceDueCents: number
  paymentSummary: string
}

const SERVICE_LABELS: Record<string, string> = {
  'moving': 'Moving Service',
  'junk-removal': 'Junk Removal',
  'eviction': 'Eviction / Property Cleanout',
  'appliance-delivery': 'Appliance Delivery',
  'freight': 'Freight Service',
  'estate-cleanout': 'Estate Cleanout',
  'garage-cleanout': 'Garage Cleanout',
  'other': 'Service',
}
const PAYMENT_SUMMARY_LABEL: Record<string, string> = {
  unpaid: 'Unpaid', deposit_paid: 'Deposit Paid', partially_paid: 'Partially Paid', paid_in_full: 'Paid in Full',
}

const usd = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const FEE_PCT = 0.029
const FEE_FIXED = 30
function grossUp(net: number) { const total = Math.round((net + FEE_FIXED) / (1 - FEE_PCT)); return { net, fee: total - net, total } }
function fmtDate(iso?: string) {
  if (!iso) return ''
  const d = new Date(iso + 'T00:00:00')
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
}

const iStyle: React.CSSProperties = {
  width: '100%', padding: '12px 14px',
  background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.10)',
  borderRadius: '10px', color: '#f3f4f6', fontSize: '15px', outline: 'none',
}
const labelStyle: React.CSSProperties = { display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--muted)', marginBottom: '6px' }
const sectionLabel = 'text-xs font-bold uppercase tracking-widest mb-4'
const sectionLabelStyle: React.CSSProperties = { color: 'var(--muted)', letterSpacing: '0.12em' }

function Row({ k, v }: { k: string; v?: string | null }) {
  if (!v) return null
  return (
    <div className="flex justify-between gap-4 py-2" style={{ borderBottom: '1px solid rgba(255,255,255,.05)' }}>
      <span className="text-sm shrink-0" style={{ color: 'var(--muted)' }}>{k}</span>
      <span className="text-sm font-semibold text-right" style={{ color: 'var(--text)' }}>{v}</span>
    </div>
  )
}

export default function BookingClient({
  token, initialBooking, policy,
}: {
  token: string
  initialBooking: CustomerBooking
  policy: { version: number; text: string }
}) {
  const [b, setB] = useState<CustomerBooking>(initialBooking)
  const [banner, setBanner] = useState<string>('')

  // Mark viewed + refresh on mount (also picks up a just-completed payment).
  // Banner is derived from the return URL inside this async callback (not in the
  // effect body) so we never setState synchronously during the effect.
  const refresh = useCallback(async () => {
    const sp = new URLSearchParams(window.location.search)
    if (sp.get('paid') === '1') setBanner('Payment received — thank you!')
    else if (sp.get('pay') === 'cancelled') setBanner('Payment was cancelled. You can try again anytime.')
    try {
      const res = await fetch(`/api/booking/${token}`, { cache: 'no-store' })
      if (res.ok) { const j = await res.json(); if (j.booking) setB(j.booking) }
    } catch { /* keep SSR data */ }
  }, [token])

  useEffect(() => { refresh() }, [refresh])

  const cancelled = b.status === 'cancelled'
  const verified = !!b.customerTimeVerifiedAt && !!b.selectedDate && !!b.selectedWindow
  const confirmed = b.status === 'confirmed' || b.status === 'completed'
  const completed = b.status === 'completed'
  // When ops set a single available date, it's the fixed service date — show it
  // and have the customer choose only the arrival time.
  const serviceDate = b.selectedDate || (b.availableDates.length === 1 ? b.availableDates[0] : '')

  const heading = completed
    ? 'Your service is complete'
    : confirmed
      ? "You're officially booked with J KISS LLC"
      : verified
        ? 'Your service time is verified'
        : "You're almost booked with J KISS LLC"

  return (
    <main className="min-h-screen pb-20" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      <header className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-4"
        style={{ background: 'rgba(11,11,12,0.95)', backdropFilter: 'blur(12px)', borderBottom: '1px solid rgba(255,255,255,.08)' }}>
        <Link href="/" className="text-xl font-black tracking-tight" style={{ color: '#fff', letterSpacing: '-0.03em' }}>
          J Kiss <span style={{ color: 'var(--red)' }}>LLC</span>
        </Link>
        <a href="tel:+18179094312" className="text-sm font-semibold" style={{ color: 'var(--muted)' }}>(817) 909-4312</a>
      </header>

      <section className="pt-28 px-5">
        <div className="max-w-2xl mx-auto">
          <div className="label mb-5">{cancelled ? 'Booking Cancelled' : confirmed ? 'Confirmed' : 'Booking'}</div>
          <h1 className="text-3xl md:text-4xl font-black text-white mb-3" style={{ letterSpacing: '-0.04em', lineHeight: 1.08, fontFamily: 'var(--font-display)' }}>
            {confirmed && !completed && <span style={{ color: 'var(--red)' }}>✓ </span>}{heading}
          </h1>
          <p className="text-base mb-2" style={{ color: 'var(--muted)', lineHeight: 1.6 }}>
            {cancelled
              ? 'This booking has been cancelled. Please contact us if you have questions.'
              : completed
                ? 'Thank you for choosing J Kiss LLC. We hope to work with you again.'
                : verified
                  ? 'Your service time has been verified. J Kiss LLC will contact you if any adjustment is needed.'
                  : serviceDate
                    ? `Your service is scheduled for ${fmtDate(serviceDate)}. Please choose the arrival time that works best for you and confirm below.`
                    : 'Your booking is almost confirmed. Please verify the service date and arrival window below.'}
          </p>
          <p className="text-sm mb-6" style={{ color: 'rgba(255,255,255,.45)' }}>
            Booking <span className="font-mono">{b.bookingNumber}</span>
            {b.invoiceNumber && <> · Invoice <span className="font-mono">{b.invoiceNumber}</span></>}
          </p>

          {banner && (
            <div className="rounded-xl px-4 py-3 mb-6 text-sm font-semibold"
              style={{ background: 'rgba(224,0,42,.10)', border: '1px solid rgba(224,0,42,.3)', color: '#ff8aa0' }}>
              {banner}
            </div>
          )}

          {/* ── Booking summary ─────────────────────────────────────────── */}
          <div className="glass-card p-6 mb-5" style={{ borderRadius: '18px' }}>
            <p className={sectionLabel} style={sectionLabelStyle}>Booking Details</p>
            <Row k="Customer" v={b.customerName} />
            <Row k="Service" v={SERVICE_LABELS[b.serviceType] ?? b.serviceType} />
            <Row k="Service Date" v={serviceDate ? fmtDate(serviceDate) : undefined} />
            <Row k="Arrival Window" v={b.selectedWindow ?? undefined} />
            <Row k="Invoice Date" v={b.invoiceDate} />
            <Row k="Pickup" v={b.pickupAddress} />
            <Row k="Drop-off" v={b.dropoffAddress} />
            <Row k="Job Site" v={b.jobSiteAddress} />
            <Row k="Crew" v={b.crewSize ? `${b.crewSize}-person team` : undefined} />
            <Row k="Estimated Time" v={b.estimatedHours ? `${b.estimatedHours} hours` : undefined} />
            {b.description && <p className="text-sm mt-4" style={{ color: 'var(--muted)', lineHeight: 1.6 }}>{b.description}</p>}
            {b.items.length > 0 && (
              <ul className="mt-3 text-sm space-y-1" style={{ color: 'var(--muted)' }}>
                {b.items.map((it, i) => <li key={i}>• {it}</li>)}
              </ul>
            )}
          </div>

          {/* ── Verify date/time + agreement ────────────────────────────── */}
          {!cancelled && (
            <VerifyCard b={b} token={token} policy={policy} onUpdated={setB} verified={verified} />
          )}

          {/* ── Payment (shown under the booking time) ──────────────────── */}
          <PaymentCard b={b} token={token} onChange={refresh} disabled={cancelled} />

          {/* ── Confirmation record ─────────────────────────────────────── */}
          {verified && (
            <div className="glass-card p-6 mb-5" style={{ borderRadius: '18px' }}>
              <p className={sectionLabel} style={sectionLabelStyle}>Confirmation Record</p>
              <p className="text-sm mb-4" style={{ color: 'var(--muted)' }}>
                Download or print your booking confirmation — it includes your verified date, arrival window, and the policy version you accepted.
              </p>
              <a href={`/api/booking/${token}/confirmation`} target="_blank" rel="noopener noreferrer" className="btn">
                Download Confirmation →
              </a>
            </div>
          )}

          <p className="text-xs text-center mt-8" style={{ color: 'rgba(255,255,255,.3)' }}>
            J Kiss LLC · (817) 909-4312 · info@jkissllc.com · US DOT 3484556 / MC 01155352
          </p>
        </div>
      </section>
    </main>
  )
}

// ── Payment card ───────────────────────────────────────────────────────────
function PaymentCard({ b, token, onChange, disabled }: { b: CustomerBooking; token: string; onChange: () => void; disabled: boolean }) {
  const [busy, setBusy] = useState<string>('')
  const [err, setErr] = useState('')
  const [showManual, setShowManual] = useState(false)

  const balance = b.balanceDueCents
  const depositDue = Math.max(0, Math.min(b.depositAmountCents - b.amountPaidCents, balance))

  async function pay(kind: 'deposit' | 'balance' | 'full') {
    setBusy(kind); setErr('')
    try {
      const res = await fetch(`/api/booking/${token}/pay`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }),
      })
      const j = await res.json()
      if (res.ok && j.url) { window.location.href = j.url; return }
      setErr(j.error ?? 'Could not start checkout.')
    } catch { setErr('Connection error — please try again.') }
    setBusy('')
  }

  return (
    <div className="glass-card p-6 mb-5" style={{ borderRadius: '18px' }}>
      <p className={sectionLabel} style={sectionLabelStyle}>{b.collectInPerson && balance > 0 ? 'Remaining Balance — Optional' : 'Payment'}</p>
      <Row k="Invoice Total" v={usd(b.invoiceAmountCents)} />
      {b.depositAmountCents > 0 && <Row k="Deposit" v={usd(b.depositAmountCents)} />}
      <Row k="Amount Paid" v={usd(b.amountPaidCents)} />
      <div className="flex justify-between gap-4 py-3 mt-1">
        <span className="text-base font-bold" style={{ color: 'var(--text)' }}>Balance Due</span>
        <span className="text-2xl font-black" style={{ color: 'var(--red)', letterSpacing: '-0.02em' }}>{usd(balance)}</span>
      </div>
      <div className="inline-flex items-center gap-2 mb-4 text-xs font-bold px-3 py-1 rounded-full"
        style={{ background: 'rgba(255,255,255,.05)', color: 'var(--muted)' }}>
        {PAYMENT_SUMMARY_LABEL[b.paymentSummary] ?? b.paymentSummary}
      </div>

      {balance <= 0 ? (
        <p className="text-sm font-semibold" style={{ color: '#34d399' }}>✓ Paid in full — thank you!</p>
      ) : disabled ? null : (
        <>
          {b.collectInPerson && (
            <div className="rounded-xl px-4 py-3 mb-4 text-sm" style={{ background: 'rgba(52,211,153,.08)', border: '1px solid rgba(52,211,153,.25)', color: 'var(--text)', lineHeight: 1.6 }}>
              {b.amountPaidCents > 0 && <>✓ Deposit of <strong>{usd(b.amountPaidCents)}</strong> received. </>}
              Your remaining balance of <strong>{usd(balance)}</strong> is due at the end of services. Paying now is <strong>optional</strong>.
            </div>
          )}
          <div className="flex flex-col gap-3">
            {!b.collectInPerson && depositDue > 0 && depositDue < balance && (
              <button onClick={() => pay('deposit')} disabled={!!busy} className="btn w-full" style={{ justifyContent: 'center' }}>
                {busy === 'deposit' ? 'Starting…' : `Pay Deposit — ${usd(grossUp(depositDue).total)}`}
              </button>
            )}
            <button onClick={() => pay('full')} disabled={!!busy} className={`w-full ${b.collectInPerson ? 'btn-ghost' : 'btn'}`} style={{ justifyContent: 'center' }}>
              {busy === 'full' ? 'Starting…' : b.collectInPerson
                ? `Pay Remaining Balance Now (optional) — ${usd(grossUp(balance).total)}`
                : `Pay ${depositDue > 0 && depositDue < balance ? 'Full Balance' : 'Now'} — ${usd(grossUp(balance).total)}`}
            </button>
          </div>
          <p className="text-xs mt-3" style={{ color: 'rgba(255,255,255,.4)' }}>
            💳 Card payments include a processing fee ({(FEE_PCT * 100).toFixed(1)}% + {usd(FEE_FIXED)}). Shown on the secure Stripe checkout before you pay.
          </p>
          {err && <p className="text-sm mt-3" style={{ color: '#f87171' }}>{err}</p>}

          <div className="mt-5 pt-5" style={{ borderTop: '1px solid rgba(255,255,255,.08)' }}>
            <p className="text-sm font-semibold mb-2" style={{ color: 'var(--text)' }}>Prefer no card fee? Pay by Zelle or Apple Pay {b.collectInPerson && <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span>}</p>
            <p className="text-sm" style={{ color: 'var(--muted)' }}>
              Zelle: <span className="font-mono text-white">jkissbiz@gmail.com</span><br />
              Apple Pay / Apple Cash: <span className="font-mono text-white">817-909-4312</span>
            </p>
            <p className="text-xs mt-2" style={{ color: 'rgba(255,255,255,.4)' }}>Please include your invoice number ({b.invoiceNumber ?? b.bookingNumber}) in the payment memo.</p>
            {!showManual ? (
              <button onClick={() => setShowManual(true)} className="btn-ghost mt-3" style={{ padding: '10px 18px', fontSize: '13px' }}>I Sent Payment</button>
            ) : (
              <ManualPaymentForm token={token} balance={balance} onDone={() => { setShowManual(false); onChange() }} onCancel={() => setShowManual(false)} />
            )}
          </div>
        </>
      )}
    </div>
  )
}

function ManualPaymentForm({ token, balance, onDone, onCancel }: { token: string; balance: number; onDone: () => void; onCancel: () => void }) {
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState(false)

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true); setErr('')
    const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>
    try {
      const res = await fetch(`/api/booking/${token}/manual-payment`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'Failed')
      setDone(true)
      setTimeout(onDone, 1800)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); setSaving(false) }
  }

  if (done) return <p className="text-sm mt-4" style={{ color: '#34d399' }}>✓ Thanks — we&apos;ll confirm your payment once it lands and update your balance.</p>

  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label style={labelStyle}>Amount Sent</label>
          <input name="amount" required inputMode="decimal" placeholder={(balance / 100).toFixed(2)} style={iStyle} />
        </div>
        <div>
          <label style={labelStyle}>Method</label>
          <select name="method" defaultValue="zelle" style={{ ...iStyle, cursor: 'pointer' }}>
            <option value="zelle">Zelle</option>
            <option value="apple_cash">Apple Pay / Cash</option>
            <option value="cash">Cash</option>
            <option value="other">Other</option>
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label style={labelStyle}>Date Sent</label>
          <input name="dateSent" type="date" style={{ ...iStyle, cursor: 'pointer' }} />
        </div>
        <div>
          <label style={labelStyle}>Reference # (optional)</label>
          <input name="reference" placeholder="Confirmation #" style={iStyle} />
        </div>
      </div>
      {err && <p className="text-sm" style={{ color: '#f87171' }}>{err}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className="btn" style={{ padding: '10px 18px', fontSize: '13px' }}>{saving ? 'Sending…' : 'Submit Payment Notice'}</button>
        <button type="button" onClick={onCancel} className="btn-ghost" style={{ padding: '10px 18px', fontSize: '13px' }}>Cancel</button>
      </div>
    </form>
  )
}

// ── Verify card ────────────────────────────────────────────────────────────
function VerifyCard({ b, token, policy, onUpdated, verified }: {
  b: CustomerBooking; token: string; policy: { version: number; text: string }
  onUpdated: (b: CustomerBooking) => void; verified: boolean
}) {
  const onlyDate = b.availableDates.length === 1 ? b.availableDates[0] : ''
  const [editing, setEditing] = useState(!verified)
  const [date, setDate] = useState(b.selectedDate || onlyDate)
  const [win, setWin] = useState(b.selectedWindow ?? '')
  const [agree, setAgree] = useState(false)
  const [showPolicy, setShowPolicy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const hasOptions = b.availableDates.length > 0 && b.availableWindows.length > 0

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setErr('')
    if (!date) return setErr('Please choose a service date.')
    if (!win) return setErr('Please choose an arrival window.')
    if (!agree) return setErr('You must accept the Cancellation & Refund Policy to continue.')
    setSaving(true)
    const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>
    try {
      const res = await fetch(`/api/booking/${token}/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, selectedDate: date, selectedWindow: win, agreementAccepted: true }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'Failed')
      onUpdated(j.booking)
      setEditing(false)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); setSaving(false) }
  }

  if (verified && !editing) {
    return (
      <div className="glass-card p-6 mb-5" style={{ borderRadius: '18px', borderColor: 'rgba(52,211,153,.3)' }}>
        <p className={sectionLabel} style={sectionLabelStyle}>Service Time — Verified ✓</p>
        <Row k="Service Date" v={fmtDate(b.selectedDate)} />
        <Row k="Arrival Window" v={b.selectedWindow} />
        <Row k="Gate Code" v={b.gateCode} />
        <Row k="Parking" v={b.parkingNotes} />
        <Row k="Access Notes" v={b.accessNotes} />
        <Row k="Special Instructions" v={b.specialInstructions} />
        <p className="text-xs mt-4" style={{ color: 'rgba(255,255,255,.4)' }}>
          Policy v{b.agreementPolicyVersion} accepted{b.agreementAcceptedAt ? ` on ${new Date(b.agreementAcceptedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}.
        </p>
        <button onClick={() => setEditing(true)} className="btn-ghost mt-4" style={{ padding: '10px 18px', fontSize: '13px' }}>Change Date / Details</button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="glass-card p-6 mb-5" style={{ borderRadius: '18px', borderColor: 'rgba(224,0,42,.3)' }}>
      <p className={sectionLabel} style={sectionLabelStyle}>{onlyDate ? 'Set Your Arrival Time' : 'Verify Your Service Time'}</p>

      {!hasOptions ? (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          We&apos;re finalizing available time slots — we&apos;ll be in touch shortly, or call <a href="tel:+18179094312" style={{ color: 'var(--red)' }}>(817) 909-4312</a>.
        </p>
      ) : (
        <>
          {onlyDate ? (
            <div className="mb-5">
              <label style={labelStyle}>Service Date</label>
              <div className="px-4 py-3 rounded-xl flex items-center gap-2"
                style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)' }}>
                <span style={{ color: 'var(--red)' }}>📅</span>
                <span className="text-sm font-bold text-white">{fmtDate(onlyDate)}</span>
              </div>
            </div>
          ) : (
            <>
              <label style={labelStyle}>Service Date *</label>
              <div className="flex flex-wrap gap-2 mb-4">
                {b.availableDates.map(d => (
                  <button type="button" key={d} onClick={() => setDate(d)}
                    className="px-4 py-2.5 rounded-xl text-sm font-semibold transition"
                    style={{
                      background: date === d ? 'var(--red)' : 'rgba(255,255,255,.05)',
                      border: `1px solid ${date === d ? 'var(--red)' : 'rgba(255,255,255,.1)'}`,
                      color: date === d ? '#fff' : 'var(--text)',
                    }}>
                    {fmtDate(d)}
                  </button>
                ))}
              </div>
            </>
          )}

          <label style={labelStyle}>{onlyDate ? 'What time should we arrive? *' : 'Arrival Window *'}</label>
          <div className="flex flex-wrap gap-2 mb-5">
            {b.availableWindows.map(w => (
              <button type="button" key={w} onClick={() => setWin(w)}
                className="px-4 py-2.5 rounded-xl text-sm font-semibold transition"
                style={{
                  background: win === w ? 'var(--red)' : 'rgba(255,255,255,.05)',
                  border: `1px solid ${win === w ? 'var(--red)' : 'rgba(255,255,255,.1)'}`,
                  color: win === w ? '#fff' : 'var(--text)',
                }}>
                {w}
              </button>
            ))}
          </div>

          <div className="grid sm:grid-cols-2 gap-3 mb-3">
            <div>
              <label style={labelStyle}>Contact Phone</label>
              <input name="customerPhone" defaultValue={b.customerPhone} placeholder="(214) 555-0000" style={iStyle} />
            </div>
            <div>
              <label style={labelStyle}>Gate / Entry Code</label>
              <input name="gateCode" defaultValue={b.gateCode} placeholder="#1234" style={iStyle} />
            </div>
          </div>
          <div className="mb-3">
            <label style={labelStyle}>Parking Instructions</label>
            <input name="parkingNotes" defaultValue={b.parkingNotes} placeholder="Driveway, loading dock, street, etc." style={iStyle} />
          </div>
          <div className="mb-3">
            <label style={labelStyle}>Access Notes</label>
            <textarea name="accessNotes" rows={2} defaultValue={b.accessNotes} placeholder="Stairs, elevator, floor, where to enter…" style={{ ...iStyle, resize: 'vertical' }} />
          </div>
          <div className="mb-5">
            <label style={labelStyle}>Special Instructions</label>
            <textarea name="specialInstructions" rows={2} defaultValue={b.specialInstructions} placeholder="Anything our crew should know" style={{ ...iStyle, resize: 'vertical' }} />
          </div>

          {/* Required agreement */}
          <div className="rounded-xl p-4 mb-4" style={{ background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.1)' }}>
            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)}
                style={{ width: 20, height: 20, marginTop: 2, accentColor: '#E0002A', flexShrink: 0 }} />
              <span className="text-sm" style={{ color: 'var(--text)', lineHeight: 1.5 }}>
                I have read and agree to the J KISS LLC{' '}
                <button type="button" onClick={() => setShowPolicy(s => !s)} className="font-semibold underline" style={{ color: 'var(--red)' }}>
                  Cancellation &amp; Refund Policy
                </button>{' '}and Terms of Service. <span style={{ color: 'rgba(255,255,255,.4)' }}>(v{policy.version})</span>
              </span>
            </label>
            {showPolicy && (
              <pre className="mt-3 text-xs whitespace-pre-wrap max-h-64 overflow-auto p-3 rounded-lg"
                style={{ background: 'rgba(0,0,0,.3)', color: 'var(--muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5 }}>
                {policy.text}
              </pre>
            )}
          </div>

          {err && <p className="text-sm mb-3" style={{ color: '#f87171' }}>{err}</p>}
          <button type="submit" disabled={saving} className="btn w-full" style={{ justifyContent: 'center' }}>
            {saving ? 'Submitting…' : verified ? 'Update My Booking →' : 'Verify & Confirm My Booking →'}
          </button>
          <p className="text-xs text-center mt-3" style={{ color: 'rgba(255,255,255,.4)' }}>
            Your booking is not fully confirmed until you verify your service time above.
          </p>
        </>
      )}
    </form>
  )
}
