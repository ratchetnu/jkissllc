// ── Operion Sandbox — teardown ───────────────────────────────────────────────
//   Removes every key seed-operion-sandbox.mjs writes, leaving the platform registry
//   exactly as it was before. Does NOT touch any live business. Also (optionally) deletes
//   any operion/update/* preview branches you may have created during testing is left to
//   `git push origin --delete` / the GitHub UI — this script only clears the registry rows.
//
//     vercel env pull .env.preview.local --environment=preview
//     node scripts/reset-operion-sandbox.mjs .env.preview.local

import { readFileSync } from 'node:fs'

const ENV_FILE = process.argv[2] || '.env.preview.local'
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

const env = loadEnv(new URL(`../${ENV_FILE}`, import.meta.url).pathname)
const URL_ = env.KV_REST_API_URL
const TOKEN = env.KV_REST_API_TOKEN
if (!URL_ || !TOKEN) { console.error(`Missing KV creds in ${ENV_FILE}`); process.exit(1) }

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

await call(['DEL', 'platform:business:' + BIZ_ID])
await call(['ZREM', 'platform:business:index', BIZ_ID])
await call(['DEL', 'platform:update:' + UPDATE_KEY])
await call(['ZREM', 'platform:update:index', UPDATE_KEY])
await call(['DEL', 'platform:compat:' + UPDATE_KEY])

console.log('Removed Operion Sandbox registry rows (business + update + compat). Live businesses untouched.')
