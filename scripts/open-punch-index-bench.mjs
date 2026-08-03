// Measures the Redis command cost and wall-clock latency of ONE clock-in
// decision, scan path vs indexed path, at a few history sizes.
//
// Not a test — a measurement harness. Run:
//   node scripts/open-punch-index-bench.mjs [routes] [bookings]
//
// It counts every command that reaches the store by sitting a counting proxy in
// front of the local KV emulator, so the figure is what production would actually
// send to Upstash, not an estimate.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'

const ROUTES = Number(process.argv[2] ?? 200)
const BOOKINGS = Number(process.argv[3] ?? 200)
const KV_PORT = 9400 + (process.pid % 60)
const PROXY_PORT = KV_PORT + 1

process.env.ADMIN_SESSION_SECRET ||= 'test-admin-session-secret-32byteslong!!'
process.env.KV_REST_API_URL = `http://127.0.0.1:${KV_PORT}`
process.env.KV_REST_API_TOKEN = 'x'
process.env.BOOKING_ASSIGNMENT_ENABLED = 'true'
process.env.SINGLE_OPEN_PUNCH_ENABLED = 'true'

const kv = spawn(process.execPath, ['scripts/local-audit/kv-emulator.mjs', '--port', String(KV_PORT)], { stdio: 'ignore' })
for (let i = 0; i < 200; i++) {
  try { if ((await fetch(`http://127.0.0.1:${KV_PORT}/__admin/health`)).ok) break } catch {}
  await sleep(50)
}

let count = 0
let counting = false
const proxy = createServer((req, res) => {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', async () => {
    const body = Buffer.concat(chunks).toString('utf8')
    if (counting) count++
    const up = await fetch(`http://127.0.0.1:${KV_PORT}${req.url ?? '/'}`, {
      method: req.method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
      body: req.method === 'POST' && body ? body : undefined,
    })
    const text = await up.text()
    res.writeHead(up.status, { 'content-type': 'application/json' })
    res.end(text)
  })
})
await new Promise(r => proxy.listen(PROXY_PORT, '127.0.0.1', r))

const { saveRoute } = await import('../app/lib/routes.ts')
const { saveBooking } = await import('../app/lib/bookings.ts')
const { runWithTenant } = await import('../app/lib/platform/tenancy/context.ts')
const { withSingleOpenPunchPolicy } = await import('../app/lib/timeclock/punch-policy.ts')
const { backfillOpenPunchIndex } = await import('../app/lib/timeclock/open-punch-backfill.ts')

const T = fn => runWithTenant({ tenantId: 'jkiss' }, fn)
const DAY = '2030-03-01'
const pad = (n, w = 12) => String(n).padStart(w, '0')

console.log(`seeding ${ROUTES} routes + ${BOOKINGS} bookings ...`)
await T(async () => {
  for (let i = 0; i < ROUTES; i++) {
    await saveRoute({
      token: `r${pad(i, 15)}`, routeNumber: `JK-R-${i}`, businessName: 'Acme',
      routeDate: i % 3 === 0 ? DAY : '2030-04-01', status: 'assigned',
      createdAt: 1, updatedAt: 1, events: [], audit: [],
      assignees: [{ staffId: `s${i % 25}`, name: 'Crew', token: `c${pad(i, 15)}`, confirmedAt: 1 }],
    })
  }
  for (let i = 0; i < BOOKINGS; i++) {
    await saveBooking({
      token: `b${pad(i, 15)}`, bookingNumber: `JK-B-${i}`, customerName: 'C',
      status: 'confirmed', selectedDate: i % 3 === 0 ? DAY : '2030-04-01',
      createdAt: 1, updatedAt: 1, events: [],
      assignees: [{ staffId: `s${i % 25}`, name: 'Crew', token: `k${pad(i, 15)}`, confirmedAt: 1 }],
    })
  }
})

async function measure(label) {
  // Route the app through the counting proxy ONLY for the measured call, so
  // seeding and backfill traffic never inflates the figure.
  process.env.KV_REST_API_URL = `http://127.0.0.1:${PROXY_PORT}`
  count = 0; counting = true
  const t0 = process.hrtime.bigint()
  const r = await T(() => withSingleOpenPunchPolicy('clock_in',
    { type: 'route', jobToken: `r${pad(0, 15)}`, staffId: 's0', serviceDate: DAY },
    async () => 'ok'))
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  counting = false
  process.env.KV_REST_API_URL = `http://127.0.0.1:${KV_PORT}`
  console.log(`${label.padEnd(28)} commands=${String(count).padStart(6)}  ${ms.toFixed(1)} ms  result=${r.ok ? 'allowed' : r.block}`)
  return { count, ms }
}

process.env.OPEN_PUNCH_INDEX_ENABLED = 'false'
const scan = await measure('SCAN path (index off)')

process.env.OPEN_PUNCH_INDEX_ENABLED = 'true'
counting = false
const bf = await T(() => backfillOpenPunchIndex('bench', Date.now()))
console.log(`backfill: ${bf.ok ? `ok, indexed ${bf.marker.openPunchesIndexed} open punches` : `FAILED ${bf.reason}`}`)
const indexed = await measure('INDEXED path (index on)')

console.log(`\nrecords=${ROUTES + BOOKINGS}  commands ${scan.count} -> ${indexed.count}` +
  `  (${(scan.count / Math.max(1, indexed.count)).toFixed(1)}x fewer)`)

proxy.close(); kv.kill('SIGKILL')
process.exit(0)
