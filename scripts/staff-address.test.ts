import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret-32byteslong!!'
process.env.KV_REST_API_URL = 'http://staff-address-fake.local'
process.env.KV_REST_API_TOKEN = 'test-token'

const STORE = process.env.KV_REST_API_URL
const kv = new Map<string, string>()
const zsets = new Map<string, Map<string, number>>()
const zset = (key: string) => zsets.get(key) ?? zsets.set(key, new Map()).get(key)!

globalThis.fetch = (async (url: string, init: { body?: string }) => {
  if (url !== STORE) return { ok: true, status: 200, json: async () => ({}) }
  const [rawCommand, ...args] = JSON.parse(init.body as string) as string[]
  const command = rawCommand.toUpperCase()
  const key = args[0]
  let result: unknown = null
  if (command === 'GET') result = kv.get(key) ?? null
  else if (command === 'SET') { kv.set(key, args[1]); result = 'OK' }
  else if (command === 'DEL') { result = kv.delete(key) ? 1 : 0 }
  else if (command === 'ZADD') { zset(key).set(args[2], Number(args[1])); result = 1 }
  else if (command === 'ZREM') result = zset(key).delete(args[1]) ? 1 : 0
  else if (command === 'ZCARD') result = zset(key).size
  else if (command === 'ZREVRANGE' || command === 'ZRANGE') {
    const desc = command === 'ZREVRANGE'
    const entries = [...zset(key).entries()].sort((a, b) => desc ? b[1] - a[1] : a[1] - b[1])
    const stop = Number(args[2])
    result = entries.map(([member]) => member).slice(Number(args[1]), stop === -1 ? entries.length : stop + 1)
  }
  return { ok: true, status: 200, json: async () => ({ result }) }
}) as unknown as typeof fetch

import { NextRequest } from 'next/server'
import { createSessionToken, createUserSessionToken } from '../app/api/admin/_lib/session'
import { POST as adminStaffPOST } from '../app/api/admin/staff/route'
import { GET as meGET, PATCH as mePATCH } from '../app/api/portal/me/route'
import { formatStaffAddress, getStaff, parseStaffAddress, saveStaff, type Staff } from '../app/lib/staff'
import { listAuditForEntity } from '../app/lib/audit'

const CTX = { params: Promise.resolve({} as Record<string, string>) }
const ADDRESS = { line1: ' 123   Main St ', line2: ' Apt 4 ', city: ' Dallas ', state: 'tx', postalCode: '75201' }

