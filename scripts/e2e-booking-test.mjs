// End-to-end smoke test against production. Creates a throwaway booking, walks
// the full customer + admin flow, asserts each step, then deletes it.
import { readFileSync } from 'node:fs'

function loadEnv(path) {
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/); if (!m) continue
    let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}
const env = loadEnv(new URL('../.env.production.local', import.meta.url).pathname)
const BASE = 'https://www.jkissllc.com'
let cookie = ''
let pass = 0, fail = 0
function ok(name, cond, detail = '') { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`) }

async function j(method, path, body, opts = {}) {
  const res = await fetch(BASE + path, {
    method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const setc = res.headers.get('set-cookie'); if (setc && opts.captureCookie) cookie = setc.split(';')[0]
  let data = null; const txt = await res.text(); try { data = JSON.parse(txt) } catch { data = txt }
  return { status: res.status, data }
}

// 1. Admin auth
let r = await j('POST', '/api/admin/auth', { password: env.ADMIN_PASSWORD }, { captureCookie: true })
ok('admin auth', r.status === 200 && r.data.valid && cookie.includes('jk_admin_session'), `status ${r.status}`)

// 2. Unauthorized check (no cookie)
const saved = cookie; cookie = ''
r = await j('GET', '/api/admin/bookings')
ok('admin API rejects unauthed', r.status === 401, `status ${r.status}`)
cookie = saved

// 3. Create booking
r = await j('POST', '/api/admin/bookings', {
  customerName: 'E2E TEST (auto-deleted)', serviceType: 'junk-removal',
  invoiceNumber: 'E2E-TEST', invoiceAmount: '300', depositAmount: '100',
  jobSiteAddress: '123 Test St, Dallas, TX', items: 'Old couch\nMattress',
  availableDates: '2026-07-01\n2026-07-02', availableWindows: '8am–10am\n10am–12pm',
})
const token = r.data?.booking?.token
ok('create booking', r.status === 200 && !!token, `status ${r.status}`)
if (!token) { console.log('aborting — no token'); process.exit(1) }

// 4. Customer GET (marks viewed) + policy present
r = await j('GET', `/api/booking/${token}`)
ok('customer fetch + policy', r.status === 200 && r.data.booking && r.data.policy?.text?.length > 50, `status ${r.status}`)
ok('internal notes hidden from customer', r.status === 200 && r.data.booking.internalNotes === undefined && r.data.booking.agreementIp === undefined)

// 5. Verify requires agreement
r = await j('POST', `/api/booking/${token}/verify`, { selectedDate: '2026-07-01', selectedWindow: '8am–10am', agreementAccepted: false })
ok('verify blocked without agreement', r.status === 400, `status ${r.status}`)

// 6. Verify rejects bad date
r = await j('POST', `/api/booking/${token}/verify`, { selectedDate: '2026-12-31', selectedWindow: '8am–10am', agreementAccepted: true })
ok('verify rejects unavailable date', r.status === 400, `status ${r.status}`)

// 7. Verify success
r = await j('POST', `/api/booking/${token}/verify`, {
  selectedDate: '2026-07-01', selectedWindow: '10am–12pm', agreementAccepted: true,
  gateCode: '#4242', parkingNotes: 'Driveway', accessNotes: 'Garage', customerPhone: '214-555-0100',
})
ok('verify success → time_verified', r.status === 200 && r.data.booking.status === 'time_verified', `status ${r.status} state ${r.data?.booking?.status}`)

// 8. Confirmation record HTML
r = await fetch(BASE + `/api/booking/${token}/confirmation`)
const confHtml = await r.text()
ok('confirmation record renders', r.status === 200 && confHtml.includes('BOOKING CONFIRMATION') && confHtml.includes('Policy Version'), `status ${r.status}`)

// 9. Stripe pay → graceful 503 (no keys configured)
r = await j('POST', `/api/booking/${token}/pay`, { kind: 'full' })
ok('pay endpoint graceful w/o Stripe', r.status === 503, `status ${r.status}`)

// 10. Manual payment (customer reports)
r = await j('POST', `/api/booking/${token}/manual-payment`, { amount: '100', method: 'zelle', reference: 'TEST123' })
ok('manual payment reported', r.status === 200, `status ${r.status}`)

// 11. Admin confirms the pending payment → becomes confirmed; booking → confirmed (time already verified)
r = await j('GET', `/api/admin/bookings/${token}`)
const pendingId = r.data?.booking?.payments?.find(p => p.status === 'sent_by_customer')?.id
r = await j('PATCH', `/api/admin/bookings/${token}`, { action: 'confirm-payment', paymentId: pendingId })
ok('admin confirm payment → booking confirmed', r.status === 200 && r.data.booking.status === 'confirmed' && r.data.booking.amountPaidCents === 10000, `state ${r.data?.booking?.status} paid ${r.data?.booking?.amountPaidCents}`)

// 12. Mark paid in full
r = await j('PATCH', `/api/admin/bookings/${token}`, { action: 'mark-paid-full', method: 'cash' })
ok('mark paid in full', r.status === 200 && r.data.booking.amountPaidCents === 30000, `paid ${r.data?.booking?.amountPaidCents}`)

// 13. Send confirmation link (no email/phone provider → channels false but no error)
r = await j('PATCH', `/api/admin/bookings/${token}`, { action: 'send-link' })
ok('send-link action', r.status === 200 && r.data.channels !== undefined, `status ${r.status}`)

// 14. CSV export
r = await fetch(BASE + '/api/admin/bookings/export?filter=all', { headers: { Cookie: cookie } })
const csv = await r.text()
ok('CSV export', r.status === 200 && csv.includes('Booking #') && csv.includes('E2E-TEST'), `status ${r.status}`)

// 15. Policy GET + version bump
r = await j('GET', '/api/admin/policy')
ok('policy GET', r.status === 200 && r.data.current?.text?.length > 50, `status ${r.status}`)

// 16. Cleanup — delete test booking
r = await fetch(BASE + `/api/admin/bookings/${token}`, { method: 'DELETE', headers: { Cookie: cookie } })
ok('delete test booking', r.status === 200, `status ${r.status}`)
r = await j('GET', `/api/booking/${token}`)
ok('deleted booking is gone', r.status === 404, `status ${r.status}`)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
