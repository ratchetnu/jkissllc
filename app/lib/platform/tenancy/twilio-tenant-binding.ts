import { redis } from '../../redis'
import { isEnabled } from '../flags'
import { currentTenantId } from './context'
import { normalizeTenantId, platformKey } from './keys'
import { DEFAULT_TENANT_ID } from './types'

const SID = /^SM[a-zA-Z0-9]{8,64}$/
const TTL_SECONDS = 60 * 60 * 24 * 35

function key(messageSid: string): string | null {
  return SID.test(messageSid) ? platformKey(`platform:twilio-message-tenant:${messageSid}`) : null
}

/** Bind an accepted outbound message to its tenant; works even with number pools. */
export async function bindTwilioMessageTenant(messageSid: string): Promise<void> {
  if (!isEnabled('TENANCY_ENABLED')) return
  const tenantId = currentTenantId()
  const k = key(messageSid)
  if (!tenantId || !k) throw new Error('Twilio message requires tenant context')
  await redis.set(k, normalizeTenantId(tenantId))
  await redis.expire(k, TTL_SECONDS)
}

/** Resolve a status callback from the MessageSid minted during the tenant send. */
export async function resolveTwilioMessageTenant(messageSid: string): Promise<string | null> {
  if (!isEnabled('TENANCY_ENABLED')) return DEFAULT_TENANT_ID
  const k = key(messageSid)
  if (!k) return null
  const tenantId = await redis.get(k)
  if (!tenantId) return null
  try { return normalizeTenantId(tenantId) } catch { return null }
}
