import { NextRequest, NextResponse } from 'next/server'
import { requireCrew } from '../_lib/crew'
import { getInstance, ackInstance } from '../../../lib/reminders'
import { getMessage, saveMessage } from '../../../lib/messages'
import { ACK_LABEL, type AckKind } from '../../../lib/reminder-templates'
import { recordAudit } from '../../../lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALL_ACKS: AckKind[] = ['acknowledged', 'completed', 'calling', 'need_help', 'already_done', 'having_issues', 'unable']

// Acknowledge a reminder from inside the authenticated crew portal (request Part 5).
// Scoped: a crew member may only ack an instance addressed to their own staffId.
export async function POST(req: NextRequest) {
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const instanceId = typeof body.instanceId === 'string' ? body.instanceId : ''
  const kind = body.kind as AckKind
  if (!ALL_ACKS.includes(kind)) return NextResponse.json({ error: 'invalid_ack' }, { status: 400 })

  const existing = await getInstance(instanceId)
  if (!existing || existing.staffId !== who.staffId) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const inst = await ackInstance(instanceId, kind, req.headers.get('user-agent') || undefined)
  if (!inst) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (inst.messageId) {
    const m = await getMessage(inst.messageId)
    if (m) { m.crewReadAt = m.crewReadAt || Date.now(); m.crewAckAt = Date.now(); m.crewAckKind = kind; await saveMessage(m) }
  }
  await recordAudit({
    actor: who.staffId, actorRole: 'crew', action: 'reminder.acknowledged',
    entity: 'reminder_instance', entityId: inst.id,
    summary: `${inst.staffName} responded "${ACK_LABEL[kind]}" to "${inst.title}"`,
    meta: { kind, reminderId: inst.reminderId, via: 'portal' },
  })
  return NextResponse.json({ ok: true, ackedKind: kind, completed: !!inst.completedAt })
}
