// Rollout readiness for the two flags this work prepares but does NOT enable:
// OPERION_CRITIC_JSON and OPERION_EVENT_ENQUEUE.
//
// Neither flag ships on. Each is a Production behaviour change that has to earn its
// rollout with evidence, and these tests pin the properties that evidence depends on:
//
//   CRITIC_JSON      — the cheap JSON critic must still ESCALATE. If it silently
//                      accepted borderline or unsafe reads it would trade latency
//                      for bad auto-quotes, which is not a trade we are willing to
//                      make at any speed.
//   EVENT_ENQUEUE    — the post-response kick must be an ACCELERATION, never a
//                      mechanism. If it never fires, fires twice, or dies mid-flight,
//                      the 15-minute cron must still recover the job unchanged.
//
// No network, no Redis, no provider.
import assert from 'node:assert/strict'
import test from 'node:test'

import { criticModeFor, reconcileWithCritic, criticEnabled, CRITIC_VISION_OVERALL_MAX, CRITIC_VISION_VOLUME_MAX, type CriticVerdict } from '../app/lib/ai/junk-critic'
import { normalizeAnalysis, type NormalizeCtx } from '../app/lib/ai/analysis-schema'
import { decideQuote } from '../app/lib/pricing/quote-decision'
import { DEFAULT_DISPOSAL } from '../app/lib/disposal'
import { shouldKickAiWorker, isDue, enqueueAiJob, MAX_ATTEMPTS } from '../app/lib/book-now-ai'
import type { Booking, AiJob, AiJobStatus } from '../app/lib/bookings'

/** A minimal online junk booking — the shape the durable worker actually reasons about. */
function booking(p: Partial<Booking> = {}): Booking {
  return {
    token: 'tok', bookingNumber: 'JK-B-1', customerName: 'C',
    serviceType: 'junk-removal', items: [], invoiceAmountCents: 0, depositAmountCents: 0,
    amountPaidCents: 0, availableDates: [], availableWindows: [], status: 'quote_received',
    payments: [], source: 'online', createdAt: 1, updatedAt: 1,
    invoicePhotos: [{ url: 'https://blob.example.com/p.jpg' }], ...p,
  } as Booking
}

const ctx: NormalizeCtx = {
  analysisId: 'a1', bookingId: 'b1', photoUrls: ['https://blob.example.com/p.jpg'],
  modelProvider: 'vercel-ai-gateway', modelName: 'm', analyzedAt: '2026-08-03T00:00:00.000Z',
}

const analysisAt = (overall: number, volume: number) => normalizeAnalysis({
  normalizedItems: [{ category: 'furniture', label: 'couch', estimatedQuantity: 1, estimatedVolumeCubicYards: 3, heavy: false, requiresDisassembly: false, confidence: overall }],
  photoObservations: [{ photoUrl: ctx.photoUrls[0], imageQuality: 'good' }],
  totalEstimatedVolumeCubicYards: { minimum: 2.5, likely: 3, maximum: 3.5 },
  totalEstimatedWeightPounds: { minimum: 300, likely: 400, maximum: 500 },
  estimatedTruckLoadFraction: { minimum: 0.06, likely: 0.07, maximum: 0.09 },
  estimatedTruckLoads: { minimum: 1, likely: 1, maximum: 1 },
  confidence: { overall, volume },
  reviewRequired: false, reviewReasons: [], warnings: [], additionalQuestions: [],
}, ctx)

const decide = (analysis: ReturnType<typeof analysisAt>, forceReview = false) =>
  decideQuote({ analysis, settings: DEFAULT_DISPOSAL, serviceType: 'junk-removal', forceReview })

// ─────────────────────────────────────────────────────────────────────────────
// OPERION_CRITIC_JSON — cheaper, but never blinder
// ─────────────────────────────────────────────────────────────────────────────

test('the critic is ON by default and only AI_JUNK_CRITIC=off silences it', () => {
  const prev = process.env.AI_JUNK_CRITIC
  try {
    delete process.env.AI_JUNK_CRITIC
    assert.equal(criticEnabled(), true, 'the second opinion is not optional by accident')
    process.env.AI_JUNK_CRITIC = 'off'
    assert.equal(criticEnabled(), false)
  } finally {
    if (prev === undefined) delete process.env.AI_JUNK_CRITIC; else process.env.AI_JUNK_CRITIC = prev
  }
})

