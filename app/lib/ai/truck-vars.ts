// ── Truck facts for prompt rendering ─────────────────────────────────────────
// Every vision prompt that asks the model "how much of the truck does this fill?"
// needs to name a truck. That number is fleet-dependent — J KISS runs a 24 ft box
// (~1,000 cu ft loadable), a branded clone may run a 26 ft (~1,400) — so it is a
// per-tenant SETTING, not a constant compiled into the prompt text.
//
// This module is the one place that turns the stored setting into render vars, so
// a fleet change is a single admin edit rather than a prompt edit in three files.

import { getDisposalSettings } from '../disposal'
import { truckPromptVars, TRUCK_PROMPT_DEFAULTS } from './prompts'

/**
 * Truck render vars for the current tenant.
 *
 * Fail-soft on purpose: a Redis hiccup must not take down photo quoting, and it
 * must not silently render an EMPTY capacity into the prompt either — a prompt
 * reading "a box truck holding about  cubic feet" invites the model to invent a
 * truck, which is exactly the failure this whole change exists to remove. On any
 * read error the house truck is used and the caller is none the wiser.
 */
export async function truckVars(): Promise<Record<string, unknown>> {
  try {
    return truckPromptVars(await getDisposalSettings())
  } catch {
    return { ...TRUCK_PROMPT_DEFAULTS }
  }
}
