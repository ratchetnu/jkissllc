import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '../../_lib/session'
import { hasPrompt, listPrompts } from '../../../../lib/ai/prompts'
import {
  listVersions, getActiveVersion, getAb, saveEdit, activateVersion, setAb, clearAb, type AbConfig,
} from '../../../../lib/ai/prompt-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/ai/prompts — the Prompt Management surface. Lists every prompt with
// its full version history, active version, and A/B config. Read access = ai:analytics.
export async function GET(req: NextRequest) {
  const who = await requirePermission(req, 'ai:analytics')
  if (who instanceof NextResponse) return who
  try {
    const base = listPrompts()
    const prompts = await Promise.all(base.map(async p => ({
      id: p.id,
      description: p.description,
      builtinVersion: p.version,
      activeVersion: await getActiveVersion(p.id),
      versions: await listVersions(p.id),
      ab: await getAb(p.id),
    })))
    return NextResponse.json({ ok: true, prompts })
  } catch (e) {
    console.error('[ai/prompts GET]', e)
    return NextResponse.json({ error: 'Failed to load prompts.' }, { status: 500 })
  }
}

// POST /api/admin/ai/prompts — mutations. Editing/activating/rolling back a prompt and
// configuring an A/B test are powerful, so they require ai:prompts:manage (admin only).
// This changes AI CONFIG only — never authoritative business data — and is fully
// reversible (rollback to any prior version, including the immutable built-in).
export async function POST(req: NextRequest) {
  const who = await requirePermission(req, 'ai:prompts:manage')
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const id = typeof body.id === 'string' ? body.id : ''
  const action = typeof body.action === 'string' ? body.action : ''
  if (!id || !hasPrompt(id)) return NextResponse.json({ error: 'unknown prompt id' }, { status: 400 })

  try {
    if (action === 'edit') {
      const system = typeof body.system === 'string' ? body.system : ''
      const prompt = typeof body.prompt === 'string' ? body.prompt : ''
      if (!system.trim() && !prompt.trim()) return NextResponse.json({ error: 'system or prompt required' }, { status: 400 })
      if (system.length > 20_000 || prompt.length > 20_000) return NextResponse.json({ error: 'template too long' }, { status: 400 })
      const note = typeof body.note === 'string' ? body.note : undefined
      const version = await saveEdit(id, { system, prompt, note, editedBy: who.sub }, Date.now())
      return NextResponse.json({ ok: true, version })
    }
    if (action === 'activate') {
      const version = Number(body.version)
      if (!Number.isInteger(version)) return NextResponse.json({ error: 'version required' }, { status: 400 })
      const done = await activateVersion(id, version)
      if (!done) return NextResponse.json({ error: 'unknown version' }, { status: 404 })
      return NextResponse.json({ ok: true, activeVersion: version })
    }
    if (action === 'ab') {
      const variant = Number(body.variant)
      const split = Math.max(0, Math.min(100, Number(body.split)))
      const enabled = body.enabled !== false
      if (!Number.isInteger(variant) || !Number.isFinite(split)) return NextResponse.json({ error: 'variant + split required' }, { status: 400 })
      const cfg: AbConfig = { enabled, variant, split, note: typeof body.note === 'string' ? body.note : undefined, startedAt: Date.now() }
      await setAb(id, cfg)
      return NextResponse.json({ ok: true, ab: cfg })
    }
    if (action === 'clearAb') {
      await clearAb(id)
      return NextResponse.json({ ok: true })
    }
    return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  } catch (e) {
    console.error('[ai/prompts POST]', e)
    return NextResponse.json({ error: 'Prompt update failed.' }, { status: 500 })
  }
}
