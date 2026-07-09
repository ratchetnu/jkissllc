import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { rateLimit } from '../../lib/rate-limit'
import { escapeHtml, isValidEmail } from '../../lib/validators'
import { isBlockedBot } from '../../lib/botcheck'
import { getPromo, validatePromo, normalizeCode } from '../../lib/promo'
import { getDisposalSettings, priceJob, categoryFor, type DisposalQuote } from '../../lib/disposal'
import { getCalibration } from '../../lib/job-learning'
import { COMPANY } from '../../lib/company'

// Look up a US ZIP via zippopotam.us (free, no key required).
async function lookupZip(zip: string): Promise<{ lat: number; lon: number; city: string; state: string } | null> {
  if (!/^\d{5}$/.test(zip)) return null
  try {
    const res = await fetch(`https://api.zippopotam.us/us/${zip}`, { cache: 'force-cache', next: { revalidate: 60 * 60 * 24 * 30 } })
    if (!res.ok) return null
    const data = await res.json()
    const place = data.places?.[0]
    if (!place) return null
    return {
      lat: parseFloat(place.latitude),
      lon: parseFloat(place.longitude),
      city: place['place name'] ?? '',
      state: place['state abbreviation'] ?? '',
    }
  } catch {
    return null
  }
}

// Haversine distance in miles between two lat/lon points.
function distanceMiles(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 3958.8
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// Fuel surcharge based on the truck's ROUND-TRIP miles (2× the one-way job
// distance). Operations run a 24 ft box truck. Returns whole USD.
//  • round trip ≤ 75 mi: no fuel charge
//  • 75 < round trip < 150 mi: flat $100
//  • round trip ≥ 150 mi: $100 + $0.65 per round-trip mile beyond 150, rounded to $5
function fuelChargeDollars(oneWayMiles: number): number {
  const roundTrip = oneWayMiles * 2
  if (roundTrip <= 75) return 0
  if (roundTrip < 150) return 100
  return Math.round((100 + (roundTrip - 150) * 0.65) / 5) * 5
}

// Pricing formula — easy to tune. All values USD.
const PRICING = {
  base: 125,
  perMile: 3.5,
  perPallet: 35,
  serviceMult: {
    'dock-to-dock': 1.0,
    'last-mile-curbside': 1.2,
    'white-glove': 1.4,
  } as Record<string, number>,
  timeMult: {
    standard: 1.0,
    'next-day': 1.25,
    'same-day': 1.55,
    weekend: 1.20,
    'after-hours': 1.35,
    emergency: 1.75,
  } as Record<string, number>,
  // Flat add-on fees (USD) — applied on top of the estimate.
  addOns: {
    stairs: 40,
    'extra-stop': 60,
    packing: 75,
    disposal: 50,
    'extra-labor': 65,
    assembly: 55,
    // Premium service upgrades surfaced in the guided quote wizard.
    'same-day': 120,
    'inside-placement': 60,
    'appliance-hookup': 45,
    priority: 40,
  } as Record<string, number>,
  // Range spread around point estimate (low, high)
  rangeLow: 0.85,
  rangeHigh: 1.20,
}

const ADDON_LABELS: Record<string, string> = {
  stairs: 'Stairs / no elevator', 'extra-stop': 'Extra stop', packing: 'Protective wrapping',
  disposal: 'Dump run / haul-away', 'extra-labor': 'Extra labor', assembly: 'Furniture assembly',
  'same-day': 'Same-day service', 'inside-placement': 'Inside placement',
  'appliance-hookup': 'Appliance hookup', priority: 'Priority scheduling',
}

export async function POST(request: NextRequest) {
  // Public form that sends email and makes an outbound ZIP-lookup call —
  // rate-limit per IP to block spam/amplification abuse.
  if (await rateLimit(request, 'quote', 5, 10 * 60_000)) {
    return NextResponse.json({ error: 'Too many requests. Please wait a few minutes and try again.' }, { status: 429 })
  }
  if (await isBlockedBot()) {
    return NextResponse.json({ error: 'Request blocked. Please try again.' }, { status: 403 })
  }

  const body = await request.json()
  const {
    pickupZip, deliveryZip,
    pallets, weight, serviceType, timing, loadSize,
    name, email, phone, company, notes, referral, promo,
  } = body

  // Junk removal and eviction/property cleanouts are priced per job, not by
  // distance/pallets — collect the lead and let ops send a custom quote rather
  // than showing a misleading number.
  const isJunk = serviceType === 'junk-removal'
  const isEviction = serviceType === 'eviction'
  const isJobBased = isJunk || isEviction
  const jobLabel = isEviction ? 'Property Cleanout' : 'Junk Removal'
  const LOAD_LABELS: Record<string, string> = {
    'few-items': 'A few items',
    quarter: 'About a quarter truck',
    half: 'About a half truck',
    'three-quarter': 'About three-quarter truck',
    full: 'Full truck load',
    multiple: 'More than one truck',
  }

  // Validate
  if (!isValidEmail(email) || !name) {
    return NextResponse.json({ error: 'Name and valid email are required.' }, { status: 400 })
  }
  if (!/^\d{5}$/.test(pickupZip) || !/^\d{5}$/.test(deliveryZip)) {
    return NextResponse.json({ error: 'Both ZIP codes must be 5 digits.' }, { status: 400 })
  }
  const palletCount = Math.max(0, Math.min(20, parseInt(pallets, 10) || 0))
  const lbs = Math.max(0, Math.min(20000, parseInt(weight, 10) || 0))

  // ZIP → lat/lon
  const [from, to] = await Promise.all([lookupZip(pickupZip), lookupZip(deliveryZip)])
  if (!from || !to) {
    return NextResponse.json({ error: 'Could not look up one or both ZIP codes. Please double-check.' }, { status: 400 })
  }
  const miles = distanceMiles(from, to)

  // Selected add-ons (flat fees on top of the estimate)
  const selectedAddOns: string[] = Array.isArray(body.addOns)
    ? body.addOns.map((a: unknown) => String(a)).filter((a: string) => a in PRICING.addOns).slice(0, 10)
    : []
  const addOnTotal = selectedAddOns.reduce((s, a) => s + (PRICING.addOns[a] ?? 0), 0)
  const addOnLabels = selectedAddOns.map(a => `${ADDON_LABELS[a] ?? a} (+$${PRICING.addOns[a]})`)

  // Job photos uploaded via /api/upload (Vercel Blob) — carried into the ops email
  // so the team can size the job accurately. Only trusted http(s) URLs, capped at 6.
  const photoUrls: string[] = Array.isArray(body.photos)
    ? body.photos.map((u: unknown) => String(u)).filter((u: string) => /^https?:\/\//.test(u)).slice(0, 6)
    : []

  // Compute estimate (delivery only — job-based services are quoted by hand)
  let low = 0
  let high = 0
  const fuelCharge = isJobBased ? 0 : fuelChargeDollars(miles)
  if (!isJobBased) {
    const serviceMult = PRICING.serviceMult[serviceType] ?? 1.0
    const timeMult = PRICING.timeMult[timing] ?? 1.0
    const point =
      (PRICING.base + miles * PRICING.perMile + palletCount * PRICING.perPallet) *
      serviceMult *
      timeMult
    low = Math.round((point * PRICING.rangeLow) / 5) * 5 + addOnTotal + fuelCharge
    high = Math.round((point * PRICING.rangeHigh) / 5) * 5 + addOnTotal + fuelCharge
  }

  // Job-based services (junk / brush / debris / eviction / cleanout) now get an
  // INSTANT price with disposal cost folded in and margin + minimums protecting profit.
  let disposal: DisposalQuote | null = null
  if (isJobBased) {
    const [settings, calibration] = await Promise.all([getDisposalSettings(), getCalibration()])
    disposal = priceJob({ settings, category: categoryFor(serviceType, body.debris), loadSize, calibration })
    low = disposal.low + addOnTotal
    high = disposal.high + addOnTotal
  }
  const distanceLabel = `${Math.round(miles)} mi (${Math.round(miles * 2)} mi round trip)`

  // Promo code: validate it, preview the discount on a delivery estimate, and
  // carry the code into the lead + booking prefill so it can be applied for real.
  let promoCode = ''
  let promoPct = 0
  const promoInput = normalizeCode(promo)
  if (promoInput) {
    const p = await getPromo(promoInput)
    const v = validatePromo(p, (high || 100) * 100, Date.now())
    if (v.ok) {
      promoCode = v.promo.code
      if (high > 0) {
        if (v.promo.type === 'percent') {
          promoPct = v.promo.value
          low = Math.max(0, Math.round(low * (1 - v.promo.value / 100)))
          high = Math.max(0, Math.round(high * (1 - v.promo.value / 100)))
        } else {
          low = Math.max(0, low - v.promo.value)
          high = Math.max(0, high - v.promo.value)
        }
      }
    }
  }

  const safe = {
    pickupZip:    escapeHtml(pickupZip),
    deliveryZip:  escapeHtml(deliveryZip),
    pickupLabel:  `${from.city}, ${from.state} ${pickupZip}`,
    deliveryLabel:`${to.city}, ${to.state} ${deliveryZip}`,
    pallets:      String(palletCount),
    weight:       String(lbs),
    serviceType:  escapeHtml(serviceType),
    timing:       escapeHtml(timing),
    loadSize:     escapeHtml(LOAD_LABELS[loadSize] ?? loadSize) || '—',
    name:         escapeHtml(name),
    email:        escapeHtml(email),
    phone:        escapeHtml(phone) || '—',
    company:      escapeHtml(company) || '—',
    notes:        escapeHtml(notes) || '—',
    referral:     escapeHtml(referral) || '—',
  }

  const resend = new Resend(process.env.RESEND_API_KEY)

  try {
    // Junk-removal leads carry a job location + load-size hint; delivery quotes
    // carry the full route + the price range the customer was shown.
    const jobRows = isJobBased
      ? `
            <tr><td style="padding:6px 0;color:#999;width:140px">Job Location</td><td style="padding:6px 0;font-weight:600">${safe.pickupLabel}</td></tr>
            <tr><td style="padding:6px 0;color:#999">Est. Load Size</td><td style="padding:6px 0">${safe.loadSize}</td></tr>
            <tr><td style="padding:6px 0;color:#999">Timing</td><td style="padding:6px 0">${safe.timing}</td></tr>`
      : `
            <tr><td style="padding:6px 0;color:#999;width:140px">Pickup</td><td style="padding:6px 0;font-weight:600">${safe.pickupLabel}</td></tr>
            <tr><td style="padding:6px 0;color:#999">Delivery</td><td style="padding:6px 0;font-weight:600">${safe.deliveryLabel}</td></tr>
            <tr><td style="padding:6px 0;color:#999">Distance</td><td style="padding:6px 0;font-weight:600">${distanceLabel}</td></tr>
            <tr><td style="padding:6px 0;color:#999">Pallets</td><td style="padding:6px 0">${safe.pallets}</td></tr>
            <tr><td style="padding:6px 0;color:#999">Weight</td><td style="padding:6px 0">${safe.weight} lbs</td></tr>
            <tr><td style="padding:6px 0;color:#999">Service Type</td><td style="padding:6px 0">${safe.serviceType}</td></tr>
            <tr><td style="padding:6px 0;color:#999">Timing</td><td style="padding:6px 0">${safe.timing}</td></tr>
            ${fuelCharge > 0 ? `<tr><td style="padding:6px 0;color:#999">Fuel Charge</td><td style="padding:6px 0">$${fuelCharge} (${Math.round(miles * 2)} mi round trip)</td></tr>` : ''}
            ${addOnLabels.length ? `<tr><td style="padding:6px 0;color:#999">Add-ons</td><td style="padding:6px 0">${escapeHtml(addOnLabels.join(', '))}</td></tr>` : ''}`

    // One-tap "Create Booking" deep link: opens the admin new-booking form
    // pre-filled with this customer's details (?new=1&…).
    const bookingParams = new URLSearchParams({ new: '1', name: name || '', email: email || '', phone: phone || '', service: isJunk ? 'junk-removal' : isEviction ? 'eviction' : 'freight' })
    if (isJobBased) bookingParams.set('jobSite', `${from.city}, ${from.state} ${pickupZip}`)
    else { bookingParams.set('pickup', `${from.city}, ${from.state} ${pickupZip}`); bookingParams.set('dropoff', `${to.city}, ${to.state} ${deliveryZip}`) }
    if (disposal) bookingParams.set('disposalEst', String(Math.round(disposal.disposalCents / 100)))
    const desc = [notes, isJobBased ? `Est. load: ${LOAD_LABELS[loadSize] ?? loadSize}` : '', timing ? `Timing: ${timing}` : '', addOnLabels.length ? `Add-ons: ${addOnLabels.join(', ')}` : '', promoCode ? `Promo: ${promoCode}` : '', disposal ? `Disposal est $${Math.round(disposal.disposalCents / 100)} · ${disposal.confidence} confidence` : ''].filter(Boolean).join(' · ')
    if (desc) bookingParams.set('desc', desc)
    const bookingUrl = `${COMPANY.siteUrl}/admin/bookings?${bookingParams.toString()}`

    // Notify ops
    await resend.emails.send({
      from: COMPANY.emailFrom,
      to: [COMPANY.email, COMPANY.ownerEmail],
      replyTo: email as string,
      subject: isJobBased
        ? `${jobLabel} Request — ${safe.pickupLabel} (${safe.loadSize})`
        : `Quote Request — ${safe.pickupLabel} → ${safe.deliveryLabel} (${distanceLabel})`,
      html: `
        <div style="font-family:sans-serif;max-width:640px;margin:0 auto">
          <h2 style="color:${COMPANY.brand.red};margin-bottom:4px">${isJobBased ? `${jobLabel} Request` : 'Instant Quote Request'}</h2>
          <p style="color:#666;margin-top:0">Submitted via ${COMPANY.domain}/quote · Customer was shown $${low.toLocaleString()}–$${high.toLocaleString()}</p>
          ${disposal ? `<table style="width:100%;border-collapse:collapse;background:#fafafa;border-radius:8px;margin:8px 0"><tr><td colspan="2" style="padding:8px 10px;font-weight:700;color:${COMPANY.brand.red}">Pricing intelligence (internal)</td></tr>
            <tr><td style="padding:4px 10px;color:#999;width:200px">Truck fill / loads / trips</td><td style="padding:4px 10px;font-weight:600">${disposal.fillPct}% · ${disposal.truckLoads} load${disposal.truckLoads > 1 ? 's' : ''} · ${disposal.landfillTrips} trip${disposal.landfillTrips > 1 ? 's' : ''}</td></tr>
            <tr><td style="padding:4px 10px;color:#999">Disposal estimate</td><td style="padding:4px 10px;font-weight:600">$${Math.round(disposal.disposalCents / 100)} ${disposal.requiresReview ? '⚠ review' : ''}</td></tr>
            <tr><td style="padding:4px 10px;color:#999">Labor estimate</td><td style="padding:4px 10px">$${Math.round(disposal.laborCents / 100)}</td></tr>
            <tr><td style="padding:4px 10px;color:#999">Cost basis</td><td style="padding:4px 10px">$${Math.round(disposal.costBasisCents / 100)}</td></tr>
            <tr><td style="padding:4px 10px;color:#999">Est. profit (at low)</td><td style="padding:4px 10px;font-weight:600">$${Math.round(disposal.profitLowCents / 100)}</td></tr>
            <tr><td style="padding:4px 10px;color:#999">Confidence</td><td style="padding:4px 10px;font-weight:600;text-transform:uppercase">${disposal.confidence}</td></tr>
            <tr><td style="padding:4px 10px;color:#999">Category</td><td style="padding:4px 10px">${disposal.category}</td></tr>
            </table>` : ''}

          <div style="margin:18px 0">
            <a href="${bookingUrl}" style="display:inline-block;background:${COMPANY.brand.red};color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 24px;border-radius:8px">Create Booking →</a>
            <p style="color:#999;font-size:12px;margin:8px 0 0">Opens your admin with a new booking pre-filled from this request. (Sign in if prompted.)</p>
          </div>

          <h3 style="margin-bottom:8px">${isJobBased ? 'Job' : 'Route'}</h3>
          <table style="width:100%;border-collapse:collapse">${jobRows}
          </table>

          <h3 style="margin-top:20px;margin-bottom:8px">Customer</h3>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:6px 0;color:#999;width:140px">Name</td><td style="padding:6px 0;font-weight:600">${safe.name}</td></tr>
            <tr><td style="padding:6px 0;color:#999">Company</td><td style="padding:6px 0">${safe.company}</td></tr>
            <tr><td style="padding:6px 0;color:#999">Email</td><td style="padding:6px 0"><a href="mailto:${safe.email}">${safe.email}</a></td></tr>
            <tr><td style="padding:6px 0;color:#999">Phone</td><td style="padding:6px 0">${safe.phone}</td></tr>
            ${safe.referral !== '—' ? `<tr><td style="padding:6px 0;color:#999">Heard via</td><td style="padding:6px 0;font-weight:600">${safe.referral}</td></tr>` : ''}
            ${promoCode ? `<tr><td style="padding:6px 0;color:#999">Promo</td><td style="padding:6px 0;font-weight:600">${escapeHtml(promoCode)}${promoPct ? ` (${promoPct}% off)` : ''}</td></tr>` : ''}
          </table>

          <p style="color:#999;margin:18px 0 6px 0">${isJobBased ? 'What needs to go' : 'Notes'}</p>
          <p style="background:#f9f9f9;padding:14px;border-radius:8px;margin:0;white-space:pre-wrap">${safe.notes}</p>

          ${photoUrls.length ? `
          <p style="color:#999;margin:18px 0 6px 0">Photos (${photoUrls.length})</p>
          <div style="display:flex;flex-wrap:wrap;gap:8px">
            ${photoUrls.map(u => `<a href="${u}" style="display:inline-block"><img src="${u}" alt="Job photo" width="92" height="92" style="width:92px;height:92px;object-fit:cover;border-radius:8px;border:1px solid #eee" /></a>`).join('')}
          </div>` : ''}
        </div>
      `,
    })

    // Job-based services now get an instant, disposal-protected price range.
    if (isJobBased) {
      return NextResponse.json({
        ok: true,
        estimate: {
          low, high, miles: 0, promoCode, promoPct,
          confidence: disposal?.confidence ?? 'medium',
          jobBased: true,
          pickupLabel: `${from.city}, ${from.state}`, deliveryLabel: `${from.city}, ${from.state}`,
        },
      })
    }

    return NextResponse.json({
      ok: true,
      estimate: { low, high, miles: Math.round(miles), fuelCharge, promoCode, promoPct, confidence: 'high', pickupLabel: `${from.city}, ${from.state}`, deliveryLabel: `${to.city}, ${to.state}` },
    })
  } catch (err) {
    console.error('[quote]', err)
    return NextResponse.json({ error: `Failed to submit. Please email ${COMPANY.email} directly.` }, { status: 500 })
  }
}
