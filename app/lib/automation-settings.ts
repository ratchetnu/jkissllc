import { redis } from './redis'

// Owner-controllable automation switches. Runtime-editable so the daily cron's
// behavior can be changed from the dashboard without a redeploy. Defaults preserve
// today's behavior (everything on) so an unset store keeps sending as before.

export type AutomationSettings = {
  // The 9am crew "please confirm" nudge for unconfirmed routes today/tomorrow.
  confirmationReminders: boolean
  // The morning-of reminder to crew who ALREADY confirmed a route happening today.
  morningReminders: boolean
}

const KEY = 'automation:settings'

const DEFAULTS: AutomationSettings = {
  confirmationReminders: true,
  morningReminders: true,
}

export async function getAutomationSettings(): Promise<AutomationSettings> {
  try {
    const raw = await redis.get(KEY)
    if (!raw) return { ...DEFAULTS }
    const o = JSON.parse(raw as string) as Partial<AutomationSettings>
    return {
      confirmationReminders: typeof o.confirmationReminders === 'boolean' ? o.confirmationReminders : DEFAULTS.confirmationReminders,
      morningReminders: typeof o.morningReminders === 'boolean' ? o.morningReminders : DEFAULTS.morningReminders,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export async function setAutomationSettings(patch: Partial<AutomationSettings>): Promise<AutomationSettings> {
  const current = await getAutomationSettings()
  const next: AutomationSettings = {
    confirmationReminders: typeof patch.confirmationReminders === 'boolean' ? patch.confirmationReminders : current.confirmationReminders,
    morningReminders: typeof patch.morningReminders === 'boolean' ? patch.morningReminders : current.morningReminders,
  }
  await redis.set(KEY, JSON.stringify(next))
  return next
}
