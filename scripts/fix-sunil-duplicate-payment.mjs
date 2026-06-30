// One-off correction: Sunil's booking double-counted the $150 deposit.
// The admin recorded the deposit AND confirmed the customer's "I sent payment"
// notice for the same $150, so Amount Paid showed $300 instead of $150.
//
// This removes ONLY the duplicate customer-originated record (type 'partial',
// $150, confirmed) and keeps the legitimate 'deposit' record, then recomputes
// amountPaidCents the same way the app does (sum of confirmed netCents).
//
// Dry-run by default. Pass --apply to write the change.
import { readFileSync } from 'node:fs'

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
async function call(a) {
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(a.map(String)) })
  const j = await r.json(); if (j.error) throw new Error(j.error); return j.result
}
const usd = c => `$${(c / 100).toFixed(2)}`

const T = '363a33b74cf44282b6967399c6e652a4dd1e50d9d7704183b338f817ffdb70d4'
const apply = process.argv.includes('--apply')

const b = JSON.parse(await call(['GET', `bk:${T}`]))
console.log(`Booking ${b.bookingNumber} — ${b.customerName}`)
console.log(`  Invoice ${usd(b.invoiceAmountCents)} · Deposit ${usd(b.depositAmountCents)} · Amount Paid ${usd(b.amountPaidCents)} · Balance ${usd(Math.max(0, b.invoiceAmountCents - b.amountPaidCents))}`)
console.log('  Payments:')
for (const p of b.payments) console.log(`   - id=${p.id.slice(0, 8)} ${usd(p.amountCents)} · ${p.method} · ${p.type} · ${p.status}${p.note ? ` · "${p.note}"` : ''}`)

// The real payment is the customer's $150 Zelle (type 'partial'). The phantom
// 'deposit' record is the duplicate — remove it, keep the customer's payment.
const dupIdx = b.payments.findIndex(p => p.status === 'confirmed' && p.type === 'deposit' && p.amountCents === 15000)
const keepsReal = b.payments.some(p => p.status === 'confirmed' && p.type === 'partial' && p.amountCents === 15000)

if (dupIdx === -1) { console.log('\nNo confirmed $150 "deposit" duplicate found — nothing to do.'); process.exit(0) }
if (!keepsReal) { console.log('\nNo customer $150 "partial" payment to keep — aborting out of caution.'); process.exit(1) }

const removed = b.payments[dupIdx]
const keep = b.payments.find(p => p.status === 'confirmed' && p.type === 'partial' && p.amountCents === 15000)
const confirmedAfter = b.payments.filter((_, i) => i !== dupIdx).filter(p => p.status === 'confirmed').reduce((s, p) => s + p.netCents, 0)
console.log(`\nWill remove: id=${removed.id.slice(0, 8)} ${usd(removed.amountCents)} ${removed.type}`)
console.log(`Will keep & relabel as deposit: id=${keep.id.slice(0, 8)} ${usd(keep.amountCents)} ${keep.type} -> deposit`)
console.log(`Amount Paid: ${usd(b.amountPaidCents)} -> ${usd(confirmedAfter)} · Balance Due -> ${usd(Math.max(0, b.invoiceAmountCents - confirmedAfter))}`)

if (!apply) { console.log('\nDRY RUN — re-run with --apply to write.'); process.exit(0) }

b.payments.splice(dupIdx, 1)
keep.type = 'deposit' // the customer's $150 Zelle IS the deposit required at booking
b.amountPaidCents = confirmedAfter
const stamp = new Date().toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
b.internalNotes = `${b.internalNotes ? b.internalNotes + '\n' : ''}[${stamp}] Voided duplicate payment: ${usd(removed.amountCents)} · ${removed.method} · ${removed.type} · ${removed.status} — phantom record; only the customer's $150 Zelle (partial) was actually paid (corrected via script).`
b.updatedAt = Date.now()
await call(['SET', `bk:${T}`, JSON.stringify(b)])
await call(['ZADD', 'bk:index', String(b.updatedAt), T])
console.log(`\n✓ Applied. Amount Paid is now ${usd(b.amountPaidCents)}, Balance Due ${usd(Math.max(0, b.invoiceAmountCents - b.amountPaidCents))}.`)
