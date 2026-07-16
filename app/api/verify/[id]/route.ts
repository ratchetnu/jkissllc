import { NextRequest, NextResponse } from 'next/server'
import { getStatement } from '../../../lib/pay-statements'
import { publicStatement } from '../../../lib/pay-statement-view'
import { COMPANY } from '../../../lib/company'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/verify/[id] — PUBLIC authenticity check for a contractor pay statement. The id is
// the opaque ps_<uuid> (not enumerable). Returns ONLY non-sensitive confirmation fields —
// statement number, business, period, issued date, status, contractor initials — never
// amounts or the full name. Confirms the document a contractor shares with a lender is real.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const s = await getStatement(id)
  if (!s) return NextResponse.json({ verified: false, reason: 'No statement matches this code.' }, { status: 404 })
  return NextResponse.json({ verified: s.status !== 'void', statement: publicStatement(s, COMPANY.legalName) })
}
