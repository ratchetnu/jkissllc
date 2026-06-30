// Thin wrapper around the Upstash Redis REST API.
// Env: KV_REST_API_URL and KV_REST_API_TOKEN (auto-provisioned by the Vercel/Upstash integration).

type RedisValue = string | number | null
type RedisResult<T = RedisValue> = { result: T } | { error: string }

async function call(args: (string | number)[]): Promise<unknown> {
  const url = process.env.KV_REST_API_URL
  const token = process.env.KV_REST_API_TOKEN
  if (!url || !token) throw new Error('UPSTASH_NOT_CONFIGURED')

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args.map(String)),
    cache: 'no-store',
  })
  const json = (await res.json()) as RedisResult
  if ('error' in json) throw new Error(json.error)
  return json.result
}

export const redis = {
  async get(key: string): Promise<string | null> {
    return (await call(['GET', key])) as string | null
  },
  async set(key: string, value: string): Promise<void> {
    await call(['SET', key, value])
  },
  async del(key: string): Promise<void> {
    await call(['DEL', key])
  },
  async zadd(key: string, score: number, member: string): Promise<void> {
    await call(['ZADD', key, score, member])
  },
  async zrevrange(key: string, start: number, stop: number): Promise<string[]> {
    return ((await call(['ZREVRANGE', key, start, stop])) ?? []) as string[]
  },
  async zrem(key: string, member: string): Promise<void> {
    await call(['ZREM', key, member])
  },
  async incr(key: string): Promise<number> {
    return (await call(['INCR', key])) as number
  },
  async pexpire(key: string, ms: number): Promise<void> {
    await call(['PEXPIRE', key, ms])
  },
  async zcard(key: string): Promise<number> {
    return ((await call(['ZCARD', key])) ?? 0) as number
  },
  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    return ((await call(['ZRANGE', key, start, stop])) ?? []) as string[]
  },
}
