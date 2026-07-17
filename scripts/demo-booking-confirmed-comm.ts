// Proof: confirming a booking records exactly ONE suppressed/test comms-history
// entry with ZERO provider calls, and is idempotent. Run:
//   npx tsx scripts/demo-booking-confirmed-comm.ts
import type { Booking } from '../app/lib/bookings'
import type { CommDeps } from '../app/lib/comms/service'
import { emitBookingConfirmedComm } from '../app/lib/comms/wire-booking-confirmed'

const b: Booking = {
  token: 'demo0000demo0000', bookingNumber: 'JK-B-4242', customerName: 'Alicia Ross',
  customerPhone: '+18175551234', customerEmail: 'alicia@example.com',
  serviceType: 'junk-removal', items: [], invoiceAmountCents: 40000, depositAmountCents: 20000,
  amountPaidCents: 20000, availableDates: [], availableWindows: [], selectedDate: '2026-08-01',
  selectedWindow: '8am–10am', status: 'confirmed', payments: [], source: 'online',
  createdAt: 1, updatedAt: 1,
} as Booking

const ledger: Parameters<CommDeps['record']>[0][] = []
const provider = { sms: 0, email: 0 }
let claimed = false
const deps: Partial<CommDeps> = {
  now: () => 1_700_000_000_000,
  claim: async () => { if (claimed) return false; claimed = true; return true }, // real one-shot idempotency
  record: async (m) => { ledger.push(m); return { id: `rec_${ledger.length}` } },
  sendSms: async () => { provider.sms++; throw new Error('should not be called') },
  sendEmail: async () => { provider.email++; throw new Error('should not be called') },
  isSmsOptedOut: async () => false,
  isEmailOptedOut: async () => false,
  audit: async () => ({}),
}

async function main() {
  console.log('\n  PROOF — BOOKING_CONFIRMED controlled wiring\n')

  const r1 = await emitBookingConfirmedComm(b, {}, deps)
  console.log(`  1st confirmation dispatch:`)
  console.log(`     mode              = ${r1?.mode}`)
  console.log(`     duplicate         = ${r1?.duplicate}`)
  console.log(`     outcome           = ${r1?.outcomes.map(o => `${o.channel}:${o.status}`).join(', ')}`)
  console.log(`     ledger rows total = ${ledger.length}`)
  console.log(`     provider calls    = sms:${provider.sms} email:${provider.email}`)

  const r2 = await emitBookingConfirmedComm(b, {}, deps) // replay same booking
  console.log(`\n  2nd (replayed) dispatch — idempotency:`)
  console.log(`     duplicate         = ${r2?.duplicate}`)
  console.log(`     ledger rows total = ${ledger.length}  (unchanged → exactly one entry per booking)`)

  const row = ledger[0]
  console.log(`\n  The one recorded entry:`)
  console.log(`     channel   = ${row.channel}`)
  console.log(`     status    = ${row.status}   (never "sent")`)
  console.log(`     tags      = [${row.tags?.join(', ')}]`)
  console.log(`     booking   = ${row.bookingNumber}`)

  const pass = ledger.length === 1 && provider.sms === 0 && provider.email === 0 &&
    row.tags?.includes('simulated') && r1?.mode === 'test' && r2?.duplicate === true
  console.log(`\n  RESULT: ${pass ? '✅ exactly ONE suppressed/test entry, ZERO provider calls, idempotent' : '❌ FAILED'}\n`)
  if (!pass) process.exit(1)
}
main().catch(e => { console.error(e); process.exit(1) })
