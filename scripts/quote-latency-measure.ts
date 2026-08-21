// Stage measurement for the interactive photo estimate.
//
// Measures every stage that does NOT require a provider call, plus the resolved
// configuration of the stages that do. Uses non-customer fixture photos supplied on
// argv. Emits NO image bytes, no prompts, no credentials, no provider responses.
import { Jimp } from 'jimp'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { optimizeForModel } from '../app/lib/image-optimize'
import { analysisOutputTokenBudget, analysisTimeoutMs } from '../app/lib/ai/junk-analysis'
import { DEFAULT_INTERACTIVE_BUDGET as B, interactiveBudget, outputTokensForSlice } from '../app/lib/ai/interactive-policy'
import { normalizeAnalysis } from '../app/lib/ai/analysis-schema'

const CLIENT_MAX_EDGE = 1280   // app/quote/page.tsx downscaleToDataUrl default
const CLIENT_QUALITY = 70      // 0.7
const TOK_PER_SEC = 107        // measured rate cited in junk-analysis.ts

/** Reproduce exactly what the browser uploads: 1280px long edge, JPEG q0.7. */
async function clientResize(buf: Buffer) {
  const t0 = performance.now()
  const img = await Jimp.read(buf)
  const scale = Math.min(1, CLIENT_MAX_EDGE / Math.max(img.width, img.height))
  img.resize({ w: Math.round(img.width * scale), h: Math.round(img.height * scale) })
  const out = await img.getBuffer('image/jpeg', { quality: CLIENT_QUALITY })
  return { buf: out, ms: performance.now() - t0, w: img.width, h: img.height }
}

/** Anthropic's documented image-token approximation. */
const imgTokens = (w: number, h: number) => Math.ceil((w * h) / 750)

const CTX = {
  analysisId: 'measure', bookingId: 'measure', photoUrls: ['p'],
  modelProvider: 'measure', modelName: 'measure', analyzedAt: '2026-01-01T00:00:00.000Z',
}

async function main() {
  const files = process.argv.slice(2)
  if (!files.length) { console.error('usage: tsx scratch/measure-stages.ts <img>...'); process.exit(2) }

  console.log('=== RESOLVED CONFIGURATION ===')
  console.log(`route maxDuration (function limit) : 60000 ms`)
  console.log(`interactive route ceiling          : ${B.routeCeilingMs} ms`)
  console.log(`response margin (reserved)         : ${B.responseMarginMs} ms`)
  console.log(`=> interactive deadline            : ${B.routeCeilingMs - B.responseMarginMs} ms`)
  console.log(`primary slice cap                  : ${B.primaryMaxMs} ms`)
  console.log(`primary attempts (interactive)     : ${interactiveBudget(0).primary(0).attempts}`)
  console.log(`critic cap / min                   : ${B.criticMaxMs} / ${B.criticMinMs} ms`)

  console.log('\n=== PER-IMAGE: client resize + server preprocessing ===')
  const resized: { name: string; bytes: number; w: number; h: number; tok: number }[] = []
  for (const f of files) {
    const raw = readFileSync(f)
    const r = await clientResize(raw)
    const t0 = performance.now()
    const opt = await optimizeForModel(r.buf, 'image/jpeg', {})
    const preprocMs = performance.now() - t0
    const tok = imgTokens(r.w, r.h)
    resized.push({ name: basename(f), bytes: r.buf.length, w: r.w, h: r.h, tok })
    console.log(
      `${basename(f).padEnd(16)} orig ${(raw.length / 1048576).toFixed(2)}MB -> client ${r.w}x${r.h} `
      + `${(r.buf.length / 1024).toFixed(0)}KB in ${r.ms.toFixed(0)}ms | server-preproc ${preprocMs.toFixed(0)}ms `
      + `applied=${opt.metrics.applied} | ~${tok} img tokens`,
    )
  }

  console.log('\n=== MATRIX: request shape vs the interactive slice ===')
  console.log('n | imgBytes | imgTokens | outTokBudget | ~genMs@107t/s | durableAllowance | interactiveSlice | verdict')
  for (const n of [1, 2, 4, Math.min(8, resized.length)].filter((v, i, a) => v <= resized.length && a.indexOf(v) === i)) {
    const set = resized.slice(0, n)
    const bytes = set.reduce((s, r) => s + r.bytes, 0)
    const itok = set.reduce((s, r) => s + r.tok, 0)
    const otok = analysisOutputTokenBudget(n)
    const genMs = Math.round((otok / TOK_PER_SEC) * 1000)
    const durable = analysisTimeoutMs(n)
    const fits = genMs <= B.primaryMaxMs
    console.log(
      `${n} | ${(bytes / 1024).toFixed(0)}KB | ~${itok} | ${otok} | ~${genMs} | ${durable}ms | ${B.primaryMaxMs}ms | `
      + `${fits ? 'fits' : 'CANNOT FIT (generation alone exceeds the slice)'}`,
    )
  }

  console.log('\n=== WITH THE COUPLING FIX: what the slice can actually buy ===')
  console.log('n | cap | asked | ~genMs | +overhead | fits 32s slice?')
  for (const n of [1, 2, 4, 8]) {
    const cap = analysisOutputTokenBudget(n)
    const asked = outputTokensForSlice(B.primaryMaxMs, cap)
    const gen = Math.round((asked / TOK_PER_SEC) * 1000)
    const total = gen + B.fixedOverheadMs
    console.log(`${n} | ${cap} | ${asked} | ~${gen} | ~${total} | ${total <= B.primaryMaxMs ? 'YES' : 'no'}`)
  }

  console.log('\n=== JSON parse + schema validation cost (no provider needed) ===')
  // A worst-case-shaped payload: one photoObservation per photo, 8 normalizedItems.
  const mk = (n: number) => JSON.stringify({
    normalizedItems: Array.from({ length: 8 }, (_, i) => ({
      label: `item ${i}`, category: 'furniture', estimatedQuantity: 2, confidence: 0.8,
      bulky: true, heavy: false, weightLbsRange: { low: 20, high: 60 },
      sourcePhotoIds: ['p1'], evidence: 'visible in frame', specialHandling: [],
    })),
    photoObservations: Array.from({ length: n }, (_, i) => ({
      photoUrl: `p${i}`, visibleItems: [{ label: 'box', confidence: 0.7 }],
      quality: 'good', confidence: 0.7, specialHandling: [],
    })),
    estimatedTruckLoads: { low: 0.8, likely: 1.2, high: 1.6 },
    confidence: { overall: 0.7, volume: 0.7, items: 0.7 },
    additionalQuestions: [],
  })
  for (const n of [1, 4, 8]) {
    const s = mk(n)
    const t0 = performance.now()
    for (let i = 0; i < 200; i++) normalizeAnalysis(JSON.parse(s), CTX)
    const per = (performance.now() - t0) / 200
    console.log(`n=${n}: payload ${(s.length / 1024).toFixed(1)}KB | parse+validate ${per.toFixed(2)}ms/call`)
  }
}

main().catch(e => { console.error('measure failed:', e instanceof Error ? e.message : e); process.exit(1) })
