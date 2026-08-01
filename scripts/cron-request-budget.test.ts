// ─────────────────────────────────────────────────────────────────────────────
// Cron request budget.
//
// The Upstash request quota was exhausted (500,000/500,000) and Production went
// down: health 503 `kv_unreachable`, homepage 500. The cron layer was the dominant
// consumer — 1,393 scheduled runs/day, of which `ai-jobs` alone was 480 runs at
// ~16 Redis requests each (measured in Production: `estimatedRedisRequests: 16`).
//
// Cadence is a COST decision as much as a correctness one, so it is pinned here.
// A future edit that quietly returns a job to */3 has to change this file too, and
// explain itself in the diff.
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

type Cron = { path: string; schedule: string }
const crons: Cron[] = JSON.parse(
  readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'),
).crons

/** Scheduled runs per day for the cron expressions this project uses. */
function runsPerDay(schedule: string): number {
  const [min, hour] = schedule.split(' ')
  const everyMin = /^\*\/(\d+)$/.exec(min)
  const everyHour = /^\*\/(\d+)$/.exec(hour)
  const fixedMinutes = /^\d+(?:,\d+)+$/.test(min) ? min.split(',').map(Number) : null
  if (everyMin && hour === '*') return (60 / Number(everyMin[1])) * 24
  if (fixedMinutes && hour === '*') return fixedMinutes.length * 24
  if (everyHour && /^\d+$/.test(min)) return 24 / Number(everyHour[1])
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) return 1
  throw new Error(`unhandled cron expression: ${schedule}`)
}

const bySchedulePath = Object.fromEntries(crons.map(c => [c.path, c.schedule]))
const total = crons.reduce((n, c) => n + runsPerDay(c.schedule), 0)

test('BUDGET: total scheduled cron runs stay within the daily ceiling', () => {
  // 1,393/day is what exhausted the quota. 400 leaves headroom for the current
  // shape (297/day) without silently absorbing a return to minute-level cadence.
  assert.ok(total <= 400, `cron runs/day is ${total}, over the 400 ceiling`)
  assert.ok(total > 0)
})

test('BUDGET: no cron runs more often than every 15 minutes', () => {
  for (const c of crons) {
    const m = /^\*\/(\d+) \*/.exec(c.schedule)
    if (!m) continue
    assert.ok(Number(m[1]) >= 15,
      `${c.path} runs every ${m[1]}m — minute-level cadence is what exhausted the request quota`)
  }
})

test('BUDGET: ai-jobs is a RECOVERY backstop, so it does not need minute cadence', () => {
  // /api/quote processes the estimate inline (processAiJob), and enqueueAiJob is
  // documented as the path for "if this request has photos but no valid AI estimate
  // got attached … so it never strands at Awaiting AI". The cron therefore delays
  // only ALREADY-FAILED estimates, never a normal quote.
  assert.equal(bySchedulePath['/api/cron/ai-jobs'], '*/15 * * * *')

  const quote = readFileSync(new URL('../app/api/quote/route.ts', import.meta.url), 'utf8')
  assert.match(quote, /processAiJob\(/,
    'if the inline path ever disappears, the cron becomes customer-facing and this cadence must be revisited')

  const requests = readFileSync(new URL('../app/lib/booking-requests.ts', import.meta.url), 'utf8')
  assert.match(requests, /never strands at "Awaiting AI"/,
    'the recovery framing is the premise for this cadence')
})

test('BUDGET: internal-only shadow jobs are not on a minute cadence', () => {
  // These compare an experimental estimate against the authoritative one. Nothing
  // customer-facing waits on them, and both are flag-gated off.
  assert.equal(bySchedulePath['/api/cron/vision-shadow'], '0 */6 * * *')
  // shadow-alerts EVALUATES what vision-shadow produced, so it is offset by 30
  // minutes rather than sharing the tick — same 4 runs/day, no contention.
  assert.equal(bySchedulePath['/api/cron/shadow-alerts'], '30 */6 * * *')
  assert.notEqual(bySchedulePath['/api/cron/shadow-alerts'], bySchedulePath['/api/cron/vision-shadow'],
    'the evaluator must not run on the same tick as the worker it reads from')
  for (const p of ['/api/cron/vision-shadow', '/api/cron/shadow-alerts']) {
    assert.ok(runsPerDay(bySchedulePath[p]) <= 4, `${p} is internal — hourly-plus is enough`)
  }
})

test('BUDGET: the daily job is untouched', () => {
  assert.equal(bySchedulePath['/api/cron/daily'], '0 14 * * *')
  assert.equal(runsPerDay('0 14 * * *'), 1)
})

test('BUDGET: runsPerDay is right, or the ceiling means nothing', () => {
  assert.equal(runsPerDay('*/3 * * * *'), 480)
  assert.equal(runsPerDay('*/5 * * * *'), 288)
  assert.equal(runsPerDay('*/15 * * * *'), 96)
  assert.equal(runsPerDay('*/30 * * * *'), 48)
  assert.equal(runsPerDay('10,40 * * * *'), 48)
  assert.equal(runsPerDay('0 */6 * * *'), 4)
  assert.equal(runsPerDay('0 14 * * *'), 1)
  // The pre-incident schedule must still exceed the ceiling, or the guard is inert.
  const before = 1 + 288 + 480 + 144 + 96 + 288 + 96
  assert.equal(before, 1393)
  assert.ok(before > 400, 'the ceiling must reject what actually caused the outage')
})
