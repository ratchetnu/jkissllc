// Which transport carries model calls, and what credential proves it is configured.
//
// This lives in its own dependency-free module for one reason: `app/lib/health.ts` needs
// to know the active transport, and importing `app/lib/ai.ts` would drag the AI SDK and
// the Anthropic provider into the health route's bundle. The alternative — restating the
// rule in health.ts — is what created the bug this module exists to prevent: the
// `ai_provider` component checked Gateway credentials only, so after the switch it was
// reporting on a transport that no longer carried any traffic.
//
// One definition, imported by both. No env reads at module scope, so it stays pure and
// directly testable.

export type AiProvider = 'gateway' | 'anthropic'

export type ProviderEnv = Record<string, string | undefined>

/** Defaults to 'gateway' — the historical behavior — unless deliberately opted out of. */
export function resolveAiProvider(env: ProviderEnv): AiProvider {
  return (env.AI_PROVIDER ?? '').trim().toLowerCase() === 'anthropic' ? 'anthropic' : 'gateway'
}

/**
 * The env var whose presence indicates the ACTIVE transport has a credential.
 *
 * Note what is deliberately absent from the gateway list: `VERCEL`. It was treated as a
 * credential because the Gateway auto-authenticates via OIDC on Vercel — but `VERCEL` is
 * set on every Vercel runtime unconditionally, so including it made the check
 * structurally incapable of returning anything but "configured". It reported ok
 * throughout a total outage in which every request was rejected with a 402.
 */
export function credentialKeysFor(provider: AiProvider): string[] {
  return provider === 'anthropic'
    ? ['ANTHROPIC_API_KEY']
    : ['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN']
}

/** True when a credential for the active transport is present. Presence only — never proof it works. */
export function providerCredentialPresent(env: ProviderEnv): boolean {
  return credentialKeysFor(resolveAiProvider(env)).some(k => !!env[k])
}
