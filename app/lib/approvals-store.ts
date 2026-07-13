import { redis } from './redis'
import type { ApprovalRequest } from './platform/approvals/types'

// ── Approval request persistence ─────────────────────────────────────────────
//
// The platform approvals domain (app/lib/platform/approvals/) is a storage-free
// state machine. This is its Redis home: the governed queue of human-in-the-loop
// AI actions (today: "send this AI-drafted quote"). Tenant-owned keys (`appr:*`)
// → namespaced per tenant by the tenancy chokepoint. Factory over a minimal
// client so the flow is unit-testable; default binds to redis.

const apprKey = (id: string) => `appr:${id}`
const tenantIndex = (tenantId: string) => `appr:t:${tenantId}`

export interface ApprovalClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  zadd(key: string, score: number, member: string): Promise<void>
  zrevrange(key: string, start: number, stop: number): Promise<string[]>
}

export function makeApprovals(client: ApprovalClient) {
  async function saveApproval(req: ApprovalRequest): Promise<void> {
    await client.set(apprKey(req.id), JSON.stringify(req))
    await client.zadd(tenantIndex(req.tenantId), req.createdAt, req.id) // re-add on update = same score
  }

  async function getApproval(id: string): Promise<ApprovalRequest | null> {
    const raw = await client.get(apprKey(id))
    if (!raw) return null
    try { return JSON.parse(raw) as ApprovalRequest } catch { return null }
  }

  /** Newest-first approvals for a tenant, optionally filtered to a status. */
  async function listApprovals(tenantId: string, opts: { limit?: number; status?: ApprovalRequest['status'] } = {}): Promise<ApprovalRequest[]> {
    const ids = await client.zrevrange(tenantIndex(tenantId), 0, Math.max(0, (opts.limit ?? 100) - 1))
    const out: ApprovalRequest[] = []
    for (const id of ids) {
      const req = await getApproval(id)
      if (!req) continue
      if (opts.status && req.status !== opts.status) continue
      out.push(req)
    }
    return out
  }

  return { saveApproval, getApproval, listApprovals }
}

const defaults = makeApprovals(redis)
export const saveApproval = defaults.saveApproval
export const getApproval = defaults.getApproval
export const listApprovals = defaults.listApprovals
