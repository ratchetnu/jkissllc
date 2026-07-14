import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { getInstanceByToken, ackInstance, markInstanceOpened } from '../../../lib/reminders'
import { getMessage, saveMessage } from '../../../lib/messages'
import { ACK_LABEL, type AckKind } from '../../../lib/reminder-templates'
import { recordAudit } from '../../../lib/audit'
import { rateLimit } from '../../../lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALL_ACKS: AckKind[] = ['acknowledged', 'completed', 'calling', 'need_help', 'already_done', 'having_issues', 'unable']

// Public one-tap acknowledgement (request Part 5). The instance token is the
// capability — no login — so a crew member can respond straight from an SMS/email
// link. GET marks it opened + returns what to render; POST records the ack.
export const GET = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ token: string }> }) => {
  const { token } = await params
  const inst = await markInstanceOpened((await getInstanceByToken(token))?.id || '', req.headers.get('user-agent') || undefined)
  if (!inst) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({
    title: inst.title, message: inst.message,
    ackOptions: inst.ackOptions, ackLabels: ACK_LABEL,
    ackedKind: inst.ackKind ?? null, completedAt: inst.completedAt ?? null,
    staffName: inst.staffName, sentAt: inst.sentAt,
  })
})

export const POST = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ token: string }> }) => {
  if (await rateLimit(req, 'ack', 30, 10 * 60_000)) {
    return NextResponse.json({ error: 'Too many requests. Please wait a moment.' }, { status: 429 })
  }
  const { token } = await params
  const existing = await getInstanceByToken(token)
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const kind = body.kind as AckKind
  if (!ALL_ACKS.includes(kind)) return NextResponse.json({ error: 'invalid_ack' }, { status: 400 })

  const inst = await ackInstance(existing.id, kind, req.headers.get('user-agent') || undefined)
  if (!inst) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  // Reflect the ack onto the linked in-app message so the ops Crew thread shows it.
  if (inst.messageId) {
    const m = await getMessage(inst.messageId)
    if (m) { m.crewReadAt = m.crewReadAt || Date.now(); m.crewAckAt = Date.now(); m.crewAckKind = kind; await saveMessage(m) }
  }
  await recordAudit({
    actor: inst.staffId, actorRole: 'crew', action: 'reminder.acknowledged',
    entity: 'reminder_instance', entityId: inst.id,
    summary: `${inst.staffName} responded "${ACK_LABEL[kind]}" to "${inst.title}"`,
    meta: { kind, reminderId: inst.reminderId },
  })
  return NextResponse.json({ ok: true, ackedKind: kind, completed: !!inst.completedAt })
})
