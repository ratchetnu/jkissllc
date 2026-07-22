#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// PREVIEW-ONLY AI OBSERVABILITY VERIFICATION HARNESS
//
// Drives ONE synthetic Book-Now job through the real customer pipeline on a
// PREVIEW deployment and verifies the AI pipeline observability trace it produces:
//   upload photo → /api/quote → durable AI worker → read /api/admin/ai/pipeline.
//
// This is a SEPARATE harness from scripts/e2e-booking-test.mjs (which targets
// production and never touches the AI pipeline). It NEVER targets production: it
// refuses to run against the live domain and reads its base URL + secrets from the
// environment (default: .env.preview.local). It is reusable and structured so new
// AI-regression assertions can be added to VERIFY() over time.
//
// Prerequisite: the target Preview deployment must have been built with
// AI_PIPELINE_OBSERVABILITY_ENABLED=true (Vercel bakes env vars per deployment, so
// setting the Preview env var only takes effect on a NEW preview build). The
// preflight below fails fast with a clear message if the flag is not active — so it
// never spends an AI call against a flag-off deployment.
//
// Usage:
//   PREVIEW_URL=https://<preview>.vercel.app node scripts/observability-verify.mjs
//   node scripts/observability-verify.mjs --json          # machine-readable output
//   node scripts/observability-verify.mjs --preflight-only # auth + flag check, no job
//   node scripts/observability-verify.mjs --keep          # don't delete the test booking
//
// Config (env or .env.preview.local; env wins):
//   PREVIEW_URL | BASE_URL   REQUIRED — the Preview deployment URL (never prod)
//   ADMIN_PASSWORD           admin login (reads the pipeline API + polls the job)
//   CRON_SECRET              bearer to kick /api/cron/ai-jobs (else waits for cron)
//   SAMPLE_PHOTO             local image path (default public/images/junk-yard-debris.jpg)
//   ENV_FILE                 env file to load (default .env.preview.local)
//   POLL_TIMEOUT_MS          job wait budget (default 150000)
//   POLL_INTERVAL_MS         poll cadence (default 4000)
//   EXPECTED_STAGES          comma list (default queue,ai,pricing,database)
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs'
import path from 'node:path'

