// Business-requirement demonstration (no Redis): ONE date holds a Book Now
// junk-removal job, a manual moving job, a contract route, a pending Book Now
// request, an assigned job, and an unassigned job — all visible in one day view.
// Also runs the reconciliation dry-run over a small booking set. Run:
//   npx tsx scripts/demo-unified-schedule.ts
import type { Booking } from '../app/lib/bookings'
import type { RouteRecord } from '../app/lib/routes'
import { mergeSchedule, itemsForDay } from '../app/lib/schedule/unified'
import { detectConflicts } from '../app/lib/schedule/conflicts'
import { reconcile, RECON_CLASS_LABEL, type ReconClass } from '../app/lib/schedule/reconcile'

const DAY = '2026-07-20'
let n = 5000
const bk = (o: Partial<Booking>): Booking => ({
  token: `bk${n++}`.padEnd(16, '0'), bookingNumber: `JK-B-${n}`, customerName: 'Customer',
  serviceType: 'junk-removal', items: [], invoiceAmountCents: 0, depositAmountCents: 0,
  amountPaidCents: 0, availableDates: [], availableWindows: [], status: 'quote_received',
  payments: [], source: 'online', createdAt: 1, updatedAt: 1, ...o,
} as Booking)
const rt = (o: Partial<RouteRecord>): RouteRecord => ({
  token: `rt${n++}`.padEnd(16, '0'), routeNumber: `JK-R-${n}`, status: 'assigned',
  businessName: 'Business', reportAddress: 'Addr', reportTime: '7:00 AM', routeDate: DAY,
  events: [], audit: [], createdAt: 1, updatedAt: 1, ...o,
} as RouteRecord)

// ── The six required item types, all on DAY ──────────────────────────────────
const bookings: Booking[] = [
  bk({ bookingNumber: 'JK-B-2001', customerName: 'Alicia Ross', serviceType: 'junk-removal', source: 'online',
    status: 'confirmed', selectedDate: DAY, selectedWindow: '9:00 AM', jobSiteAddress: '123 Oak Ave',
    assignedTo: 'Marcus', invoiceAmountCents: 38000, amountPaidCents: 19000, depositAmountCents: 19000,
    bookNow: { loadSizeLabel: 'Half Truck' } }),                                     // Book Now junk-removal
  bk({ bookingNumber: 'JK-B-2002', customerName: 'David Kim', serviceType: 'moving', source: 'admin',
    status: 'confirmed', selectedDate: DAY, selectedWindow: '9:30 AM', jobSiteAddress: '50 Elm St',
    assignedTo: 'Marcus', assignedHelper: 'Tony', invoiceAmountCents: 72000, amountPaidCents: 72000 }), // manual moving (+crew clash on Marcus)
  bk({ bookingNumber: 'JK-B-2003', customerName: 'Priya N', serviceType: 'appliance-delivery', source: 'admin',
    status: 'confirmed', selectedDate: DAY, selectedWindow: '1:00 PM', jobSiteAddress: '9 Pine Rd',
    assignedTo: 'Priya', invoiceAmountCents: 15000, amountPaidCents: 0 }),           // assigned job
  bk({ bookingNumber: 'JK-B-2004', customerName: 'Unassigned Uma', serviceType: 'junk-removal', source: 'online',
    status: 'confirmed', selectedDate: DAY, selectedWindow: '11:00 AM', jobSiteAddress: '77 Birch Ln',
    invoiceAmountCents: 28000, amountPaidCents: 14000, depositAmountCents: 14000 }), // unassigned job (no crew)
  bk({ bookingNumber: 'JK-B-2005', customerName: 'Tentative Tim', serviceType: 'estate-cleanout', source: 'online',
    status: 'quote_received', bookNow: { requestedDate: DAY, loadSizeLabel: 'Full Truck' } }), // pending Book Now request
]
const routes: RouteRecord[] = [
  rt({ routeNumber: 'JK-R-1001', businessName: 'Amazon DSP', reportAddress: '1 Commerce St',
    reportTime: '7:00 AM', routeDate: DAY, vehicle: '26ft Box', equipmentId: 'eq_box_1',
    assignees: [{ staffId: 's_dana', name: 'Dana', token: 't_dana'.padEnd(16, '0'), confirmedAt: 1 }] }), // contract route
]

const items = mergeSchedule({ bookings, routes })
const day = itemsForDay(items, DAY)
const conflicts = detectConflicts(items)

console.log(`\n  UNIFIED OPERATIONS — ${DAY}  (one window, every source)\n`)
const pad = (s: string, w: number) => (s + ' '.repeat(w)).slice(0, w)
console.log('  ' + ['TIME', 'SOURCE', 'STATUS', 'CUSTOMER/BIZ', 'SERVICE', 'CREW', 'VEHICLE', 'PAY'].map((h, i) => pad(h, [8, 10, 12, 16, 14, 14, 10, 10][i])).join(''))
console.log('  ' + '─'.repeat(92))
for (const it of day) {
  console.log('  ' + [
    pad(it.timeLabel || (it.tentative ? 'req.' : '—'), 8),
    pad(it.source, 10),
    pad(it.statusLabel, 12),
    pad(it.title, 16),
    pad(it.serviceLabel, 14),
    pad(it.crew.map(c => c.name).join('+') || 'UNASSIGNED', 14),
    pad(it.vehicle || '—', 10),
    pad(it.paymentState && it.paymentState !== 'n/a' ? it.paymentState : '—', 10),
  ].join(''))
}
console.log(`\n  Lanes: ${day.filter(i => i.lane === 'confirmed').length} confirmed · ${day.filter(i => i.lane === 'pending').length} pending/tentative`)

console.log(`\n  CONFLICTS (deterministic, no AI): ${conflicts.length}`)
for (const c of conflicts) console.log(`   [${c.severity}] ${c.type}: ${c.message}`)

// ── Reconciliation dry-run over a small booking set ──────────────────────────
const reconInput: Booking[] = [
  ...bookings,
  bk({ bookingNumber: 'JK-B-3001', status: 'payment_received', amountPaidCents: 20000 }),     // accepted, unscheduled
  bk({ bookingNumber: 'JK-B-3002', status: 'completed', selectedDate: '2026-07-01' }),         // completed
  bk({ bookingNumber: 'JK-B-3003', status: 'cancelled' }),                                     // cancelled
  bk({ token: 'dupe1'.padEnd(16, '0'), bookingNumber: 'JK-B-3004', customerName: 'Repeat Rae', serviceType: 'moving', status: 'confirmed', selectedDate: '2026-08-02' }),
  bk({ token: 'dupe2'.padEnd(16, '0'), bookingNumber: 'JK-B-3005', customerName: 'Repeat Rae', serviceType: 'moving', status: 'confirmed', selectedDate: '2026-08-02' }),
]
const report = reconcile(reconInput, 1_700_000_000_000)
console.log(`\n  RECONCILIATION DRY-RUN — scanned ${report.total} record(s), wrote 0:`)
for (const cls of Object.keys(report.counts) as ReconClass[]) {
  if (report.counts[cls]) console.log(`   ${String(report.counts[cls]).padStart(3)}  ${RECON_CLASS_LABEL[cls]}`)
}
console.log(`   → ${report.reviewRequired.length} need owner review (never auto-touched)\n`)
