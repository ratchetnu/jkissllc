// OPERION AI latency Phase 2 — unit tests for the pure decision logic:
//   Task 1  critic mode gate (JSON vs vision by confidence)
//   Task 3  due-job index scoring + scan/index parity + flag gates
// No network, no Redis. Behaviour with the flags OFF is proven byte-identical by the
// pre-existing suites (book-now-ai / ai-queue / ai-regression) — these cover the new
// ON-path decisions.
import assert from 'node:assert/strict'
import test from 'node:test'

import { criticModeFor, CRITIC_VISION_OVERALL_MAX, CRITIC_VISION_VOLUME_MAX } from '../app/lib/ai/junk-critic'
import {
  dueScore, bookingDueScore, compareDue, dueLeaseMs, dueIndexMaintained, dueIndexReadEnabled,
} from '../app/lib/ai-due-index'
import type { AiJob } from '../app/lib/bookings'

// ── Task 1: critic mode gate ─────────────────────────────────────────────────

test('criticModeFor OFF → always vision (byte-identical to today)', () => {
  assert.equal(criticModeFor({ overall: 0.99, volume: 0.99 }, false), 'vision')
  assert.equal(criticModeFor({ overall: 0.71, volume: 0.61 }, false), 'vision')
})

test('criticModeFor ON + confident read → cheap JSON critic (no second vision call)', () => {
  assert.equal(criticModeFor({ overall: 0.85, volume: 0.75 }, true), 'json')
  assert.equal(criticModeFor({ overall: CRITIC_VISION_OVERALL_MAX, volume: CRITIC_VISION_VOLUME_MAX }, true), 'json') // exactly at the bar
})

test('criticModeFor ON + borderline read → keep the vision re-check where it matters', () => {
  assert.equal(criticModeFor({ overall: 0.79, volume: 0.90 }, true), 'vision') // overall just under
  assert.equal(criticModeFor({ overall: 0.90, volume: 0.69 }, true), 'vision') // volume just under
  assert.equal(criticModeFor({ overall: 0.72, volume: 0.62 }, true), 'vision') // both just above the instant bar
})

// ── Task 3: due-job index scoring (must mirror isDue exactly) ────────────────

const LEASE = 300_000
const job = (o: Partial<AiJob>): AiJob => ({
  status: 'queued', idempotencyKey: 'k', photoVersion: 1, attempts: 0, updatedAt: 0, ...o,
})

test('dueScore: queued/retrying → nextRetryAt (due when ≤ now)', () => {
  assert.equal(dueScore(job({ status: 'queued', nextRetryAt: 1000 }), LEASE), 1000)
  assert.equal(dueScore(job({ status: 'retrying', nextRetryAt: 5000 }), LEASE), 5000)
  assert.equal(dueScore(job({ status: 'queued' }), LEASE), 0) // missing → 0 = due immediately
})

test('dueScore: processing → lastAttemptAt + lease (due only once STALE)', () => {
  assert.equal(dueScore(job({ status: 'processing', lastAttemptAt: 1000 }), LEASE), 1000 + LEASE)
})

test('dueScore: terminal states are never due', () => {
  for (const s of ['completed', 'failed', 'manual_review'] as const) {
    assert.equal(dueScore(job({ status: s }), LEASE), null)
  }
})

test('bookingDueScore: archived / test / no-job are never due (isDue parity)', () => {
  assert.equal(bookingDueScore({ archived: true, isTest: false, aiJob: job({ nextRetryAt: 1 }) }, LEASE), null)
  assert.equal(bookingDueScore({ archived: false, isTest: true, aiJob: job({ nextRetryAt: 1 }) }, LEASE), null)
  assert.equal(bookingDueScore({ archived: false, isTest: false, aiJob: undefined }, LEASE), null)
  assert.equal(bookingDueScore({ archived: false, isTest: false, aiJob: job({ nextRetryAt: 42 }) }, LEASE), 42)
})

// ── Task 3: parity (dark-launch proof the index === the scan) ────────────────

test('compareDue: identical sets → match, no drift', () => {
  const p = compareDue(['a', 'b', 'c'], ['c', 'a', 'b'])
  assert.equal(p.match, true)
  assert.deepEqual(p.missingFromIndex, [])
  assert.deepEqual(p.extraInIndex, [])
  assert.equal(p.scan, 3)
  assert.equal(p.index, 3)
})

test('compareDue: flags the dangerous direction (due per scan, absent from index)', () => {
  const p = compareDue(['a', 'b', 'c'], ['a'])
  assert.equal(p.match, false)
  assert.deepEqual(p.missingFromIndex.sort(), ['b', 'c']) // jobs the index would strand
  assert.deepEqual(p.extraInIndex, [])
})

test('compareDue: flags benign extras (in index, not currently due per scan)', () => {
  const p = compareDue(['a'], ['a', 'x'])
  assert.equal(p.match, false)
  assert.deepEqual(p.missingFromIndex, [])
  assert.deepEqual(p.extraInIndex, ['x'])
})

// ── Task 3: flag gates default OFF (inert) ───────────────────────────────────

test('due-index gates are OFF by default and env-driven', () => {
  assert.equal(dueIndexMaintained({}), false)
  assert.equal(dueIndexReadEnabled({}), false)
  assert.equal(dueIndexMaintained({ OPERION_DUE_INDEX_DARK_LAUNCH: 'true' }), true)  // maintained in dark-launch
  assert.equal(dueIndexReadEnabled({ OPERION_DUE_INDEX_DARK_LAUNCH: 'true' }), false) // but not read
  assert.equal(dueIndexReadEnabled({ OPERION_DUE_INDEX: 'true' }), true)              // read flips only on the live flag
  assert.equal(dueIndexMaintained({ OPERION_DUE_INDEX: 'true' }), true)
})

test('dueLeaseMs reads AI_PROCESSING_LEASE_MS with a safe default', () => {
  assert.equal(dueLeaseMs({}), 300_000)
  assert.equal(dueLeaseMs({ AI_PROCESSING_LEASE_MS: '120000' }), 120_000)
  assert.equal(dueLeaseMs({ AI_PROCESSING_LEASE_MS: 'garbage' }), 300_000)
})
