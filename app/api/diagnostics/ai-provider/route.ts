import { NextRequest, NextResponse } from 'next/server'
import { generateAI, aiModel, aiConfigured, aiProvider } from '../../../lib/ai'
import { modelForFeature } from '../../../lib/ai/routing'
import { isEnabled } from '../../../lib/platform/flags'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

// ─────────────────────────────────────────────────────────────────────────────
// AI provider diagnostic — PREVIEW ONLY, flag-gated, secret-free.
//
// WHY THIS EXISTS. When every vision call fails, the question "is it us or the
// provider?" has to be answerable in one request rather than by running a whole
// benchmark and reading the failure backwards. The first real Preview benchmark
// spent ten model calls and forty minutes of wall-clock to discover something
// this endpoint answers in two seconds.
//
// WHAT IT NEVER RETURNS. No API key, no bearer token, no OIDC token, no signed
// URL, no raw provider response body, no customer data. Credentials are reported
// as BOOLEANS and errors as a sanitized class + a short redacted excerpt. The
// excerpt is scrubbed of anything key-shaped before it leaves the process.
//
// THREE INDEPENDENT GATES, all of which must pass:
//   1. never in Production (VERCEL_ENV), regardless of flags;
//   2. AI_PROVIDER_DIAGNOSTIC_ENABLED, which defaults OFF everywhere;
//   3. Preview deployment protection already sits in front of the whole host.
// ─────────────────────────────────────────────────────────────────────────────

