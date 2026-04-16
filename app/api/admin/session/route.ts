import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '../_lib/session'

export async function GET(req: NextRequest) {
  const authed = await requireSession(req)
  return NextResponse.json({ authed })
}
