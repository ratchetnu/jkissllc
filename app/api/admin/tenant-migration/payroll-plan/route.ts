// ── TEMPORARY owner-only Production dry-run: stable-id payroll rekey ─────────
//
// Runs the AUDITED planner (`planPayRekey`, the same pure module the CLI `plan`
// command uses) against the live Production KV, INSIDE the Vercel runtime, so the
// sensitive KV token never has to leave the platform. It is a companion to
// scripts/tenant-migration/payroll-rekey.ts and is deliberately far more restricted:
//
//   • READ-ONLY BY CONSTRUCTION. There is no write path in this file. The scan
//     runs through `redisRO` (bound to the injected read-only KV token) — the Upstash
//     server rejects writes on that token — and `listBusinesses`/`listStaff` typed to a
//     RedisReader (get/zrevrange only). No mutating function is imported or reachable.
//   • FLAG-GATED OFF. Without OPERION_PAYROLL_REKEY_DRYRUN=1 it 404s and is inert.
//   • OWNER-ONLY. `requirePlatformOwner` — the platform-owner authorization chokepoint.
//   • TYPED CONFIRM. Requires the exact phrase in the body, mirroring the Operion gates.
//   • STORE-PINNED. Refuses unless the wired KV host is the confirmed Production store,
//     so it cannot run against Preview/any other store even if enabled there.
//   • REDACTED OUTPUT. Returns only counts, categories, and salted hashes — never a
//     name, email, amount, or any raw id.
//
// It never enables the CLI's two write switches (it does not reference them at all) —
// the write path stays impossible. DELETE this route + the flag once the dry-run
// report is captured.

import { NextRequest, NextResponse } from 'next/server'
import { isEnabled } from '../../../../lib/platform/flags'
import { requirePlatformOwner } from '../../_lib/session'
import { kvHost, redisRO } from '../../../../lib/redis'
import { listBusinesses } from '../../../../lib/businesses'
import { listStaff } from '../../../../lib/staff'
import { buildRedactedPlanReport } from '../../../../lib/tenant-migration/payroll-plan-report'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The exact intent phrase the owner must send to execute the (read-only) dry run.
const CONFIRM_PHRASE = 'PLAN PAYROLL REKEY JKISS'
// The owner-confirmed Production store host (jkissllc-analytics). The scan refuses to
// run against anything else, so a Preview deploy (wired to OperionPreview) cannot run it.
const EXPECTED_PROD_HOST = 'smooth-vulture-92540.upstash.io'

const LIMIT = 1000

export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. Inert unless explicitly enabled.
  if (!isEnabled('OPERION_PAYROLL_REKEY_DRYRUN')) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // 2. Platform-owner only.
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who

  // 3. Explicit typed confirmation.
  let body: unknown = null
  try { body = await req.json() } catch { /* empty/invalid body → fails the phrase check */ }
  const confirm = (body as { confirm?: unknown } | null)?.confirm
  if (confirm !== CONFIRM_PHRASE) {
    return NextResponse.json(
      { error: 'confirmation_required', expectedPhrase: CONFIRM_PHRASE },
      { status: 400 },
    )
  }

  // 4. Pin to the confirmed Production store — refuse anywhere else.
  const host = kvHost()
  if (host !== EXPECTED_PROD_HOST) {
    return NextResponse.json({ error: 'unexpected_store', host }, { status: 409 })
  }

  // 5. Read-only scan (redisRO cannot write) → pure planner → redacted report.
  const [businesses, staff] = await Promise.all([
    listBusinesses(LIMIT, redisRO),
    listStaff(LIMIT, redisRO),
  ])
  const report = buildRedactedPlanReport(businesses, staff, { host })
  return NextResponse.json(report)
}
