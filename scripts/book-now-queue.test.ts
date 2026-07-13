// Book Now operations queue: a submission is visible the instant it is persisted
// (before any quote/payment/booking), lands in the right workflow stage, and matches
// the right filters. Pure/hermetic — mirrors what the Operations UI renders.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Booking } from '../app/lib/bookings'
import {
  isBookNow, bookNowServiceGroup, bookNowStage, matchesBookNowFilter,
  summarizeBookNow, ownerAlertStatus, aiStatus, quoteStatus, paymentStatus,
} from '../app/lib/book-now-queue'

// Minimal fixture — the queue helpers only read a handful of fields.
function mk(p: Partial<Booking>): Booking {
  return {
    token: p.token ?? 't', bookingNumber: 'JK-B-1', customerName: 'C',
    serviceType: 'junk-removal', items: [], invoiceAmountCents: 0, depositAmountCents: 0,
    amountPaidCents: 0, availableDates: [], availableWindows: [], status: 'quote_received',
    payments: [], source: 'online', createdAt: 1, updatedAt: 1, ...p,
  } as Booking
}

test('only online submissions belong in the Book Now queue', () => {
  assert.equal(isBookNow(mk({ source: 'online' })), true)
  assert.equal(isBookNow(mk({ source: 'admin' })), false)
})

test('service groups split junk / moving / delivery', () => {
  assert.equal(bookNowServiceGroup('junk-removal'), 'junk')
  assert.equal(bookNowServiceGroup('estate-cleanout'), 'junk')
  assert.equal(bookNowServiceGroup('moving'), 'moving')
  assert.equal(bookNowServiceGroup('appliance-delivery'), 'delivery')
  assert.equal(bookNowServiceGroup('freight'), 'delivery')
})

test('a JUST-submitted request is visible immediately — before quote, payment, or booking', () => {
  // Junk with photos, no AI yet → the owner should see it as "Awaiting AI".
  const fresh = mk({ serviceType: 'junk-removal', invoicePhotos: [{ url: 'https://x/p.jpg' }] })
  assert.equal(isBookNow(fresh), true)
  assert.equal(bookNowStage(fresh), 'awaiting_ai')
  assert.notEqual(bookNowStage(fresh), 'booked')     // NOT gated behind a confirmed booking
  assert.equal(matchesBookNowFilter(fresh, 'all'), true)
})

test('junk with no photos is Awaiting Photos; moving/delivery with no photos is New', () => {
  assert.equal(bookNowStage(mk({ serviceType: 'junk-removal', invoicePhotos: [] })), 'awaiting_photos')
  assert.equal(bookNowStage(mk({ serviceType: 'moving', invoicePhotos: [] })), 'new')
  assert.equal(bookNowStage(mk({ serviceType: 'freight', invoicePhotos: [] })), 'new')
})

test('stage advances with the workflow', () => {
  assert.equal(bookNowStage(mk({ aiEstimate: { decision: 'manual_review', pricing: {} } as Booking['aiEstimate'] })), 'manual_review')
  assert.equal(bookNowStage(mk({ aiEstimate: { decision: 'estimate_range', pricing: { lowUsd: 1, highUsd: 2 } } as Booking['aiEstimate'] })), 'quote_ready')
  assert.equal(bookNowStage(mk({ invoiceAmountCents: 20000 })), 'quote_sent')
  assert.equal(bookNowStage(mk({ status: 'pending_payment' })), 'payment_pending')
  assert.equal(bookNowStage(mk({ amountPaidCents: 5000 })), 'paid')
  assert.equal(bookNowStage(mk({ status: 'confirmed' })), 'booked')
  assert.equal(bookNowStage(mk({ status: 'completed' })), 'booked')
  assert.equal(bookNowStage(mk({ status: 'cancelled' })), 'failed')
})

