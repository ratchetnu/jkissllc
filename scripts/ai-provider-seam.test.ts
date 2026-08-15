// AI_PROVIDER seam — the transport can change; the model's IDENTITY cannot.
//
// Operion names every model by a canonical "provider/model" string. routing.ts resolves
// one, cost-tables.ts is keyed on one, telemetry records one, and the AI Command Center
// groups by one. The Vercel AI Gateway happens to accept that string as its wire format,
// which made identity and transport look like the same thing for as long as there was
// only one transport. They are not, and this file is what keeps them apart.
//
//   S1  the default path is byte-identical to the old behavior (this ships inert)
//   S2  the anthropic path strips the routing prefix, and ONLY the routing prefix
//   S3  a model the active transport cannot serve fails loudly, never silently
//   S4  that failure is classified non-retryable — config errors must not burn retries
//   S5  identity survives the swap, and the cost table proves why that matters
//   S6  customer-facing copy never names our vendor, our account, or our balance
//   S7  the operator hint names the transport that ACTUALLY failed
//   S8  aiConfigured() checks the credential for the ACTIVE transport
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveModel,
  aiProvider,
  aiConfigured,
  classifyAiError,
  friendlyError,
  operatorHint,
} from '../app/lib/ai'
import { isKnownModel, estimateCostUsd } from '../app/lib/ai/cost-tables'

