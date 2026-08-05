// ─────────────────────────────────────────────────────────────────────────────
// Execution layer: transport seam, cache, retry, checkpoint and the pipeline.
//
// The transport is INJECTED (`VisionCaller`). Every rule in this file is
// therefore testable without a network or a credential, and the same code path
// runs in tests and in the paid pilot — no test-only branch that quietly
// diverges from what actually spends money.
//
// Fail-closed points, all deliberate:
//   • role independence is asserted before the first candidate;
//   • a schema failure is terminal for that candidate, never coerced;
//   • auth / credit / licence / privacy failures never retry;
//   • there is no fallback to the production estimator.
// ─────────────────────────────────────────────────────────────────────────────

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { assertIndependent, DEFAULT_ROLES, modelForRole } from './roles'
import { PROMPTS, SCHEMA_VERSION, SchemaError, parseClassifier, parseLabel, parseVerifier, type LabelResponse } from './contract'
import { decide, preScreen, type ConsensusDecision, type VerifierResult, type ClassifierResult } from './consensus'
import { cacheKey, isRetryable } from './tiers'
import { appendRevision, type LabelProvenance, type RoleAssignment } from './types'
import type { ManifestEntry } from '../schema'

/** What a transport must provide. Nothing else about the provider leaks in. */
export type VisionRequest = {
  model: string
  promptVersion: keyof typeof PROMPTS
  system: string
  user: string
  imagePath: string
  /** Pre-resolved image, used when the caller has no filesystem (a Preview route). */
  imageDataUrl?: string
}
export type VisionResponse = {
  text: string
  inputTokens: number
  outputTokens: number
  latencyMs: number
  usd: number
}
export type VisionCaller = (req: VisionRequest) => Promise<VisionResponse>

/** Failure kinds the runtime distinguishes. Only the first four ever retry. */
export type FailureKind =
  | 'timeout' | 'rate_limit' | 'network' | 'server_error'
  | 'auth' | 'credit_exhausted' | 'license' | 'privacy' | 'schema' | 'unknown'

export class CallFailure extends Error {
  constructor(public readonly kind: FailureKind, message: string) { super(message); this.name = 'CallFailure' }
}

/** Map a provider error onto a retry decision. Unknown is NOT retried. */
export function classifyFailure(message: string): FailureKind {
  const m = message.toLowerCase()
  if (/timeout|timed out|etimedout/.test(m)) return 'timeout'
  if (/rate.?limit|429|too many requests/.test(m)) return 'rate_limit'
  if (/econnreset|enotfound|socket|network/.test(m)) return 'network'
  if (/5\d\d|internal server|bad gateway|unavailable/.test(m)) return 'server_error'
  if (/unauthor|forbidden|invalid api key|401|403/.test(m)) return 'auth'
  if (/credit|quota|billing|insufficient funds/.test(m)) return 'credit_exhausted'
  if (/licen[cs]e/.test(m)) return 'license'
  return 'unknown'
}

// ── cache ───────────────────────────────────────────────────────────────────

export type CacheStore = { get(key: string): string | null; set(key: string, value: string): void }

/** File-backed cache. A hit means the paid call is never repeated. */
export function fileCache(root: string): CacheStore {
  const path = join(root, 'curation-cache.json')
  let data: Record<string, string> = {}
  if (existsSync(path)) { try { data = JSON.parse(readFileSync(path, 'utf8')) } catch { data = {} } }
  return {
    get: (k) => data[k] ?? null,
    set: (k, v) => { data[k] = v; mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data, null, 2)) },
  }
}

export function memoryCache(seed: Record<string, string> = {}): CacheStore {
  const data = { ...seed }
  return { get: (k) => data[k] ?? null, set: (k, v) => { data[k] = v } }
}

// ── checkpoint ──────────────────────────────────────────────────────────────

export type Checkpoint = { done(id: string): boolean; record(id: string, state: string): void }

/** Append-only checkpoint so a killed run resumes without re-spending. */
export function fileCheckpoint(root: string): Checkpoint {
  const path = join(root, 'curation-checkpoint.jsonl')
  const seen = new Set<string>()
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { seen.add((JSON.parse(line) as { id: string }).id) } catch { /* ignore */ }
    }
  }
  return {
    done: (id) => seen.has(id),
    record: (id, state) => {
      seen.add(id)
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, JSON.stringify({ id, state }) + '\n')
    },
  }
}

export function memoryCheckpoint(seed: string[] = []): Checkpoint {
  const seen = new Set(seed)
  return { done: (id) => seen.has(id), record: (id) => { seen.add(id) } }
}

// ── one call, with cache and bounded retry ──────────────────────────────────

export type CallContext = {
  caller: VisionCaller
  cache: CacheStore
  maxAttempts?: number
  onSpend?: (usd: number, model: string) => void
}

export async function callRole(
  ctx: CallContext, req: VisionRequest, imageSha256: string,
): Promise<{ text: string; cached: boolean; usd: number; latencyMs: number }> {
  const key = cacheKey({ imageSha256, model: req.model, promptVersion: req.promptVersion, schemaVersion: SCHEMA_VERSION })
  const hit = ctx.cache.get(key)
  if (hit !== null) return { text: hit, cached: true, usd: 0, latencyMs: 0 }

  const max = ctx.maxAttempts ?? 3
  let lastKind: FailureKind = 'unknown'
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      const res = await ctx.caller(req)
      ctx.cache.set(key, res.text)
      ctx.onSpend?.(res.usd, req.model)
      return { text: res.text, cached: false, usd: res.usd, latencyMs: res.latencyMs }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      lastKind = e instanceof CallFailure ? e.kind : classifyFailure(msg)
      // Auth, credit and licence failures are not transient — retrying burns
      // money or time to reproduce the same refusal.
      if (!isRetryable(lastKind) || attempt === max) throw new CallFailure(lastKind, msg)
    }
  }
  throw new CallFailure(lastKind, 'exhausted attempts')
}

