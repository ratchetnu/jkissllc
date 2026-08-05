// ─────────────────────────────────────────────────────────────────────────────
// Vision benchmark — image acquisition.
//
// SOURCE. Openverse (api.openverse.org), the CC-licensed image index. It is used
// instead of scraping a search engine for three reasons that matter here: it
// exposes a documented API intended for programmatic use, it returns the LICENCE
// and the ORIGINAL source page for every result, and it needs no key. Search
// engines disallow automated result scraping in robots.txt, so they are not used
// for fetching at all — a human may of course use one for discovery and paste a
// source page in by hand.
//
// WHAT IS FETCHED. Only images whose reported licence permits commercial use AND
// modification (CC0, PDM, BY, BY-SA). Every rejection is written to the
// rejected-source log with its reason, so the dataset's exclusions are auditable
// rather than invisible. `licenseVerified` stays FALSE on everything this script
// writes: an API field is a strong signal, not a legal opinion, and a human
// confirms it in review.
//
// WHAT IS NOT DONE. No authentication, paywall, CAPTCHA or anti-bot system is
// touched. Requests are rate-limited and identified by a descriptive User-Agent.
// Candidates whose text suggests people, children, documents or plates are
// demoted to human review rather than auto-accepted — a text screen cannot see a
// photograph, and pretending otherwise would put the burden in the wrong place.
//
// Run: npx tsx tools/vision-benchmark/acquire.ts --pilot
// ─────────────────────────────────────────────────────────────────────────────

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import {
  licenseDecision, piiRisk, type ManifestEntry, type JobType,
} from './schema'
import {
  datasetRoot, paths, loadManifest, saveManifest, loadRejected, saveRejected,
  sha256, dHashFromGray, findDuplicates,
} from './dataset'
import { generateQueries, ALL_CATEGORIES, PILOT_TARGET_PER_CATEGORY, type GeneratedQuery } from './queries'

const UA = 'jkiss-vision-benchmark/1.0 (internal model evaluation; contact nunubaby@icloud.com)'
const API = 'https://api.openverse.org/v1/images/'
const REQUEST_GAP_MS = 1_200        // deliberate rate limiting; be a good citizen
const MIN_EDGE_PX = 480             // below this the model cannot resolve objects
const MAX_BYTES = 12 * 1024 * 1024
const CHECKPOINT_EVERY = 10          // flush the manifest this often, so a killed run loses nothing

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type OpenverseResult = {
  id: string
  title?: string
  url?: string
  foreign_landing_url?: string
  license?: string
  license_version?: string
  source?: string
  provider?: string
  creator?: string
  width?: number
  height?: number
  tags?: Array<{ name?: string }>
}

async function search(query: string, pageSize: number): Promise<OpenverseResult[]> {
  const url = `${API}?q=${encodeURIComponent(query)}&license_type=commercial,modification&page_size=${pageSize}`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
    if (!res.ok) { console.warn(`  [search] ${res.status} for "${query}"`); return [] }
    const j = await res.json() as { results?: OpenverseResult[] }
    return Array.isArray(j.results) ? j.results : []
  } catch (e) {
    console.warn(`  [search] failed for "${query}": ${e instanceof Error ? e.message : e}`)
    return []
  }
}

async function download(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' })
    if (!res.ok) return null
    const len = Number(res.headers.get('content-length') ?? 0)
    if (len > MAX_BYTES) return null
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.length > 0 && buf.length <= MAX_BYTES ? buf : null
  } catch { return null }
}

/** Perceptual hash + dimensions, straight from the bytes. Null when undecodable. */
async function fingerprint(buf: Buffer): Promise<{ phash: string; width: number; height: number } | null> {
  try {
    const img = sharp(buf, { failOn: 'error' })
    const meta = await img.metadata()
    if (!meta.width || !meta.height) return null
    const raw = await sharp(buf).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer()
    return { phash: dHashFromGray([...raw]), width: meta.width, height: meta.height }
  } catch { return null }
}

const domainOf = (u: string): string => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return '' } }

