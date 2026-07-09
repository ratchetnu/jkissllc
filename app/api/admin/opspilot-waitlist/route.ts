import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '../_lib/session'
import { listWaitlist, waitlistCount } from '../../../lib/opspilot-waitlist'

// Read-only view of the OpsPilot early-access captures. The public form
// (/api/opspilot/waitlist) is the only writer; this just surfaces what it saved
// so leads are visible even if a Resend notification was missed.
export async function GET(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const [items, count] = await Promise.all([listWaitlist(), waitlistCount()])
    return NextResponse.json({ ok: true, items, count })
  } catch {
    return NextResponse.json({ error: 'Could not load the waitlist.' }, { status: 500 })
  }
}
