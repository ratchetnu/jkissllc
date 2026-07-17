#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// One-off operator tool: re-run the failed production shadow job to verify the
// c190a27 vision-timeout fix, and produce the first real V1↔V2 comparison.
//
// WHY THIS IS SAFE:
//  • `shadow-retry` is handled entirely against the independent `shadow:*` store and
//    returns EARLY (app/api/admin/bookings/[id]/route.ts:100) — it never touches the
//    booking blob, authoritative fields, pricing, comms, or the saveBooking flow.
//  • It sends no customer notification, changes no quote, creates no invoice.
//  • It only resets an ALREADY-FAILED job (status must be failed/cancelled).
//  • Reads use KV_REST_API_READ_ONLY_TOKEN. The only write goes through the
//    authenticated, owner-guarded admin API — never direct to Redis.
//  • It prints NOTHING sensitive: no tokens, no signed URLs, no customer data.
//    The booking is referred to by its bookingNumber only.
//
// Run:  node scripts/shadow-rerun-prod.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs'

const BASE = 'https://www.jkissllc.com'
const ENV_FILE = new URL('../.env.production.local', import.meta.url).pathname

const env = Object.fromEntries(
  readFileSync(ENV_FILE, 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')] }),
)

const need = (k) => { if (!env[k]) { console.error(`missing ${k} in .env.production.local`); process.exit(1) } return env[k] }
const KV_URL = need('KV_REST_API_URL')
const KV_RO = env.KV_REST_API_READ_ONLY_TOKEN || need('KV_REST_API_TOKEN')
const PASSWORD = need('ADMIN_PASSWORD')
const CRON = need('CRON_SECRET')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function kv(args) {
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_RO}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args.map(String)), cache: 'no-store',
  })
  const j = await res.json()
  if (j.error) throw new Error(j.error)
  return j.result
}

const jobOf = async (id) => JSON.parse((await kv(['GET', `shadow:job:${id}`])) ?? 'null')

const show = (j, label) => {
  console.log(`\n── ${label} ──`)
  console.log('  booking        ', j.bookingNumber ?? '(none)')
  console.log('  status         ', j.status)
  console.log('  attempts       ', j.attempts)
  console.log('  model          ', j.model ?? '(none recorded)')
  console.log('  promptVersion  ', j.promptVersion ?? '(none recorded)')
  console.log('  latencyMs      ', j.latencyMs ?? '(unset)')
  console.log('  failureCategory', j.failureCategory ?? '(none)')
  console.log('  failureSummary ', j.failureSummary ?? '(none)')
  console.log('  result present ', !!j.result, j.result ? `(ok=${j.result.ok})` : '')
  console.log('  comparison     ', j.comparison ? `outcome=${j.comparison.outcome} manualReview=${j.comparison.shadowManualReview}` : '(none)')
  if (j.comparison) {
    console.log('    V1 recommended', j.comparison.authoritativeRecommendedUsd ?? '(none)', '| V1 decision', j.comparison.authoritativeDecision ?? '(none)')
    console.log('    V2 recommended', j.comparison.shadowRecommendedUsd, '| V2 decision', j.comparison.shadowDecision)
    console.log('    deltaUsd      ', j.comparison.quoteDeltaUsd ?? '(none)')
  }
  console.log('  estCostUsd     ', j.estimatedCostUsd ?? '(unset)')
}

const main = async () => {
  const ids = await kv(['ZREVRANGE', 'shadow:index', 0, 20])
  if (!ids.length) { console.error('No shadow jobs in the index.'); process.exit(1) }

  // Only act on jobs that are already terminal-failed. Never disturb a live one.
  const targets = []
  for (const id of ids) {
    const j = await jobOf(id)
    if (j && (j.status === 'failed' || j.status === 'cancelled')) targets.push({ id, job: j })
  }
  if (!targets.length) { console.log('No failed/cancelled shadow jobs to re-run. Nothing to do.'); return }

  console.log(`${targets.length} failed/cancelled job(s) to re-run.`)
  for (const t of targets) show(t.job, `BEFORE — ${t.job.bookingNumber}`)

  // 1) Authenticate as the platform owner (legacy shared-password session).
  console.log('\n[1/4] authenticating…')
  const auth = await fetch(`${BASE}/api/admin/auth`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }), redirect: 'manual',
  })
  const cookie = (auth.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  if (!auth.ok || !cookie) { console.error(`  auth failed: ${auth.status}`); process.exit(1) }
  console.log('  ok — owner session established')

  // 2) Reset each failed job to `retrying` (shadow store only).
  for (const t of targets) {
    console.log(`\n[2/4] shadow-retry → ${t.job.bookingNumber}`)
    // The booking route exposes GET / DELETE / PATCH — shadow actions are handled inside
    // PATCH (route.ts:78), which returns EARLY for them without touching the booking blob.
    const r = await fetch(`${BASE}/api/admin/bookings/${t.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ action: 'shadow-retry' }),
    })
    const body = await r.json().catch(() => ({}))
    console.log('  status', r.status, '→', JSON.stringify(body).slice(0, 160))
    if (!r.ok) { console.error('  retry refused — stopping.'); process.exit(1) }
  }

  // 3) Drive the worker directly instead of waiting up to 10 min for the cron.
  //    The worker takes ONE job per tick, so loop until every target is terminal.
  console.log('\n[3/4] driving the vision-shadow worker…')
  for (let tick = 1; tick <= targets.length * 3; tick++) {
    const r = await fetch(`${BASE}/api/cron/vision-shadow`, { headers: { Authorization: `Bearer ${CRON}` } })
    const body = await r.json().catch(() => ({}))
    console.log(`  tick ${tick}: status ${r.status} enabled=${body.enabled} processed=${body.processed ?? 0}`)
    if (body.enabled === false) {
      console.error('\n  VISION_SHADOW_WORKER_ENABLED is OFF — the worker will not process. Stopping.')
      console.error('  (No harm done: the jobs are queued as `retrying` and will run once the flag is on.)')
      process.exit(2)
    }
    const states = []
    for (const t of targets) states.push((await jobOf(t.id))?.status)
    console.log('   job states:', states.join(', '))
    if (states.every((s) => ['completed', 'manual_review', 'failed', 'skipped', 'not_eligible'].includes(s))) break
    await sleep(4000)
  }

  // 4) Report the outcome.
  console.log('\n[4/4] result')
  for (const t of targets) {
    const j = await jobOf(t.id)
    show(j, `AFTER — ${j.bookingNumber}`)
  }
  console.log('\nDone. Nothing customer-facing was touched.')
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