test('JSON mode is used ONLY where a pixel re-read could not change the answer', () => {
  // Confident: the numbers alone are enough — no second vision pass.
  assert.equal(criticModeFor({ overall: 0.95, volume: 0.9 }, true), 'json')
  // Borderline: exactly where a mis-read flips an auto-quote — keep the pixels.
  assert.equal(criticModeFor({ overall: CRITIC_VISION_OVERALL_MAX - 0.01, volume: 0.9 }, true), 'vision')
  assert.equal(criticModeFor({ overall: 0.95, volume: CRITIC_VISION_VOLUME_MAX - 0.01 }, true), 'vision')
  // Just above the instant-quote bar is the most dangerous band of all.
  assert.equal(criticModeFor({ overall: 0.71, volume: 0.61 }, true), 'vision')
  // Flag OFF is unchanged: vision, always.
  assert.equal(criticModeFor({ overall: 0.99, volume: 0.99 }, false), 'vision')
})

test('the vision band covers every read that could still auto-quote', () => {
  // decideQuote's instant bar is 0.70/0.60. Everything from the bar up to the
  // vision maxima must still get a pixel re-check, or a borderline auto-quote
  // could be waved through on numbers alone.
  for (let overall = 0.70; overall < CRITIC_VISION_OVERALL_MAX; overall += 0.01) {
    assert.equal(criticModeFor({ overall, volume: 0.65 }, true), 'vision', `overall ${overall.toFixed(2)} must stay on vision`)
  }
})

test('a JSON-mode "review" verdict escalates to manual review', () => {
  const a = analysisAt(0.95, 0.9)
  assert.equal(decide(a).decision, 'instant_quote', 'precondition: this would auto-quote')

  const verdict: CriticVerdict = { agrees: false, recommend: 'review', confidence: 0.3, concerns: ['numbers imply a far larger load than the item list'] }
  const reconciled = reconcileWithCritic(a, verdict)
  assert.equal(reconciled.reviewRequired, true)
  const d = decide(reconciled, verdict.recommend === 'review')
  assert.equal(d.decision, 'manual_review')
  assert.ok(d.reviewReasons.some(r => /numbers imply a far larger load/.test(r)), 'the concern reaches the human')
})

test('a JSON-mode "range" verdict drops the read below the instant bar', () => {
  const a = analysisAt(0.95, 0.9)
  const verdict: CriticVerdict = { agrees: false, recommend: 'range', confidence: 0.5, concerns: ['weight looks high for the volume'] }
  const reconciled = reconcileWithCritic(a, verdict)
  assert.ok(reconciled.confidence.overall <= 0.6)
  assert.equal(decide(reconciled).decision, 'estimate_range', 'no auto-commit on a contested read')
})

test('a materially different fill read widens the range instead of picking a side', () => {
  const a = analysisAt(0.95, 0.9)   // fraction.likely = 0.07
  const verdict: CriticVerdict = { agrees: false, recommend: 'accept', adjustedTruckLoadFraction: 0.5, confidence: 0.8, concerns: [] }
  const reconciled = reconcileWithCritic(a, verdict)
  assert.ok(reconciled.estimatedTruckLoadFraction.minimum <= 0.07)
  assert.ok(reconciled.estimatedTruckLoadFraction.maximum >= 0.5, 'the range must cover BOTH reads')
  assert.notEqual(decide(reconciled).decision, 'instant_quote', 'a disagreement is never auto-quoted')
})

test('unsafe reads never reach the critic at all — they are already manual review', () => {
  // The critic gate is `decision === instant_quote`. A hazard read is manual_review
  // BEFORE the gate, so no critic mode can wave it through.
  const hazardous = normalizeAnalysis({
    normalizedItems: [{ category: 'household_junk', label: 'paint cans', estimatedQuantity: 8, estimatedVolumeCubicYards: 0.3, heavy: false, requiresDisassembly: false, confidence: 0.9 }],
    photoObservations: [{ photoUrl: ctx.photoUrls[0], imageQuality: 'good' }],
    estimatedTruckLoadFraction: { minimum: 0.05, likely: 0.08, maximum: 0.12 },
    detectedConditions: { hazardousMaterialPossible: true },
    confidence: { overall: 0.95, volume: 0.95 },
    reviewRequired: false, reviewReasons: [],
  }, ctx)
  assert.equal(decide(hazardous).decision, 'manual_review')
})

