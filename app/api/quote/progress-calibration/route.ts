import { NextResponse } from 'next/server'
import { isEnabled } from '../../../lib/platform/flags'
import { getProgressCalibration, DEFAULT_ANALYZE_P50_MS } from '../../../lib/ai/progress-calibration'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/quote/progress-calibration — the measured p50 that paces the Option A
// customer progress display (feature-gated). Public, no PII (a single timing
// number + sample size). Returns the safe default when the flag is off or
// telemetry is thin, so the client can always render. Short CDN cache — the p50
// drifts slowly and a stale value is harmless.
export async function GET() {
  if (!isEnabled('OPERION_PROGRESS_UX')) {
    return NextResponse.json(
      { analyzeP50Ms: DEFAULT_ANALYZE_P50_MS, sampleSize: 0, source: 'default', enabled: false },
      { headers: { 'Cache-Control': 'public, max-age=60' } },
    )
  }
  const cal = await getProgressCalibration()
  return NextResponse.json(
    { ...cal, enabled: true },
    { headers: { 'Cache-Control': 'public, max-age=120, s-maxage=120' } },
  )
}
