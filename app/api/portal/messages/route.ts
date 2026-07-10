import { NextRequest, NextResponse } from 'next/server'
import { requireCrew } from '../_lib/crew'
import { threadForStaff, recordMessage, markCrewRead, recentForStaff } from '../../../lib/messages'
import { getStaff } from '../../../lib/staff'
import { notifyOwnerOfReply } from '../../../lib/owner-alerts'
import { COMPANY } from '../../../lib/company'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The crew portal inbox (request Part 12, crew side). GET returns this crew member's
// full conversation with dispatch; POST marks-read or sends a reply back to ops.
export async function GET(req: NextRequest) {
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who
  const msgs = await threadForStaff(who.staffId, 300)
  return NextResponse.json({
    messages: msgs.map(m => ({
      id: m.id, direction: m.direction, channel: m.channel, kind: m.kind ?? null,
      subject: m.subject, body: m.body, createdAt: m.createdAt,
      crewReadAt: m.crewReadAt ?? null, crewAckKind: m.crewAckKind ?? null,
    })),
  })
}

export async function POST(req: NextRequest) {
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const action = typeof body.action === 'string' ? body.action : ''

  if (action === 'read') {
    // Mark everything (or one message) as read by this crew member.
    const id = typeof body.id === 'string' ? body.id : ''
    if (id) { await markCrewRead(id) }
    else {
      const recent = await recentForStaff(who.staffId, 150)
      await Promise.all(recent.filter(m => m.direction === 'outbound' && !m.crewReadAt).map(m => markCrewRead(m.id)))
    }
    return NextResponse.json({ ok: true })
  }

  if (action === 'reply') {
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 2000) : ''
    if (!text) return NextResponse.json({ error: 'Message is empty.' }, { status: 400 })
    const staff = await getStaff(who.staffId)
    const name = staff?.name || 'Crew'
    const m = await recordMessage({
      direction: 'inbound', channel: 'note', provider: 'manual', body: text,
      staffId: who.staffId, crewName: name, kind: 'crew_dm', unread: true, status: 'received',
      tags: ['crew_dm'],
    })
    // Alert the ops owner that a crew member replied (reuse the customer-reply alert).
    try {
      await notifyOwnerOfReply({
        via: 'text', customerName: `${name} (crew)`, preview: text.slice(0, 140),
        adminUrl: `${(process.env.NEXT_PUBLIC_SITE_URL || COMPANY.siteUrlApex).replace(/\/$/, '')}/admin/operations/messages`,
      })
    } catch { /* non-fatal */ }
    return NextResponse.json({ ok: true, id: m.id })
  }

  return NextResponse.json({ error: 'unknown_action' }, { status: 400 })
}
