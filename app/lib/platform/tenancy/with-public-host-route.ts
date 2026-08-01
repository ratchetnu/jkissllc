import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { runWithTenant } from './context'
import { resolveTenantFromHostChannel } from './tenant-channel-resolve'

type Handler<C> = (req: NextRequest, ctx: C) => Response | Promise<Response>

/** Establish tenant context for public routes whose authority is the verified Host. */
export function withPublicHostRoute<C>(handler: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    const tenantId = await resolveTenantFromHostChannel(req.headers.get('host'))
    if (!tenantId) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    return runWithTenant({ tenantId }, () => handler(req, ctx))
  }
}
