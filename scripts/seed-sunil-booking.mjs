// One-time seed: create the first real booking (Sunil's move) from invoice
// INV-2026-0616. Idempotent — re-running reuses the same booking via a marker key.
// Reads KV creds from .env.production.local (pulled via `vercel env pull`).
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

function loadEnv(path) {
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

const env = loadEnv(new URL('../.env.production.local', import.meta.url).pathname)
const URL_ = env.KV_REST_API_URL
const TOKEN = env.KV_REST_API_TOKEN
if (!URL_ || !TOKEN) { console.error('Missing KV creds'); process.exit(1) }

async function call(args) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args.map(String)),
  })
  const j = await res.json()
  if (j.error) throw new Error(j.error)
  return j.result
}

const MARKER = 'bk:seed:sunil-inv-2026-0616'

const existing = await call(['GET', MARKER])
if (existing) {
  const raw = await call(['GET', `bk:${existing}`])
  const b = JSON.parse(raw)
  console.log('Already seeded.')
  console.log('TOKEN=' + existing)
  console.log('BOOKING_NUMBER=' + b.bookingNumber)
  console.log('URL=https://www.jkissllc.com/booking/' + existing)
  process.exit(0)
}

const n = await call(['INCR', 'bk:counter'])
const token = (randomUUID() + randomUUID()).replace(/-/g, '')
const now = Date.now()

const booking = {
  token,
  bookingNumber: `JK-B-${1000 + n}`,
  customerName: 'Sunil',
  customerPhone: '(214) 228-2810',
  customerEmail: undefined,
  invoiceNumber: 'INV-2026-0616',
  invoiceDate: 'June 16, 2026',
  serviceType: 'moving',
  pickupAddress: '4612 Pine Brook Dr, Plano, TX',
  dropoffAddress: '956 Jim Cannon Rd, Van Alstyne, TX',
  jobSiteAddress: undefined,
  description: 'Local Moving Service — Plano, TX to Van Alstyne, TX. Loading, transport, and unloading. 2-person team, approx. 5 hours. Flat rate includes all travel and fuel costs — no additional charges.',
  items: ['Approx. 40 boxes', 'Refrigerator', 'Dresser', 'Couch', 'Grill'],
  invoiceAmountCents: 55000,
  depositAmountCents: 15000,
  amountPaidCents: 0,
  crewSize: 2,
  estimatedHours: 5,
  availableDates: ['2026-06-26'],
  availableWindows: ['8am–10am', '10am–12pm', '12pm–2pm', '2pm–4pm', '4pm–6pm'],
  selectedDate: undefined,
  selectedWindow: undefined,
  internalNotes: 'Seeded from invoice INV-2026-0616. Deposit $150 due via Zelle; mark deposit paid once received.',
  status: 'booking_created',
  payments: [],
  createdAt: now,
  updatedAt: now,
}

await call(['SET', `bk:${token}`, JSON.stringify(booking)])
await call(['SET', `bk:num:${booking.bookingNumber.toUpperCase()}`, token])
await call(['ZADD', 'bk:index', String(now), token])
await call(['SET', MARKER, token])

console.log('Seeded booking.')
console.log('TOKEN=' + token)
console.log('BOOKING_NUMBER=' + booking.bookingNumber)
console.log('URL=https://www.jkissllc.com/booking/' + token)
