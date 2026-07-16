// ── Operion automation — provider abstraction (Phase 3/4) ────────────────────
//
// One server-side interface for all external execution. The initial concrete provider
// is a GitHub App (installation-token minted from GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY
// in env) driving GitHub Actions, plus Vercel for deployments. Until the owner provisions
// those, the DEFAULT is an inert StubProvider whose write ops fail closed — so the whole
// control plane deploys safely with no credentials present.
//
// The browser NEVER calls a provider. Only the server orchestrator does, and only with
// values pulled from the registered PlatformBusiness record (never user input).

import { GitHubActionsProvider } from './github-provider'

export type RepoRef = { owner: string; name: string }
export type ProviderResult<T> = { ok: true; data: T } | { ok: false; error: string; category?: string }

export interface UpdateAutomationProvider {
  readonly name: string
  /** Discover which installation covers a repo (App JWT; read-only) — for auto-config. */
  getRepoInstallation(repo: RepoRef): Promise<ProviderResult<{ installationId: string }>>
  validateConnection(installationId: string): Promise<ProviderResult<{ connected: boolean; login?: string }>>
  readRepository(installationId: string, repo: RepoRef): Promise<ProviderResult<{ defaultBranch: string; private: boolean }>>
  readBranch(installationId: string, repo: RepoRef, branch: string): Promise<ProviderResult<{ commit: string }>>
  readCommit(installationId: string, repo: RepoRef, sha: string): Promise<ProviderResult<{ sha: string; message: string }>>
  /** Files changed in a commit — the deterministic basis for a commit-transfer manifest. */
  readCommitFiles(installationId: string, repo: RepoRef, sha: string): Promise<ProviderResult<{ files: { filename: string; status: string }[] }>>
  /** Raw file content at a ref (base64) — the approved bytes a manifest transfers. */
  readFileContent(installationId: string, repo: RepoRef, path: string, ref: string): Promise<ProviderResult<{ contentBase64: string; sha256: string }>>
  createBranch(installationId: string, repo: RepoRef, fromBranch: string, newBranch: string): Promise<ProviderResult<{ branch: string; commit: string }>>
  dispatchWorkflow(installationId: string, repo: RepoRef, workflowFile: string, ref: string, inputs: Record<string, string>): Promise<ProviderResult<{ dispatched: boolean }>>
  readWorkflowRun(installationId: string, repo: RepoRef, runId: string): Promise<ProviderResult<{ status: string; conclusion?: string; url?: string }>>
  readCheckResults(installationId: string, repo: RepoRef, ref: string): Promise<ProviderResult<{ passed: boolean; total: number; failed: number }>>
  readPullRequest(installationId: string, repo: RepoRef, number: number): Promise<ProviderResult<{ headSha: string; mergeable: boolean; url: string }>>
  createPullRequest(installationId: string, repo: RepoRef, head: string, base: string, title: string, body: string): Promise<ProviderResult<{ number: number; url: string }>>
  mergePullRequest(installationId: string, repo: RepoRef, number: number, expectedHeadSha: string): Promise<ProviderResult<{ merged: boolean; mergeCommit?: string }>>
  readDeployment(project: string, deploymentId: string): Promise<ProviderResult<{ state: string; url?: string }>>
  createPreviewDeployment(project: string, ref: string): Promise<ProviderResult<{ deploymentId: string; url: string }>>
  promoteProduction(project: string, deploymentId: string): Promise<ProviderResult<{ promoted: boolean; url?: string }>>
  runHealthCheck(url: string): Promise<ProviderResult<{ ok: boolean; status: number }>>
  cancelJob(installationId: string, repo: RepoRef, runId: string): Promise<ProviderResult<{ cancelled: boolean }>>
}

const NOT_CONFIGURED = 'automation execution not configured (no GitHub App / Vercel token provisioned)'
function fail<T>(): Promise<ProviderResult<T>> { return Promise.resolve({ ok: false, error: NOT_CONFIGURED, category: 'not_configured' }) }

/** The inert default: every operation fails closed. Safe to run with no credentials. */
export class StubProvider implements UpdateAutomationProvider {
  readonly name = 'stub'
  getRepoInstallation() { return fail<{ installationId: string }>() }
  validateConnection() { return fail<{ connected: boolean; login?: string }>() }
  readRepository() { return fail<{ defaultBranch: string; private: boolean }>() }
  readBranch() { return fail<{ commit: string }>() }
  readCommit() { return fail<{ sha: string; message: string }>() }
  readCommitFiles() { return fail<{ files: { filename: string; status: string }[] }>() }
  readFileContent() { return fail<{ contentBase64: string; sha256: string }>() }
  createBranch() { return fail<{ branch: string; commit: string }>() }
  dispatchWorkflow() { return fail<{ dispatched: boolean }>() }
  readWorkflowRun() { return fail<{ status: string; conclusion?: string; url?: string }>() }
  readCheckResults() { return fail<{ passed: boolean; total: number; failed: number }>() }
  readPullRequest() { return fail<{ headSha: string; mergeable: boolean; url: string }>() }
  createPullRequest() { return fail<{ number: number; url: string }>() }
  mergePullRequest() { return fail<{ merged: boolean; mergeCommit?: string }>() }
  readDeployment() { return fail<{ state: string; url?: string }>() }
  createPreviewDeployment() { return fail<{ deploymentId: string; url: string }>() }
  promoteProduction() { return fail<{ promoted: boolean; url?: string }>() }
  runHealthCheck() { return fail<{ ok: boolean; status: number }>() }
  cancelJob() { return fail<{ cancelled: boolean }>() }
}

/**
 * Resolve the active provider. Returns the inert stub unless a GitHub App is fully
 * provisioned in env AND automation is enabled — the live GitHubActionsProvider is a
 * deferred go-live step. Keeping this a single chokepoint means enabling live execution
 * is one wiring change, not a scatter of new call sites.
 */
export function getAutomationProvider(env: Record<string, string | undefined> = process.env): UpdateAutomationProvider {
  const provisioned = !!env.GITHUB_APP_ID && !!env.GITHUB_APP_PRIVATE_KEY
  if (!provisioned) return new StubProvider()   // no credentials → inert, fails closed
  // Live GitHub App provider. READ ops work; WRITE ops still self-gate on
  // OPERION_GITHUB_ACTIONS_ENABLED (off) — so this is read-only validation mode.
  return new GitHubActionsProvider(env)
}
