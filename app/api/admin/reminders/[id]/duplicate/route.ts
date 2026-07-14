import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../../_lib/session'
import { getReminder, createReminder } from '../../../../../lib/reminders'
import { recordAudit } from '../../../../../lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Duplicate a reminder (request Part 7). Copies the rule as a paused draft so the
// admin can tweak before it fires; counters reset.
export const POST = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const who = await requirePermission(req, 'reminders:manage')
  if (who instanceof NextResponse) return who
  const { id } = await params
  const src = await getReminder(id)
  if (!src) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const copy = await createReminder({
    templateId: src.templateId,
    title: `${src.title} (copy)`,
    message: src.message,
    channels: [...src.channels],
    schedule: { ...src.schedule },
    target: { ...src.target },
    requireAck: src.requireAck,
    ackOptions: [...src.ackOptions],
    smartSuppress: src.smartSuppress,
    escalation: src.escalation.map(e => ({ ...e })),
    active: false,
    paused: true,
    archived: false,
    createdBy: who.sub,
    createdByRole: who.role,
    scopeBusinessKeys: src.scopeBusinessKeys ? [...src.scopeBusinessKeys] : undefined,
  })
  await recordAudit({
    actor: who.sub, actorRole: who.role, action: 'reminder.duplicated',
    entity: 'reminder', entityId: copy.id, summary: `Duplicated "${src.title}"`,
    meta: { from: id },
  })
  return NextResponse.json({ reminder: copy }, { status: 201 })
})
