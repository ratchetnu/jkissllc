import { redis } from './redis'
import { COMPANY } from './company'

// Versioned Cancellation & Refund Policy. Each booking stores the version the
// customer accepted, so historical bookings always reflect the exact terms in
// force when they agreed (chargeback evidence).

export type Policy = {
  version: number
  text: string
  updatedAt: number
}

const KEY_CURRENT = 'policy:current'      // -> current version number
const KEY_VERSION = 'policy:v:'           // policy:v:{n} -> JSON Policy

export const POLICY_TITLE = `${COMPANY.legalNameUpper} Cancellation & Refund Policy`

// Version 1 — built-in default. Editing the policy in the admin creates v2+.
export const DEFAULT_POLICY_TEXT = `${COMPANY.legalNameUpper} — CANCELLATION & REFUND POLICY

BOOKING DEPOSITS
Deposits are used to reserve labor, equipment, vehicles, scheduling time, and routing. Deposits are generally non-refundable unless otherwise required by law.

CUSTOMER CANCELLATIONS

More Than 72 Hours Before Service
• Full deposit credit toward future service within 90 days; or
• Refund less any non-recoverable processing fees.

48–72 Hours Before Service
• Credit toward future service within 90 days; or
• Refund of 50% of deposit.

Less Than 48 Hours Before Service
• Deposits are non-refundable.

Same-Day Cancellations / No-Shows
• No refunds.

RESCHEDULING
• One free reschedule if requested at least 48 hours before service.
• Additional reschedules may require a new deposit.

COMPLETED SERVICES
• No refunds after services have been substantially performed or completed.

WEATHER DELAYS
• Free reschedule or future service credit.

COMPANY CANCELLATION
• Full refund of deposit if ${COMPANY.legalNameUpper} cancels and cannot reasonably reschedule.

STRIPE / CARD PROCESSING FEES
• Stripe / card processing fees are non-refundable once processed.

CUSTOMER RESPONSIBILITY
• Customer must provide accurate addresses, inventory, access instructions, and service details. Additional charges may apply if actual job conditions differ materially from what was originally provided.

RIGHT TO REFUSE SERVICE
${COMPANY.legalNameUpper} reserves the right to refuse or discontinue service due to:
• Unsafe conditions
• Hazardous materials
• Illegal activity
• Threats or violence
• Dangerous access conditions
• Situations placing workers, equipment, or property at risk
Deposits may be forfeited in such situations.

By accepting, you confirm you have read and agree to this Cancellation & Refund Policy and the ${COMPANY.legalNameUpper} Terms of Service.`

const DEFAULT_POLICY: Policy = { version: 1, text: DEFAULT_POLICY_TEXT, updatedAt: 0 }

export async function getCurrentPolicy(): Promise<Policy> {
  try {
    const cur = await redis.get(KEY_CURRENT)
    if (!cur) return DEFAULT_POLICY
    const raw = await redis.get(`${KEY_VERSION}${cur}`)
    if (!raw) return DEFAULT_POLICY
    return JSON.parse(raw) as Policy
  } catch {
    return DEFAULT_POLICY
  }
}

export async function getPolicyVersion(version: number): Promise<Policy | null> {
  if (version === 1) {
    // v1 may be the built-in default (never written to Redis) or an override.
    try {
      const raw = await redis.get(`${KEY_VERSION}1`)
      if (raw) return JSON.parse(raw) as Policy
    } catch { /* fall through */ }
    return DEFAULT_POLICY
  }
  try {
    const raw = await redis.get(`${KEY_VERSION}${version}`)
    return raw ? (JSON.parse(raw) as Policy) : null
  } catch {
    return null
  }
}

export async function savePolicy(text: string): Promise<Policy> {
  const current = await getCurrentPolicy()
  const version = (current.updatedAt === 0 ? 1 : current.version) + 1
  const policy: Policy = { version, text: text.trim(), updatedAt: Date.now() }
  await redis.set(`${KEY_VERSION}${version}`, JSON.stringify(policy))
  await redis.set(KEY_CURRENT, String(version))
  return policy
}

export async function listPolicyVersions(max = 20): Promise<Policy[]> {
  const current = await getCurrentPolicy()
  const top = current.updatedAt === 0 ? 1 : current.version
  const out: Policy[] = []
  for (let v = top; v >= 1 && out.length < max; v--) {
    const p = await getPolicyVersion(v)
    if (p) out.push(p)
  }
  return out
}
