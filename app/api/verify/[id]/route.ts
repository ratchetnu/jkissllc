import { NextRequest, NextResponse } from 'next/server'
import { withPublicTokenRoute } from '../../../lib/platform/tenancy/with-public-token-route'
import { getStatement } from '../../../lib/pay-statements'
import { publicStatement } from '../../../lib/pay-statement-view'
import { COMPANY } from '../../../lib/company'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/verify/[id] — PUBLIC authenticity check for a contractor pay statement. The id is
// the opaque ps_<uuid> (not enumerable). Returns ONLY non-sensitive confirmation fields —
// statement number, business, period, issued date, status, contractor initials — never
// amounts or the full name. Confirms the document a contractor shares with a lender is real.
// WAVE 6D-B — the opaque ps_ id is the public capability (owner decision 2), so the
// binding is looked up by the id itself and every existing printed/emailed link keeps
// working. `param: 'id'` because this route's segment is [id], not [token].
export const GET = withPublicTokenRoute<{ id: string }>(async (_req: NextRequest, { params }) => {
  const { id } = await params
  const s = await getStatement(id)
  if (!s) return NextResponse.json({ verified: false, reason: 'No statement matches this code.' }, { status: 404 })
  return NextResponse.json({ verified: s.status !== 'void', statement: publicStatement(s, COMPANY.legalName) })
}, { param: 'id', expect: 'pay-statement' })
