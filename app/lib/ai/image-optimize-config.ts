// ── Image-optimization config resolver ───────────────────────────────────────
//
// The single place that maps the platform feature flags onto the pure
// OptimizeOptions the transform core (image-optimize.ts) consumes. Keeps flag /
// env reads OUT of the pure core so the core stays deterministic and trivially
// testable, and gives callers one import for "is this on + how".
//
// Master switch: IMAGE_OPTIMIZATION_ENABLED. When off, `imageOptimizationEnabled`
// is false and callers must behave byte-identically to today (no derivative
// generated, model reads the original). The four higher-risk sub-flags only ever
// matter when the master switch is on.

import { isEnabled } from '../platform/flags'
import type { OptimizeOptions } from '../image-optimize'

type EnvLike = Record<string, string | undefined>

/** Master switch — true only when derivatives should be generated and preferred. */
export function imageOptimizationEnabled(env: EnvLike = process.env): boolean {
  return isEnabled('IMAGE_OPTIMIZATION_ENABLED', env)
}

/** Resolve the higher-risk-op toggles into OptimizeOptions. The low-risk ops
 *  (orient, resize, quality, metadata strip) are always applied by the core and
 *  need no flag. Returns the option set to hand to optimizeForModel. */
export function resolveImageOptimizeOptions(env: EnvLike = process.env): OptimizeOptions {
  return {
    autocrop: isEnabled('IMAGE_OPT_AUTOCROP_ENABLED', env),
    normalize: isEnabled('IMAGE_OPT_NORMALIZE_ENABLED', env),
    sharpen: isEnabled('IMAGE_OPT_SHARPEN_ENABLED', env),
    denoise: isEnabled('IMAGE_OPT_DENOISE_ENABLED', env),
  }
}