/** Run `fn` with a patched environment, restoring exactly what was there before. */
function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>()
  for (const k of Object.keys(patch)) saved.set(k, process.env[k])
  try {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    return fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const CANON = 'anthropic/claude-sonnet-4-6'

// ── S1 — inert by default ────────────────────────────────────────────────────

test('S1: with AI_PROVIDER unset, the model is passed through untouched', () => {
  withEnv({ AI_PROVIDER: undefined }, () => {
    assert.equal(aiProvider(), 'gateway')
    // A plain string is what the AI SDK has always received. If this ever stops being
    // strictly equal, the "default path is unchanged" claim behind shipping this
    // flag-off is false.
    assert.equal(resolveModel(CANON), CANON)
  })
})

test('S1: only the exact string "anthropic" opts in — no fuzzy matching', () => {
  for (const v of ['', ' ', 'Gateway', 'anthropik', 'anthropic-direct', 'true', '1']) {
    withEnv({ AI_PROVIDER: v }, () => {
      assert.equal(aiProvider(), 'gateway', `AI_PROVIDER=${JSON.stringify(v)} must not opt in`)
    })
  }
  // …but the real value opts in regardless of casing/padding, because an env var typed
  // by a human in a dashboard is routinely " Anthropic".
  for (const v of ['anthropic', 'ANTHROPIC', '  Anthropic  ']) {
    withEnv({ AI_PROVIDER: v }, () => assert.equal(aiProvider(), 'anthropic'))
  }
})

// ── S2 — prefix stripping ────────────────────────────────────────────────────

test('S2: the anthropic path strips the routing prefix', () => {
  const m = resolveModel(CANON, 'anthropic')
  assert.notEqual(typeof m, 'string', 'the anthropic path must resolve a model handle, not a string')
  assert.equal((m as { modelId: string }).modelId, 'claude-sonnet-4-6')
})

test('S2: a bare model id is already transport-native and passes through', () => {
  const m = resolveModel('claude-haiku-4-5', 'anthropic')
  assert.equal((m as { modelId: string }).modelId, 'claude-haiku-4-5')
})

test('S2: only the FIRST segment is treated as a prefix', () => {
  // Model ids are not guaranteed to be slash-free forever. Splitting on every slash
  // would silently truncate such an id to its first segment and call a different model.
  const m = resolveModel('anthropic/vendor/model-x', 'anthropic')
  assert.equal((m as { modelId: string }).modelId, 'vendor/model-x')
})

// ── S3 / S4 — fail loudly, and do not retry ──────────────────────────────────

test('S3: a non-anthropic model under AI_PROVIDER=anthropic THROWS', () => {
  // The tempting alternative — quietly fall back to the default Anthropic model — would
  // still return a 200 with plausible text, while cost was priced against the requested
  // model and the quality score was attributed to it. Every downstream number would be
  // wrong and nothing would look broken.
  assert.throws(
    () => resolveModel('openai/gpt-4o', 'anthropic'),
    /AI config error:[\s\S]*openai\/gpt-4o/,   // [\s\S] not /s — the tsconfig target predates dotAll
  )
  assert.throws(() => resolveModel('google/gemini-2.5-flash', 'anthropic'), /AI config error:/)
})

test('S3: the same models resolve fine on the gateway path', () => {
  // Proves the throw is about the ACTIVE TRANSPORT, not about the model being invalid.
  assert.equal(resolveModel('openai/gpt-4o', 'gateway'), 'openai/gpt-4o')
})

test('S4: a config error is classified non-retryable', () => {
  const e = (() => { try { resolveModel('openai/gpt-4o', 'anthropic') } catch (x) { return x } })()
  const cls = classifyAiError(e)
  assert.equal(cls.kind, 'config')
  assert.equal(cls.retryable, false,
    'retrying cannot fix an env var; a retryable config error burns the whole attempt budget')
})

test('S4: MUTATION GUARD — without its own branch, a config error is retried', () => {
  // Delete the `/^AI config error:/` branch from classifyAiError and this is what
  // happens: the message matches none of the remaining patterns, so it falls through to
  // the 'unknown' default, which is retryable: true. This test is here so that deletion
  // fails loudly instead of quietly re-issuing an impossible call N times.
  const msg = 'AI config error: AI_PROVIDER=anthropic cannot serve "openai/gpt-4o".'
  assert.doesNotMatch(msg, /\btimed?\s?out\b|\babort/i)
  assert.doesNotMatch(msg, /schema|invalid|parse|validation|unsupported/i)
  assert.doesNotMatch(msg, /credit|quota|billing|payment|insufficient|unauthor|forbidden|api key|token/i)
})

// ── S5 — identity survives, and the cost table shows why ─────────────────────

test('S5: the cost table prices the CANONICAL id, not the transport-native one', () => {
  // This is the whole reason resolveModel() converts at the last moment instead of
  // rewriting the id upstream. If the bare id leaked into telemetry, every Anthropic-path
  // call would miss its rate row, fall back to the default rate, and be silently
  // mispriced — while `rateFallback` quietly flipped true on 100% of traffic.
  assert.equal(isKnownModel(CANON), true)
  assert.equal(isKnownModel('claude-sonnet-4-6'), false,
    'the bare id has no rate row — it must never reach the cost table')

  // Haiku makes the mispricing concrete: 1/5 published vs the 3/15 Sonnet-class default.
  const known = estimateCostUsd('anthropic/claude-haiku-4-5', 1_000_000, 1_000_000)
  const bare = estimateCostUsd('claude-haiku-4-5', 1_000_000, 1_000_000)
  assert.equal(known, 6)
  assert.equal(bare, 18)
  assert.ok(bare > known * 2, 'losing identity would overstate Haiku spend threefold')
})

// ── S6 — customer-facing copy is vendor-free ─────────────────────────────────

test('S6: no customer-facing message names our vendor, account, or balance', () => {
  // POST /api/ai/photo-estimate returns this string verbatim in its 503 body. Before this
  // change a depleted balance rendered as "AI Gateway needs credits enabled on your
  // Vercel account to use this" — shipped to a member of the public who uploaded a photo.
  const errors = [
    new Error('Insufficient credits for this request'),
    new Error('402 payment required: quota exceeded'),
    new Error('Unauthorized: invalid api key'),
    new Error('403 forbidden'),
    new Error('AI config error: AI_PROVIDER=anthropic cannot serve "openai/gpt-4o".'),
    new Error('something completely unexpected'),
  ]
  for (const e of errors) {
    const msg = friendlyError(e)
    assert.doesNotMatch(msg, /vercel|gateway|anthropic|api[ _-]?key|token|account|billing|credits?\b/i,
      `leaked infrastructure detail to a customer: ${JSON.stringify(msg)}`)
    assert.ok(msg.length > 0)
  }
})

test('S6: a timeout still reads as a timeout — the safe rewrite kept the useful case', () => {
  const t = Object.assign(new Error('request timed out'), { name: 'TimeoutError' })
  assert.match(friendlyError(t), /timed out/i)
})

// ── S7 — the operator hint points at the right vendor ────────────────────────

test('S7: the billing hint names the transport that actually failed', () => {
  const billing = new Error('Insufficient credits')
  withEnv({ AI_PROVIDER: 'anthropic' }, () => {
    const h = operatorHint(billing)
    assert.match(h, /anthropic/i)
    assert.doesNotMatch(h, /vercel/i, 'topping up the wrong vendor must not be a plausible response')
  })
  withEnv({ AI_PROVIDER: undefined }, () => {
    const h = operatorHint(billing)
    assert.match(h, /vercel/i)
    assert.doesNotMatch(h, /anthropic organization/i)
  })
})

test('S7: auth and billing get DIFFERENT hints — they need different fixes', () => {
  withEnv({ AI_PROVIDER: 'anthropic' }, () => {
    assert.notEqual(operatorHint(new Error('insufficient credits')), operatorHint(new Error('invalid api key')))
    assert.match(operatorHint(new Error('invalid api key')), /ANTHROPIC_API_KEY/)
  })
})

test('S7: an ordinary failure gets no hint — an empty hint means "nothing to act on"', () => {
  assert.equal(operatorHint(new Error('the model returned malformed json')), '')
})

// ── S8 — credential check follows the active transport ───────────────────────

test('S8: aiConfigured() checks the credential for the ACTIVE transport', () => {
  withEnv({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: undefined, VERCEL_OIDC_TOKEN: 'x', AI_GATEWAY_API_KEY: undefined }, () => {
    assert.equal(aiConfigured(), false,
      'an OIDC token is not an Anthropic credential — reporting configured here would be a lie')
  })
  withEnv({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test', VERCEL_OIDC_TOKEN: undefined }, () => {
    assert.equal(aiConfigured(), true)
  })
  withEnv({ AI_PROVIDER: undefined, ANTHROPIC_API_KEY: 'sk-ant-test', VERCEL_OIDC_TOKEN: undefined, AI_GATEWAY_API_KEY: undefined }, () => {
    assert.equal(aiConfigured(), false,
      'an Anthropic key does not configure the Gateway path')
  })
})
