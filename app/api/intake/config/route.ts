import { NextRequest, NextResponse } from 'next/server'
import { resolveIntakeConfig, DEFAULT_PACK_ID } from '../../../lib/intake-config'

// Public: the intake configuration (services, questions, pricing method) for the
// current tenant's industry pack. The Book Now wizard reads this so its steps come
// from the vertical's pack, not hard-coded logic. Single-vertical today (reference
// pack); host/subdomain → tenant → pack resolution comes with multi-tenant rollout.
export async function GET(req: NextRequest) {
  const packId = req.nextUrl.searchParams.get('pack') || DEFAULT_PACK_ID
  const config = resolveIntakeConfig(packId)
  return NextResponse.json({ config })
}
