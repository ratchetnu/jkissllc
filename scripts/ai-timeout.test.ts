// Bounded AI-call timeout (Phase 4). Pure/hermetic: the timeout budget, the
// error classifier that marks a client-side abort TRANSIENT (retryable) while a
// credit/auth/validation error stays PERMANENT, and the worker-layer guarantee that a
// timed-out call resolves to retrying/failed — never a stranded 'processing'.
import assert from 'node:assert/strict'
import test from 'node:test'

import { aiCallTimeoutMs, classifyAiError } from '../app/lib/ai'
import { classifyOutcome, retryDecision, MAX_ATTEMPTS } from '../app/lib/book-now-ai'

test('the call timeout is bounded and stays under the 60s function cap', () => {
  const ms = aiCallTimeoutMs()
  assert.ok(ms > 0)
  assert.ok(ms < 60_000, `timeout ${ms}ms must be < the 60s function budget`)
})

test('a REAL AbortSignal.timeout produces a TimeoutError classified transient/retryable', async () => {
  const sig = AbortSignal.timeout(1)
  await new Promise((r) => setTimeout(r, 15))       // let the deadline fire
  assert.equal(sig.aborted, true)
  const cls = classifyAiError(sig.reason)            // reason = DOMException 'TimeoutError'
  assert.equal(cls.kind, 'timeout')
  assert.equal(cls.retryable, true)
})

test('timeout / abort errors are transient (retryable)', () => {
  const timeoutErr = Object.assign(new Error('operation timed out'), { name: 'TimeoutError' })
  const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
  assert.deepEqual(classifyAiError(timeoutErr), { kind: 'timeout', retryable: true })
  assert.deepEqual(classifyAiError(abortErr), { kind: 'timeout', retryable: true })
})

test('a validation / credit / auth error is NOT retryable (distinct from a timeout)', () => {
  assert.equal(classifyAiError(new Error('invalid_schema: failed to parse')).retryable, false)
  assert.equal(classifyAiError(new Error('response did not match schema')).kind, 'validation')
  assert.equal(classifyAiError(new Error('insufficient credit / billing')).retryable, false)
  assert.equal(classifyAiError(new Error('unauthorized: bad api key')).retryable, false)
})

test('worker path: a timeout OUTCOME is classified provider_unavailable and retried, not stranded', () => {
  // The analyzer surfaces a timeout as an outcome string; the worker maps it to a
  // transient code and the retry policy re-schedules it (status → retrying), never
  // leaving the job in 'processing'.
  assert.equal(classifyOutcome('vision_call_timeout', false), 'provider_unavailable')
  const early = retryDecision(1, 'provider_unavailable')
  assert.equal(early.terminal, false)               // → status 'retrying' (not 'processing')
  assert.ok((early.delayMs ?? 0) > 0)
  const exhausted = retryDecision(MAX_ATTEMPTS, 'provider_unavailable')
  assert.equal(exhausted.terminal, true)            // → status 'failed' after the cap
  assert.equal(exhausted.finalCode, 'retry_exhausted')
})

test('worker path: a validation failure is terminal on the first attempt (never retried)', () => {
  assert.equal(classifyOutcome('schema_invalid', false), 'invalid_schema')
  const d = retryDecision(1, 'invalid_schema')      // PERMANENT error
  assert.equal(d.terminal, true)
  assert.equal(d.finalCode, 'invalid_schema')
})
