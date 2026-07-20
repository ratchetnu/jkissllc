// ─────────────────────────────────────────────────────────────────────────────
// AI IMAGE OPTIMIZATION — produce a model-optimized derivative of an uploaded
// photo BEFORE it reaches the vision provider, without ever mutating the original.
//
// Why: iPhone photos arrive at 3–4k px / multi-MB. The vision model is billed by
// image resolution (Claude image tokens ≈ width·height / 750) and every extra byte
// is upload + fetch latency. Downscaling to a long-edge cap + a sane JPEG quality
// typically cuts tokens and bytes by a large factor while leaving the pixels the
// model actually reasons over unchanged — so quote accuracy is preserved.
//
// This module is the PURE transform core. It:
//   • NEVER throws — any decode/encode failure returns the input buffer unchanged
//     with a `skippedReason`, so a bad image can never break an upload or estimate.
//   • Reads no env and no flag — callers decide (via image-optimize-config) which
//     ops to enable. Same input + same options → same output.
//   • Auto-corrects EXIF orientation and strips ALL metadata as a side effect of
//     decode → re-encode (Jimp writes no EXIF back).
//   • Reports the token / byte / pixel reduction it achieved so callers can MEASURE
//     the win (see OptimizeMetrics).
//
// LOW-RISK ops (safe defaults, applied whenever optimization runs): EXIF orient,
// intelligent long-edge resize, JPEG quality, metadata strip.
// HIGHER-RISK ops (each opt-in, default OFF until the shadow eval clears them):
// autocrop (whitespace/border removal), normalize (adaptive brightness+contrast),
// sharpen, denoise. See docs/operations/image-optimization.md.
// ─────────────────────────────────────────────────────────────────────────────

import { Jimp } from 'jimp' // pure-JS/wasm image codec — serverless-safe, no native deps

// The concrete instance type Jimp.read resolves to — using this everywhere avoids
// the "two unrelated types named X" clash from Jimp's heavily-generic method typings.
type JimpImage = Awaited<ReturnType<typeof Jimp.read>>

// The vision provider decodes these; anything else we pass through untouched.
const DECODABLE = new Set(['image/jpeg', 'image/png', 'image/bmp', 'image/tiff', 'image/gif'])

export const DEFAULT_MAX_EDGE = 1280 // long-edge cap (px) — plenty for junk-pile reasoning
export const DEFAULT_QUALITY = 82    // JPEG quality — visually lossless for photos, big byte win
const MIN_RESIZE_EDGE = 320          // never downscale a photo below this long edge

// Sharpen kernel (unsharp-ish 3×3). Applied AFTER resize so it counters downscale softening.
const SHARPEN_KERNEL = [
  [0, -1, 0],
  [-1, 5, -1],
  [0, -1, 0],
]

export type OptimizeOptions = {
  maxEdge?: number       // long-edge cap in px (default DEFAULT_MAX_EDGE)
  quality?: number       // JPEG quality 1..100 (default DEFAULT_QUALITY)
  // Higher-risk ops — each OFF unless explicitly enabled by the caller.
  autocrop?: boolean     // trim uniform whitespace / borders
  normalize?: boolean    // adaptive brightness + contrast normalization (histogram stretch)
  sharpen?: boolean      // mild sharpen (after resize)
  denoise?: boolean      // mild blur to suppress sensor noise
}

export type OptimizeMetrics = {
  applied: boolean            // true only if a real derivative was produced
  skippedReason?: string      // set when applied === false (e.g. 'undecodable', 'no_gain')
  ops: string[]               // ops that actually ran, in order
  originalBytes: number
  optimizedBytes: number
  byteReductionPct: number    // 0..100 (bytes saved / original)
  originalWidth?: number
  originalHeight?: number
  optimizedWidth?: number
  optimizedHeight?: number
  pixelReductionPct?: number  // 0..100
  estTokensBefore?: number    // Claude vision estimate ≈ w·h / 750
  estTokensAfter?: number
  estTokenReductionPct?: number
  processingMs?: number       // wall time spent optimizing (cost, not benefit)
}

export type OptimizeResult = {
  buffer: Buffer
  contentType: string
  ext: string
  metrics: OptimizeMetrics
}

/** Claude vision token estimate for a decoded image. Documented approximation:
 *  tokens ≈ (width_px × height_px) / 750. Returns 0 for degenerate dims. */
export function estimateImageTokens(width?: number, height?: number): number {
  if (!width || !height || width <= 0 || height <= 0) return 0
  return Math.ceil((width * height) / 750)
}

const pct = (from: number, to: number): number =>
  from <= 0 ? 0 : Math.max(0, Math.round(((from - to) / from) * 1000) / 10)

function passthrough(buffer: Buffer, contentType: string, reason: string): OptimizeResult {
  const ct = (contentType || 'image/jpeg').toLowerCase()
  return {
    buffer,
    contentType: ct,
    ext: ct === 'image/jpeg' ? 'jpg' : (ct.split('/')[1] || 'jpg'),
    metrics: {
      applied: false,
      skippedReason: reason,
      ops: [],
      originalBytes: buffer.length,
      optimizedBytes: buffer.length,
      byteReductionPct: 0,
    },
  }
}

