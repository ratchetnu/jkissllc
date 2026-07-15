// Book Now KPI accuracy — the overview counters must tell the truth:
//   • "Awaiting AI" — the COUNT and the KPI click-through FILTER derive from ONE
//     canonical predicate, so the number always equals the rows shown (parity).
//   • "Booked Today" — keys off the CONFIRMED date (America/Chicago), not the
//     submission date, and respects the midnight day boundary.
// Pure/hermetic — mirrors scripts/book-now-queue.test.ts.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Booking } from '../app/lib/bookings'
import {
  AWAITING_AI_STAGES, isAwaitingAi, isBookedOn, bookedAt,
  bookNowStage, matchesBookNowFilter,
} from '../app/lib/book-now-queue'
import { centralToday } from '../app/lib/dates'

// Minimal fixture — the queue helpers only read a handful of fields.
function mk(p: Partial<Booking>): Booking {
  return {
    token: p.token ?? 't', bookingNumber: 'JK-B-1', customerName: 'C',
    serviceType: 'junk-removal', items: [], invoiceAmountCents: 0, depositAmountCents: 0,
    amountPaidCents: 0, availableDates: [], availableWindows: [], status: 'quote_received',
    payments: [], source: 'online', createdAt: 1, updatedAt: 1, ...p,
  } as Booking
}
const photos = [{ url: 'https://x/p.jpg' }]
const job = (status: string) => ({ status, idempotencyKey: 'k', photoVersion: 1, attempts: 1, updatedAt: 1 })

// ── The canonical stage-set is exactly the intended six ──────────────────────
test('AWAITING_AI_STAGES is exactly the intended stage set', () => {
  assert.deepEqual(
    [...AWAITING_AI_STAGES].sort(),
    ['ai_failed', 'ai_processing', 'ai_queued', 'awaiting_ai', 'awaiting_photos', 'manual_review'].sort(),
  )
})

// One representative booking per Awaiting-AI stage, plus decoys that must NOT count.
const awaitingCases: Booking[] = [
  mk({ token: 'photos', serviceType: 'junk-removal', invoicePhotos: [] }),                        // awaiting_photos
  mk({ token: 'legacy', serviceType: 'junk-removal', invoicePhotos: photos }),                    // awaiting_ai (photos, never enqueued)
  mk({ token: 'queued', serviceType: 'junk-removal', invoicePhotos: photos, aiJob: job('queued') as Booking['aiJob'] }),      // ai_queued
  mk({ token: 'proc', serviceType: 'junk-removal', invoicePhotos: photos, aiJob: job('processing') as Booking['aiJob'] }),    // ai_processing
  mk({ token: 'failed', serviceType: 'junk-removal', invoicePhotos: photos, aiJob: job('failed') as Booking['aiJob'] }),      // ai_failed
  mk({ token: 'review', serviceType: 'junk-removal', invoicePhotos: photos, aiJob: job('manual_review') as Booking['aiJob'] }), // manual_review
]
const decoys: Booking[] = [
  mk({ token: 'new', serviceType: 'moving' }),                                                    // new
  mk({ token: 'ready', aiEstimate: { decision: 'estimate_range', pricing: { lowUsd: 1, highUsd: 2 } } as Booking['aiEstimate'] }), // quote_ready
  mk({ token: 'paid', amountPaidCents: 100 }),                                                    // paid
  mk({ token: 'booked', status: 'confirmed' }),                                                   // booked
  mk({ token: 'admin', source: 'admin', serviceType: 'junk-removal', invoicePhotos: [] }),        // not online (but stage still awaiting_photos)
]

test('every Awaiting-AI fixture lands in an AWAITING_AI_STAGES stage', () => {
  for (const b of awaitingCases) {
    assert.ok(AWAITING_AI_STAGES.includes(bookNowStage(b)), `${b.token} → ${bookNowStage(b)}`)
    assert.equal(isAwaitingAi(b), true)
  }
})

test('KPI "Awaiting AI" count === rows the composite filter returns (parity)', () => {
  const dataset = [...awaitingCases, ...decoys]
  const viaComposite = dataset.filter(b => matchesBookNowFilter(b, 'awaiting_ai')).length
  const viaPredicate = dataset.filter(isAwaitingAi).length
  const viaStages = dataset.filter(b => AWAITING_AI_STAGES.includes(bookNowStage(b))).length
  // All three routes agree, and equal the six intended cases (+ the admin decoy,
  // which is awaiting_photos — filter parity is about stage, not the online gate).
  assert.equal(viaComposite, viaPredicate)
  assert.equal(viaComposite, viaStages)
  assert.equal(viaComposite, 7)  // 6 awaitingCases + admin decoy (awaiting_photos)
  // The decoys that are NOT awaiting-AI stages must be excluded.
  assert.equal(matchesBookNowFilter(mk({ token: 'new', serviceType: 'moving' }), 'awaiting_ai'), false)
  assert.equal(matchesBookNowFilter(mk({ amountPaidCents: 100 }), 'awaiting_ai'), false)
})

// ── Booked Today keys off the confirmed date, with a Central midnight boundary ─
test('"Booked Today" uses confirmedAt (booked date), not createdAt (submission)', () => {
  // Submitted long ago, confirmed today → COUNTS. The old createdAt logic missed this.
  const submittedYesterdayConfirmedToday = mk({
    status: 'confirmed',
    createdAt: Date.parse('2026-07-01T12:00:00-05:00'),
    confirmedAt: Date.parse('2026-07-14T09:00:00-05:00'),
  })
  assert.equal(bookedAt(submittedYesterdayConfirmedToday), Date.parse('2026-07-14T09:00:00-05:00'))
  assert.equal(isBookedOn(submittedYesterdayConfirmedToday, '2026-07-14'), true)

  // Submitted today but not yet confirmed → NOT a booking today (not a booked stage).
  const submittedTodayNotBooked = mk({ createdAt: Date.parse('2026-07-14T10:00:00-05:00') })
  assert.equal(isBookedOn(submittedTodayNotBooked, '2026-07-14'), false)
})

test('"Booked Today" respects the Central midnight boundary', () => {
  const day = '2026-07-14'
  // 00:01 Central on the 14th → counts for the 14th.
  const justAfter = mk({ status: 'confirmed', confirmedAt: Date.parse('2026-07-14T00:01:00-05:00') })
  // 23:59 Central on the 13th → belongs to the 13th, NOT the 14th.
  const justBefore = mk({ status: 'confirmed', confirmedAt: Date.parse('2026-07-13T23:59:00-05:00') })

  assert.equal(centralToday(justAfter.confirmedAt!), '2026-07-14')
  assert.equal(centralToday(justBefore.confirmedAt!), '2026-07-13')
  assert.equal(isBookedOn(justAfter, day), true)
  assert.equal(isBookedOn(justBefore, day), false)
  assert.equal(isBookedOn(justBefore, '2026-07-13'), true)  // it IS booked on the 13th
})

test('bookedAt falls back to createdAt for legacy records without confirmedAt', () => {
  const legacy = mk({ status: 'completed', createdAt: Date.parse('2026-07-14T08:00:00-05:00') })
  assert.equal(legacy.confirmedAt, undefined)
  assert.equal(bookedAt(legacy), legacy.createdAt)
  assert.equal(isBookedOn(legacy, '2026-07-14'), true)
})