function request(url: string, method: string, cookie?: string, body?: unknown): NextRequest {
  const headers: Record<string, string> = {}
  if (cookie) headers.cookie = `jk_admin_session=${cookie}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return new NextRequest(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
}

function crew(id: string, name = id): Staff {
  return { id, name, active: true, createdAt: Date.now(), updatedAt: Date.now() }
}

beforeEach(() => { kv.clear(); zsets.clear() })

test('address parser normalizes a complete US mailing address and permits clearing', () => {
  assert.deepEqual(parseStaffAddress(ADDRESS), {
    address: { line1: '123 Main St', line2: 'Apt 4', city: 'Dallas', state: 'TX', postalCode: '75201' },
  })
  assert.deepEqual(parseStaffAddress({ line1: '', line2: '', city: '', state: '', postalCode: '' }), {})
  assert.match(parseStaffAddress({ line1: '123 Main', city: 'Dallas', state: 'TX', postalCode: 'bad' }).error ?? '', /valid ZIP/)
  assert.match(parseStaffAddress({ city: 'Dallas', state: 'TX', postalCode: '75201' }).error ?? '', /Street address/)
})

test('statement mailing address uses a professional one-line format', () => {
  assert.equal(formatStaffAddress({
    line1: '2901 E Mayfield Rd', line2: '#2103', city: 'Grand Prairie', state: 'TX', postalCode: '75052',
  }), '2901 E Mayfield Rd, #2103, Grand Prairie, TX 75052')
  assert.equal(formatStaffAddress(), undefined)
})

test('admin can set a crew address and the change is audited without storing address details in the audit', async () => {
  await saveStaff(crew('crew-a', 'Avery Crew'))
  const admin = await createSessionToken()
  const res = await adminStaffPOST(request('http://localhost/api/admin/staff', 'POST', admin, {
    id: 'crew-a', name: 'Avery Crew', active: true, address: ADDRESS,
  }), CTX)
  assert.equal(res.status, 200)
  assert.deepEqual((await getStaff('crew-a'))?.address, { line1: '123 Main St', line2: 'Apt 4', city: 'Dallas', state: 'TX', postalCode: '75201' })
  assert.equal((await getStaff('crew-a'))?.w9?.addressComplete, true)
  const audit = await listAuditForEntity('crew-a')
  assert.equal(audit[0]?.action, 'staff.address_updated')
  assert.equal(audit[0]?.meta?.via, 'admin')
  assert.doesNotMatch(JSON.stringify(audit[0]), /123 Main|75201/, 'audit must not duplicate address PII')
})

test('manager and crew cannot use the admin staff writer', async () => {
  const manager = await createUserSessionToken({ id: 'u-manager', role: 'manager' })
  const crewToken = await createUserSessionToken({ id: 'u-crew', role: 'crew', staffId: 'crew-a' })
  for (const token of [manager, crewToken]) {
    const res = await adminStaffPOST(request('http://localhost/api/admin/staff', 'POST', token, { id: 'crew-a', name: 'Nope', address: ADDRESS }), CTX)
    assert.equal(res.status, 403)
  }
})

test('crew self-service updates only the staff id in the signed session, ignoring a forged body id', async () => {
  await saveStaff(crew('crew-a', 'Avery Crew'))
  await saveStaff(crew('crew-b', 'Bailey Crew'))
  const token = await createUserSessionToken({ id: 'u-a', role: 'crew', staffId: 'crew-a' })
  const res = await mePATCH(request('http://localhost/api/portal/me', 'PATCH', token, {
    id: 'crew-b', staffId: 'crew-b', address: ADDRESS,
  }), CTX)
  assert.equal(res.status, 200)
  assert.equal((await getStaff('crew-a'))?.address?.postalCode, '75201')
  assert.equal((await getStaff('crew-b'))?.address, undefined, 'foreign crew record must be untouched')

  const mine = await meGET(request('http://localhost/api/portal/me', 'GET', token), CTX)
  const body = await mine.json()
  assert.equal(body.crew.id, 'crew-a')
  assert.equal(body.crew.address.postalCode, '75201')
})

test('invalid or missing address is rejected without changing the stored record', async () => {
  const original = crew('crew-a', 'Avery Crew')
  await saveStaff(original)
  const token = await createUserSessionToken({ id: 'u-a', role: 'crew', staffId: 'crew-a' })
  const invalid = await mePATCH(request('http://localhost/api/portal/me', 'PATCH', token, { address: { line1: '1 Main', city: 'Dallas', state: 'TX', postalCode: '7' } }), CTX)
  assert.equal(invalid.status, 400)
  const missing = await mePATCH(request('http://localhost/api/portal/me', 'PATCH', token, { staffId: 'crew-a' }), CTX)
  assert.equal(missing.status, 400)
  assert.equal((await getStaff('crew-a'))?.address, undefined)
})

test('crew can clear their own address and W-9 completeness follows the real address', async () => {
  const record = crew('crew-a', 'Avery Crew')
  record.address = { line1: '1 Main', city: 'Dallas', state: 'TX', postalCode: '75201' }
  record.w9 = { status: 'on_file', addressComplete: true }
  await saveStaff(record)
  const token = await createUserSessionToken({ id: 'u-a', role: 'crew', staffId: 'crew-a' })
  const res = await mePATCH(request('http://localhost/api/portal/me', 'PATCH', token, { address: { line1: '', line2: '', city: '', state: '', postalCode: '' } }), CTX)
  assert.equal(res.status, 200)
  assert.equal((await getStaff('crew-a'))?.address, undefined)
  assert.equal((await getStaff('crew-a'))?.w9?.addressComplete, false)
})

test('portal profile routes reject unauthenticated and non-crew sessions', async () => {
  assert.equal((await mePATCH(request('http://localhost/api/portal/me', 'PATCH', undefined, { address: ADDRESS }), CTX)).status, 401)
  assert.equal((await mePATCH(request('http://localhost/api/portal/me', 'PATCH', await createSessionToken(), { address: ADDRESS }), CTX)).status, 403)
})
