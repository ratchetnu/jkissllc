// PRODUCT SYNC ENGINE — Internal Engineering Dashboard (Phase 11). Generates a
// self-contained static HTML file (out/dashboard.html) from the manifest registry +
// the latest discovery drift report. INTERNAL engineering tool — NOT a customer-facing
// UI, not wired into any product's app. Run via tsx.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { loadRegistry, loadProducts, writeOut, ROOT } from './lib'
import type { DriftReport, DriftSummary } from '../drift'

const registry = loadRegistry().map((r) => r.manifest)
const products = loadProducts()

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

const pending = registry.filter((m) => ['discovered', 'planned', 'approved', 'adapting', 'implemented', 'verified', 'preview-ready'].includes(m.status))
const completed = registry.filter((m) => ['merged', 'released'].includes(m.status))
const blocked = registry.filter((m) => m.status === 'blocked')
const excluded = registry.filter((m) => m.classification === 'excluded')

// Latest drift per downstream (if discovery has been run)
const driftByDownstream: { downstream: string; report: DriftReport; summary: DriftSummary }[] = []
for (const rel of products.relationships) {
  const f = path.join(ROOT, 'out', `drift-operion-to-${rel.downstream}.json`)
  if (existsSync(f)) { const d = JSON.parse(readFileSync(f, 'utf8')); driftByDownstream.push({ downstream: rel.downstream, ...d }) }
}

const badge = (s: string) => `<span class="b b-${s}">${esc(s)}</span>`
const row = (m: (typeof registry)[number]) => `<tr>
  <td class="mono">${esc(m.id)}</td>
  <td>${esc(m.title)}</td>
  <td>${esc(m.product.upstream)}→${esc(m.product.downstream)}</td>
  <td>${badge(m.classification)}</td>
  <td>${badge(m.status)}</td>
  <td>${esc(m.riskLevel)}</td>
  <td>${m.surface.featureFlags.map(esc).join('<br>') || '—'}</td>
  <td>${m.dependencies.map(esc).join(', ') || '—'}</td>
</tr>`

const section = (title: string, items: typeof registry) => items.length ? `
  <h2>${esc(title)} <span class="count">${items.length}</span></h2>
  <table><thead><tr><th>ID</th><th>Title</th><th>Path</th><th>Class</th><th>Status</th><th>Risk</th><th>Flags</th><th>Deps</th></tr></thead>
  <tbody>${items.map(row).join('')}</tbody></table>` : ''

const historyRows = registry.flatMap((m) => m.history.map((h) => ({ id: m.id, ...h }))).sort((a, b) => (a.at < b.at ? 1 : -1))

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Product Sync — Engineering Dashboard</title>
<style>
:root{--bg:#0b0d10;--card:#14181d;--line:#232a31;--txt:#e6e9ec;--mut:#8b97a3;--red:#E0002A}
body{background:var(--bg);color:var(--txt);font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:32px;max-width:1200px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px} .sub{color:var(--mut);margin-bottom:24px}
h2{font-size:16px;margin:28px 0 10px;border-bottom:1px solid var(--line);padding-bottom:6px}
.count{color:var(--mut);font-weight:400;font-size:13px}
.kpis{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;min-width:120px}
.kpi .n{font-size:24px;font-weight:800} .kpi .l{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mut);font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.04em}
.mono{font-family:ui-monospace,Menlo,monospace}
.b{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:700;border:1px solid var(--line)}
.b-excluded,.b-rejected{color:#f87171;border-color:#5b2126}.b-blocked{color:#fbbf24;border-color:#5b4a1a}
.b-released,.b-merged{color:#4ade80;border-color:#1f5b2f}.b-direct-port{color:#4ade80}
.b-adaptation-required{color:#60a5fa}.b-partially-present{color:#fbbf24}.b-discovered,.b-planned,.b-approved{color:#8b97a3}
.drift{display:flex;gap:8px;flex-wrap:wrap}.chip{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:12px}
.note{color:var(--mut);font-size:12px;margin-top:6px}
</style></head><body>
<h1>Product Synchronization — Engineering Dashboard</h1>
<div class="sub">Internal tooling · generated ${new Date().toISOString()} · ${registry.length} manifest(s) · NOT customer-facing</div>

<div class="kpis">
  <div class="kpi"><div class="n">${pending.length}</div><div class="l">Pending</div></div>
  <div class="kpi"><div class="n">${completed.length}</div><div class="l">Completed</div></div>
  <div class="kpi"><div class="n">${blocked.length}</div><div class="l">Blocked</div></div>
  <div class="kpi"><div class="n">${excluded.length}</div><div class="l">Excluded</div></div>
  <div class="kpi"><div class="n">${Object.keys(products.products).length}</div><div class="l">Products</div></div>
</div>

<h2>Products</h2>
<table><thead><tr><th>ID</th><th>Role</th><th>Repo</th><th>Default branch</th></tr></thead><tbody>
${Object.values(products.products).map((p) => `<tr><td class="mono">${esc(p.id)}</td><td>${esc(p.role)}</td><td class="mono">${esc(p.repo)}</td><td>${esc(p.defaultBranch)}</td></tr>`).join('')}
</tbody></table>
<div class="note">Downstream products have unrelated git histories → discovery is content-based.</div>

${section('Pending updates', pending)}
${section('Completed updates', completed)}
${section('Blocked updates', blocked)}
${section('Excluded (intentionally different)', excluded)}

<h2>Current drift <span class="count">${driftByDownstream.length ? 'latest discovery' : 'run discovery first'}</span></h2>
${driftByDownstream.length ? driftByDownstream.map((d) => `
  <div><strong>operion → ${esc(d.downstream)}</strong> · ${d.summary.total} items (upstream ${esc(d.report.upstream.head)} / downstream ${esc(d.report.downstream.head)})</div>
  <div class="drift">${Object.entries(d.summary.byKind).sort((a, b) => (b[1] as number) - (a[1] as number)).map(([k, n]) => `<span class="chip">${esc(k)}: <strong>${n}</strong></span>`).join('')}</div>`).join('') : '<div class="note">No discovery report found. Run: npm run sync:discover</div>'}

<h2>Manifest history <span class="count">${historyRows.length}</span></h2>
<table><thead><tr><th>When</th><th>Manifest</th><th>From→To</th><th>Actor</th><th>Note</th></tr></thead><tbody>
${historyRows.map((h) => `<tr><td class="mono">${esc(h.at)}</td><td class="mono">${esc(h.id)}</td><td>${esc(h.from ?? '∅')}→${badge(h.to)}</td><td>${esc(h.actor)}</td><td>${esc(h.note ?? '')}</td></tr>`).join('')}
</tbody></table>

<h2>Feature rollout history <span class="count">flags by manifest</span></h2>
<table><thead><tr><th>Manifest</th><th>Flags introduced</th><th>Default</th><th>Status</th></tr></thead><tbody>
${registry.filter((m) => m.surface.featureFlags.length).map((m) => `<tr><td class="mono">${esc(m.id)}</td><td>${m.surface.featureFlags.map(esc).join(', ')}</td><td>${m.rollout.featureFlagsOffByDefault ? 'OFF' : '<span class="b b-blocked">ON?</span>'}</td><td>${badge(m.status)}</td></tr>`).join('')}
</tbody></table>

</body></html>`

const out = writeOut('dashboard.html', html)
console.log(`Engineering dashboard → ${path.relative(ROOT, out)}`)
console.log(`  ${pending.length} pending · ${completed.length} completed · ${blocked.length} blocked · ${excluded.length} excluded · ${registry.length} manifests`)
console.log(`  open: file://${out}`)
