import { modelForFeature } from './routing'
import { getPrompt } from './prompts'
import { isKnownModel } from './telemetry'

// AI Feature Registry (LLMOps Phase 3). The single documented catalog of every AI
// capability in the platform — what it does, where it runs, which model + prompt it
// uses, who can invoke it, who owns it, and its lifecycle status. This is the
// authoritative inventory the AI Control Center renders; live usage/cost metrics are
// joined onto it at read time (registry = static contract, telemetry = runtime truth).

export type FeatureAccess = 'public' | 'permission'
export type FeatureStatus = 'ga' | 'beta'
export type FeatureInput = 'text' | 'multimodal'

export type AiFeatureDef = {
  taskId: string            // prompt registry id (also the analytics `feature` key)
  name: string              // human label
  description: string       // what it produces
  surface: string           // where it's exposed in the product
  owner: string             // accountable team/role
  access: FeatureAccess     // public (rate-limited) or permission-gated
  permission?: string       // RBAC permission when access = 'permission'
  input: FeatureInput
  structured: boolean       // validated against a schema?
  writes: false             // INVARIANT: no AI feature writes authoritative business data
  status: FeatureStatus
}

// Ordered, stable catalog. Adding an AI feature = adding an entry here (and a prompt).
export const AI_FEATURES: AiFeatureDef[] = [
  {
    taskId: 'ops.command', name: 'Command Palette (⌘K)',
    description: 'Maps a natural-language request to one allowlisted navigation target, or answers a factual question from provided counts.',
    surface: 'Admin ⌘K command bar', owner: 'Operations Platform',
    access: 'permission', permission: 'ai:use', input: 'text', structured: true, writes: false, status: 'ga',
  },
  {
    taskId: 'ops.message', name: 'Customer Message Draft',
    description: 'Drafts a short, warm SMS/email to a customer from booking facts. Draft-only — never auto-sent.',
    surface: 'Admin booking detail', owner: 'Customer Comms',
    access: 'permission', permission: 'ai:use', input: 'text', structured: false, writes: false, status: 'ga',
  },
  {
    taskId: 'ops.insights', name: 'Owner Insights Briefing',
    description: 'Summarizes booking analytics into a short owner briefing plus two high-ROI actions.',
    surface: 'Admin analytics', owner: 'Operations Platform',
    access: 'permission', permission: 'ai:use', input: 'text', structured: false, writes: false, status: 'ga',
  },
  {
    taskId: 'ops.reviewReply', name: 'Review Reply Draft',
    description: 'Drafts a warm public reply to a customer review. Draft-only.',
    surface: 'Admin reviews', owner: 'Customer Comms',
    access: 'permission', permission: 'ai:use', input: 'text', structured: false, writes: false, status: 'ga',
  },
  {
    taskId: 'ops.photoEstimate', name: 'Photo Junk Estimate',
    description: 'Estimates junk-removal load size + price range from a customer photo. Public, rate-limited, bot-checked.',
    surface: 'Public quote page', owner: 'Growth',
    access: 'public', input: 'multimodal', structured: true, writes: false, status: 'ga',
  },
]

export type AiFeatureView = AiFeatureDef & {
  model: string            // model currently routed to this feature
  modelKnownRate: boolean  // false → cost is a fallback estimate (AUDIT-F4)
  promptVersion: number    // active built-in prompt version
}

// The registry joined with current routing + prompt version (no telemetry here — the
// API layer joins live metrics). Pure + synchronous.
export function featureCatalog(): AiFeatureView[] {
  return AI_FEATURES.map(f => {
    const model = modelForFeature(f.taskId)
    let promptVersion = 0
    try { promptVersion = getPrompt(f.taskId).version } catch { promptVersion = 0 }
    return { ...f, model, modelKnownRate: isKnownModel(model), promptVersion }
  })
}

export function getFeatureDef(taskId: string): AiFeatureDef | undefined {
  return AI_FEATURES.find(f => f.taskId === taskId)
}
