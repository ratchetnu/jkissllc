// Tenant-readiness static audit (Operion multi-tenant). Permanent, read-only
// diagnostic — run with:  node scripts/tenant-readiness-audit.mjs
//
// It answers three questions the tenancy foundation cannot answer at runtime while
// TENANCY_ENABLED=false, by statically scanning source:
//
//   1. ROUTE CONTEXT COVERAGE — which app/api route handlers establish a tenant
//      context (withTenantRoute) vs. resolve it in the background (withBackgroundTenant)
//      vs. are legitimately exempt (pre-auth / platform-global) vs. UNCLASSIFIED
//      (a potential gap a reviewer should look at).
//   2. DERIVED-KEY FAMILIES — Redis key families whose key is an external/user string
//      (business name, promo code, BOL, phone, email). Tenant key-prefixing does NOT
//      fix these; they need an entity-id data migration before a 2nd tenant.
//   3. UN-SCOPED BLOB WRITES — Vercel Blob put()/upload() call sites that do NOT route
//      their path through scopeBlobPath (a helper), so they'd land in the shared
//      namespace even with tenancy on.
//
// This is a REPORT, not a CI gate: it always exits 0 so it never blocks a parallel
// branch. Promote a section to a gate (process.exit(1) on UNCLASSIFIED) once the
// remaining items below are closed. Nothing here imports app code or touches Redis.

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(process.cwd())
const API_DIR = path.join(ROOT, 'app', 'api')
const LIB_DIR = path.join(ROOT, 'app', 'lib')

// ── helpers ──────────────────────────────────────────────────────────────────
function walk(dir, pred) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p, pred))
    else if (pred(p)) out.push(p)
  }
  return out
}
const rel = (p) => path.relative(ROOT, p)
const read = (p) => fs.readFileSync(p, 'utf8')

// ── 1. Route context coverage ────────────────────────────────────────────────
//
// Handlers that legitimately DON'T call withTenantRoute. Two reasons:
//  • pre-auth / platform-global surfaces (login, logout, session probe, health,
//    the platform waitlist) — no tenant to resolve, by design; and
//  • background entry points (cron, webhooks) that resolve tenant via
//    withBackgroundTenant instead of the request wrapper.
// Everything else that lacks a wrapper is UNCLASSIFIED and wants a human look.
const EXEMPT_PREAUTH = new Set([
  'app/api/admin/auth/route.ts',        // login — mints the session that carries the tenant
  'app/api/admin/logout/route.ts',      // clears the cookie
  'app/api/admin/session/route.ts',     // session probe — returns {authed:false} when none
  'app/api/auth/login/route.ts',        // named-user login
  'app/api/health/route.ts',            // liveness — no data access
  'app/api/opspilot/waitlist/route.ts', // platform (opspilot:) — allowlisted global
  'app/api/admin/opspilot-waitlist/route.ts',
])

