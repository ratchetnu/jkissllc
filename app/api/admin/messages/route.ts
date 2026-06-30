// Admin: customer-message inbox API. GET lists/filters/searches; PATCH marks a
// message read / unread / archived, sets a review state, attaches an unmatched
// message to a booking, or dismisses it as not-customer. Admin-only.

import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '../_lib/session'
import {
  listRecent, listUnread, markRead, markUnread, archiveMessage, setReviewState,
  attachToBooking, dismissAsNotCustomer, unreadCount,
  type Message, type MsgReviewState,
} from '../../../lib/messages'
import { getBookingByToken } from '../../../lib/bookings'

const REVIEW_STATES = new Set<MsgReviewState>(['needs_reply', 'customer_responded', 'waiting_on_customer', 'resolved'])

export async function GET(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const sp = new URL(req.url).searchParams
  const tab = sp.get('tab') || 'unread'                  // unread | all | archived
  const channel = sp.get('channel') || ''                // sms | email
  const booking = sp.get('booking') || ''                // booking token
  const matched = sp.get('matched') || ''                // '1' matched | '0' unmatched
  const phone = sp.get('phone') || ''                    // exact e164 (thread fetch)
  const email = (sp.get('email') || '').toLowerCase()    // exact email (thread fetch)
  const q = (sp.get('q') || '').trim().toLowerCase()

  let items: Message[] = tab === 'unread' ? await listUnread(300) : await listRecent(500)
  items = items.filter(m => (tab === 'archived' ? m.status === 'archived' : m.status !== 'archived'))
  if (channel) items = items.filter(m => m.channel === channel)
  if (booking) items = items.filter(m => m.bookingToken === booking)
  if (matched === '1') items = items.filter(m => !!m.bookingToken)
  if (matched === '0') items = items.filter(m => !m.bookingToken)
  if (phone) items = items.filter(m => m.customerPhone === phone || m.from === phone || m.to === phone)
  if (email) items = items.filter(m => (m.customerEmail || '').toLowerCase() === email || (m.from || '').toLowerCase() === email || (m.to || '').toLowerCase() === email)
  if (q) {
    items = items.filter(m =>
      [m.body, m.customerName, m.customerPhone, m.customerEmail, m.bookingNumber, m.from, m.subject]
        .some(v => (v || '').toLowerCase().includes(q)),
    )
  }
  return NextResponse.json({ items, unread: await unreadCount() })
}

export async function PATCH(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const id = typeof body.id === 'string' ? body.id : ''
  const action = typeof body.action === 'string' ? body.action : ''
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  let m: Message | null = null
  if (action === 'read') m = await markRead(id)
  else if (action === 'unread') m = await markUnread(id)
  else if (action === 'archive') m = await archiveMessage(id)
  else if (action === 'not_customer') m = await dismissAsNotCustomer(id)
  else if (action === 'review' && REVIEW_STATES.has(body.reviewState)) m = await setReviewState(id, body.reviewState as MsgReviewState)
  else if (action === 'attach') {
    const token = typeof body.bookingToken === 'string' ? body.bookingToken : ''
    if (!token) return NextResponse.json({ error: 'bookingToken required' }, { status: 400 })
    const bk = await getBookingByToken(token)
    if (!bk) return NextResponse.json({ error: 'booking not found' }, { status: 404 })
    m = await attachToBooking(id, {
      token: bk.token, bookingNumber: bk.bookingNumber, customerName: bk.customerName,
      customerPhone: bk.customerPhone, customerEmail: bk.customerEmail,
    })
  }
  else return NextResponse.json({ error: 'unknown action' }, { status: 400 })

  if (!m) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ message: m, unread: await unreadCount() })
}
