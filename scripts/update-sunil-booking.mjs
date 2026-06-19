// Update Sunil's booking (JK-B-1001): collect-in-person, 1-hour arrival windows,
// and ensure the $150 deposit is recorded as a confirmed Zelle payment.
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

function loadEnv(p) {
  const o = {}
  for (const l of readFileSync(p, 'utf8').split('\n')) {
    const m = l.match(/^([A-Z_]+)=(.*)$/); if (!m) continue
    let v = m[2].trim(); if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    o[m[1]] = v
  }
  return o
}
const env = loadEnv(new URL('../.env.production.local', import.meta.url).pathname)
const URL_ = env.KV_REST_API_URL, TOKEN = env.KV_REST_API_TOKEN
async function call(args) {
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args.map(String)) })
  const j = await r.json(); if (j.error) throw new Error(j.error); return j.result
}

const TOKENV = '363a33b74cf44282b6967399c6e652a4dd1e50d9d7704183b338f817ffdb70d4'
const raw = await call(['GET', `bk:${TOKENV}`])
if (!raw) { console.error('booking not found'); process.exit(1) }
const b = JSON.parse(raw)

b.collectInPerson = true
b.availableWindows = ['8am–9am', '9am–10am', '10am–11am', '11am–12pm', '12pm–1pm', '1pm–2pm', '2pm–3pm', '3pm–4pm', '4pm–5pm', '5pm–6pm']

// Ensure a confirmed Zelle deposit of $150 exists.
b.payments = Array.isArray(b.payments) ? b.payments : []
let dep = b.payments.find(p => p.amountCents === 15000)
const now = Date.now()
if (dep) {
  dep.method = 'zelle'; dep.type = 'deposit'; dep.status = 'confirmed'
  dep.confirmedAt = dep.confirmedAt || now
  dep.note = (dep.note ? dep.note + ' · ' : '') + 'Deposit paid via Zelle'
} else {
  b.payments.push({
    id: randomUUID(), type: 'deposit', method: 'zelle', status: 'confirmed',
    amountCents: 15000, feeCents: 0, totalChargedCents: 15000, netCents: 15000,
    note: 'Deposit paid via Zelle', createdAt: now, confirmedAt: now,
  })
}
// Recompute amountPaid from confirmed payments.
b.amountPaidCents = b.payments.filter(p => p.status === 'confirmed').reduce((s, p) => s + p.netCents, 0)
b.updatedAt = now

await call(['SET', `bk:${TOKENV}`, JSON.stringify(b)])
await call(['ZADD', 'bk:index', String(now), TOKENV])

console.log('Updated Sunil.')
console.log('collectInPerson:', b.collectInPerson)
console.log('windows:', b.availableWindows.join(', '))
console.log('amountPaid:', b.amountPaidCents, 'balance:', b.invoiceAmountCents - b.amountPaidCents)
console.log('payments:', b.payments.map(p => `${p.method}/${p.type}/${p.status}/$${p.amountCents / 100}`).join(' | '))
