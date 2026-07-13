// Static isolation gate: tenant-owned data must go through app/lib/redis.ts, and
// tenant prefixes must be built ONLY in the key API. Fails CI if a new file
// reaches Upstash directly or hand-constructs a `t:{...}:` prefix.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const APP = path.join(process.cwd(), 'app')

// The ONLY app file allowed to reference the raw Upstash credentials.
const KV_ALLOWLIST = [path.join('lib', 'redis.ts')]
// The ONLY app file allowed to construct a tenant prefix.
const PREFIX_ALLOWLIST = [path.join('lib', 'platform', 'tenancy', 'keys.ts')]

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(full)
  }
  return out
}

const files = walk(APP)

test('no app file reaches Upstash directly except app/lib/redis.ts', () => {
  const offenders: string[] = []
  for (const f of files) {
    const rel = path.relative(APP, f)
    if (KV_ALLOWLIST.some((a) => rel.endsWith(a))) continue
    if (/KV_REST_API/.test(readFileSync(f, 'utf8'))) offenders.push(rel)
  }
  assert.deepEqual(offenders, [], `direct Upstash access outside redis.ts: ${offenders.join(', ')}`)
})

test('no app file hand-constructs a tenant prefix except the key API', () => {
  const RAW_PREFIX = /(`t:\$\{|['"]t:['"]\s*\+)/
  const offenders: string[] = []
  for (const f of files) {
    const rel = path.relative(APP, f)
    if (PREFIX_ALLOWLIST.some((a) => rel.endsWith(a))) continue
    if (RAW_PREFIX.test(readFileSync(f, 'utf8'))) offenders.push(rel)
  }
  assert.deepEqual(offenders, [], `raw tenant-prefix construction outside keys.ts: ${offenders.join(', ')}`)
})

test('the two former bypass files now import the redis wrapper', () => {
  for (const rel of [path.join('api', 'track', 'route.ts'), path.join('api', 'admin', 'analytics', 'route.ts')]) {
    const src = readFileSync(path.join(APP, rel), 'utf8')
    assert.match(src, /from '.*lib\/redis'/, `${rel} should use the redis wrapper`)
    assert.ok(!/KV_REST_API/.test(src), `${rel} must not touch Upstash directly`)
  }
})
