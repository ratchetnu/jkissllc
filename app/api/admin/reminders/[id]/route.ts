import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '../../_lib/session'
import { getReminder, saveReminder, deleteReminder, listInstancesForReminder } from '../../../../lib/reminders'
import { recordAudit } from '../../../../lib/audit'
import { parseReminderInput } from '../route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const S = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const who = await requirePermission(req, 'reminders:view')
  if (who instanceof NextResponse) return who
  const { id } = await params
  const reminder = await getReminder(id)
  if (!reminder) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const instances = await listInstancesForReminder(id, 200)
  return NextResponse.json({ reminder, instances })
}

// PATCH handles lifecycle actions (pause/resume/archive/unarchive/activate) and full
// edits. `action` selects a lifecycle transition; otherwise the body is re-validated
// as a full reminder edit.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const who = await requirePermission(req, 'reminders:manage')
  if (who instanceof NextResponse) return who
  const { id } = await params
  const reminder = await getReminder(id)
  if (!reminder) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const action = S(body.action, 30)

  if (action) {
    switch (action) {
      case 'pause': reminder.paused = true; break
      case 'resume': reminder.paused = false; break
      case 'archive': reminder.archived = true; reminder.active = false; break
      case 'unarchive': reminder.archived = false; break
      case 'activate': reminder.active = true; break
      case 'deactivate': reminder.active = false; break
      default: return NextResponse.json({ error: 'unknown_action' }, { status: 400 })
    }
    await saveReminder(reminder)
    const auditAction = action === 'pause' ? 'reminder.paused' : action === 'resume' ? 'reminder.resumed' : action === 'archive' ? 'reminder.archived' : 'reminder.edited'
    await recordAudit({
      actor: who.sub, actorRole: who.role, action: auditAction,
      entity: 'reminder', entityId: id, summary: `${action} reminder "${reminder.title}"`,
    })
    return NextResponse.json({ reminder })
  }

  // Full edit — re-validate, preserve id/stats/counters/createdAt.
  const parsed = parseReminderInput(body, { sub: reminder.createdBy, role: reminder.createdByRole })
  if (typeof parsed === 'string') return NextResponse.json({ error: parsed }, { status: 400 })
  const merged = {
    ...reminder,
    ...parsed,
    id: reminder.id,
    stats: reminder.stats,
    createdAt: reminder.createdAt,
    createdBy: reminder.createdBy,
    createdByRole: reminder.createdByRole,
    archived: reminder.archived,
  }
  await saveReminder(merged)
  await recordAudit({
    actor: who.sub, actorRole: who.role, action: 'reminder.edited',
    entity: 'reminder', entityId: id, summary: `Edited reminder "${merged.title}"`,
  })
  return NextResponse.json({ reminder: merged })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const who = await requirePermission(req, 'reminders:manage')
  if (who instanceof NextResponse) return who
  const { id } = await params
  const reminder = await getReminder(id)
  await deleteReminder(id)
  await recordAudit({
    actor: who.sub, actorRole: who.role, action: 'reminder.deleted',
    entity: 'reminder', entityId: id, summary: `Deleted reminder "${reminder?.title ?? id}"`,
  })
  return NextResponse.json({ ok: true })
}