test('filters select the right requests', () => {
  const junk = mk({ serviceType: 'junk-removal', invoicePhotos: [{ url: 'https://x/p.jpg' }] })
  const moving = mk({ serviceType: 'moving' })
  const delivery = mk({ serviceType: 'appliance-delivery' })
  const paid = mk({ amountPaidCents: 100 })
  assert.equal(matchesBookNowFilter(junk, 'junk'), true)
  assert.equal(matchesBookNowFilter(moving, 'moving'), true)
  assert.equal(matchesBookNowFilter(delivery, 'delivery'), true)
  assert.equal(matchesBookNowFilter(paid, 'paid'), true)
  assert.equal(matchesBookNowFilter(paid, 'new'), false)
})

test('durable AI job states drive the queue stage (real, not overlapping with Awaiting AI)', () => {
  const withPhotos = { serviceType: 'junk-removal' as const, invoicePhotos: [{ url: 'https://x/p.jpg' }] }
  assert.equal(bookNowStage(mk({ ...withPhotos, aiJob: { status: 'queued', idempotencyKey: 'k', photoVersion: 1, attempts: 0, updatedAt: 1 } })), 'ai_queued')
  assert.equal(bookNowStage(mk({ ...withPhotos, aiJob: { status: 'processing', idempotencyKey: 'k', photoVersion: 1, attempts: 1, updatedAt: 1 } })), 'ai_processing')
  assert.equal(bookNowStage(mk({ ...withPhotos, aiJob: { status: 'retrying', idempotencyKey: 'k', photoVersion: 1, attempts: 2, updatedAt: 1 } })), 'ai_processing')
  assert.equal(bookNowStage(mk({ ...withPhotos, aiJob: { status: 'failed', idempotencyKey: 'k', photoVersion: 1, attempts: 5, errorCode: 'retry_exhausted', updatedAt: 1 } })), 'ai_failed')
  assert.equal(bookNowStage(mk({ ...withPhotos, aiJob: { status: 'manual_review', idempotencyKey: 'k', photoVersion: 1, attempts: 1, updatedAt: 1 } })), 'manual_review')
  // AI Failed filter matches the real persisted status, distinct from Awaiting AI.
  const failed = mk({ ...withPhotos, aiJob: { status: 'failed', idempotencyKey: 'k', photoVersion: 1, attempts: 5, errorCode: 'retry_exhausted', updatedAt: 1 } })
  assert.equal(matchesBookNowFilter(failed, 'ai_failed'), true)
  assert.equal(matchesBookNowFilter(failed, 'ai_queued'), false)
})

test('summary counts online submissions by stage', () => {
  const c = summarizeBookNow([
    mk({ serviceType: 'moving' }),                                   // new
    mk({ serviceType: 'junk-removal', invoicePhotos: [{ url: 'https://x/p.jpg' }] }), // awaiting_ai
    mk({ amountPaidCents: 100 }),                                    // paid
    mk({ source: 'admin' }),                                         // excluded (not online)
  ])
  assert.equal(c.new, 1)
  assert.equal(c.awaiting_ai, 1)
  assert.equal(c.paid, 1)
})

test('owner-alert status reflects the ledger; sub-statuses read the booking', () => {
  assert.equal(ownerAlertStatus(mk({})), 'none')
  assert.equal(ownerAlertStatus(mk({ notifications: [{ id: '1', kind: 'new_submission', channel: 'email', status: 'sent', at: 1, retryCount: 0 }] })), 'sent')
  assert.equal(ownerAlertStatus(mk({ notifications: [{ id: '1', kind: 'new_submission', channel: 'email', status: 'failed', at: 1, retryCount: 0 }] })), 'failed')
  assert.equal(aiStatus(mk({ invoicePhotos: [{ url: 'https://x/p.jpg' }] })), 'processing')
  assert.equal(aiStatus(mk({ aiJob: { status: 'queued', idempotencyKey: 'k', photoVersion: 1, attempts: 0, updatedAt: 1 } })), 'queued')
  assert.equal(aiStatus(mk({ aiJob: { status: 'failed', idempotencyKey: 'k', photoVersion: 1, attempts: 5, updatedAt: 1 } })), 'failed')
  assert.equal(quoteStatus(mk({ invoiceAmountCents: 100 })), 'sent')
  assert.equal(paymentStatus(mk({ invoiceAmountCents: 100, amountPaidCents: 100 })), 'paid')
})
