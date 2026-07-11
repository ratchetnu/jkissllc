// Version-controlled prompt registry (LLMOps Phase 1). Every prompt the AI service
// runs lives here with an explicit version that is bumped on any change and recorded
// on each call — so a prompt is a reviewable, versioned artifact, not a string
// buried in a route handler. Prompts are pure builders (vars → {system, prompt}).

export type BuiltPrompt = { system: string; prompt: string }
export type PromptDef = {
  id: string
  version: number
  description: string
  build: (vars: Record<string, unknown>) => BuiltPrompt
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// ── ops.command — the ⌘K natural-language command palette ────────────────────
// Read-only by construction: the model may only echo a target id from the provided
// allowlist (the server maps id→href), or answer from the provided DATA. It never
// emits URLs and is forbidden from inventing facts.
const opsCommand: PromptDef = {
  id: 'ops.command',
  version: 1,
  description: 'Map an operator request to one allowlisted navigation target, or answer a factual question from provided counts. Read-only.',
  build: (vars) => ({
    system:
      'You are the command bar for OpsPilot, a logistics operations platform. Map the user\'s request to exactly ONE target from the TARGETS list, or answer a short factual question using ONLY the DATA provided. ' +
      'Respond with a single minified JSON object and nothing else. To navigate: {"targetId":"<id from TARGETS>"}. To answer: {"answer":"<one or two sentences>"}. ' +
      'Never invent ids, routes, names, numbers, or facts. If nothing fits, return {"targetId":"ops"}. Prefer navigation over answering when the user clearly wants to go somewhere or do something.',
    prompt:
      `USER REQUEST: ${str(vars.query)}\n\n` +
      `TARGETS (id — description):\n${str(vars.targetsText)}\n\n` +
      `DATA (for factual answers only):\n${str(vars.summaryJson)}`,
  }),
}

const REGISTRY: Record<string, PromptDef> = {
  [opsCommand.id]: opsCommand,
}

export function getPrompt(id: string): PromptDef {
  const p = REGISTRY[id]
  if (!p) throw new Error(`unknown prompt: ${id}`)
  return p
}

export function hasPrompt(id: string): boolean {
  return id in REGISTRY
}

export function listPrompts(): Array<Pick<PromptDef, 'id' | 'version' | 'description'>> {
  return Object.values(REGISTRY).map(({ id, version, description }) => ({ id, version, description }))
}
