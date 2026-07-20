import { NextRequest, NextResponse } from 'next/server'
import { after as afterResponse } from 'next/server'
import { withTenantRoute } from '../../lib/platform/tenancy/with-tenant-route'
import { withBackgroundTenant } from '../../lib/platform/tenancy/request-context'
import { currentTenantId } from '../../lib/platform/tenancy/context'
import { processAiJob } from '../../lib/book-now-ai'
import { isEnabled } from '../../lib/platform/flags'
import { rateLimit } from '../../lib/rate-limit'
import { isValidEmail } from '../../lib/validators'
import { isBlockedBot } from '../../lib/botcheck'
import { getPromo, validatePromo, normalizeCode } from '../../lib/promo'
import { getDisposalSettings, priceJob, categoryFor, type DisposalQuote } from '../../lib/disposal'
import { getCalibration } from '../../lib/job-learning'
import { COMPANY } from '../../lib/company'
import { persistQuoteRequest } from '../../lib/booking-requests'
import { unitsForLoad } from '../../lib/availability'
import { SERVICE_TYPES, getBookingByToken, type ServiceType } from '../../lib/bookings'
import { submitConfirmation, processFinalAiJob } from '../../lib/book-now-confirmation'
import { notifyOwnerAiOutcome } from '../../lib/booking-notify'
import { projectCustomerFinalState, type CustomerFinalState } from '../../lib/ai/confirmation-ui'
import { recordFunnelEvent } from '../../lib/analytics-events'
import { filterPhotoUrls } from '../../lib/photo-url'

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

