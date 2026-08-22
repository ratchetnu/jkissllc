// ── Files a release must never overwrite on a managed target (PURE) ─────────
//
// A managed target is not a copy of the source. It is a different business with its
// own name, its own legal identity, its own logo, its own deployment settings and
// its own customers. An update carries shared PLATFORM code; it must not carry the
// things that make the target itself.
//
// ── Why this exists as a standing policy, not a checklist ───────────────────
//
// Exclusions were per-update, curated by hand into each compatibility record. That
// works right up until somebody forgets — and the failure mode of forgetting is
// silent: the transfer succeeds, the tests pass, and the target's home page now
// says the source company's name. The damage is discovered by a customer.
//
// So this is a STANDING rule, unioned with whatever a compatibility record says and
// applied whether or not anyone remembered. A curated list can be forgotten; a
// policy that runs every time cannot.
//
// ── What is deliberately NOT here ───────────────────────────────────────────
//
// Capability choices and provider credentials are not files. Selections live in the
// target's own Redis under its own tenant prefix, and credentials live in the
// target's own environment — neither is reachable by a file transfer, which is
// exactly why they were put there. Tenant DATA is likewise not in the repository.
// This list covers only the third category: repository files that ARE identity.

export type TargetOwnedRule = {
  /** An exact repository-relative path, or a prefix ending in `/`. */
  pattern: string
  /** Why the target owns it. Rendered to the operator, so it must be a reason. */
  reason: string
}

export const TARGET_OWNED_PATHS: TargetOwnedRule[] = [
  {
    pattern: 'app/lib/company.ts',
    reason: 'the target’s legal name, DOT/MC numbers, phone, email, address and brand colour — this file IS the business',
  },
  {
    pattern: 'public/',
    reason: 'logos, favicons, Open Graph images and site-verification files belong to the target’s brand and domain',
  },
  {
    pattern: 'vercel.json',
    reason: 'the target’s own deployment configuration — regions, crons and headers are its hosting, not ours',
  },
  {
    pattern: '.env',
    reason: 'never transferred under any circumstances; provider credentials are per-deployment and are not shared between businesses',
  },
  {
    pattern: '.env.example',
    reason: 'documents the target’s own required configuration, which differs by which capabilities it runs',
  },
  {
    pattern: 'app/lib/tenant-branding.ts',
    reason: 'per-tenant display identity',
  },
  {
    pattern: 'README.md',
    reason: 'the target’s own repository documentation',
  },
]

/** The rule that claims a path, or null when none does. */
export function targetOwnedRuleFor(path: string): TargetOwnedRule | null {
  const p = path.trim().replace(/^\.\//, '')
  for (const rule of TARGET_OWNED_PATHS) {
    if (rule.pattern.endsWith('/')) {
      if (p === rule.pattern.slice(0, -1) || p.startsWith(rule.pattern)) return rule
    } else if (p === rule.pattern) {
      return rule
    }
  }
  return null
}

export function isTargetOwned(path: string): boolean {
  return targetOwnedRuleFor(path) !== null
}

export type TargetOwnedSplit = {
  /** Paths safe to transfer. */
  transferable: string[]
  /** Paths withheld, each with the reason it belongs to the target. */
  withheld: { path: string; reason: string }[]
}

/**
 * Split a candidate file list. Applied on TOP of any curated exclusions, never
 * instead of them: a compatibility record may withhold more, it may never withhold
 * less than this.
 */
export function splitTargetOwned(paths: readonly string[]): TargetOwnedSplit {
  const transferable: string[] = []
  const withheld: { path: string; reason: string }[] = []
  for (const path of paths) {
    const rule = targetOwnedRuleFor(path)
    if (rule) withheld.push({ path, reason: rule.reason })
    else transferable.push(path)
  }
  return { transferable, withheld }
}

/**
 * A commit that touches ONLY target-owned files has nothing to send.
 *
 * Worth its own answer: silently producing an empty manifest reads as "already up
 * to date", which is a very different statement from "everything in this change is
 * yours alone and cannot be shared".
 */
export function isEntirelyTargetOwned(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every((p) => isTargetOwned(p))
}
