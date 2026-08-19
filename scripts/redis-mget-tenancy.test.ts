import assert from 'node:assert/strict'
import test from 'node:test'
import { redis } from '../app/lib/redis'
import { runWithTenant } from '../app/lib/platform/tenancy/context'

test('redis.mget scopes every batched statement key and fails closed without tenant context', async () => {
  const previous = {
    enabled: process.env.TENANCY_ENABLED,
    dark: process.env.TENANCY_DARK_LAUNCH,
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
    fetch: globalThis.fetch,
  }
  process.env.TENANCY_ENABLED = 'true'
  process.env.TENANCY_DARK_LAUNCH = 'false'
  process.env.KV_REST_API_URL = 'http://fake-upstash.local'
  process.env.KV_REST_API_TOKEN = 'test-token'
  const commands: string[][] = []
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    commands.push(JSON.parse(String(init?.body)) as string[])
    return new Response(JSON.stringify({ result: ['one', 'two'] }), { status: 200 })
  }) as typeof fetch

  try {
    const values = await runWithTenant({ tenantId: 'jkiss' }, () => redis.mget(['paystmt:ps_a', 'paystmt:ps_b']))
    assert.deepEqual(values, ['one', 'two'])
    assert.deepEqual(commands, [['MGET', 't:jkiss:paystmt:ps_a', 't:jkiss:paystmt:ps_b']])
    await assert.rejects(() => redis.mget(['paystmt:ps_a']), /tenant context required/)
    assert.equal(commands.length, 1, 'a missing tenant must fail before any store request')
  } finally {
    globalThis.fetch = previous.fetch
    for (const [name, value] of [
      ['TENANCY_ENABLED', previous.enabled],
      ['TENANCY_DARK_LAUNCH', previous.dark],
      ['KV_REST_API_URL', previous.url],
      ['KV_REST_API_TOKEN', previous.token],
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
