import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { rateLimit } from '../../lib/rate-limit'

function escapeHtml(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function isValidEmail(email: unknown): email is string {
  if (typeof email !== 'string') return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length < 255
}

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
  } as Record<string, number>,
  // Range spread around point estimate (low, high)
  rangeLow: 0.85,
  rangeHigh: 1.20,
}

export async function POST(request: NextRequest) {
  // Public form that sends email and makes an outbound ZIP-lookup call —
  // rate-limit per IP to block spam/amplification abuse.
  if (await rateLimit(request, 'quote', 5, 10 * 60_000)) {
    return NextResponse.json({ error: 'Too many requests. Please wait a few minutes and try again.' }, { status: 429 })
  }

  const body = await request.json()
  const {
    pickupZip, deliveryZip,
    pallets, weight, serviceType, timing, loadSize,
    name, email, phone, company, notes,
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

  // Compute estimate (delivery only — job-based services are quoted by hand)
  let low = 0
  let high = 0
  if (!isJobBased) {
    const serviceMult = PRICING.serviceMult[serviceType] ?? 1.0
    const timeMult = PRICING.timeMult[timing] ?? 1.0
    const point =
      (PRICING.base + miles * PRICING.perMile + palletCount * PRICING.perPallet) *
      serviceMult *
      timeMult
    low = Math.round((point * PRICING.rangeLow) / 5) * 5
    high = Math.round((point * PRICING.rangeHigh) / 5) * 5
  }
  const distanceLabel = `${Math.round(miles)} mi`

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
            <tr><td style="padding:6px 0;color:#999">Timing</td><td style="padding:6px 0">${safe.timing}</td></tr>`

    // Notify ops
    await resend.emails.send({
      from: 'J Kiss LLC <info@jkissllc.com>',
      to: ['info@jkissllc.com', 'timmothy@jkissllc.com'],
      replyTo: email as string,
      subject: isJobBased
        ? `${jobLabel} Request — ${safe.pickupLabel} (${safe.loadSize})`
        : `Quote Request — ${safe.pickupLabel} → ${safe.deliveryLabel} (${distanceLabel})`,
      html: `
        <div style="font-family:sans-serif;max-width:640px;margin:0 auto">
          <h2 style="color:#E0002A;margin-bottom:4px">${isJobBased ? `${jobLabel} Request` : 'Instant Quote Request'}</h2>
          <p style="color:#666;margin-top:0">${isJobBased
            ? 'Submitted via jkissllc.com/quote · Needs a custom quote (no instant price shown)'
            : `Submitted via jkissllc.com/quote · Customer was shown $${low.toLocaleString()}–$${high.toLocaleString()}`}</p>

          <h3 style="margin-bottom:8px">${isJobBased ? 'Job' : 'Route'}</h3>
          <table style="width:100%;border-collapse:collapse">${jobRows}
          </table>

          <h3 style="margin-top:20px;margin-bottom:8px">Customer</h3>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:6px 0;color:#999;width:140px">Name</td><td style="padding:6px 0;font-weight:600">${safe.name}</td></tr>
            <tr><td style="padding:6px 0;color:#999">Company</td><td style="padding:6px 0">${safe.company}</td></tr>
            <tr><td style="padding:6px 0;color:#999">Email</td><td style="padding:6px 0"><a href="mailto:${safe.email}">${safe.email}</a></td></tr>
            <tr><td style="padding:6px 0;color:#999">Phone</td><td style="padding:6px 0">${safe.phone}</td></tr>
          </table>

          <p style="color:#999;margin:18px 0 6px 0">${isJobBased ? 'What needs to go' : 'Notes'}</p>
          <p style="background:#f9f9f9;padding:14px;border-radius:8px;margin:0;white-space:pre-wrap">${safe.notes}</p>
        </div>
      `,
    })

    // Job-based services: no instant price — acknowledge the request only.
    if (isJobBased) {
      return NextResponse.json({ ok: true, requested: true })
    }

    return NextResponse.json({
      ok: true,
      estimate: { low, high, miles: Math.round(miles), pickupLabel: `${from.city}, ${from.state}`, deliveryLabel: `${to.city}, ${to.state}` },
    })
  } catch (err) {
    console.error('[quote]', err)
    return NextResponse.json({ error: 'Failed to submit. Please email info@jkissllc.com directly.' }, { status: 500 })
  }
}
