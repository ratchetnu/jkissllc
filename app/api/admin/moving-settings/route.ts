// ─────────────────────────────────────────────────────────────────────────────
// Moving pricing settings — the smallest safe management surface.
//
// The moving lane prices on tenant-configured rates. Until this route existed the
// storage was reachable only from server code, so the defaults were the de-facto
// business pricing: correct-looking numbers nobody had agreed to.
//
// ADMIN ONLY, both verbs. The disposal equivalent accepts any staff session; this
// one does not, because these fifteen numbers ARE the price of every move. Read is
// gated too — a rate card is not customer-facing.
//
// Tenant scoping is inherited, not reimplemented: withTenantRoute establishes the
// context from the signed session (never a header or body), and get/saveMovingSettings
// go through the same Redis chokepoint as every other `cfg:` key. A caller cannot
// name another tenant's settings because nothing in the request names a tenant.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireAdmin } from '../_lib/session'
import { recordAudit } from '../../../lib/audit'
import {
  getMovingSettings, saveMovingSettings, sanitizeMovingSettingsPatch,
  type MovingSettings,
} from '../../../lib/pricing/moving-quote'

export const runtime = 'nodejs'

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requireAdmin(req)
  if (who instanceof NextResponse) return who
  return NextResponse.json({ ok: true, settings: await getMovingSettings() })
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requireAdmin(req)
  if (who instanceof NextResponse) return who

  const body = await req.json().catch(() => ({}))
  const { patch, rejected } = sanitizeMovingSettingsPatch(body)

  // Reject the WHOLE request on any invalid field. A partial apply would leave the
  // rate card in a state neither the admin nor the audit log describes.
  if (rejected.length > 0) {
    return NextResponse.json({ ok: false, error: 'Invalid settings', rejected }, { status: 400 })
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: 'No recognised settings in the request' }, { status: 400 })
  }

  const before = await getMovingSettings()
  const settings = await saveMovingSettings(patch)

  // Audit the CHANGE, field by field, old → new. "Someone updated moving settings"
  // is not an audit trail when the question later is which number moved and when.
  const changed = (Object.keys(patch) as (keyof MovingSettings)[])
    .filter(k => before[k] !== settings[k])
    .map(k => ({ field: k, from: before[k], to: settings[k] }))

  await recordAudit({
    actor: who.sub, actorRole: who.role,
    action: 'settings.moving_pricing_updated', entity: 'moving_settings', entityId: 'cfg:moving',
    outcome: 'success',
    summary: changed.length
      ? `Updated moving pricing: ${changed.map(c => `${c.field} ${c.from}→${c.to}`).join(', ')}`
      : 'Submitted moving pricing settings with no effective change',
    meta: { changed },
  })

  return NextResponse.json({ ok: true, settings, changed })
})
