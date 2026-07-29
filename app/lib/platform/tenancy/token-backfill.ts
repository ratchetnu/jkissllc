// ── Wave 6C backfill: bind tokens issued before the binding index existed ────
//
// Every public token minted before this wave has no `platform:token:{token}` record,
// and under tenancy an unbound token fails closed (see with-public-token-route.ts).
// This walks the EXISTING tenant-owned records and writes a binding for each token
// they already carry, so live customer links keep working when the flag flips.
//
// It reads inside ONE named tenant's context. It deliberately does not — and must not
// — scan every tenant looking for a token: that would be the cross-tenant read the
// whole wave prevents, and it is also why per-request legacy lookup is not an option.
//
// Idempotent and conflict-safe: `bindToken` returns the existing record unchanged for
// a same-tenant re-run and THROWS on a different-tenant rebind, so a second run can
// never silently re-point a live link. A conflict is reported, never resolved.

import { runWithTenant } from './context'
import { bindToken, TokenBindingConflictError, isValidPublicToken } from './token-binding'
import { listBookings } from '../../bookings'
import { listRoutes } from '../../routes'
import { listClientPortals } from '../../client-portal'
import { listInvoices } from '../../route-invoices'
import { listStatements } from '../../pay-statements'

export type TokenBackfillReport = {
  tenantId: string
  dryRun: boolean
  scanned: { bookings: number; routes: number; assigneeTokens: number; clientPortals: number; invoices: number; payStatements: number }
  bound: number
  alreadyBound: number
  conflicts: { token: string; reason: string }[]
  skippedInvalid: number
}

/**
 * @param tenantId the tenant whose records are being bound — named explicitly, never
 *        inferred, so a run can only ever affect the tenant the operator stated.
 */
export async function backfillTokenBindings(
  tenantId: string,
  opts: { dryRun?: boolean; limit?: number } = {},
): Promise<TokenBackfillReport> {
  const dryRun = opts.dryRun ?? false
  const limit = opts.limit ?? 5000
  const report: TokenBackfillReport = {
    tenantId, dryRun,
    scanned: { bookings: 0, routes: 0, assigneeTokens: 0, clientPortals: 0, invoices: 0, payStatements: 0 },
    bound: 0, alreadyBound: 0, conflicts: [], skippedInvalid: 0,
  }

  await runWithTenant({ tenantId }, async () => {
    const bookings = await listBookings(limit).catch(() => [])
    report.scanned.bookings = bookings.length
    for (const b of bookings) {
      await bindOne(b.token, 'booking', b.token, tenantId, dryRun, report)
    }

    const routes = await listRoutes(limit).catch(() => [])
    report.scanned.routes = routes.length
    for (const r of routes) {
      await bindOne(r.token, 'route', r.token, tenantId, dryRun, report)
      // Each live assignee confirm-token is its own capability pointing at the SAME
      // route. Rotated-out tokens are already gone from the record, so walking the
      // stored assignees binds exactly the links that should still work.
      for (const a of r.assignees ?? []) {
        if (a.token && a.token !== r.token) {
          report.scanned.assigneeTokens++
          await bindOne(a.token, 'route', r.token, tenantId, dryRun, report)
        }
      }
    }

    // ── Financial families (Wave 6D-B) ──────────────────────────────────────
    const invoices = await listInvoices(limit).catch(() => [])
    report.scanned.invoices = invoices.length
    for (const inv of invoices) {
      // Voided invoices keep their binding: the customer-facing contract lets someone
      // reopen the link and see that it was voided, and the route already 404s on
      // void. Deleted invoices are simply absent from this list.
      await bindOne(inv.token, 'route-invoice', inv.token, tenantId, dryRun, report)
    }

    const statements = await listStatements(limit).catch(() => [])
    report.scanned.payStatements = statements.length
    for (const st of statements) {
      // Void statements ARE bound: /api/verify/[id] answers `verified: false` for them,
      // which is a meaningful response a lender may be checking. Skipping them would
      // turn "this was voided" into "no such statement".
      await bindOne(st.id, 'pay-statement', st.id, tenantId, dryRun, report)
    }

    const portals = await listClientPortals(limit).catch(() => [])
    report.scanned.clientPortals = portals.length
    for (const c of portals) {
      await bindOne(c.token, 'client-portal', c.token, tenantId, dryRun, report)
    }
  })

  // NOTE — acknowledgement tokens are deliberately NOT backfilled. They are
  // repeat-use only while the acknowledgement is ACTIVE (owner decision), and the
  // reminder instance store has no listing API that distinguishes active from
  // completed. Binding them blindly would resurrect links for acknowledgements that
  // have already closed — the opposite of the decided lifecycle. New sends bind at
  // issue; historical ack links expire with their reminder retention.

  return report
}

async function bindOne(
  token: string | undefined,
  resourceType: 'booking' | 'route' | 'client-portal' | 'route-invoice' | 'pay-statement',
  resourceId: string,
  tenantId: string,
  dryRun: boolean,
  report: TokenBackfillReport,
): Promise<void> {
  if (!isValidPublicToken(token)) { report.skippedInvalid++; return }
  if (dryRun) { report.bound++; return }
  try {
    const before = await import('./token-binding').then(m => m.resolveTokenBinding(token))
    await bindToken(token, { tenantId, resourceType, resourceId })
    if (before) report.alreadyBound++; else report.bound++
  } catch (e) {
    if (e instanceof TokenBindingConflictError) {
      // Ambiguous ownership: the token is already bound elsewhere. Refuse and report;
      // an operator decides, never this script.
      report.conflicts.push({ token: token.slice(0, 8) + '…', reason: 'bound to a different tenant' })
      return
    }
    throw e
  }
}
