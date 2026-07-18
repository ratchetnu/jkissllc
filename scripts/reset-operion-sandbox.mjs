// ── Operion Sandbox — teardown ───────────────────────────────────────────────
//   Removes every key seed-operion-sandbox.mjs writes, leaving the platform registry
//   exactly as it was before. Does NOT touch any live business. Also (optionally) deletes
//   any operion/update/* preview branches you may have created during testing is left to
//   `git push origin --delete` / the GitHub UI — this script only clears the registry rows.
//
//     vercel env pull .env.preview.local --environment=preview
//     node scripts/reset-operion-sandbox.mjs .env.preview.local

import { readFileSync } from 'node:fs'

function loadEnv(path) {
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

// Same cred resolution as the seed: env vars → bare token arg → env file. URL is non-secret.
const DEFAULT_KV_URL = 'https://smooth-vulture-92540.upstash.io'
const arg = process.argv[2]
const argIsToken = arg && !arg.includes('/') && !arg.endsWith('.local') && !arg.endsWith('.env')
let URL_ = process.env.KV_REST_API_URL || DEFAULT_KV_URL
let TOKEN = process.env.KV_REST_API_TOKEN || (argIsToken ? arg : undefined)
if (!TOKEN && arg && !argIsToken) {
  try { const env = loadEnv(new URL(`../${arg}`, import.meta.url).pathname); URL_ = env.KV_REST_API_URL || URL_; TOKEN = env.KV_REST_API_TOKEN } catch { /* fall through */ }
}
if (!TOKEN) { console.error('No KV write token. Pass it as the first argument, or set KV_REST_API_TOKEN.'); process.exit(1) }

async function call(args) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args.map(String)),
  })
  const j = await res.json()
  if (j.error) throw new Error(j.error)
  return j.result
}

const BIZ_ID = 'operion-sandbox'
const UPDATE_KEY = 'SBX-011'

// updates store
await call(['DEL', 'platform:business:' + BIZ_ID])
await call(['ZREM', 'platform:business:index', BIZ_ID])
await call(['DEL', 'platform:update:' + UPDATE_KEY])
await call(['ZREM', 'platform:update:index', UPDATE_KEY])
await call(['DEL', 'platform:compat:' + UPDATE_KEY])
// sync store — delete each history reconciliation record, then the indexes/latest/product
const recIds = (await call(['ZRANGE', 'platform:sync:history:' + BIZ_ID, '0', '-1'])) || []
for (const rid of recIds) await call(['DEL', 'platform:sync:rec:' + rid])
await call(['DEL', 'platform:sync:history:' + BIZ_ID])
await call(['DEL', 'platform:sync:latest:' + BIZ_ID])
await call(['DEL', 'platform:sync:product:' + BIZ_ID])
await call(['ZREM', 'platform:sync:product:index', BIZ_ID])

console.log('Removed Operion Sandbox rows (sync product + reconciliation + business + update + compat). Live businesses untouched.')