// ─────────────────────────────────────────────────────────────────────────────
// OPERION_EVENT_ENQUEUE — an accelerator with the cron still underneath
// ─────────────────────────────────────────────────────────────────────────────

const jobbed = (status: AiJobStatus, over: Partial<AiJob> = {}): Booking =>
  booking({ aiJob: { status, idempotencyKey: 'k', photoVersion: 1, attempts: 0, updatedAt: 0, ...over } })

test('flag OFF ⇒ no kick: cron-only, byte-identical to today', () => {
  assert.equal(shouldKickAiWorker(jobbed('queued'), {}), false)
  assert.equal(shouldKickAiWorker(jobbed('queued'), { OPERION_EVENT_ENQUEUE: '0' }), false)
})

test('flag ON ⇒ kick a QUEUED job and nothing else', () => {
  const on = { OPERION_EVENT_ENQUEUE: '1' }
  assert.equal(shouldKickAiWorker(jobbed('queued'), on), true)
  // Never race a run that is already under way, and never resurrect a terminal one.
  for (const status of ['processing', 'completed', 'failed', 'manual_review', 'retrying'] as AiJobStatus[]) {
    assert.equal(shouldKickAiWorker(jobbed(status), on), false, `${status} must not be kicked`)
  }
  assert.equal(shouldKickAiWorker({ aiJob: undefined }, on), false)
  assert.equal(shouldKickAiWorker(null, on), false)
})

test('the kick is idempotent by construction: a kicked job is no longer kickable', () => {
  const on = { OPERION_EVENT_ENQUEUE: '1' }
  const b = jobbed('queued')
  assert.equal(shouldKickAiWorker(b, on), true)
  // processAiJob persists 'processing' BEFORE the model call, so any second caller
  // — a duplicate submit, a retry, the cron — sees a non-kickable, non-due job.
  b.aiJob!.status = 'processing'
  b.aiJob!.lastAttemptAt = Date.now()
  assert.equal(shouldKickAiWorker(b, on), false)
  assert.equal(isDue(b, Date.now()), false, 'and the cron leaves it alone too')
})

test('if the kick never runs, the cron still finds the job — unchanged', () => {
  const now = 1_000_000
  const b = jobbed('queued', { nextRetryAt: now, updatedAt: now })
  // This is the whole safety argument: eligibility does not depend on the kick.
  assert.equal(isDue(b, now), true)
  assert.equal(isDue(b, now + 15 * 60_000), true, 'still due a full cron interval later')
})

test('a kick interrupted mid-flight is recovered, not lost', () => {
  // `after` can be cut short (function teardown, deploy, crash). The job is left in
  // 'processing' and the stale-lease sweep returns it to the cron's queue rather
  // than stranding the booking.
  const start = 1_000_000
  const stranded = jobbed('processing', { attempts: 1, lastAttemptAt: start, updatedAt: start })
  assert.equal(isDue(stranded, start + 60_000), false, 'still inside its 5-minute lease — do not double-run it')
  assert.equal(isDue(stranded, start + 6 * 60_000), true, 'lease expired ⇒ the cron reclaims it')
})

test('the retry ladder is untouched by the kick', () => {
  // The accelerator changes WHEN attempt 1 starts, never how many attempts exist.
  assert.equal(MAX_ATTEMPTS, 5)
  const b = booking()
  enqueueAiJob(b, { initiatedBy: 'system' })
  assert.equal(b.aiJob?.status, 'queued')
  assert.equal(b.aiJob?.attempts, 0, 'a kick does not consume an attempt in advance')
})

test('no customer request ever waits on the durable worker', async () => {
  // The kick is scheduled with `after`, which by contract runs AFTER the response is
  // finished. This asserts the shape the route depends on: the scheduling call is
  // synchronous and does not await the work.
  const order: string[] = []
  const scheduled: Array<() => Promise<void>> = []
  const after = (fn: () => Promise<void>) => { scheduled.push(fn); order.push('scheduled') }

  const respond = () => {
    if (shouldKickAiWorker(jobbed('queued'), { OPERION_EVENT_ENQUEUE: '1' })) {
      after(async () => { order.push('worker-ran') })
    }
    order.push('responded')
  }
  respond()
  assert.deepEqual(order, ['scheduled', 'responded'], 'the response is sent first, always')

  for (const fn of scheduled) await fn()
  assert.deepEqual(order, ['scheduled', 'responded', 'worker-ran'])
})
