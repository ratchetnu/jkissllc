import { redis } from '../redis'
import { getPrompt, builtinTemplates, renderPrompt, type BuiltPrompt } from './prompts'

// Prompt Management store (LLMOps Phase 3). A Redis overlay on top of the code-defined
// prompt registry that gives operators versioning, editing, activation, and rollback
// from the admin UI — plus a lightweight A/B config — WITHOUT ever mutating code or
// touching authoritative business data.
//
// Model:
//   • Version 1 is the built-in (code) template — immutable, always available to roll
//     back to. source = 'builtin'.
//   • Edits create versions 2..N in Redis (source = 'stored').
//   • An "active" pointer selects which version the service runs; unset ⇒ built-in.
//   • An optional A/B config splits traffic between the active version (control) and a
//     chosen variant version.
// All keys are per-prompt; the tenant is isolated by the deployment's Redis namespace.

export type PromptSource = 'builtin' | 'stored'
export type PromptVersion = {
  id: string
  version: number
  system: string
  prompt: string
  source: PromptSource
  note?: string
  editedBy?: string
  at?: number
}

export type AbConfig = {
  enabled: boolean
  variant: number       // version number of the challenger
  split: number         // 0–100, percent of traffic routed to the variant
  note?: string
  startedAt?: number
}

const kSeq = (id: string) => `ai:prompt:${id}:seq`
const kVer = (id: string, n: number) => `ai:prompt:${id}:v:${n}`
const kActive = (id: string) => `ai:prompt:${id}:active`
const kAb = (id: string) => `ai:prompt:${id}:ab`

const BUILTIN_VERSION = (id: string) => getPrompt(id).version

function builtinVersionObj(id: string): PromptVersion {
  const t = builtinTemplates(id)
  return { id, version: BUILTIN_VERSION(id), system: t.system, prompt: t.prompt, source: 'builtin' }
}

async function readStoredVersion(id: string, n: number): Promise<PromptVersion | null> {
  try {
    const raw = await redis.get(kVer(id, n))
    if (!raw) return null
    return JSON.parse(raw as string) as PromptVersion
  } catch { return null }
}

async function seq(id: string): Promise<number> {
  try { const v = await redis.get(kSeq(id)); return v ? parseInt(v as string) || BUILTIN_VERSION(id) : BUILTIN_VERSION(id) } catch { return BUILTIN_VERSION(id) }
}

// All versions for a prompt (built-in first), newest stored last.
export async function listVersions(id: string): Promise<PromptVersion[]> {
  getPrompt(id) // throws on unknown id
  const out: PromptVersion[] = [builtinVersionObj(id)]
  const top = await seq(id)
  for (let n = BUILTIN_VERSION(id) + 1; n <= top; n++) {
    const v = await readStoredVersion(id, n)
    if (v) out.push(v)
  }
  return out
}

export async function getActiveVersion(id: string): Promise<number> {
  try { const v = await redis.get(kActive(id)); const n = v ? parseInt(v as string) : NaN; return Number.isFinite(n) ? n : BUILTIN_VERSION(id) } catch { return BUILTIN_VERSION(id) }
}

async function versionObj(id: string, n: number): Promise<PromptVersion> {
  if (n === BUILTIN_VERSION(id)) return builtinVersionObj(id)
  return (await readStoredVersion(id, n)) ?? builtinVersionObj(id)   // fall back to built-in if a stored version vanished
}

// Save an edited prompt as a new version. Returns the created version number.
export async function saveEdit(id: string, input: { system: string; prompt: string; note?: string; editedBy?: string }, now: number): Promise<number> {
  getPrompt(id)
  // seed the sequence at the built-in version on first edit, then advance
  const cur = await seq(id)
  const next = cur + 1
  const rec: PromptVersion = {
    id, version: next, system: input.system, prompt: input.prompt, source: 'stored',
    note: input.note?.slice(0, 300), editedBy: input.editedBy, at: now,
  }
  await redis.set(kVer(id, next), JSON.stringify(rec))
  await redis.set(kSeq(id), String(next))
  await redis.set(kActive(id), String(next))    // a fresh edit becomes active
  return next
}

// Activate / roll back to any existing version. Returns false if the version is unknown.
export async function activateVersion(id: string, version: number): Promise<boolean> {
  getPrompt(id)
  if (version === BUILTIN_VERSION(id)) { await redis.set(kActive(id), String(version)); return true }
  const exists = await readStoredVersion(id, version)
  if (!exists) return false
  await redis.set(kActive(id), String(version))
  return true
}

// ── A/B configuration ─────────────────────────────────────────────────────────
export async function getAb(id: string): Promise<AbConfig | null> {
  try { const raw = await redis.get(kAb(id)); return raw ? (JSON.parse(raw as string) as AbConfig) : null } catch { return null }
}
export async function setAb(id: string, cfg: AbConfig): Promise<void> {
  await redis.set(kAb(id), JSON.stringify(cfg))
}
export async function clearAb(id: string): Promise<void> {
  await redis.del(kAb(id))
}

export type ResolvedPrompt = BuiltPrompt & { version: number; variant?: 'control' | 'variant' }

export type ArmChoice = { version: number; variant?: 'control' | 'variant' }

// Pure A/B arm selection: given the active version, an optional A/B config, and a
// 0..1 roll, decide which version runs and label the arm. No I/O — unit-testable.
export function pickArm(activeVersion: number, ab: AbConfig | null, roll: number): ArmChoice {
  if (ab && ab.enabled && ab.split > 0 && ab.variant !== activeVersion) {
    const toVariant = roll * 100 < ab.split
    return { version: toVariant ? ab.variant : activeVersion, variant: toVariant ? 'variant' : 'control' }
  }
  return { version: activeVersion }
}

// Resolve the prompt the service should run for this call: applies the A/B split when
// a test is live, otherwise the active version. `roll` is an injected 0..1 random so
// the arm assignment is deterministic in tests. Fail-soft: any store error falls back
// to the built-in code prompt so AI never breaks on a config read.
export async function resolvePrompt(id: string, vars: Record<string, unknown>, roll: number = Math.random()): Promise<ResolvedPrompt> {
  try {
    const active = await getActiveVersion(id)
    const ab = await getAb(id)
    const { version, variant } = pickArm(active, ab, roll)
    const v = await versionObj(id, version)
    const built = v.source === 'builtin' ? getPrompt(id).build(vars) : renderPrompt({ system: v.system, prompt: v.prompt }, vars)
    return { ...built, version: v.version, variant }
  } catch {
    const built = getPrompt(id).build(vars)
    return { ...built, version: BUILTIN_VERSION(id) }
  }
}
