import { NextRequest, NextResponse } from 'next/server'
import { resolveIntakeConfig, DEFAULT_PACK_ID } from '../../../lib/intake-config'
import { isEnabled } from '../../../lib/platform/flags'

// Public: the intake configuration (services, questions, pricing method) for the
// current tenant's industry pack. The Book Now wizard reads this so its steps come
// from the vertical's pack, not hard-coded logic. Single-vertical today (reference
// pack); host/subdomain → tenant → pack resolution comes with multi-tenant rollout.
//
// Also carries the small set of PRESENTATIONAL client flags the wizard needs. A flag
// absent (older client / flag off) is treated as false, so the response stays
// backward-compatible.
export async function GET(req: NextRequest) {
  const packId = req.nextUrl.searchParams.get('pack') || DEFAULT_PACK_ID
  const config = resolveIntakeConfig(packId)
  const flags = { progressUx: isEnabled('OPERION_PROGRESS_UX') }
  return NextResponse.json({ config, flags })
}
