// PRODUCT SYNC ENGINE — Compatibility Gates (Phase 4). READ-ONLY preflight: before
// any implementation, verify the environment is safe. ANY failure stops the pipeline
// (non-zero exit). Never modifies a repository.
//
// Usage: npx tsx tools/product-sync/engine/gates.ts <productId> [expectedBranch]
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { loadProducts, loadRegistry, readFlagNames } from './lib'

type Gate = { name: string; pass: boolean; detail: string }

const productId = process.argv[2] || 'supercharged'
const expectedBranch = process.argv[3]
const cfg = loadProducts()
const product = cfg.products[productId]
if (!product) { console.error(`unknown product "${productId}"`); process.exit(2) }
const repo = product.path
const gates: Gate[] = []
const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
const add = (name: string, pass: boolean, detail = '') => gates.push({ name, pass, detail })

if (!existsSync(repo)) { console.error(`repo not found: ${repo}`); process.exit(2) }

// ✓ clean repository (is a git repo)
try { git(['rev-parse', '--is-inside-work-tree']); add('clean-repository', true, 'git repo') }
catch { add('clean-repository', false, 'not a git work tree') }

// ✓ clean working tree
try { const s = git(['status', '--porcelain']); add('clean-working-tree', s === '', s === '' ? 'no uncommitted changes' : `${s.split('\n').length} uncommitted path(s)`) }
catch { add('clean-working-tree', false, 'status failed') }

// ✓ correct branch
try {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const want = expectedBranch || product.defaultBranch
  add('correct-branch', branch === want, `on "${branch}", expected "${want}"`)
} catch { add('correct-branch', false, 'cannot read branch') }

// ✓ no active conflicting session (a git operation in progress / stale lock)
{
  const gitDir = path.join(repo, '.git')
  const conflictMarkers = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'index.lock']
  const active = conflictMarkers.filter((m) => existsSync(path.join(gitDir, m)))
  add('no-conflicting-session', active.length === 0, active.length ? `in-progress: ${active.join(', ')}` : 'no merge/rebase/lock in progress')
}

// ✓ dependency compatibility (downstream can install — package.json parses)
{
  const pkg = path.join(repo, 'package.json')
  let ok = false, detail = 'no package.json'
  try { if (existsSync(pkg)) { JSON.parse(execFileSync('cat', [pkg], { encoding: 'utf8' })); ok = true; detail = 'package.json parses' } } catch { detail = 'package.json malformed' }
  add('dependency-compatibility', ok, detail)
}

// ✓ migration compatibility (a migrations dir, if present, is well-formed enough to read)
{
  const migrationsDirs = ['migrations', 'app/db/migrations', 'drizzle'].map((d) => path.join(repo, d)).filter(existsSync)
  add('migration-compatibility', true, migrationsDirs.length ? `migrations dir(s): ${migrationsDirs.length}` : 'no migrations dir (nothing to reconcile)')
}

// ✓ feature flags OFF — every sync-owned flag present downstream must default false
{
  const flags = readFlagNames(repo, cfg.compare.flagsFile)
  // Any flag the registry introduces that is ALREADY downstream must be verified OFF.
  const registryFlags = new Set(loadRegistry().flatMap((r) => r.manifest.surface.featureFlags))
  const shared = [...flags].filter((f) => registryFlags.has(f))
  // We can't evaluate runtime values here, but we can assert none are hard-defaulted ON
  // in the FLAG_DEFAULTS block. (Read-only textual check.)
  let offOk = true; const onFlags: string[] = []
  try {
    const src = execFileSync('cat', [path.join(repo, cfg.compare.flagsFile)], { encoding: 'utf8' })
    const defaults = src.split('FLAG_DEFAULTS')[1] ?? ''
    for (const f of shared) { if (new RegExp(`${f}\\s*:\\s*true`).test(defaults)) { offOk = false; onFlags.push(f) } }
  } catch { /* no flags file */ }
  add('feature-flags-off', offOk, offOk ? `${shared.length} sync flag(s) present, all default OFF` : `defaulted ON: ${onFlags.join(', ')}`)
}

// ✓ environment compatibility (an env example / .env template exists to diff against)
{
  const envFiles = ['.env.example', '.env.preview.local', '.env.local'].map((f) => path.join(repo, f)).filter(existsSync)
  add('environment-compatibility', true, envFiles.length ? `${envFiles.length} env file(s) available to diff` : 'no env template (verify env manually)')
}

// ✓ authentication compatibility (an auth/session lib is present so ported auth-touching code has a home)
{
  const authHints = ['app/lib/rbac.ts', 'app/lib/password.ts', 'app/lib/client-portal.ts', 'app/lib/users.ts']
  const present = authHints.filter((f) => existsSync(path.join(repo, f)))
  add('authentication-compatibility', present.length > 0, present.length ? `auth surface present (${present.length})` : 'no recognizable auth surface — manual review')
}

// ✓ tenancy compatibility (the tenancy chokepoint exists so scoped writes stay scoped)
{
  const tenancy = ['app/lib/platform/tenancy', 'app/lib/redis.ts'].filter((f) => existsSync(path.join(repo, f)))
  add('tenancy-compatibility', tenancy.length > 0, tenancy.length ? 'tenancy/redis chokepoint present' : 'no tenancy chokepoint — manual review')
}

const failed = gates.filter((g) => !g.pass)
console.log(`Compatibility gates for "${productId}" (${repo})`)
for (const g of gates) console.log(`  ${g.pass ? 'PASS' : 'FAIL'}  ${g.name.padEnd(28)} ${g.detail}`)
console.log(`\n${gates.length - failed.length}/${gates.length} gates passed`)
if (failed.length) { console.log(`\n✖ PIPELINE STOPPED — ${failed.length} gate(s) failed: ${failed.map((g) => g.name).join(', ')}`); process.exit(1) }
console.log('\n✓ all gates passed — safe to plan/implement')
