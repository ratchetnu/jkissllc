import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner, getPrincipal } from '../_lib/session'
import { isEnabled } from '../../../lib/platform/flags'
import { getAiPrefs, setAiPrefs } from '../../../lib/estimation/shadow-store'
import { validateAiPrefs } from '../../../lib/estimation/ai-prefs'
import { recordPlatformAudit } from '../../../lib/platform/updates/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// AI Command Center Settings. Platform-owner only + SHADOW_ANALYTICS_ENABLED.
// GET  → owner display preferences + config PRESENCE (never secret values). ZERO AI.
// POST → validate + save a preference patch (audited). Rejects invalid values.
const present = (k: string) => { const v = process.env[k]; return typeof v === 'string' && v.trim() !== '' }
const anyPresent = (...k: string[]) => k.some(present)

function configPresence() {
  return [
    { key: 'ai_gateway', label: 'AI provider (gateway)', status: anyPresent('AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'VERCEL') ? 'configured' : 'missing' },
    { key: 'cron', label: 'Scheduled worker secret', status: present('CRON_SECRET') ? 'configured' : 'missing' },
    { key: 'email', label: 'Owner email (Resend)', status: present('RESEND_API_KEY') ? 'configured' : 'missing' },
    { key: 'owner_subs', label: 'Platform owner subjects', status: present('PLATFORM_OWNER_SUBS') ? 'configured' : 'missing' },
    { key: 'session', label: 'Admin session secret', status: present('ADMIN_SESSION_SECRET') ? 'configured' : 'missing' },
  ]
}

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  if (!isEnabled('SHADOW_ANALYTICS_ENABLED')) return NextResponse.json({ enabled: false }, { status: 200 })
  return NextResponse.json({ enabled: true, prefs: await getAiPrefs(), config: configPresence(), backgroundAlerting: isEnabled('SHADOW_ALERTING_ENABLED') })
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  if (!isEnabled('SHADOW_ANALYTICS_ENABLED')) return NextResponse.json({ error: 'settings disabled' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const current = await getAiPrefs()
  const v = validateAiPrefs(body, current)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })

  await setAiPrefs(v.prefs)
  const actor = (await getPrincipal(req))?.sub || 'owner'
  await recordPlatformAudit({
    actor, actorType: 'owner', source: 'ai-settings', action: 'status.manual_correction',
    summary: 'Updated AI Command Center display preferences.', meta: { prefs: v.prefs },
  })
  return NextResponse.json({ ok: true, prefs: v.prefs })
})
