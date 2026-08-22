// ── The owner's one real decision: where numbering starts ───────────────────
//
// Everything else in baseline adoption is a fact Operion can read. This is not. `0.1.0`
// and `1.0.0` describe the same code and differ only in what the owner is promising,
// so Operion must never pick one — not by defaulting, not by inferring from age, size,
// or how long the product has been live.
//
// The distinction, in the owner's terms, is the one thing worth explaining well.

import { channelSupportsPrerelease, parseSemanticVersion } from './semver-policy'
import type { ReleaseChannel as VersionedChannel } from './versions'

/**
 * `custom` exists in the business record's channel union but not in the version
 * policy's, and it carries no prerelease guarantee — so it is refused here rather
 * than cast across the boundary. Mirrors the same check in baseline-adoption.ts.
 */
export function prereleaseAllowedForChannel(channel: string): boolean {
  if (channel === 'custom') return false
  return channelSupportsPrerelease(channel as VersionedChannel)
}

export type StartingVersionChoice = {
  id: 'zero_one' | 'one_zero' | 'custom'
  version?: string
  label: string
  meaning: string
  pickWhen: string
}

export const STARTING_VERSION_CHOICES: StartingVersionChoice[] = [
  {
    id: 'zero_one',
    version: '0.1.0',
    label: 'Start at 0.1.0',
    meaning: 'Says the product is established and running, but you are not yet promising that its features and behaviour will stay stable between updates.',
    pickWhen: 'Pick this if you are still changing how things work, and want the freedom to change them again without it counting as a breaking release.',
  },
  {
    id: 'one_zero',
    version: '1.0.0',
    label: 'Start at 1.0.0',
    meaning: 'Says this is the first stable release. From here, anything that changes how the product behaves for its users is a major release.',
    pickWhen: 'Pick this if the product is settled and other people rely on it working the way it does today.',
  },
  {
    id: 'custom',
    label: 'Use a different number',
    meaning: 'Continues numbering you already use elsewhere.',
    pickWhen: 'Pick this only if this product already has a version history you are carrying over.',
  },
]

export type StartingVersionResult =
  | { ok: true; version: string; choice: StartingVersionChoice['id'] }
  | { ok: false; reason: 'no_choice_made' | 'invalid_version' | 'prerelease_not_allowed'; detail: string }

/**
 * Resolve the owner's choice into a version. Refuses to proceed on an unmade choice —
 * there is deliberately NO default, because a default is Operion deciding.
 */
export function resolveStartingVersion(input: {
  choice?: string | null
  customVersion?: string | null
  allowPrerelease?: boolean
}): StartingVersionResult {
  const choice = STARTING_VERSION_CHOICES.find((c) => c.id === input.choice)
  if (!choice) {
    return {
      ok: false, reason: 'no_choice_made',
      detail: 'Choose where this product’s version numbering should start. Operion will not choose for you, because the two options mean different things to the people using the product.',
    }
  }
  const raw = choice.version ?? (input.customVersion ?? '').trim()
  const parsed = parseSemanticVersion(raw)
  if (!parsed.ok) {
    return {
      ok: false, reason: 'invalid_version',
      detail: 'A version number looks like 1.4.0 — three numbers separated by dots.',
    }
  }
  if (parsed.version.prerelease?.length && !input.allowPrerelease) {
    return {
      ok: false, reason: 'prerelease_not_allowed',
      detail: 'This product’s release channel does not accept a pre-release version as a starting point.',
    }
  }
  return { ok: true, version: parsed.normalized, choice: choice.id }
}
