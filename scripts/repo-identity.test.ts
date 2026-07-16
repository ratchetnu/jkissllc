// Canonical repository identity — pure unit tests. Locks the one accepted format
// (owner/name), the allowlist source, and the rejection rules for bad input.
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRepoName, canonicalRepoName, businessRepoRef } from '../app/lib/platform/automation/repo-identity'
import { isRepoAllowed } from '../app/lib/platform/automation/preflight'
import type { PlatformBusiness } from '../app/lib/platform/updates/types'

test('accepts canonical owner/name', () => {
  assert.deepEqual(parseRepoName('ratchetnu/supercharged'), { owner: 'ratchetnu', name: 'supercharged' })
  assert.deepEqual(parseRepoName('ratchetnu/jkissllc'), { owner: 'ratchetnu', name: 'jkissllc' })
  assert.equal(canonicalRepoName('  ratchetnu/supercharged  '), 'ratchetnu/supercharged')
})

test('rejects a bare repository name (no owner)', () => {
  assert.equal(parseRepoName('supercharged'), null)
  assert.equal(canonicalRepoName('supercharged'), null)
  assert.equal(parseRepoName('(separate repo — verify)'), null)   // the old bad seed value
})

test('normalizes a GitHub HTTPS/SSH URL to owner/name', () => {
  assert.equal(canonicalRepoName('https://github.com/ratchetnu/supercharged'), 'ratchetnu/supercharged')
  assert.equal(canonicalRepoName('https://github.com/ratchetnu/supercharged.git'), 'ratchetnu/supercharged')
  assert.equal(canonicalRepoName('https://github.com/ratchetnu/supercharged/'), 'ratchetnu/supercharged')
  assert.equal(canonicalRepoName('git@github.com:ratchetnu/supercharged.git'), 'ratchetnu/supercharged')
})

test('rejects non-GitHub URLs and other schemes', () => {
  assert.equal(parseRepoName('https://gitlab.com/ratchetnu/supercharged'), null)
  assert.equal(parseRepoName('ftp://x/y'), null)
})

test('rejects filesystem paths, traversal, extra slashes, junk chars', () => {
  assert.equal(parseRepoName('/etc/passwd'), null)
  assert.equal(parseRepoName('../../secret'), null)
  assert.equal(parseRepoName('a/b/c'), null)              // extra slash
  assert.equal(parseRepoName('owner//name'), null)
  assert.equal(parseRepoName('owner/na me'), null)        // space
  assert.equal(parseRepoName('owner/na$me'), null)        // unsupported char
  assert.equal(parseRepoName('./name'), null)
  assert.equal(parseRepoName(''), null)
  assert.equal(parseRepoName(undefined), null)
})

test('businessRepoRef: repoName preferred, explicit owner+name as fallback', () => {
  assert.deepEqual(businessRepoRef({ repoName: 'ratchetnu/supercharged' }), { owner: 'ratchetnu', name: 'supercharged' })
  // Fallback when repoName is the old placeholder but explicit fields are set.
  assert.deepEqual(businessRepoRef({ repoName: '(separate repo — verify)', repositoryOwner: 'ratchetnu', repositoryNameOnly: 'supercharged' }), { owner: 'ratchetnu', name: 'supercharged' })
  // Nothing valid → null (this is the exact state that produced the validation error).
  assert.equal(businessRepoRef({ repoName: 'supercharged' }), null)
})

test('allowlist matches against the canonical owner/repo only', () => {
  const b = { repoName: 'ratchetnu/supercharged' } as PlatformBusiness
  assert.equal(isRepoAllowed(b, 'ratchetnu', 'supercharged'), true)
  assert.equal(isRepoAllowed(b, 'attacker', 'supercharged'), false)
  assert.equal(isRepoAllowed(b, 'ratchetnu', 'jkissllc'), false)
  // A record that can't resolve a canonical repo is never allowlisted.
  assert.equal(isRepoAllowed({ repoName: 'supercharged' } as PlatformBusiness, 'ratchetnu', 'supercharged'), false)
})

test('validation action resolves the corrected field (regression for the reported bug)', async () => {
  const { validateGithubConnection } = await import('../app/lib/platform/automation/github-validate')
  // No GitHub credentials in env → provider not configured, but the FIRST gate (repository
  // configured) must now PASS for a canonical repoName, and FAIL for a bare name.
  const good = await validateGithubConnection({ repoName: 'ratchetnu/supercharged' } as PlatformBusiness, {})
  assert.equal(good.checks[0].name, 'Repository configured')
  assert.equal(good.checks[0].ok, true)
  const bad = await validateGithubConnection({ repoName: 'supercharged' } as PlatformBusiness, {})
  assert.equal(bad.checks[0].ok, false)
  assert.ok(/owner\/name/.test(bad.checks[0].detail ?? ''))
})
