// Regression coverage for PRIV-1: while tenancy is disabled, /api/auth/tenant
// used to turn every named user's signed role into admin by way of a synthetic
// membership. Exercise the actual route and cookie, not just the helper.
process.env.ADMIN_SESSION_SECRET ||= 'test-secret-at-least-16-chars-long'

import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { NextRequest, NextResponse } from 'next/server'

import { GET, POST } from '../app/api/auth/tenant/route'
import {
  COOKIE_NAME,
  createSessionToken,
  createTenantSelectionToken,
  createUserSessionToken,
  getPrincipalFromToken,
} from '../app/api/admin/_lib/session'
import { requireMemberSession } from '../app/api/admin/_lib/tenant-session'
import { upsertMembership } from '../app/lib/platform/tenancy/membership'
import { ensureReferenceTenant } from '../app/lib/platform/tenancy/tenant-registry'
import { DEFAULT_TENANT_ID } from '../app/lib/platform/tenancy/types'
import type { Role } from '../app/lib/rbac'

const PORT = 7000 + (process.pid % 500)
process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT}`
process.env.KV_REST_API_TOKEN = 'emulator-accepts-anything'

let kv: ChildProcess | null = null

before(async () => {
  kv = spawn(process.execPath, ['scripts/local-audit/kv-emulator.mjs', '--port', String(PORT)], {
    stdio: 'ignore',
    detached: false,
  })
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/__admin/health`)
      if (response.ok) return
    } catch { /* emulator is still starting */ }
    await sleep(50)
  }
  throw new Error('kv emulator did not start')
})

after(() => {
  kv?.kill('SIGKILL')
  delete process.env.TENANCY_ENABLED
})

function request(token: string, body: Record<string, unknown> = { tenantId: DEFAULT_TENANT_ID }): NextRequest {
  return new NextRequest('http://localhost/api/auth/tenant', {
    method: 'POST',
    headers: {
      cookie: `${COOKIE_NAME}=${token}`,
      'content-type': 'application/json',
      'x-tenant-id': 'forged-tenant',
      'x-role': 'admin',
    },
    body: JSON.stringify({ ...body, role: 'admin', staffId: 'forged-staff' }),
  })
}

function replacementToken(response: NextResponse): string | null {
  return response.cookies.get(COOKIE_NAME)?.value ?? null
}

test('TENANCY off: owner, admin, manager, crew, and pending tokens cannot switch or mint a cookie', async () => {
  delete process.env.TENANCY_ENABLED

  const tokens: Array<[string, string]> = [
    ['owner', await createSessionToken()],
    ['admin', await createUserSessionToken({ id: 'named-admin', role: 'admin' })],
    ['manager', await createUserSessionToken({ id: 'named-manager', role: 'manager' })],
    ['crew', await createUserSessionToken({ id: 'named-crew', role: 'crew', staffId: 'crew-1' })],
    ['pending', await createTenantSelectionToken('named-crew')],
  ]

  for (const [label, token] of tokens) {
    const post = await POST(request(token))
    assert.equal(post.status, 404, `${label}: switch endpoint is unavailable`)
    assert.equal(replacementToken(post), null, `${label}: no replacement session cookie`)

    const get = await GET(new NextRequest('http://localhost/api/auth/tenant', {
      headers: { cookie: `${COOKIE_NAME}=${token}` },
    }))
    assert.equal(get.status, 404, `${label}: tenant directory endpoint is unavailable`)
    assert.equal(replacementToken(get), null, `${label}: GET mints no cookie`)
  }
})

test('TENANCY off: the membership guard preserves signed roles and rejects a non-reference tenant', async () => {
  delete process.env.TENANCY_ENABLED

  for (const role of ['admin', 'manager', 'crew'] satisfies Role[]) {
    const token = await createUserSessionToken({
      id: `named-${role}`,
      role,
      staffId: role === 'crew' ? 'crew-1' : undefined,
    })
    const guarded = await requireMemberSession(request(token))
    assert.ok(!(guarded instanceof NextResponse), `${role}: signed reference session is accepted`)
    if (!(guarded instanceof NextResponse)) {
      assert.equal(guarded.role, role, `${role}: role is not overwritten`)
      assert.equal(guarded.membershipVerified, false, `${role}: no store verification is claimed while off`)
    }
  }

  const foreign = await createUserSessionToken({ id: 'named-manager', role: 'manager', tenantId: 'foreign' })
  const denied = await requireMemberSession(request(foreign))
  assert.ok(denied instanceof NextResponse)
  if (denied instanceof NextResponse) assert.equal(denied.status, 403)
})

test('TENANCY on: a valid destination membership controls the new role and forged inputs are ignored', async () => {
  process.env.TENANCY_ENABLED = 'true'
  await ensureReferenceTenant()
  await upsertMembership({
    tenantId: DEFAULT_TENANT_ID,
    userId: 'switch-user',
    role: 'crew',
    staffId: 'real-crew',
    status: 'active',
  })

  const source = await createUserSessionToken({ id: 'switch-user', role: 'manager', tenantId: 'foreign' })
  const response = await POST(request(source))
  assert.equal(response.status, 200)

  const token = replacementToken(response)
  assert.ok(token, 'successful switch mints a replacement session')
  const principal = await getPrincipalFromToken(token)
  assert.equal(principal?.tenantId, DEFAULT_TENANT_ID)
  assert.equal(principal?.role, 'crew', 'destination membership wins over source and forged roles')
  assert.equal(principal?.staffId, 'real-crew', 'destination membership supplies the staff link')
})

test('TENANCY on: a non-member cannot switch and receives no cookie', async () => {
  process.env.TENANCY_ENABLED = 'true'
  const token = await createUserSessionToken({ id: 'non-member', role: 'crew', tenantId: 'foreign' })
  const response = await POST(request(token))
  assert.equal(response.status, 403)
  assert.equal(replacementToken(response), null)
})
