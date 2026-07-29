// ── Wave 6 backfill: give every existing account a real membership ───────────
//
// Two moves, both idempotent, both safe to run against a live store:
//
//   1. `backfillUserDirectory()` — copy legacy `user:*` records into the
//      platform-global `platform:user:*` directory, so login can find an account
//      before a tenant is known (see users.ts for why that is mandatory).
//   2. membership seeding — give each account an ACTIVE membership in the reference
//      tenant carrying ITS OWN role and staff link, plus the legacy `owner` seed.
//
// Idempotence rules that make a re-run harmless:
//   • an account that already HAS a membership in the reference tenant is left
//     completely alone — a re-run never overwrites a role that was deliberately
//     changed after the first run, and never resurrects a suspended membership;
//   • the user-directory copy skips anything already present under the platform key.
//
// Ordering matters: the directory copy runs FIRST, because the membership pass reads
// the directory. Running this before enabling tenancy is what prevents a lockout —
// once TENANCY_ENABLED=true, an account with no membership cannot log in at all.

import { listUsers, backfillUserDirectory } from '../../users'
import { getMembership, upsertMembership, ensureReferenceMembership } from './membership'
import { DEFAULT_TENANT_ID } from './types'

export type Wave6BackfillReport = {
  directory: { scanned: number; copied: number; skipped: number }
  memberships: { scanned: number; created: number; existing: number }
  ownerSeeded: boolean
  dryRun: boolean
}

/**
 * @param dryRun report what WOULD change without writing memberships. The directory
 *        copy is still skipped in a dry run, so a dry run is genuinely read-only.
 */
export async function runWave6Backfill(opts: { dryRun?: boolean } = {}): Promise<Wave6BackfillReport> {
  const dryRun = opts.dryRun ?? false

  const directory = dryRun
    ? { scanned: 0, copied: 0, skipped: 0 }
    : await backfillUserDirectory()

  const users = await listUsers(1000)
  let created = 0
  let existing = 0

  for (const u of users) {
    const current = await getMembership(u.id, DEFAULT_TENANT_ID)
    if (current) { existing++; continue }
    if (!dryRun) {
      await upsertMembership({
        tenantId: DEFAULT_TENANT_ID,
        userId: u.id,
        role: u.role,          // the account's OWN role — never a blanket 'admin'
        staffId: u.staffId,    // crew keep their roster link, scoped to this tenant
        status: 'active',
        createdAt: u.createdAt,
      })
    }
    created++
  }

  let ownerSeeded = false
  if (!dryRun) {
    await ensureReferenceMembership()
    ownerSeeded = true
  }

  return {
    directory,
    memberships: { scanned: users.length, created, existing },
    ownerSeeded,
    dryRun,
  }
}
