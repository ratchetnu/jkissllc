import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '../_lib/session'
import { getDisposalSettings, saveDisposalSettings, type DisposalSettings } from '../../../lib/disposal'

export async function GET(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({ ok: true, settings: await getDisposalSettings() })
}

export async function POST(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({})) as Partial<DisposalSettings>
  // Coerce numeric fields safely; ignore anything unexpected.
  const patch: Partial<DisposalSettings> = {}
  const numKeys: (keyof DisposalSettings)[] = ['serviceMinimumCents', 'defaultDisposalCents', 'dumpTripCents', 'laborMinCents', 'laborFullLoadCents', 'perTonCents', 'perCubicYardCents', 'perLoadCents']
  for (const k of numKeys) if (body[k] !== undefined) (patch as Record<string, number>)[k] = Math.max(0, Math.round(Number(body[k]) || 0))
  if (body.marginPct !== undefined) patch.marginPct = Math.min(0.9, Math.max(0, Number(body.marginPct) || 0))
  if (body.category) patch.category = { ...(await getDisposalSettings()).category, ...Object.fromEntries(Object.entries(body.category).map(([k, v]) => [k, Math.max(0, Math.round(Number(v) || 0))])) } as DisposalSettings['category']
  if (body.facility) patch.facility = body.facility
  if (body.showDumpFee !== undefined) patch.showDumpFee = body.showDumpFee === true

  const settings = await saveDisposalSettings(patch)
  return NextResponse.json({ ok: true, settings })
}