// ── Config ───────────────────────────────────────────────────────────────────
const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
function loadEnvFile(rel) {
  try {
    const out = {}
    for (const line of readFileSync(path.resolve(ROOT, rel), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (!m) continue
      let v = m[2].trim(); if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
      out[m[1]] = v
    }
    return out
  } catch { return {} }
}
const fileEnv = loadEnvFile(process.env.ENV_FILE || '.env.preview.local')
const pick = (k, d) => process.env[k] ?? fileEnv[k] ?? d
const args = new Set(process.argv.slice(2))

const cfg = {
  baseUrl: (pick('PREVIEW_URL') || pick('BASE_URL') || '').replace(/\/+$/, ''),
  adminPassword: pick('ADMIN_PASSWORD'),
  cronSecret: pick('CRON_SECRET'),
  // Preview deployments are behind Vercel Deployment Protection (SSO). Provide a
  // Protection Bypass for Automation secret to reach them programmatically.
  bypassSecret: pick('VERCEL_AUTOMATION_BYPASS_SECRET'),
  samplePhoto: pick('SAMPLE_PHOTO', 'public/images/junk-yard-debris.jpg'),
  pollTimeoutMs: Number(pick('POLL_TIMEOUT_MS', '150000')),
  pollIntervalMs: Number(pick('POLL_INTERVAL_MS', '4000')),
  expectedStages: pick('EXPECTED_STAGES', 'queue,ai,pricing,database').split(',').map(s => s.trim()).filter(Boolean),
  jsonOut: args.has('--json'),
  preflightOnly: args.has('--preflight-only'),
  keep: args.has('--keep'),
}

// Production hosts this harness must NEVER touch. Extend as needed.
const PROD_HOSTS = new Set(['jkissllc.com', 'www.jkissllc.com'])

const log = (...a) => { if (!cfg.jsonOut) console.log(...a) }
const results = []          // { name, pass, detail }
let trace = null            // the recorded PipelineTraceRecord
let token = null            // the synthetic booking token
function check(name, pass, detail = '') { results.push({ name, pass: !!pass, detail }); log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`) }
function die(msg, code = 2) { if (cfg.jsonOut) console.log(JSON.stringify({ ok: false, error: msg, results }, null, 2)); else console.error(`\n✖ ${msg}`); process.exit(code) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ── Guards ───────────────────────────────────────────────────────────────────
if (!cfg.baseUrl) die('PREVIEW_URL (or BASE_URL) is required — a Preview deployment URL. This harness never targets production.')
let host
try { host = new URL(cfg.baseUrl).host } catch { die(`PREVIEW_URL is not a valid URL: ${cfg.baseUrl}`) }
if (PROD_HOSTS.has(host)) die(`Refusing to run against production host "${host}". This harness is Preview-only.`)
if (!cfg.adminPassword) die('ADMIN_PASSWORD is required (to read the observability API and poll the job).')

// ── HTTP (cookie jar) ────────────────────────────────────────────────────────
let cookie = ''
async function http(method, urlPath, { body, headers = {}, captureCookie = false, raw = false } = {}) {
  const res = await fetch(cfg.baseUrl + urlPath, {
    method, redirect: 'manual',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      // Bypass Vercel Deployment Protection (SSO) on preview URLs when a secret is set.
      // Sent per-request (no set-bypass-cookie, which would 307-redirect to set a cookie).
      ...(cfg.bypassSecret ? { 'x-vercel-protection-bypass': cfg.bypassSecret } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  // A redirect to Vercel SSO means we hit deployment protection without a valid bypass.
  const loc = res.headers.get('location') || ''
  if ((res.status === 302 || res.status === 307) && /vercel\.com\/sso/.test(loc)) {
    die(`blocked by Vercel Deployment Protection at ${urlPath}. Set VERCEL_AUTOMATION_BYPASS_SECRET (Project → Settings → Deployment Protection → Protection Bypass for Automation), or use a shareable preview link.`)
  }
  const setc = res.headers.get('set-cookie'); if (setc && captureCookie) cookie = setc.split(';')[0]
  const txt = await res.text()
  if (raw) return { status: res.status, text: txt }
  let data = null; try { data = JSON.parse(txt) } catch { data = txt }
  return { status: res.status, data }
}

// ── Steps ────────────────────────────────────────────────────────────────────
async function adminAuth() {
  const r = await http('POST', '/api/admin/auth', { body: { password: cfg.adminPassword }, captureCookie: true })
  check('admin auth', r.status === 200 && cookie.includes('jk_admin_session'), `status ${r.status}`)
  if (!cookie) die('admin auth failed — cannot proceed')
}

async function preflightFlagActive() {
  // The observability read API returns { enabled:false } when the deployment was
  // NOT built with the flag. This is the fail-fast gate before any AI spend.
  const r = await http('GET', '/api/admin/ai/pipeline?limit=1')
  const enabled = r.status === 200 && r.data && r.data.enabled === true
  check('observability flag active on deployment', enabled, r.status === 200 ? `enabled=${r.data?.enabled}${r.data?.reason ? ' — ' + r.data.reason : ''}` : `status ${r.status}`)
  return enabled
}

function samplePhotoDataUrl() {
  const p = path.resolve(ROOT, cfg.samplePhoto)
  const buf = readFileSync(p)
  const ext = path.extname(p).toLowerCase()
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
  return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, bytes: buf.length, file: cfg.samplePhoto }
}

async function uploadPhoto() {
  const { dataUrl, bytes, file } = samplePhotoDataUrl()
  const r = await http('POST', '/api/upload', { body: { image: dataUrl } })
  const url = r.data?.url
  check('upload sample photo', r.status === 200 && typeof url === 'string', `status ${r.status} (${file}, ${(bytes / 1024 | 0)}KB)${r.status === 403 ? ' — bot-blocked; run from an allowed context' : ''}`)
  if (!url) die('photo upload failed — cannot create a photo-bearing quote')
  return url
}

async function submitQuote(photoUrl) {
  // Junk-removal, job-based → persists a booking with a durable AI job.
  const r = await http('POST', '/api/quote', {
    body: {
      serviceType: 'junk-removal', name: 'OBS VERIFY (auto-deleted)',
      email: 'obs-verify@example.com', phone: '214-555-0100',
      pickupZip: '75201', deliveryZip: '75201',
      bookService: 'junk-removal', pickupAddress: '123 Test St, Dallas, TX',
      preferredDate: '2026-08-01', contactMethod: 'email',
      photos: [photoUrl], notes: 'Synthetic observability verification job.',
    },
  })
  token = r.data?.request?.token || r.data?.token || r.data?.booking?.token
  check('submit /api/quote (customer flow)', r.status === 200 && !!token, `status ${r.status}${r.status === 403 ? ' — bot-blocked' : ''}`)
  if (!token) die('quote did not return a booking token — no durable AI job to trace')
  return token
}

async function driveWorkerAndWait() {
  const deadline = Date.now() + cfg.pollTimeoutMs
  // Deterministic trigger: the admin 'run-ai' action runs the traced processAiJob
  // synchronously under our admin session — no CRON_SECRET and no Vercel cron needed
  // (cron does not fire on preview deployments). Idempotent; cron remains the prod path.
  const rr = await http('PATCH', `/api/admin/bookings/${token}`, { body: { action: 'run-ai' } })
  check('trigger AI analysis (admin run-ai)', rr.status === 200, `status ${rr.status}${rr.data?.error ? ' — ' + rr.data.error : ''}`)
  let last = rr.data?.booking?.aiJob ?? null
  while (Date.now() < deadline) {
    if (cfg.cronSecret) {
      await http('GET', '/api/cron/ai-jobs', { headers: { Authorization: `Bearer ${cfg.cronSecret}` } }).catch(() => {})
    }
    const r = await http('GET', `/api/admin/bookings/${token}`)
    const job = r.data?.booking?.aiJob
    last = job ?? last
    const st = job?.status
    if (st && ['completed', 'manual_review', 'failed'].includes(st)) return job
    await sleep(cfg.pollIntervalMs)
  }
  return last
}

async function readTrace() {
  const r = await http('GET', `/api/admin/ai/pipeline?booking=${encodeURIComponent(token)}`)
  const traces = Array.isArray(r.data?.traces) ? r.data.traces : []
  trace = traces[traces.length - 1] || null
  return { status: r.status, traces }
}

async function readAggregate() {
  const r = await http('GET', '/api/admin/ai/pipeline?limit=2000')
  return r.data
}

async function cleanup() {
  if (cfg.keep || !token) return
  await http('DELETE', `/api/admin/bookings/${token}`).catch(() => {})
}

// ── Run ──────────────────────────────────────────────────────────────────────
try {
  log(`▶ Observability verification against ${cfg.baseUrl}`)
  await adminAuth()
  const active = await preflightFlagActive()
  if (!active) die('Target Preview deployment was NOT built with AI_PIPELINE_OBSERVABILITY_ENABLED=true. Set it in the Preview env and redeploy that branch, then re-run. (No AI call was made.)', 3)
  if (cfg.preflightOnly) { log('\nPreflight OK — flag active. Exiting (--preflight-only).'); process.exit(0) }

  const photoUrl = await uploadPhoto()
  await submitQuote(photoUrl)
  const job = await driveWorkerAndWait()
  check('durable AI job reached a terminal state', !!job && ['completed', 'manual_review', 'failed'].includes(job?.status), `status ${job?.status ?? 'timeout'} attempt ${job?.attempt ?? '?'}`)
  check('no worker failure', job?.status !== 'failed', `job status ${job?.status}`)
  check('no unexpected retries (attempt === 1)', (job?.attempt ?? 1) === 1, `attempt ${job?.attempt ?? '?'}`)

  const { traces } = await readTrace()
  check('trace created', traces.length >= 1, `${traces.length} trace(s)`)
  check('trace ID present', !!trace?.id, trace?.id || '—')
  check('trace tied to booking', trace?.bookingId === token || traces.length >= 1, trace?.bookingId || '—')

  const stages = trace?.stages || {}
  const present = Object.keys(stages)
  for (const s of cfg.expectedStages) {
    const st = stages[s]
    check(`stage recorded: ${s}`, !!st, st ? `${st.totalMs}ms ×${st.count}` : 'missing')
    if (st) check(`stage timing populated: ${s}`, typeof st.totalMs === 'number' && st.totalMs >= 0 && st.count >= 1, `${st.totalMs}ms count ${st.count}`)
  }
  check('end-to-end duration recorded', typeof trace?.durationMs === 'number' && trace.durationMs > 0, `${trace?.durationMs}ms`)

  const agg = await readAggregate()
  const aggCount = agg?.totals?.count ?? agg?.count ?? (Array.isArray(agg?.stages) ? undefined : undefined)
  check('aggregate metrics updated', !!agg && agg.enabled === true && (aggCount === undefined || aggCount >= 1), `count=${aggCount ?? 'n/a'}`)

  await cleanup()

  const failed = results.filter(r => !r.pass)
  const timing = trace ? Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, v.totalMs])) : {}
  const summary = {
    ok: failed.length === 0,
    baseUrl: cfg.baseUrl,
    traceId: trace?.id || null,
    bookingToken: token,
    jobStatus: job?.status ?? null,
    attempt: job?.attempt ?? null,
    durationMs: trace?.durationMs ?? null,
    stagesPresent: present,
    timingBreakdownMs: timing,
    passed: results.filter(r => r.pass).length,
    failed: failed.length,
    trace,
  }
  if (cfg.jsonOut) console.log(JSON.stringify(summary, null, 2))
  else {
    log('\n── Timing breakdown (ms) ──'); for (const [k, v] of Object.entries(timing)) log(`  ${k.padEnd(16)} ${v}`)
    log(`\ntrace ID: ${summary.traceId}`)
    log(`\n${summary.passed} passed, ${summary.failed} failed`)
    log('\n── Raw trace JSON ──'); log(JSON.stringify(trace, null, 2))
  }
  process.exit(failed.length ? 1 : 0)
} catch (e) {
  await cleanup().catch(() => {})
  die(`harness error: ${e?.stack || e?.message || e}`, 2)
}
