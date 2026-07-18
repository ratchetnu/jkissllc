#!/usr/bin/env node
// ── operion:sandbox:verify ───────────────────────────────────────────────────
//
// Verifies (and optionally repairs) the operion-sandbox records by calling the
// deployment's OWN diagnostics/repair endpoints — it never needs local KV creds,
// because the Preview deployment holds them. Read-only by default; `--repair`
// requires an explicit confirmation. Refuses Production URLs unconditionally.
//
// Usage:
//   npm run operion:sandbox:verify -- --url https://<preview>.vercel.app
//   npm run operion:sandbox:verify -- --url https://<preview>.vercel.app --repair --yes
//
// Owner auth: the endpoints are platform-owner gated. Provide the owner session
// cookie via env OPERION_ADMIN_COOKIE (the `jk_admin_session` value from a logged-in
// browser). This is the repo's existing short-lived session — no new secret system.
// Without it you'll get 401/404; the in-app "Check / Repair Sandbox" button is the
// primary path.

const PRODUCTION_HOSTS = [
  'jkissllc.com', 'www.jkissllc.com',
  'superchargedenterprise.com', 'www.superchargedenterprise.com',
]

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : fallback
}
const has = (name) => process.argv.includes(name)

const url = arg('--url', process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined)
const doRepair = has('--repair')
const confirmed = has('--yes')
const cookie = process.env.OPERION_ADMIN_COOKIE || ''

if (!url || typeof url !== 'string') {
  console.error('Missing --url <previewUrl>. Example: npm run operion:sandbox:verify -- --url https://jkissllc-git-....vercel.app')
  process.exit(2)
}
let host
try { host = new URL(url).host.toLowerCase().replace(/:\d+$/, '') } catch { console.error('Invalid --url'); process.exit(2) }

// ── Production refusal (multiple checks) ─────────────────────────────────────
if (PRODUCTION_HOSTS.includes(host)) { console.error(`Refusing: ${host} is a Production domain. This tool is Preview-only.`); process.exit(3) }
if (!host.endsWith('.vercel.app') && !confirmed) {
  console.error(`Refusing: ${host} is not a *.vercel.app Preview host. Re-run with --yes if this really is a Preview alias.`); process.exit(3)
}

const headers = { 'Content-Type': 'application/json', ...(cookie ? { Cookie: `jk_admin_session=${cookie}` } : {}) }
const base = url.replace(/\/$/, '')

function printDiag(d) {
  if (!d) { console.log('  (no diagnostics returned)'); return }
  console.log(`  environment: ${d.environment}`)
  console.log(`  records: business=${d.records.business} product=${d.records.product} reconciliation=${d.records.reconciliation} update=${d.records.update} compat=${d.records.compat}`)
  console.log(`  queryReturnsSandbox: ${d.queryReturnsSandbox}  version: ${d.currentVersion} → ${d.availableVersion}`)
  console.log(`  status: ${d.resolvedStatus}  action: ${d.resolvedAction}`)
  console.log(`  visibleBusinesses: ${d.visibleBusinesses.map((b) => b.id).join(', ') || '(none)'}`)
  for (const n of d.notes || []) console.log(`  note: ${n}`)
}

async function main() {
  console.log(`\n[operion:sandbox:verify] target ${host} (Preview)`)
  // Diagnostics
  const dr = await fetch(`${base}/api/admin/release/sandbox/diagnostics`, { headers, redirect: 'manual' })
  if (dr.status === 401 || dr.status === 403) { console.error(`\nAuth required (${dr.status}). Set OPERION_ADMIN_COOKIE to your jk_admin_session value, or use the in-app button.`); process.exit(4) }
  if (dr.status === 404) { console.error('\nDiagnostics endpoint hidden (404) — not a flagged Preview (OPERION_SANDBOX_REPAIR_ENABLED off) or this is Production.'); process.exit(4) }
  if (!dr.ok) { console.error(`\nDiagnostics failed: HTTP ${dr.status}`); process.exit(4) }
  const dj = await dr.json()
  console.log('\nDiagnostics:')
  printDiag(dj.diagnostics)

  if (!doRepair) {
    const ok = dj.diagnostics?.queryReturnsSandbox && dj.diagnostics?.resolvedStatus === 'Update available'
    console.log(`\nResult: sandbox ${ok ? 'VISIBLE (Update available)' : 'NOT yet visible'}. Re-run with --repair --yes to fix.`)
    process.exit(ok ? 0 : 1)
  }

  if (!confirmed) { console.error('\n--repair requires --yes (explicit confirmation).'); process.exit(2) }
  console.log('\nRepairing (operion-sandbox only)…')
  const rr = await fetch(`${base}/api/admin/release/sandbox/repair`, {
    method: 'POST', headers, body: JSON.stringify({ slug: 'operion-sandbox', confirm: 'operion-sandbox' }),
  })
  const rj = await rr.json().catch(() => ({}))
  if (!rr.ok) { console.error(`Repair refused (HTTP ${rr.status}): ${(rj.refusals || []).join(', ') || 'unknown'}`); process.exit(4) }
  console.log(`  keysWritten: ${rj.keysWritten.join(', ') || '(none — already valid)'}`)
  console.log(`  keysUnchanged: ${rj.keysUnchanged.length}`)
  console.log(`  live records unchanged: ${rj.integrity.liveRecordsUnchanged ? 'YES' : 'NO — investigate'} (${rj.integrity.liveRecordsBefore}→${rj.integrity.liveRecordsAfter})`)
  console.log('\nPost-repair diagnostics:')
  printDiag(rj.diagnostics)
  const ok = rj.diagnostics?.queryReturnsSandbox && rj.diagnostics?.resolvedStatus === 'Update available'
  console.log(`\nResult: sandbox ${ok ? 'VISIBLE (Update available)' : 'still NOT visible — check notes above'}.`)
  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error('Error:', e.message); process.exit(5) })
