import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '../../_lib/session'
import { TEMPLATES, DISPATCH_ACTIONS, SEGMENT_LABEL, ACK_LABEL } from '../../../../lib/reminder-templates'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The static template catalog, dispatch quick-blasts, segment labels, and ack labels
// the Communication Center UI renders. Read-only.
export async function GET(req: NextRequest) {
  const who = await requirePermission(req, 'reminders:view')
  if (who instanceof NextResponse) return who
  return NextResponse.json({
    templates: TEMPLATES,
    dispatch: DISPATCH_ACTIONS,
    segments: SEGMENT_LABEL,
    ackLabels: ACK_LABEL,
  })
}