export type AcquireOptions = {
  perCategory: number
  jobTypes: JobType[]
  dryRun: boolean
  maxQueries?: number
}

export async function acquire(opts: AcquireOptions): Promise<void> {
  const root = datasetRoot()
  const p = paths(root)
  mkdirSync(p.images, { recursive: true })

  const manifest = loadManifest(root)
  const rejected = loadRejected(root)
  const haveSha = new Set(manifest.map(e => e.sha256))
  const haveSource = new Set(manifest.map(e => e.sourceImageUrl))
  const perCategoryCount = new Map<string, number>()
  for (const e of manifest) perCategoryCount.set(e.category, (perCategoryCount.get(e.category) ?? 0) + 1)

  const queries = generateQueries(ALL_CATEGORIES.filter(c => opts.jobTypes.includes(c.jobType)))
  const limited = opts.maxQueries ? queries.slice(0, opts.maxQueries) : queries
  console.log(`\nVision benchmark acquisition`)
  console.log(`  store        : ${root}`)
  console.log(`  queries      : ${limited.length}`)
  console.log(`  per-category : ${opts.perCategory}`)
  console.log(`  mode         : ${opts.dryRun ? 'DRY RUN (no downloads)' : 'live'}\n`)

  let accepted = 0, skipped = 0
  const reject = (r: GeneratedQuery, res: OpenverseResult, reason: string, license: string) => {
    rejected.push({
      sourcePageUrl: res.foreign_landing_url ?? '', sourceImageUrl: res.url ?? '',
      sourceDomain: domainOf(res.foreign_landing_url ?? res.url ?? ''),
      license, reason, searchQuery: r.query, at: new Date().toISOString(),
    })
  }

  for (const q of limited) {
    if ((perCategoryCount.get(q.category) ?? 0) >= opts.perCategory) continue
    const results = await search(q.query, 8)
    await sleep(REQUEST_GAP_MS)
    if (results.length === 0 && q.expectThin) console.log(`  [thin] "${q.query}" → 0 permissive results (expected)`)

    for (const res of results) {
      if ((perCategoryCount.get(q.category) ?? 0) >= opts.perCategory) break
      const imageUrl = res.url ?? ''
      const pageUrl = res.foreign_landing_url ?? ''
      if (!imageUrl || !pageUrl) { skipped++; continue }
      if (haveSource.has(imageUrl)) { skipped++; continue }

      // 1) Licence gate — the only thing that decides whether we may fetch at all.
      const decision = licenseDecision(res.license)
      if (!decision.permitted) { reject(q, res, decision.reason, decision.license); skipped++; continue }

      // 2) Personal-information text screen — demotes, never certifies.
      const text = [res.title, res.creator, ...(res.tags ?? []).map(t => t?.name)].filter(Boolean).join(' ')
      const pii = piiRisk(text)

      if (opts.dryRun) {
        console.log(`  [would fetch] ${q.category} ← ${domainOf(pageUrl)} (${decision.license})${pii.risky ? ' ⚠ pii-terms' : ''}`)
        perCategoryCount.set(q.category, (perCategoryCount.get(q.category) ?? 0) + 1)
        accepted++
        continue
      }

      // 3) Fetch.
      const buf = await download(imageUrl)
      await sleep(REQUEST_GAP_MS)
      if (!buf) { reject(q, res, 'download failed or too large', decision.license); skipped++; continue }

      const hash = sha256(buf)
      if (haveSha.has(hash)) { skipped++; continue }        // exact duplicate already held

      const fp = await fingerprint(buf)
      if (!fp) { reject(q, res, 'undecodable image', decision.license); skipped++; continue }
      if (Math.min(fp.width, fp.height) < MIN_EDGE_PX) {
        reject(q, res, `too small (${fp.width}×${fp.height}) — the model cannot resolve objects`, decision.license)
        skipped++; continue
      }

      const id = `${q.jobType === 'moving' ? 'mv' : 'jr'}_${q.category}_${hash.slice(0, 10)}`
      const ext = (imageUrl.match(/\.(jpe?g|png|webp)(?:$|\?)/i)?.[1] ?? 'jpg').toLowerCase()
      const rel = join(q.jobType, q.category, `${id}.${ext}`)
      const abs = join(p.images, rel)
      mkdirSync(join(p.images, q.jobType, q.category), { recursive: true })
      writeFileSync(abs, buf)

      const entry: ManifestEntry = {
        id, jobType: q.jobType, category: q.category,
        sourcePageUrl: pageUrl, sourceImageUrl: imageUrl, sourceDomain: domainOf(pageUrl),
        license: decision.license, licenseVerified: false, downloadPermitted: true,
        searchQuery: q.query,
        // Ground truth is a HUMAN output. Nothing here is guessed from the title.
        expectedObjects: [], expectedQuantityRange: null, expectedVolumeRangeCubicYards: null,
        expectedTruckSpaceRangePercent: null, expectedHandlingFlags: [],
        lighting: null, clutter: null, imageQuality: null, containsPeople: null,
        reviewStatus: 'pending',
        labelStatus: 'unlabelled',
        expectedCrewRange: null, expectedLaborHoursRange: null,
        disposalFlags: [], accessConcerns: [],
        labelConfidence: null, difficulty: null,
        notes: pii.risky ? `AUTO: title/tags mention ${pii.matched.join(', ')} — check for identifiable people or documents` : '',
        storedPath: rel, sha256: hash, phash: fp.phash,
        widthPx: fp.width, heightPx: fp.height, bytes: buf.length,
        attribution: [res.creator, res.source, decision.license].filter(Boolean).join(' / '),
        fetchedAt: new Date().toISOString(),
        split: 'unassigned',
      }
      manifest.push(entry)
      haveSha.add(hash); haveSource.add(imageUrl)
      perCategoryCount.set(q.category, (perCategoryCount.get(q.category) ?? 0) + 1)
      accepted++
      console.log(`  [+] ${id} (${fp.width}×${fp.height}, ${decision.license})`)

      // Checkpoint. A long acquisition run interrupted at minute nine would
      // otherwise leave images on disk with NO manifest row — bytes whose licence
      // and provenance we no longer know, which is exactly the thing we must never
      // have. Cheap insurance: the manifest is small and the write is local.
      if (accepted % CHECKPOINT_EVERY === 0) { saveManifest(manifest, root); saveRejected(rejected, root) }
    }
  }

  if (!opts.dryRun) {
    saveManifest(manifest, root)
    saveRejected(rejected, root)
    const dupes = findDuplicates(manifest)
    console.log(`\n  manifest      : ${manifest.length} images`)
    console.log(`  accepted now  : ${accepted}   skipped: ${skipped}`)
    console.log(`  rejected log  : ${rejected.length} entries`)
    console.log(`  exact dupes   : ${dupes.exact.length}   near dupes: ${dupes.near.length}`)
    console.log(`\n  Nothing is approved yet — every entry is reviewStatus="pending".`)
    console.log(`  Next: npx tsx tools/vision-benchmark/label.ts   (licence + content + ground truth)\n`)
  } else {
    console.log(`\n  would accept ${accepted}, skip ${skipped}. No files written.\n`)
  }
}

// Only run the CLI when this file IS the entry point — importing it (tests, other
// tooling) must never kick off network acquisition.
if (require.main === module) {
  const argv = process.argv.slice(2)
  const jobTypes: JobType[] = argv.includes('--junk') ? ['junk_removal']
    : argv.includes('--moving') ? ['moving']
      : ['junk_removal', 'moving']
  const perCategory = Number(argv.find(a => a.startsWith('--per='))?.split('=')[1]) || PILOT_TARGET_PER_CATEGORY
  const maxQueries = Number(argv.find(a => a.startsWith('--max-queries='))?.split('=')[1]) || undefined
  void acquire({ perCategory, jobTypes, dryRun: argv.includes('--dry-run'), maxQueries })
    .catch(e => { console.error('acquisition failed:', e); process.exitCode = 1 })
}
