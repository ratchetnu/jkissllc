// Estate Cleanout service family — reuses the shared workflow with service-specific
// intake, keep/donate/dispose sorting, sensitive-item governance, and site-visit
// routing. Pure/hermetic (injected settings + timestamps).
import assert from 'node:assert/strict'
import test from 'node:test'

import { INVENTORY_TAXONOMY, taxonomyEntry, normalizeToInventoryCategory, classifyFreeText } from '../app/lib/ai/inventory-taxonomy'
import {
  normalizeConfirmation, activeItems, sensitiveItems, hasSensitiveItems, estateNeedsSiteVisit, isEstateConfirmation,
  CLEANOUT_SUBTYPE_LABEL,
} from '../app/lib/ai/confirmation-schema'
import { buildConfirmedEstimate } from '../app/lib/ai/confirmed-analysis'
import { selectFollowUpQuestions } from '../app/lib/ai/followup-questions'
import { buildOwnerReviewModel } from '../app/lib/ai/confirmation-review'
import { projectCustomerFinalState } from '../app/lib/ai/confirmation-ui'
import { isEstateBooking, bookNowStage, matchesBookNowFilter, confirmationStatus } from '../app/lib/book-now-queue'
import { DEFAULT_DISPOSAL } from '../app/lib/disposal'
import type { Booking } from '../app/lib/bookings'

const NOW = '2026-07-13T00:00:00.000Z'
const fullAtt = { representsEverything: true, additionalMayChangePrice: true, hazardousDisclosed: true, accessDisclosed: true, mayRequireOwnerReview: true }
const conf = (raw: Record<string, unknown>, v = 1) => normalizeConfirmation(raw, { now: NOW, confirmationVersion: v, submittedBy: 'customer' })
const priced = (c: ReturnType<typeof conf>) => buildConfirmedEstimate({ initial: undefined, confirmation: c, serviceType: 'estate-cleanout', settings: DEFAULT_DISPOSAL, now: NOW, analysisId: 'f', bookingId: 'b' })

// ── Sensitive taxonomy ───────────────────────────────────────────────────────
test('sensitive/estate categories are flagged and never plain disposal', () => {
  for (const k of ['valuables', 'documents', 'medications', 'firearms', 'personal_keepsakes', 'hazardous'] as const) {
    assert.equal(INVENTORY_TAXONOMY[k].sensitive, true, `${k} must be sensitive`)
    assert.equal(INVENTORY_TAXONOMY[k].specialHandling, true)
  }
  assert.notEqual(taxonomyEntry('furniture').sensitive, true)
})

test('free text routes sensitive items to the right sensitive category', () => {
  assert.equal(classifyFreeText('grandpa’s shotgun and ammo'), 'firearms')
  assert.equal(classifyFreeText('a box of prescription pills'), 'medications')
  assert.equal(classifyFreeText('an urn with ashes'), 'personal_keepsakes')
  assert.equal(classifyFreeText('jewelry and a coin collection'), 'valuables')
  assert.equal(classifyFreeText('the will and passport'), 'documents')
  assert.equal(normalizeToInventoryCategory('other', 'important legal papers'), 'documents')
})

// ── Estate intake normalization + disposition ───────────────────────────────
test('estate intake + item disposition normalize onto the confirmation', () => {
  const c = conf({
    items: [{ id: 'a', category: 'furniture', name: 'Sofa', quantity: 1, aiDetected: true, disposition: 'donate' }],
    estate: { subtype: 'estate', relationship: 'executor', occupancy: 'vacant', expectedTruckloads: 2, deadlineType: 'probate', deadlineDate: '2026-08-01' },
    attestation: fullAtt,
  })
  assert.equal(isEstateConfirmation(c), true)
  assert.equal(c.estate?.subtype, 'estate')
  assert.equal(c.estate?.relationship, 'executor')
  assert.equal(c.items[0].disposition, 'donate')
  assert.equal(CLEANOUT_SUBTYPE_LABEL.hoarding, 'Hoarding Cleanup')
})

// ── Sensitive + site-visit governance ────────────────────────────────────────
test('a confirmed firearm/medication is sensitive and routes to a human', () => {
  const c = conf({ items: [
    { id: 'a', category: 'firearms', name: 'Shotgun', quantity: 1, aiDetected: false },
    { id: 'b', category: 'furniture', name: 'Couch', quantity: 1, aiDetected: true },
  ], estate: { subtype: 'estate' }, attestation: fullAtt })
  assert.equal(hasSensitiveItems(c), true)
  assert.deepEqual(sensitiveItems(c).map(i => i.name), ['Shotgun'])
  const r = priced(c)
  assert.equal(r.finalDecision, 'site_visit_required')       // sensitive → site visit, never auto-quote
  assert.ok(r.sensitiveItems.includes('Shotgun'))
})

