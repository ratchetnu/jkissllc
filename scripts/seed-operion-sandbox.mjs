// ── Operion Sandbox — register the disposable TEST target in the platform registry ──
//
//   TEST ONLY / NON-PRODUCTION / SAFE TO RESET
//
// Registers ONE isolated Business ("operion-sandbox", role=target) + ONE eligible test
// release (0.1.0 -> 0.1.1) + its compatibility, using the EXACT same key layout as
// app/lib/platform/updates/store.ts (platform:business:* / platform:update:* / platform:compat:*).
// It touches NONE of the live businesses (jkiss, supercharged, claimguard, howard-wealth,
// nunubabymuzik) — it only adds a new, clearly-labelled record.
//
// Reversible: run scripts/reset-operion-sandbox.mjs to remove every key this writes.
//
// KV creds are read from an env file you pull yourself (never hard-coded):
//     vercel env pull .env.preview.local --environment=preview      # (from the jkissllc repo)
//     node scripts/seed-operion-sandbox.mjs .env.preview.local
// Optionally pass the GitHub App installation id (after installing the App on the repo):
//     OPERION_SANDBOX_INSTALLATION_ID=12345678 node scripts/seed-operion-sandbox.mjs .env.preview.local
// If you omit it, the record is left "incomplete" — click "Validate GitHub Connection" in the
// Release Center to auto-fill it (the existing owner-safe mechanism).

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

