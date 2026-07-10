import { NextRequest, NextResponse } from 'next/server'
import { runDueReminders, runEscalations } from '../../../lib/reminder-engine'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// The reminder engine cron (request Parts 2, 6). Runs every few minutes: fires every
// due reminder (after smart suppression + occurrence dedup), then walks
// unacknowledged require-ack sends and applies escalation. Mirrors the auth pattern
// of /api/cron/daily (CRON_SECRET bearer; Vercel injects it automatically).
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return true // not configured — allow (Vercel adds the bearer once set)
  return req.headers.get('authorization') === `Bearer ${secret}`
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const now = Date.now()
  let due: { evaluated: number; sent: number } = { evaluated: 0, sent: 0 }
  let esc: { escalated: number } = { escalated: 0 }
  try { due = await runDueReminders(now) } catch (e) { console.error('[cron/reminders] due', e) }
  try { esc = await runEscalations(now) } catch (e) { console.error('[cron/reminders] escalations', e) }
  return NextResponse.json({ ok: true, ...due, ...esc, at: now })
}