/** Anything that looks like a credential is removed before an excerpt is returned. */
function scrub(text: string): string {
  return text
    .replace(/\b(sk|rk|pk|vck|vercel_blob_rw)[-_][A-Za-z0-9_-]{8,}/gi, '[redacted-key]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[redacted-jwt]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|key|signature|sig|X-Amz-Signature)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 300)
}

/** Coarse, actionable category for a provider failure. Drives the "who fixes this". */
function categorize(message: string): { category: string; owner: 'provider_account' | 'configuration' | 'application' | 'unknown' } {
  const m = message.toLowerCase()
  if (/credit|balance|top.?up|insufficient fund/.test(m)) return { category: 'no_credit_balance', owner: 'provider_account' }
  if (/quota|rate limit|429|too many/.test(m)) return { category: 'quota_or_rate_limit', owner: 'provider_account' }
  if (/unauthor|forbidden|api key|invalid token|authentication/.test(m)) return { category: 'credentials_rejected', owner: 'configuration' }
  if (/model .*(not found|unavailable|unsupported)|unknown model/.test(m)) return { category: 'model_unavailable', owner: 'configuration' }
  if (/schema|invalid request|bad request|unsupported|validation/.test(m)) return { category: 'request_contract', owner: 'application' }
  if (/timeout|timed out|abort/.test(m)) return { category: 'timeout', owner: 'application' }
  if (/fetch failed|network|econn|dns/.test(m)) return { category: 'gateway_unreachable', owner: 'configuration' }
  return { category: 'other', owner: 'unknown' }
}

export async function GET(_req: NextRequest) {
  // Gate 1 — never in Production, whatever the flags say.
  if (process.env.VERCEL_ENV === 'production') {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  // Gate 2 — opt-in, OFF by default everywhere.
  if (!isEnabled('AI_PROVIDER_DIAGNOSTIC_ENABLED')) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const feature = 'ops.junkAnalysis'
  const model = modelForFeature(feature)

  // TRANSPORT vs MODEL FAMILY are different questions and this report must not conflate
  // them. `modelSelected` is the canonical "provider/model" identity routing.ts chose;
  // its prefix names the model's VENDOR. `transport` is how the call physically leaves
  // the process, which AI_PROVIDER controls independently. Reading the vendor prefix as
  // the transport — as this line used to — reports "anthropic" while the request is in
  // fact going through the Gateway, which is precisely the confusion the direct-provider
  // switch has to be able to rule out.
  const transport = aiProvider()
  const modelFamily = model.includes('/') ? model.split('/')[0] : 'unknown'

  const report: Record<string, unknown> = {
    environment: process.env.VERCEL_ENV ?? 'unknown',
    transport: transport === 'anthropic' ? 'anthropic-direct' : 'vercel-ai-gateway',
    modelFamily,
    modelSelected: model,
    defaultModel: aiModel(),
    // Presence only — never the values.
    credentialsConfigured: aiConfigured(),
    credentialSource: transport === 'anthropic'
      ? (process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'none')
      : process.env.AI_GATEWAY_API_KEY
        ? 'AI_GATEWAY_API_KEY'
        : process.env.VERCEL_OIDC_TOKEN ? 'VERCEL_OIDC_TOKEN' : 'none',
    // The one combination that cannot make a call at all: the active transport is
    // Anthropic but routing selected a model it cannot serve. resolveModel() throws on
    // this, so surfacing it here turns an opaque run of provider_error telemetry into a
    // one-line answer.
    routableOnTransport: transport === 'gateway' || modelFamily === 'anthropic',
  }

  // ── Probe 1: text-only. Separates "can we reach and pay for the gateway at
  // all" from "is our multimodal request shaped correctly". A text probe is
  // cheap and unambiguous, so it runs first.
  const textStarted = Date.now()
  const text = await generateAI({
    prompt: 'Reply with the single word: ok',
    maxOutputTokens: 5,
    temperature: 0,
    timeoutMs: 10_000,
  })
  report.textProbe = text.ok
    ? { ok: true, latencyMs: Date.now() - textStarted, model: text.model, outputTokens: text.usage.outputTokens }
    : { ok: false, latencyMs: Date.now() - textStarted, ...categorize(text.error), errorKind: text.errorKind, excerpt: scrub(text.error) }
  // Renamed from `gatewayReachable`: with two transports, "the gateway" is no longer
  // necessarily what we failed to reach.
  report.providerReachable = text.ok || !/fetch failed|network|econn|dns/i.test(text.error ?? '')

  // ── Probe 2: multimodal, only if the text probe passed. Running it after a
  // billing failure would just reproduce the same error and bill nothing useful.
  if (text.ok) {
    // A tiny self-contained PNG — no external fetch, no signed URL, no customer data.
    const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const visionStarted = Date.now()
    const vision = await generateAI({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: ok' }, { type: 'image', image: px }] }],
      maxOutputTokens: 5,
      temperature: 0,
      timeoutMs: 15_000,
    })
    report.imageInputProbe = vision.ok
      ? { ok: true, latencyMs: Date.now() - visionStarted, outputTokens: vision.usage.outputTokens }
      : { ok: false, latencyMs: Date.now() - visionStarted, ...categorize(vision.error), errorKind: vision.errorKind, excerpt: scrub(vision.error) }
  } else {
    report.imageInputProbe = { skipped: 'text probe failed — a multimodal probe would only repeat the same error' }
  }

  // The single actionable line: who has to do something, and what.
  const failing = !text.ok ? categorize(text.error) : null
  report.verdict = failing
    ? {
      healthy: false,
      category: failing.category,
      fixOwner: failing.owner,
      // Remediation names the ACTIVE transport. A stale instruction to top up Vercel
      // while traffic runs on Anthropic sends an operator to spend money in the one
      // place that cannot fix the outage.
      action: failing.category === 'no_credit_balance'
        ? (transport === 'anthropic'
          ? 'Anthropic organization credits are exhausted. Top up (or enable auto-reload) in the Anthropic Console. No application change will help.'
          : 'Add credits to the Vercel AI Gateway for this team. No application change will help.')
        : failing.category === 'credentials_rejected'
          ? (transport === 'anthropic'
            ? 'Provision ANTHROPIC_API_KEY for this environment, or confirm the key has not been revoked.'
            : 'Provision AI_GATEWAY_API_KEY for this environment, or confirm the project OIDC issuer is trusted by the gateway.')
          : failing.category === 'model_unavailable'
            ? `Model "${model}" is not available on the ${transport === 'anthropic' ? 'Anthropic API' : 'gateway'} — check the model id or the routing override.`
            : 'See excerpt; category is not one of the known external causes.',
    }
    : { healthy: true, action: 'Provider is answering. Benchmarking can proceed.' }

  return NextResponse.json(report, { headers: { 'Cache-Control': 'no-store' } })
}