// Creds resolution (in order): env vars → a bare token as the first CLI arg → an env file.
// The KV URL is the shared platform store; it is NOT a secret, so it defaults here and only
// the write TOKEN needs to be supplied.
const DEFAULT_KV_URL = 'https://smooth-vulture-92540.upstash.io'
const arg = process.argv[2]
const argIsToken = arg && !arg.includes('/') && !arg.endsWith('.local') && !arg.endsWith('.env')
let URL_ = process.env.KV_REST_API_URL || DEFAULT_KV_URL
let TOKEN = process.env.KV_REST_API_TOKEN || (argIsToken ? arg : undefined)
if (!TOKEN && arg && !argIsToken) {
  try {
    const env = loadEnv(new URL(`../${arg}`, import.meta.url).pathname)
    URL_ = env.KV_REST_API_URL || URL_
    TOKEN = env.KV_REST_API_TOKEN
  } catch { /* fall through to error */ }
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

// ── Facts pinned at sandbox-creation time ────────────────────────────────────
const BIZ_ID = 'operion-sandbox'
const UPDATE_KEY = 'SBX-011'                                   // custom key — never touches the shared UPD counter
const REPO = 'ratchetnu/operion-sandbox'
const MAIN_COMMIT = '4adfa8c54ff6546f69fdccafd893df6faa2c804f' // main @ 0.1.0
const SOURCE_COMMIT = 'a64f5385df305c0cb9d7df7d5d447bf41d458b93' // release/0.1.1-source (single-file bump)
const PREVIEW_PROJECT_ID = 'prj_Uqxm4MMxZJzD3EwXgfACqnMsUeD4'
const INSTALL_ID = process.env.OPERION_SANDBOX_INSTALLATION_ID || undefined
const now = Date.now()

// updates store (the Update action reads these)
const K_BIZ = 'platform:business:'
const K_BIZ_IDX = 'platform:business:index'
const K_UPD = 'platform:update:'
const K_UPD_IDX = 'platform:update:index'
const K_COMPAT = 'platform:compat:'
// sync store (the Release Center *Businesses list* iterates these — a business only shows if a
// matching SyncProduct exists; the updates-store record above only enriches that row).
const K_PROD = 'platform:sync:product:'
const K_PROD_IDX = 'platform:sync:product:index'
const K_LATEST = 'platform:sync:latest:'
const K_REC = 'platform:sync:rec:'
const K_HIST_IDX = 'platform:sync:history:'

// Idempotent: every write below is a SET/ZADD upsert, so re-running is safe (no early return).

const PASS = {
  typecheck: 'passed', lint: 'passed', tests: 'passed', build: 'passed',
  securityReview: 'not_applicable', accessibilityReview: 'not_applicable',
  e2e: 'not_applicable', smokeTest: 'passed', ownerVerification: 'passed',
}

const business = {
  recordVersion: 1,
  id: BIZ_ID,
  name: 'Operion Sandbox — TEST ONLY',
  slug: BIZ_ID,
  industry: 'Sandbox / automation test',
  edition: 'sandbox',
  status: 'active',
  role: 'target',
  repoProvider: 'github',
  repoName: REPO,
  repositoryOwner: 'ratchetnu',
  repositoryNameOnly: 'operion-sandbox',
  defaultBranch: 'main',
  deployProvider: 'vercel',
  deployProject: 'operion-sandbox',
  healthEndpoint: '/api/health',
  currentVersion: '0.1.0',
  currentCommit: MAIN_COMMIT,
  releaseChannel: 'beta',
  updatePolicy: 'owner_approval',
  updatesPaused: false,
  manualApprovalRequired: true,
  autoDeployAllowed: false,
  healthStatus: 'unknown',
  // controlled automation config (non-secret)
  githubInstallationId: INSTALL_ID,
  allowedTargetBranches: ['main'],
  automationWorkflowFile: 'operion-update.yml',
  previewDeploymentProvider: 'vercel',
  previewProjectId: PREVIEW_PROJECT_ID,
  requirePullRequest: true,
  requireOwnerApproval: true,
  requirePreview: true,
  requirePassingChecks: true,
  allowAutomatedMerge: false,        // never auto-merge
  allowProductionPromotion: false,   // never promote to production
  configurationStatus: INSTALL_ID ? 'ready' : 'incomplete',
  notes: 'TEST ONLY / NON-PRODUCTION / SAFE TO RESET. Disposable Operion automation sandbox — not a customer business. Remove with scripts/reset-operion-sandbox.mjs.',
  createdAt: now,
  updatedAt: now,
}

const update = {
  recordVersion: 1,
  key: UPDATE_KEY,
  title: 'Sandbox release 0.1.1',
  summary: 'Bumps the sandbox version from 0.1.0 to 0.1.1 (single-file change) to validate the Preview-only Update flow.',
  technicalImpact: 'Single-file change to lib/version.ts. No migrations, secrets, or external integrations.',
  type: 'enhancement',
  scope: 'platform_core',
  severity: 'low',
  priority: 'normal',
  status: 'approved',
  module: 'sandbox/version',
  sourceBusinessId: BIZ_ID,
  sourceRepo: REPO,
  sourceBranch: 'release/0.1.1-source',
  sourceCommit: SOURCE_COMMIT,
  breakingChange: false,
  migrationRequired: false,
  environmentChangeRequired: false,
  secretRequired: false,
  featureFlagRequired: false,
  manualPortRequired: false,
  rollbackSupported: true,
  validation: PASS,
  createdBy: 'owner',
  approvedBy: 'owner',
  approvedAt: now,
  createdAt: now,
  updatedAt: now,
}

const compat = {
  recordVersion: 1,
  updateKey: UPDATE_KEY,
  businessId: BIZ_ID,
  status: 'compatible',
  reason: 'Sandbox self-transfer: source and target are the same disposable repo.',
  assessedBy: 'owner',
  createdAt: now,
  updatedAt: now,
}

// ── Sync product (drives the Businesses LIST) ────────────────────────────────
const product = {
  recordVersion: 1,
  id: BIZ_ID,
  displayName: 'Operion Sandbox — TEST ONLY',
  productType: 'standalone',
  status: 'active',
  sourceProvider: 'github',
  githubOwner: 'ratchetnu', githubRepo: 'operion-sandbox',
  defaultBranch: 'main',
  deploymentProvider: 'vercel', vercelProject: 'operion-sandbox',
  healthPath: '/api/health',
  platformSourceId: null,               // self-contained: the 0.1.1 update lives in this repo
  supportsPlatformSync: true,           // so the "update available" signal is applicable
  supportsDeploymentTracking: true,
  createdAt: now, updatedAt: now,
}

// ── Reconciliation snapshot: makes the row read "Update available (0.1.0 → 0.1.1)" ──
const recId = `${BIZ_ID}:${now}`
const reconciliation = {
  recordVersion: 1,
  id: recId,
  productId: BIZ_ID,
  checkedAt: now,
  trigger: 'seed',
  platformSync: {
    applicable: true,
    currentBaselineVersion: '0.1.0', currentBaselineCommit: MAIN_COMMIT,
    latestBaselineVersion: '0.1.1', latestBaselineCommit: SOURCE_COMMIT,
    commitsBehind: 1, compatibility: 'compatible',
    updateAvailable: true, safeToSync: true, state: 'attention',
    detail: 'A newer sandbox version (0.1.1) is available.',
  },
  deployment: {
    applicable: true, gitConnected: true,
    deployedCommit: MAIN_COMMIT, mainCommit: MAIN_COMMIT, behindBy: 0, deployedAt: now,
    environment: 'preview', health: 'unknown', upToDate: true,
    commitLabel: MAIN_COMMIT.slice(0, 7), statusLabel: 'Up to date', state: 'ok',
  },
  ok: true, failed: false,
}

// updates store
await call(['SET', K_BIZ + BIZ_ID, JSON.stringify(business)])
await call(['ZADD', K_BIZ_IDX, now, BIZ_ID])
await call(['SET', K_UPD + UPDATE_KEY, JSON.stringify(update)])
await call(['ZADD', K_UPD_IDX, now, UPDATE_KEY])
await call(['SET', K_COMPAT + UPDATE_KEY, JSON.stringify({ [BIZ_ID]: compat })])
// sync store (product + latest reconciliation + history)
await call(['SET', K_PROD + BIZ_ID, JSON.stringify(product)])
await call(['ZADD', K_PROD_IDX, now, BIZ_ID])
await call(['SET', K_LATEST + BIZ_ID, JSON.stringify(reconciliation)])
await call(['SET', K_REC + recId, JSON.stringify(reconciliation)])
await call(['ZADD', K_HIST_IDX + BIZ_ID, now, recId])

console.log('Seeded Operion Sandbox (TEST ONLY):')
console.log('  sync product  ' + K_PROD + BIZ_ID + '  (drives the Businesses list)')
console.log('  reconciliation ' + K_LATEST + BIZ_ID + '  (update available 0.1.0 -> 0.1.1)')
console.log('  business      ' + K_BIZ + BIZ_ID + '  (role=target, current=0.1.0)')
console.log('  update        ' + K_UPD + UPDATE_KEY + '  (0.1.0 -> 0.1.1, approved, eligible)')
console.log('  compat        ' + K_COMPAT + UPDATE_KEY + '  (compatible)')
console.log('  install       ' + (INSTALL_ID ? `set (${INSTALL_ID}) — configurationStatus=ready` : 'NOT set — click "Validate GitHub Connection" in Release Center'))
console.log('Reset any time with: node scripts/reset-operion-sandbox.mjs <token>')
