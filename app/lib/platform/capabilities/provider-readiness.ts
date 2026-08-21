// ── Provider readiness — ONE value-free source, shared by everything ──────────
//
// Health, the settings surface, the runtime guards, and the deployment evidence
// returned to Operion all answer "is Stripe / Twilio / email usable here?" from
// THIS module. They used to answer it separately (health read one env key,
// sms.ts read four, the Supercharged panel read a third set), which is how a
// deployment could report `payments: ok` while no charge could actually be made.
//
// ── Contract ──
//   • PURE. Environment + a resolved tenant selection in, a verdict out.
//   • VALUE-FREE. Variable NAMES leave this module; values never do. Nothing
//     here logs, returns, hashes, or compares a secret.
//   • Every state carries a STABLE, non-secret `code` suitable for an API
//     response, a log line, and a signed deployment snapshot.
//
// ── The four states, and why "disabled" is not "broken" ──────────────────────
//
//   disabled         The tenant does not use this channel. NOT a fault: it is a
//                    product decision, so it must never degrade overall health
//                    and must never gate a software update.
//   setup_required   The tenant turned it ON and the credentials are missing.
//                    This IS actionable, so it degrades THAT capability — and
//                    only that capability.
//   ready            Enabled and credentialed. Presence only: a real round trip
//                    is the only proof of reachability, which is what an
//                    observed failure below supplies.
//   degraded         Enabled, credentialed, and the last real call failed at the
//                    provider. The half a config check can never see.

import type { CapabilityId, ProviderId } from './types'

export type { ProviderId }
import { twilioConfigured } from '../../sms-config'

export type ProviderReadinessState = 'disabled' | 'setup_required' | 'ready' | 'degraded'

/** Stable, non-secret codes. Safe to return to a client and to store as evidence. */
export const READINESS_CODES = {
  disabled: 'capability_disabled',
  setup_required: 'provider_setup_required',
  ready: 'provider_ready',
  degraded: 'provider_degraded',
} as const satisfies Record<ProviderReadinessState, string>

export type Env = Record<string, string | undefined>

/** Trim-aware presence. A variable that exists but is blank is ABSENT — naming a
 *  key in `.env.example` must not read as configuring it. */
const present = (v: string | undefined): boolean => typeof v === 'string' && v.trim().length > 0

export type ProviderSpec = {
  id: ProviderId
  /** The optional capability this provider backs. */
  capability: CapabilityId
  label: string
  /** Variable NAMES the provider needs. Never values. */
  requiredVars: string[]
  /** The predicate the SEND PATH itself uses, so readiness cannot drift from reality. */
  configured: (env: Env) => boolean
  /** Which of `requiredVars` are absent — NAMES only, for an actionable message. */
  missing: (env: Env) => string[]
  /** Non-blocking, capability-scoped facts (e.g. a webhook backstop that is off). */
  notes: (env: Env) => string[]
}

