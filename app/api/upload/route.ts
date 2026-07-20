import { NextRequest, NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import { rateLimit } from '../../lib/rate-limit'
import { isBlockedBot } from '../../lib/botcheck'
import { alert } from '../../lib/alerts'
import { scopeBlobPath, sanitizeBlobSegment } from '../../lib/platform/tenancy/blob-keys'
import { toModelReadableImage, UnreadableImageError } from '../../lib/image-convert'
import { optimizeForModel, type OptimizeMetrics } from '../../lib/image-optimize'
import { imageOptimizationEnabled, resolveImageOptimizeOptions } from '../../lib/ai/image-optimize-config'

export const runtime = 'nodejs'
export const maxDuration = 30

// Tenant-safe physical path for a public quote/booking photo. `scopeBlobPath`
// returns this UNCHANGED while tenancy is off (byte-identical to the legacy
// `quote-photos/<uuid>.<ext>`), and `tenants/<id>/quote-photos/…` once tenancy is
// on (fail-closed if no tenant context). The filename is sanitized so a crafted
// id/ext can never smuggle a path segment or traversal.
export function quotePhotoBlobPath(id: string, ext: string): string {
  return scopeBlobPath(`quote-photos/${sanitizeBlobSegment(`${id}.${ext}`)}`)
}

// The model derivative lives at the deterministic sibling key `<id>.ai.jpg` next to
// the original `<id>.<ext>`, so the AI path can find it from the original URL alone
// (see app/lib/ai/photo-optimize.ts). Same tenancy scoping as the original.
export function aiDerivativeBlobPath(id: string): string {
  return scopeBlobPath(`quote-photos/${sanitizeBlobSegment(`${id}.ai.jpg`)}`)
}

// Best-effort: generate + store the model derivative next to the original. Purely
// additive and fail-soft — ANY failure returns null and the caller still serves the
// original, so optimization can never break an upload. Returns the derivative URL +
// the reduction metrics for measurement, or null when nothing was stored.
async function storeAiDerivative(
  id: string,
  buffer: Buffer,
  contentType: string,
): Promise<{ aiUrl: string; metrics: OptimizeMetrics } | null> {
  try {
    const result = await optimizeForModel(buffer, contentType, resolveImageOptimizeOptions())
    if (!result.metrics.applied) return null // undecodable / no real gain — model reads the original
    const blob = await put(aiDerivativeBlobPath(id), result.buffer, {
      access: 'public', contentType: 'image/jpeg', addRandomSuffix: false,
    })
    return { aiUrl: blob.url, metrics: result.metrics }
  } catch (e) {
    console.error('[upload] ai-derivative skipped', e)
    return null
  }
}

// POST /api/upload — public image upload for the booking/quote flow. Stores a
// data-URL image to Vercel Blob and returns its URL. Rate-limited + bot-protected.
export async function POST(req: NextRequest) {
  if (await rateLimit(req, 'upload', 20, 10 * 60_000)) {
    return NextResponse.json({ error: 'Too many uploads. Please wait a few minutes.' }, { status: 429 })
  }
  if (await isBlockedBot()) return NextResponse.json({ error: 'Upload blocked.' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const image = typeof body.image === 'string' ? body.image : ''
  const m = image.match(/^data:(image\/(jpeg|png|webp|heic|heif));base64,(.+)$/)
  if (!m || image.length > 8_000_000) {
    return NextResponse.json({ error: 'Please attach a clear photo (JPG/PNG, under ~6MB).' }, { status: 400 })
  }
  try {
    const raw = Buffer.from(m[3], 'base64')
    // iPhone HEIC/HEIF → JPEG so the vision model can decode it (an un-converted HEIC
    // reaches the model as an unreadable format → it identifies nothing). Non-HEIC unchanged.
    const { buffer: buf, contentType, ext } = await toModelReadableImage(raw, m[1])
    // Write to the tenant-safe path using the CONVERTED ext/contentType (so a HEIC
    // stored as JPEG lands as .jpg). Path is byte-identical to legacy while tenancy off.
    const id = crypto.randomUUID()
    const blob = await put(quotePhotoBlobPath(id, ext), buf, { access: 'public', contentType, addRandomSuffix: false })

    // Optionally generate + store an optimized derivative NEXT TO the original (never
    // replacing it). Additive + fail-soft: off, undecodable, or on any error we return
    // only the original url and the AI path reads the original. When present, `aiUrl`
    // is the smaller derivative the vision model reads and `optimization` reports the
    // measured token/byte reduction. Backward compatible — `url` is unchanged.
    if (imageOptimizationEnabled()) {
      const derivative = await storeAiDerivative(id, buf, contentType)
      if (derivative) {
        const mx = derivative.metrics
        console.log('[upload] ai-derivative', JSON.stringify({
          bytesBefore: mx.originalBytes, bytesAfter: mx.optimizedBytes, byteReductionPct: mx.byteReductionPct,
          estTokenReductionPct: mx.estTokenReductionPct, dims: `${mx.originalWidth}x${mx.originalHeight}→${mx.optimizedWidth}x${mx.optimizedHeight}`,
          ops: mx.ops,
        }))
        return NextResponse.json({ ok: true, url: blob.url, aiUrl: derivative.aiUrl, optimization: mx })
      }
    }
    return NextResponse.json({ ok: true, url: blob.url })
  } catch (e) {
    if (e instanceof UnreadableImageError) {
      return NextResponse.json({ error: "We couldn't read that photo. Please re-take it or upload a JPG or PNG." }, { status: 400 })
    }
    console.error('[upload]', e)
    await alert({ type: 'upload_failed', severity: 'ERROR', route: '/api/upload', errorClass: e instanceof Error ? e.name : 'blob_put_failed' })
    return NextResponse.json({ error: 'Upload failed — please try again.' }, { status: 500 })
  }
}