export const POST = withTenantRoute(async (request: NextRequest) => {
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
    pallets, serviceType, timing, loadSize,
    name, email, phone, company, notes, referral, promo,
    // Structured fields for persisting the request as an OpsPilot booking.
    bookService, pickupAddress, dropoffAddress, preferredDate, contactMethod, idempotencyKey, analysisId,
  } = body

  // Junk removal and eviction/property cleanouts are priced per job, not by
  // distance/pallets — collect the lead and let ops send a custom quote rather
  // than showing a misleading number.
  const isJunk = serviceType === 'junk-removal'
  const isEviction = serviceType === 'eviction'
  const isJobBased = isJunk || isEviction
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
  // so the team can size the job accurately. ONLY our Blob host (no attacker links
  // reaching ops inboxes or the model), deduped, capped at 6.
  const photoUrls: string[] = filterPhotoUrls(body.photos, 6)

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



  try {
    // Junk-removal leads carry a job location + load-size hint; delivery quotes
    // carry the full route + the price range the customer was shown.
    // A compact description carried onto the persisted booking's internal notes.
    const desc = [notes, isJobBased ? `Est. load: ${LOAD_LABELS[loadSize] ?? loadSize}` : '', timing ? `Timing: ${timing}` : '', addOnLabels.length ? `Add-ons: ${addOnLabels.join(', ')}` : '', promoCode ? `Promo: ${promoCode}` : '', disposal ? `Disposal est $${Math.round(disposal.disposalCents / 100)} · ${disposal.confidence} confidence` : ''].filter(Boolean).join(' · ')

    // ── Persist the request as a booking so it appears in OpsPilot ──────────
    // Done BEFORE the ops email so the email can link straight to the real record
    // (?b=<number> opens its detail) instead of a blank create form — which would
    // otherwise create a DUPLICATE. Best-effort: a storage hiccup must not deny the
    // customer their estimate or block the ops email.
    let request_out: { number: string; token: string } | undefined
    let final: CustomerFinalState | undefined
    try {
      const svcType: ServiceType = SERVICE_TYPES.includes(bookService) ? bookService : 'other'
      const persisted = await persistQuoteRequest({
        name, email, phone, company,
        serviceType: svcType,
        jobSiteAddress: isJobBased ? (pickupAddress || `${from.city}, ${from.state} ${pickupZip}`) : undefined,
        pickupAddress: !isJobBased ? (pickupAddress || `${from.city}, ${from.state} ${pickupZip}`) : undefined,
        dropoffAddress: !isJobBased ? (dropoffAddress || `${to.city}, ${to.state} ${deliveryZip}`) : undefined,
        description: desc || notes || undefined,
        photos: photoUrls,
        jobUnits: unitsForLoad(loadSize),
        loadSize: isJobBased && loadSize ? String(loadSize) : undefined,
        loadSizeLabel: isJobBased && loadSize ? (LOAD_LABELS[loadSize] ?? String(loadSize)) : undefined,
        timing: timing ? String(timing) : undefined,
        addOnLabels: addOnLabels.length ? addOnLabels : undefined,
        preferredDate,
        contactMethod,
        promoCode: promoCode || undefined,
        estimateLow: low, estimateHigh: high,
        leadSource: 'website:book-now',
        referralSource: typeof referral === 'string' ? referral : undefined,
        idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : undefined,
        analysisId: typeof analysisId === 'string' ? analysisId : undefined,
      })
      if (persisted) request_out = { number: persisted.bookingNumber, token: persisted.token }

      // ── Event-driven recovery (OPERION_EVENT_ENQUEUE) ──────────────────────
      // When persist enqueued a durable AI job (photos present, no inline estimate
      // landed), kick the worker the moment the response is sent — so the recovery
      // job starts in seconds instead of waiting up to a full cron interval. Runs
      // post-response via `after`, in an explicit background tenant context, and is
      // fully fail-soft + idempotent (per-booking write-lock + valid-estimate guard):
      // the cron worker remains the safety net if this is cut short or never runs.
      // OFF ⇒ cron-only, byte-identical to today.
      if (persisted && persisted.aiJob?.status === 'queued' && isEnabled('OPERION_EVENT_ENQUEUE')) {
        const token = persisted.token
        const tid = (() => { try { return currentTenantId() } catch { return undefined } })()
        afterResponse(async () => {
          try {
            await withBackgroundTenant('webhook', () => processAiJob(token, { initiatedBy: 'event', tenantId: tid }), tid)
          } catch (e) { console.error('[quote] event-driven ai worker', e) }
        })
      }

      // ── Guided confirmation: run the SECOND (final) governed analysis on the
      // SERVER (never the browser). Idempotent + durable — if this inline attempt
      // fails or times out, the cron worker recovers the queued finalAiJob. ──
      if (persisted && isJobBased && body.confirmation && typeof body.confirmation === 'object') {
        try {
          const nowIso = new Date().toISOString()
          await recordFunnelEvent('confirmation_submitted', nowIso)
          const sub = await submitConfirmation(persisted.token, body.confirmation, { submittedBy: 'customer' })
          if (sub.ok) {
            await recordFunnelEvent('final_analysis_started', nowIso)
            const res = await processFinalAiJob(persisted.token, { initiatedBy: 'customer' })
            if (res.finalDecision === 'quote_ready') await recordFunnelEvent('final_analysis_completed', nowIso)
            else if (res.finalDecision === 'awaiting_owner_approval') await recordFunnelEvent('final_routed_owner_approval', nowIso)
            else if (res.finalDecision === 'manual_review') await recordFunnelEvent('final_routed_manual_review', nowIso)
            const after = await getBookingByToken(persisted.token)
            if (after) {
              final = projectCustomerFinalState(after)
              // Notify the OWNER the moment a guided estimate lands (parity with the
              // cron path). The final job parks at 'completed' for quote_ready /
              // owner_approval and 'manual_review' for review/site-visit — without
              // this the owner is never told there's an estimate awaiting approval.
              const jobStatus = after.finalAiJob?.status
              if (jobStatus === 'completed' || jobStatus === 'manual_review') {
                try { await notifyOwnerAiOutcome(after, jobStatus) } catch (e) { console.error('[quote] owner notify', e) }
              }
            }
          }
        } catch (e) { console.error('[quote] final analysis', e); /* cron recovers */ }
      }
    } catch (e) {
      console.error('[quote] persist request', e)
    }

    // Job-based services now get an instant, disposal-protected price range.
    if (isJobBased) {
      return NextResponse.json({
        ok: true,
        request: request_out,
        final,
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
      request: request_out,
      estimate: { low, high, miles: Math.round(miles), fuelCharge, promoCode, promoPct, confidence: 'high', pickupLabel: `${from.city}, ${from.state}`, deliveryLabel: `${to.city}, ${to.state}` },
    })
  } catch (err) {
    console.error('[quote]', err)
    return NextResponse.json({ error: `Failed to submit. Please email ${COMPANY.email} directly.` }, { status: 500 })
  }
})
