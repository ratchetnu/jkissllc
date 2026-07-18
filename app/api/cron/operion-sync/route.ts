import { NextRequest, NextResponse } from 'next/server'
import { isEnabled } from '../../../lib/platform/flags'
import { reconcileAll } from '../../../lib/platform/sync/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/cron/operion-sync — scheduled multi-product reconciliation so the Update
// Center always reflects live GitHub/Vercel state. CRON_SECRET bearer (Vercel injects it),
// fail-closed. Inert unless OPERION_SYNC_STATUS_ENABLED is on. READ-ONLY against providers:
// it writes nothing to any repository or deployment.
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  return !!secret && req.headers.get('authorization') === `Bearer ${secret}`
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!isEnabled('OPERION_SYNC_STATUS_ENABLED')) {
    return NextResponse.json({ ok: true, skipped: 'sync status disabled' })
  }
  const result = await reconcileAll('cron', { now: Date.now() })
  return NextResponse.json({ ok: true, ...result })
}