test('hoarding / whole-home / multi-day / dumpster jobs require a site visit', () => {
  for (const estate of [{ subtype: 'hoarding' }, { subtype: 'whole_home' }, { subtype: 'estate', multipleDays: true }, { subtype: 'estate', dumpsterNeeded: true }, { subtype: 'estate', expectedTruckloads: 4 }]) {
    const c = conf({ items: [{ id: 'a', category: 'furniture', name: 'Couch', quantity: 1, aiDetected: true }], estate, attestation: fullAtt })
    assert.equal(estateNeedsSiteVisit(c), true, JSON.stringify(estate))
    assert.equal(priced(c).finalDecision, 'site_visit_required', JSON.stringify(estate))
  }
})

test('a small, clear garage cleanout with no sensitive items can be quoted or owner-approved', () => {
  const c = conf({ items: [{ id: 'a', category: 'furniture', name: 'Couch', quantity: 1, aiDetected: true, aiQuantity: 1 }], estate: { subtype: 'garage', expectedTruckloads: 1 }, attestation: fullAtt })
  assert.equal(estateNeedsSiteVisit(c), false)
  const r = priced(c)
  assert.notEqual(r.finalDecision, 'site_visit_required')
  assert.ok(['quote_ready', 'awaiting_owner_approval'].includes(r.finalDecision))
})

test('estate sorting / cleaning add-on pushes at least to owner approval', () => {
  const c = conf({ items: [{ id: 'a', category: 'furniture', name: 'Couch', quantity: 1, aiDetected: true, aiQuantity: 1 }], estate: { subtype: 'garage', sortingRequired: true }, attestation: fullAtt })
  assert.equal(priced(c).finalDecision, 'awaiting_owner_approval')
})

// ── Estate questions ─────────────────────────────────────────────────────────
test('estate flag adds the estate questions; non-estate junk does not', () => {
  const estate = selectFollowUpQuestions({ serviceFamily: 'junk', estate: true }).map(q => q.id)
  assert.ok(estate.includes('estate_sensitive_possible'))
  assert.ok(estate.includes('estate_sorting_required'))
  const plain = selectFollowUpQuestions({ serviceFamily: 'junk' }).map(q => q.id)
  assert.ok(!plain.includes('estate_sensitive_possible'))
})

// ── Owner review model + queue + customer projection ─────────────────────────
function mkB(p: Partial<Booking>): Booking {
  return { token: 'tok', bookingNumber: 'JK-B-1', customerName: 'C', serviceType: 'estate-cleanout', items: [], invoiceAmountCents: 0, depositAmountCents: 0, amountPaidCents: 0, availableDates: [], availableWindows: [], status: 'quote_received', payments: [], source: 'online', createdAt: 1, updatedAt: 1, invoicePhotos: [{ url: 'https://x/1.jpg' }], ...p } as Booking
}

test('owner review model surfaces estate details, sensitive names, dispositions, and site-visit', () => {
  const c = conf({
    items: [
      { id: 'a', category: 'furniture', name: 'Couch', quantity: 1, aiDetected: true, disposition: 'donate' },
      { id: 'b', category: 'valuables', name: 'Jewelry box', quantity: 1, aiDetected: false, disposition: 'keep' },
    ],
    estate: { subtype: 'estate', relationship: 'family' }, attestation: fullAtt,
  })
  const finalAiEstimate = priced(c)
  const m = buildOwnerReviewModel(mkB({ confirmation: c, finalAiEstimate }))
  assert.equal(m.isEstate, true)
  assert.equal(m.estateSubtypeLabel, 'Estate Cleanout')
  assert.ok(m.sensitiveItemNames.includes('Jewelry box'))
  assert.equal(m.siteVisit, true)
  assert.equal(m.dispositionCounts.donate, 1)
  assert.equal(m.dispositionCounts.keep, 1)
})

test('queue: estate booking is estate-filtered, site_visit staged, and out of the plain junk filter', () => {
  const c = conf({ items: [{ id: 'a', category: 'firearms', name: 'Rifle', quantity: 1, aiDetected: false }], estate: { subtype: 'estate' }, attestation: fullAtt })
  const b = mkB({ confirmation: c, finalAiEstimate: priced(c) })
  assert.equal(isEstateBooking(b), true)
  assert.equal(bookNowStage(b), 'site_visit')
  assert.equal(matchesBookNowFilter(b, 'estate'), true)
  assert.equal(matchesBookNowFilter(b, 'site_visit'), true)
  assert.equal(matchesBookNowFilter(b, 'junk'), false)          // estate is triaged separately
  assert.equal(confirmationStatus(b), 'site_visit')
})

test('customer sees a calm "on-site visit" state for a site-visit estate job', () => {
  const s = projectCustomerFinalState({
    confirmation: { confirmationVersion: 1 },
    finalAiEstimate: { finalDecision: 'site_visit_required', confirmationVersion: 1, pricing: { recommendedUsd: 0, lowUsd: 0, highUsd: 0 } },
  })
  assert.equal(s.stage, 'site_visit')
  assert.ok(!/error|large|hoard/i.test(s.message))     // never alarming/technical
  assert.equal(s.lowUsd, undefined)                     // no fabricated price
})
