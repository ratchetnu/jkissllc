import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '../../_lib/session'
import { deleteClientPortal } from '../../../../lib/client-portal'

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { token } = await params
  await deleteClientPortal(token)
  return NextResponse.json({ ok: true })
}
