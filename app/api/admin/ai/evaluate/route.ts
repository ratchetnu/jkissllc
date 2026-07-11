import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '../../_lib/session'
import { runEval } from '../../../../lib/ai/eval'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

// POST /api/admin/ai/evaluate — run the deterministic quality-regression suite over
// the golden fixtures (no model calls, no cost). Returns a per-feature pass/fail
// report. This is the same engine the pre-deploy regression test runs, exposed as an
// on-demand check operators can trigger from the Control Center. Read-only.
export async function POST(req: NextRequest) {
  const who = await requirePermission(req, 'ai:analytics')
  if (who instanceof NextResponse) return who
  try {
    const report = runEval(Date.now())
    return NextResponse.json({ ok: true, report })
  } catch (e) {
    console.error('[ai/evaluate]', e)
    return NextResponse.json({ error: 'Evaluation failed to run.' }, { status: 500 })
  }
}
