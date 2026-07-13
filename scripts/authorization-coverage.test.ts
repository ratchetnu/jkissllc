// Authorization-coverage gate: every admin API route must funnel through a
// server-side guard (never rely on frontend hiding). Turns the "enforcement drift"
// finding (H2) into a CI failure and prevents regressions during the migration.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const ADMIN_API = path.join(process.cwd(), 'app', 'api', 'admin')

// Routes that are correctly unauthenticated (they MINT or CLEAR the session).
const ALLOWLIST = new Set([
  path.join('auth', 'route.ts'),
  path.join('logout', 'route.ts'),
])

// Any of these being present means the route resolves a principal server-side.
const GUARD = /\b(requireSession|requirePermission|requireAdmin|requireStaffSession|requirePrincipal|requireTenantSession|getPrincipal)\b/

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (name === 'route.ts') out.push(full)
  }
  return out
}

test('every admin API route calls a server-side authorization guard', () => {
  const files = walk(ADMIN_API)
  assert.ok(files.length > 10, `expected many admin routes, found ${files.length}`)
  const unguarded: string[] = []
  for (const f of files) {
    const rel = path.relative(ADMIN_API, f)
    if ([...ALLOWLIST].some((a) => rel.endsWith(a))) continue
    if (!GUARD.test(readFileSync(f, 'utf8'))) unguarded.push(rel)
  }
  assert.deepEqual(unguarded, [], `these admin routes have no server-side guard: ${unguarded.join(', ')}`)
})