export const PROVIDER_SPECS: Record<ProviderId, ProviderSpec> = {
  stripe: {
    id: 'stripe',
    capability: 'payments-stripe',
    label: 'Stripe (card payments)',
    requiredVars: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
    // Collecting a card needs only the secret key — that is what getStripe() asserts.
    configured: (env) => present(env.STRIPE_SECRET_KEY),
    missing: (env) => (present(env.STRIPE_SECRET_KEY) ? [] : ['STRIPE_SECRET_KEY']),
    // Taking a card and CONFIRMING it are separate capabilities on the same provider.
    // Stripe can charge fine while STRIPE_WEBHOOK_SECRET is unset, and then the durable
    // backstop that marks a paid invoice never runs. Reported, never used to block.
    notes: (env) =>
      present(env.STRIPE_SECRET_KEY) && !present(env.STRIPE_WEBHOOK_SECRET)
        ? ['STRIPE_WEBHOOK_SECRET not set — the webhook fails closed, so payment confirmation rests on the return path alone']
        : [],
  },
  twilio: {
    id: 'twilio',
    capability: 'sms-delivery',
    label: 'Twilio (SMS)',
    requiredVars: ['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'TWILIO_MESSAGING_SERVICE_SID'],
    // The SAME predicate lib/sms.ts sends by — an account SID alone cannot send and
    // must not read as configured.
    configured: (env) => twilioConfigured(env),
    missing: (env) => {
      const out: string[] = []
      if (!present(env.TWILIO_ACCOUNT_SID)) out.push('TWILIO_ACCOUNT_SID')
      const auth = (present(env.TWILIO_API_KEY_SID) && present(env.TWILIO_API_KEY_SECRET)) || present(env.TWILIO_AUTH_TOKEN)
      if (!auth) out.push('TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET (or TWILIO_AUTH_TOKEN)')
      if (!present(env.TWILIO_FROM) && !present(env.TWILIO_MESSAGING_SERVICE_SID)) out.push('TWILIO_FROM (or TWILIO_MESSAGING_SERVICE_SID)')
      return out
    },
    notes: (env) =>
      twilioConfigured(env) && !present(env.TWILIO_AUTH_TOKEN) && !present(env.TWILIO_WEBHOOK_SECRET)
        ? ['neither TWILIO_AUTH_TOKEN nor TWILIO_WEBHOOK_SECRET is set — the inbound SMS webhook fails closed, so customer replies are not ingested']
        : [],
  },
  resend: {
    id: 'resend',
    capability: 'email-delivery',
    label: 'Resend (email)',
    requiredVars: ['RESEND_API_KEY'],
    configured: (env) => present(env.RESEND_API_KEY),
    missing: (env) => (present(env.RESEND_API_KEY) ? [] : ['RESEND_API_KEY']),
    notes: () => [],
  },
}

/** The capability each provider backs, and the inverse — used by the guards. */
export const PROVIDER_FOR_CAPABILITY: Partial<Record<CapabilityId, ProviderId>> = Object.fromEntries(
  Object.values(PROVIDER_SPECS).map((s) => [s.capability, s.id]),
) as Partial<Record<CapabilityId, ProviderId>>

/** A real call that already happened, if the caller wants observed reality rather
 *  than credential presence alone. Fail-soft: omit it and nothing changes. */
export type ObservedOutcome = { ok: boolean; at?: number; errorClass?: string }

export type ProviderReadiness = {
  provider: ProviderId
  capability: CapabilityId
  label: string
  /** Whether the TENANT has this channel switched on. */
  enabled: boolean
  state: ProviderReadinessState
  code: string
  /** Whether a failure here should count against the deployment's health at all. */
  applicable: boolean
  requiredVars: string[]  // NAMES only
  missingVars: string[]   // NAMES only
  notes: string[]
  detail: string
}

export type ReadinessInput = {
  provider: ProviderId
  /** The tenant's resolved selection. See capabilities/tenant-profile.ts. */
  enabled: boolean
  env: Env
  observed?: ObservedOutcome | null
}

/**
 * The single verdict. Order matters: an intentional "off" short-circuits BEFORE any
 * environment is consulted, which is what makes a credential-free deployment healthy
 * rather than permanently degraded.
 */
export function resolveProviderReadiness(input: ReadinessInput): ProviderReadiness {
  const spec = PROVIDER_SPECS[input.provider]
  const base = {
    provider: spec.id,
    capability: spec.capability,
    label: spec.label,
    enabled: input.enabled,
    requiredVars: spec.requiredVars,
  }

  if (!input.enabled) {
    return {
      ...base,
      state: 'disabled',
      code: READINESS_CODES.disabled,
      applicable: false,
      missingVars: [],
      notes: [],
      detail: `${spec.label} is turned off for this business — not required, and not a fault.`,
    }
  }

  const missingVars = spec.missing(input.env)
  if (!spec.configured(input.env)) {
    return {
      ...base,
      state: 'setup_required',
      code: READINESS_CODES.setup_required,
      applicable: true,
      missingVars,
      notes: [],
      detail: `${spec.label} is turned on but not finished: set ${missingVars.join(', ')}. Only this capability is affected.`,
    }
  }

  const notes = spec.notes(input.env)
  if (input.observed && !input.observed.ok) {
    return {
      ...base,
      state: 'degraded',
      code: READINESS_CODES.degraded,
      applicable: true,
      missingVars: [],
      notes,
      detail: `${spec.label} is configured, but the last real call failed${input.observed.errorClass ? ` (${input.observed.errorClass})` : ''}.`,
    }
  }

  return {
    ...base,
    state: 'ready',
    code: READINESS_CODES.ready,
    applicable: true,
    missingVars: [],
    notes,
    detail: notes.length
      ? `${spec.label} is configured — ${notes.join('; ')}.`
      : `${spec.label} is configured (credential presence; a real call is the only proof of reachability).`,
  }
}

/** All three providers at once, for health and for the deployment snapshot. */
export function resolveAllProviderReadiness(opts: {
  enabled: Record<ProviderId, boolean>
  env: Env
  observed?: Partial<Record<ProviderId, ObservedOutcome | null>>
}): ProviderReadiness[] {
  return (Object.keys(PROVIDER_SPECS) as ProviderId[]).map((id) =>
    resolveProviderReadiness({ provider: id, enabled: opts.enabled[id], env: opts.env, observed: opts.observed?.[id] ?? null }),
  )
}
