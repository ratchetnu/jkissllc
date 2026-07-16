// Seed safety — an owner-configured business must survive a forced re-seed. Regression for
// "seed data cannot overwrite production data". Uses an in-memory store (no Redis).
import assert from 'node:assert/strict'
import test from 'node:test'
import { seedPlatform, type SeedStore } from '../app/lib/platform/updates/seed'
import type { PlatformBusiness } from '../app/lib/platform/updates/types'

function memStore(seed: Record<string, PlatformBusiness> = {}): SeedStore & { biz: Map<string, PlatformBusiness> } {
  const biz = new Map<string, PlatformBusiness>(Object.entries(seed))
  let ctr = 1000
  return {
    biz,
    getBusiness: async (id: string) => biz.get(id) ?? null,
    saveBusiness: async (b: PlatformBusiness) => { biz.set(b.id, b) },
    saveUpdate: async () => {},
    saveCompat: async () => {},
    nextUpdateKey: async () => `UPD-${++ctr}`,
  }
}

test('fresh seed creates both businesses with canonical repos', async () => {
  const s = memStore()
  const r = await seedPlatform(1, {}, s)
  assert.equal(r.seeded, true)
  assert.equal(s.biz.get('jkiss')?.repoName, 'ratchetnu/jkissllc')
  assert.equal(s.biz.get('supercharged')?.repoName, 'ratchetnu/supercharged')
})

test('plain re-seed is a no-op when jkiss already exists', async () => {
  const s = memStore({ jkiss: { id: 'jkiss' } as PlatformBusiness })
  const r = await seedPlatform(2, {}, s)
  assert.equal(r.seeded, false)
  assert.equal(r.businesses, 0)
})

test('FORCED re-seed never overwrites an owner-configured business', async () => {
  const configured: PlatformBusiness = {
    id: 'supercharged', name: 'Supercharged Enterprises', slug: 'supercharged', status: 'active', role: 'target',
    recordVersion: 1, defaultBranch: 'main', releaseChannel: 'beta', updatePolicy: 'owner_approval',
    updatesPaused: false, manualApprovalRequired: true, autoDeployAllowed: false, healthStatus: 'healthy',
    repoName: 'ratchetnu/supercharged', repositoryOwner: 'ratchetnu', repositoryNameOnly: 'supercharged',
    githubInstallationId: '146887383', previewProjectId: 'prj_fqqMknsnyUKapcyqEgnDx3sHROlr', previewRepoId: '1295706037',
    automationMode: 'automated_preview', configurationStatus: 'ready', createdAt: 1, updatedAt: 1,
  }
  const s = memStore({ jkiss: { id: 'jkiss', repoName: 'ratchetnu/jkissllc' } as PlatformBusiness, supercharged: configured })
  await seedPlatform(999, { force: true }, s)
  const after = s.biz.get('supercharged')!
  // Every owner-configured field is preserved — force only re-seeds updates.
  assert.equal(after.repoName, 'ratchetnu/supercharged')
  assert.equal(after.githubInstallationId, '146887383')
  assert.equal(after.previewProjectId, 'prj_fqqMknsnyUKapcyqEgnDx3sHROlr')
  assert.equal(after.configurationStatus, 'ready')
  assert.equal(after.automationMode, 'automated_preview')
})