// ── the pipeline ────────────────────────────────────────────────────────────

export type CandidateOutcome = {
  id: string
  decision: ConsensusDecision
  provenance: LabelProvenance[]
  label?: LabelResponse
  classifier?: ClassifierResult
  verifier?: VerifierResult
  adjudicated: boolean
  usd: number
  latencyMs: number
  cachedCalls: number
  failure?: { kind: FailureKind; message: string }
}

export type PipelineOptions = {
  roles?: RoleAssignment[]
  /** Supplied when running server-side, where the dataset is not on disk. */
  imageDataUrl?: string
  imageRoot: string
  now: string
  catalogVersion?: number
}

/**
 * Run one candidate end to end. Deterministic pre-screen first, so an unusable
 * image never reaches a paid call.
 */
export async function runCandidate(
  entry: ManifestEntry, ctx: CallContext, opts: PipelineOptions, seenHashes: Map<string, string>,
): Promise<CandidateOutcome> {
  const roles = opts.roles ?? DEFAULT_ROLES
  assertIndependent(roles)

  let usd = 0, latencyMs = 0, cachedCalls = 0
  const imagePath = join(opts.imageRoot, entry.storedPath)
  const sha = entry.sha256 || entry.id

  const provenanceBase = {
    sourceImageId: entry.id, sourceUrl: entry.sourcePageUrl, license: entry.license ?? '',
    roles, schemaVersion: SCHEMA_VERSION, catalogVersion: opts.catalogVersion ?? 1,
    createdAt: opts.now, humanReviewed: false,
  }
  const finish = (decision: ConsensusDecision, extra: Partial<CandidateOutcome> = {}): CandidateOutcome => ({
    id: entry.id, decision, adjudicated: false, usd, latencyMs, cachedCalls,
    provenance: appendRevision([], {
      ...provenanceBase, confidence: { consensus: decision.confidence },
      disagreements: decision.criticalDisagreements,
      deterministicProblems: decision.deterministicProblems,
      state: decision.state, decisionReason: decision.reason, tier: decision.tier,
    }),
    ...extra,
  })

  // 1) deterministic pre-screen — free
  const pre = preScreen(entry, seenHashes)
  if (pre.state) {
    return finish({
      state: pre.state, tier: 'candidate', reason: pre.reasons.join('; '),
      confidence: 0, criticalDisagreements: [], deterministicProblems: [],
    })
  }

  const call = async (role: 'classifier' | 'labeler' | 'verifier' | 'adjudicator', user: string) => {
    const model = modelForRole(role, roles)
    const promptVersion = roles.find(r => r.role === role)!.promptVersion as keyof typeof PROMPTS
    const r = await callRole(ctx, {
      model, promptVersion, system: PROMPTS[promptVersion], user, imagePath,
      ...(opts.imageDataUrl ? { imageDataUrl: opts.imageDataUrl } : {}),
    }, sha)
    usd += r.usd; latencyMs += r.latencyMs; if (r.cached) cachedCalls++
    return r.text
  }

  try {
    // 2) classifier
    const classifier = parseClassifier(await call('classifier', `category hint: ${entry.category}`))

    // 3) labeler — never receives production estimator output
    const label = parseLabel(await call('labeler', `lane: ${classifier.lane}; category hint: ${entry.category}`))

    // 4) verifier — image + proposed label ONLY, never the labeler's reasoning.
    //    `evidence` is stripped for the same reason.
    const { evidence: _dropped, ...labelForVerifier } = label
    let verifier = parseVerifier(await call('verifier', `proposed label: ${JSON.stringify(labelForVerifier)}`))

    // 5) adjudicator — ONLY on disagreement, never unconditionally
    let adjudicated = false
    if (verifier.verdict !== 'approve' || verifier.disagreements.length > 0) {
      const adj = parseVerifier(await call('adjudicator',
        `position A (label): ${JSON.stringify(labelForVerifier)}\nposition B (verifier): ${JSON.stringify(verifier)}`))
      adjudicated = true
      // The adjudicator resolves; it never simply overrides toward approval.
      verifier = adj.verdict === 'approve' && verifier.disagreements.length > 0
        ? { ...adj, disagreements: verifier.disagreements.filter(d => adj.disagreements.includes(d)) }
        : adj
    }

    // 6) deterministic validation + consensus
    const decision = decide({ preScreen: pre, classifier, label, verifier })
    return finish(decision, { label, classifier, verifier, adjudicated })
  } catch (e) {
    const kind = e instanceof SchemaError ? 'schema' : e instanceof CallFailure ? e.kind : classifyFailure(String(e))
    const message = e instanceof Error ? e.message : String(e)
    // A schema or transport failure is never an auto-verify. It is a human's problem.
    const state = kind === 'privacy' ? 'privacy_blocked' : kind === 'license' ? 'license_blocked' : 'needs_human_review'
    return finish({
      state, tier: 'candidate', reason: `${kind}: ${message}`,
      confidence: 0, criticalDisagreements: [], deterministicProblems: [message],
    }, { failure: { kind, message } })
  }
}