/**
 * Produce a model-optimized JPEG derivative of `buffer`. The ORIGINAL buffer is
 * never mutated. On any failure (undecodable format, encode error) the original is
 * returned unchanged with `metrics.applied === false` — callers then send the
 * original to the model, so optimization is always safe to attempt.
 *
 * `decode` is injectable purely for tests; production always uses Jimp.
 */
export async function optimizeForModel(
  buffer: Buffer,
  contentType: string,
  opts: OptimizeOptions = {},
  decode: (buf: Buffer) => Promise<JimpImage> = (buf) => Jimp.read(buf),
): Promise<OptimizeResult> {
  const started = typeof performance !== 'undefined' ? performance.now() : 0
  const ct = (contentType || '').toLowerCase()
  if (!DECODABLE.has(ct)) return passthrough(buffer, contentType, `undecodable_type:${ct || 'unknown'}`)
  if (!buffer?.length) return passthrough(buffer, contentType, 'empty')

  const maxEdge = Math.max(MIN_RESIZE_EDGE, Math.floor(opts.maxEdge ?? DEFAULT_MAX_EDGE))
  const quality = Math.min(100, Math.max(1, Math.floor(opts.quality ?? DEFAULT_QUALITY)))

  let img: JimpImage
  try {
    img = await decode(buffer) // Jimp.read auto-applies EXIF orientation
  } catch (e) {
    return passthrough(buffer, contentType, `decode_failed:${(e as Error)?.name || 'error'}`)
  }

  const ops: string[] = ['orient', 'strip_metadata']
  const originalWidth = img.width
  const originalHeight = img.height

  try {
    // Higher-risk cleanups first (operate on full-res pixels), then resize, then
    // sharpen (which must run AFTER the downscale to be meaningful).
    if (opts.autocrop) { img.autocrop(); ops.push('autocrop') }
    if (opts.normalize) { img.normalize(); ops.push('normalize') } // brightness + contrast stretch

    const longEdge = Math.max(img.width, img.height)
    if (longEdge > maxEdge) {
      img.scaleToFit({ w: maxEdge, h: maxEdge })
      ops.push('resize')
    }

    if (opts.denoise) { img.blur(1); ops.push('denoise') }
    if (opts.sharpen) { img.convolute(SHARPEN_KERNEL); ops.push('sharpen') }
    ops.push('quality')

    const out = await img.getBuffer('image/jpeg', { quality }) as Buffer
    const optimizedWidth = img.width
    const optimizedHeight = img.height
    const processingMs = started ? Math.round((performance.now() - started) * 10) / 10 : undefined

    // Guard: if optimization produced a LARGER file than the original and did not
    // reduce pixels (e.g. a tiny already-optimal JPEG), keep the original — never
    // send the model MORE bytes than it would have received. (Dimension reductions
    // always win on token cost even when the byte delta is marginal.)
    const pixelsReduced = optimizedWidth * optimizedHeight < originalWidth * originalHeight
    if (out.length >= buffer.length && !pixelsReduced) {
      const r = passthrough(buffer, contentType, 'no_gain')
      r.metrics.originalWidth = originalWidth
      r.metrics.originalHeight = originalHeight
      r.metrics.processingMs = processingMs
      return r
    }

    return {
      buffer: out,
      contentType: 'image/jpeg',
      ext: 'jpg',
      metrics: {
        applied: true,
        ops,
        originalBytes: buffer.length,
        optimizedBytes: out.length,
        byteReductionPct: pct(buffer.length, out.length),
        originalWidth,
        originalHeight,
        optimizedWidth,
        optimizedHeight,
        pixelReductionPct: pct(originalWidth * originalHeight, optimizedWidth * optimizedHeight),
        estTokensBefore: estimateImageTokens(originalWidth, originalHeight),
        estTokensAfter: estimateImageTokens(optimizedWidth, optimizedHeight),
        estTokenReductionPct: pct(
          estimateImageTokens(originalWidth, originalHeight),
          estimateImageTokens(optimizedWidth, optimizedHeight),
        ),
        processingMs,
      },
    }
  } catch (e) {
    return passthrough(buffer, contentType, `encode_failed:${(e as Error)?.name || 'error'}`)
  }
}

/**
 * Optimize a `data:image/...;base64,...` URL in place (for paths that hand a data
 * URL straight to the model with no Blob storage, e.g. /api/ai/photo-estimate).
 * Returns a new — smaller — JPEG data URL, or the ORIGINAL string unchanged when it
 * isn't a data URL or optimization produced no gain. Never throws; also returns the
 * metrics so the caller can measure the reduction.
 */
export async function optimizeDataUrlForModel(
  dataUrl: string,
  opts: OptimizeOptions = {},
): Promise<{ dataUrl: string; metrics: OptimizeMetrics }> {
  const m = typeof dataUrl === 'string' ? dataUrl.match(/^data:(image\/[a-z]+);base64,(.+)$/i) : null
  if (!m) return { dataUrl, metrics: passthrough(Buffer.alloc(0), '', 'not_a_data_url').metrics }
  const buffer = Buffer.from(m[2], 'base64')
  const result = await optimizeForModel(buffer, m[1].toLowerCase(), opts)
  if (!result.metrics.applied) return { dataUrl, metrics: result.metrics }
  return { dataUrl: `data:${result.contentType};base64,${result.buffer.toString('base64')}`, metrics: result.metrics }
}
