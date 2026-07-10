import { NextRequest, NextResponse } from 'next/server'
import { getPrincipal, type Principal } from '../../admin/_lib/session'

// The crew portal's authorization primitive. Every portal API funnels through this
// so that (a) only a crew principal is admitted and (b) the caller is handed the
// ONE staffId they are allowed to read. Portal handlers must scope every query to
// `who.staffId` — never trust an id from the request body or query string.
export async function requireCrew(req: NextRequest): Promise<(Principal & { staffId: string }) | NextResponse> {
  const who = await getPrincipal(req)
  if (!who) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (who.role !== 'crew' || !who.staffId) {
    return NextResponse.json({ error: 'not_a_crew_account' }, { status: 403 })
  }
  return { ...who, staffId: who.staffId }
}