function classifyRoute(p) {
  const src = read(p)
  const r = rel(p)
  if (/withTenantRoute\s*\(/.test(src)) return 'request-wrapped'
  if (/withBackgroundTenant\s*\(|resolveBackgroundTenant\s*\(/.test(src)) return 'background-context'
  if (EXEMPT_PREAUTH.has(r)) return 'exempt-preauth'
  return 'unclassified'
}

const routeFiles = walk(API_DIR, (p) => p.endsWith('route.ts'))
const routeBuckets = { 'request-wrapped': [], 'background-context': [], 'exempt-preauth': [], unclassified: [] }
for (const p of routeFiles) routeBuckets[classifyRoute(p)].push(rel(p))

// ── 2. Derived-key families (external/user string as the Redis key) ───────────
// Each entry: the family, why it's dangerous, and the regex that finds its
// definition. Prefixing scopeKey() around these keeps tenant A's and tenant B's
// namespaces separate but does NOT resolve the WITHIN-value name→id coupling.
const DERIVED_KEY_FAMILIES = [
  { family: 'biz:{name}',        why: 'key derived from business NAME (bizKey)',      re: /`biz:\$\{|biz:\$\{bizKey|biz:\$\{key/ },
  { family: 'promo:{code}',      why: 'key is the admin/customer-typed promo code',   re: /`promo:\$\{/ },
  { family: 'ship:{bol}',        why: 'key is an external BOL / PO number',           re: /ship:\$\{|normalizeBol\s*\(/ },
  { family: 'cust:email:{email}',why: 'customer email as an identity key',            re: /cust:email:\$\{/ },
  { family: 'cust:phone:{phone}',why: 'customer phone as an identity key',            re: /cust:phone:\$\{/ },
  { family: 'msg:phone:{e164}',  why: 'consumer phone → thread (cross-tenant merge)', re: /msg:phone:\$\{/ },
  { family: 'sms:optout:{e164}', why: 'consumer phone → opt-out state',               re: /sms:optout:\$\{/ },
]
const libFiles = walk(LIB_DIR, (p) => p.endsWith('.ts') && !p.endsWith('.d.ts'))
const derivedHits = []
for (const p of libFiles) {
  const src = read(p)
  for (const fam of DERIVED_KEY_FAMILIES) {
    if (fam.re.test(src)) {
      const line = src.split('\n').findIndex((l) => fam.re.test(l)) + 1
      derivedHits.push({ ...fam, at: `${rel(p)}:${line || '?'}` })
    }
  }
}
// value-embedded name-derived map keys a prefix physically cannot reach
const VALUE_EMBEDDED = [
  { what: 'Staff.payByBusiness keyed by bizKey(name)', re: /payByBusiness/ },
]
const valueEmbeddedHits = []
for (const p of libFiles) {
  const src = read(p)
  for (const v of VALUE_EMBEDDED) if (v.re.test(src)) valueEmbeddedHits.push({ what: v.what, at: rel(p) })
}

// ── 3. Un-scoped Blob writes ─────────────────────────────────────────────────
// put(...) / upload(...) whose FIRST argument is not a *BlobPath helper or a
// scopeBlobPath(...) call. Scans lib + api + admin UI (client uploaders live in
// app/admin). A raw string path here bypasses the tenant blob chokepoint.
const BLOB_SCAN_DIRS = [LIB_DIR, API_DIR, path.join(ROOT, 'app', 'admin')]
const blobFiles = BLOB_SCAN_DIRS.flatMap((d) => walk(d, (p) => /\.(ts|tsx)$/.test(p)))
const SCOPED_HELPER = /BlobPath\b|scopeBlobPath\s*\(/
const blobWriteHits = []
for (const p of blobFiles) {
  const lines = read(p).split('\n')
  lines.forEach((l, i) => {
    const m = /\b(put|upload)\s*\(\s*(`[^`]*`|'[^']*'|"[^"]*")/.exec(l) // literal path as 1st arg
    if (m && !SCOPED_HELPER.test(l)) blobWriteHits.push({ at: `${rel(p)}:${i + 1}`, call: m[1], arg: m[2].slice(0, 48) })
  })
}

// ── report ───────────────────────────────────────────────────────────────────
const bar = '─'.repeat(78)
console.log(`\nOperion tenant-readiness audit — ${routeFiles.length} route handlers, ${libFiles.length} lib files\n${bar}`)

console.log('\n1. ROUTE TENANT-CONTEXT COVERAGE')
console.log(`   request-wrapped (withTenantRoute)     : ${routeBuckets['request-wrapped'].length}`)
console.log(`   background-context (cron/webhook)     : ${routeBuckets['background-context'].length}`)
console.log(`   exempt (pre-auth / platform-global)   : ${routeBuckets['exempt-preauth'].length}`)
console.log(`   UNCLASSIFIED (review these)           : ${routeBuckets.unclassified.length}`)
for (const r of routeBuckets.unclassified) console.log(`     • ${r}`)

console.log('\n2. DERIVED-KEY FAMILIES (external string as the key — needs id migration)')
if (!derivedHits.length) console.log('   none found')
for (const h of derivedHits) console.log(`   • ${h.family.padEnd(24)} ${h.at}  — ${h.why}`)
console.log('   value-embedded name-derived keys (a Redis prefix cannot reach these):')
for (const v of valueEmbeddedHits) console.log(`   • ${v.what} — ${v.at}`)

console.log('\n3. UN-SCOPED BLOB WRITES (literal path not via a *BlobPath / scopeBlobPath helper)')
if (!blobWriteHits.length) console.log('   none found')
for (const h of blobWriteHits) console.log(`   • ${h.at}  ${h.call}(${h.arg}…)`)

console.log(`\n${bar}`)
console.log('Report only — exit 0. See docs/opspilot-os/tenant-isolation/audits/ for the')
console.log('narrative audit and the phased plan to close these items.\n')
process.exit(0)
