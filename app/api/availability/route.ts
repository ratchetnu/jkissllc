import { NextResponse } from 'next/server'
import { getAvailability } from '../../lib/availability'

export const dynamic = 'force-dynamic'

// GET /api/availability — open dates customers can book online + the deposit.
export async function GET() {
  try {
    const { dates, depositCents } = await getAvailability(60)
    return NextResponse.json({ ok: true, dates, depositCents })
  } catch {
    return NextResponse.json({ ok: true, dates: [], depositCents: 5000 })
  }
}
