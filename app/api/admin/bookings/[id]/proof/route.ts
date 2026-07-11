import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '../../../_lib/session'
import { getBookingByToken } from '../../../../../lib/bookings'
import { PROOF_PATH_RE, proofMediaType, openProof } from '../../../../../lib/payment-proof'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Admin-only decrypt + serve of a sealed Zelle payment screenshot (request Part 5).
// The blob path is NEVER accepted from the client — it is resolved server-side from
// (booking token, paymentId), which defeats IDOR: an admin can only view a proof
// that actually belongs to the booking they name, and the ciphertext path never
// reaches the browser. Gated on invoices:manage (Owner/Admin). Never cached.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const who = await requirePermission(req, 'invoices:manage')
  if (who instanceof NextResponse) return who

  const { id } = await params
  const b = await getBookingByToken(id)
  if (!b) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const paymentId = req.nextUrl.searchParams.get('p') ?? ''
  const payment = b.payments.find(p => p.id === paymentId)
  const pathname = payment?.proofPath
  // Defense in depth: the path must belong to this payment AND match the sealed
  // proof shape (prefix + this booking's token + .enc), else refuse.
  if (!pathname || !PROOF_PATH_RE.test(pathname) || !pathname.startsWith(`payment-proofs/${b.token}/`)) {
    return NextResponse.json({ error: 'no_proof' }, { status: 404 })
  }

  try {
    const plaintext = await openProof(pathname)
    return new NextResponse(new Uint8Array(plaintext), {
      headers: {
        'Content-Type': proofMediaType(pathname),
        'Cache-Control': 'private, no-store, max-age=0',
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (e) {
    console.error('[admin/bookings/proof]', e)
    return NextResponse.json({ error: 'could_not_read' }, { status: 500 })
  }
}
