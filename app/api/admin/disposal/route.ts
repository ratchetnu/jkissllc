import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireStaffSession } from '../_lib/session'
import { getDisposalSettings, saveDisposalSettings, type DisposalSettings } from '../../../lib/disposal'

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requireStaffSession(req)
  if (who instanceof NextResponse) return who
  return NextResponse.json({ ok: true, settings: await getDisposalSettings() })
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requireStaffSession(req)
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({})) as Partial<DisposalSettings>
  // Coerce numeric fields safely; ignore anything unexpected.
  const patch: Partial<DisposalSettings> = {}
  const numKeys: (keyof DisposalSettings)[] = [
    'serviceMinimumCents', 'defaultDisposalCents', 'dumpTripCents', 'laborMinCents', 'laborFullLoadCents',
    'perTonCents', 'perCubicYardCents', 'perLoadCents',
    'minDisposalFeePerTripCents', 'truckCapacityCuFt', 'laborRatePerHourCents',
    'landfillRoundTripMinutes', 'unloadMinutesPerTrip', 'equipmentOpPerLoadCents', 'travelToJobCents',
  ]
  for (const k of numKeys) if (body[k] !== undefined) (patch as Record<string, number>)[k] = Math.max(0, Math.round(Number(body[k]) || 0))
  if (body.marginPct !== undefined) patch.marginPct = Math.min(0.9, Math.max(0, Number(body.marginPct) || 0))
  if (body.category) patch.category = { ...(await getDisposalSettings()).category, ...Object.fromEntries(Object.entries(body.category).map(([k, v]) => [k, Math.max(0, Math.round(Number(v) || 0))])) } as DisposalSettings['category']
  if (body.bulkFactor) patch.bulkFactor = { ...(await getDisposalSettings()).bulkFactor, ...Object.fromEntries(Object.entries(body.bulkFactor).map(([k, v]) => [k, Math.min(5, Math.max(0.1, Number(v) || 1))])) } as DisposalSettings['bulkFactor']
  if (body.facility) patch.facility = body.facility
  if (body.showDumpFee !== undefined) patch.showDumpFee = body.showDumpFee === true

  const settings = await saveDisposalSettings(patch)
  return NextResponse.json({ ok: true, settings })
})
