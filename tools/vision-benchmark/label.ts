// ─────────────────────────────────────────────────────────────────────────────
// Vision benchmark — human review and labelling interface.
//
// Generates a single self-contained HTML page against the local dataset and
// serves it, plus a tiny save endpoint that writes decisions back to the
// manifest. Local only, no build step, no framework.
//
// WHY A HUMAN IS REQUIRED HERE, not merely allowed:
//   • Licence — the API's licence field is a signal. A person confirms it.
//   • Content — a text screen cannot see a photograph. Identifiable people,
//     children, documents, plates and addresses are a visual judgement.
//   • Ground truth — cubic yards and truck-space percentage cannot be derived
//     from a stranger's photo by the thing being measured. If the model supplied
//     the answers, the benchmark would be grading its own homework.
//   • Hazard classification and operational reasonableness — safety calls.
//
// Ground truth is entered as a RANGE, never a single number: for most photos an
// honest label is "somewhere between 2 and 4 cubic yards", and forcing a point
// estimate would manufacture false precision that the accuracy report then treats
// as fact.
//
// Run: npx tsx tools/vision-benchmark/label.ts   → http://localhost:7391
// ─────────────────────────────────────────────────────────────────────────────

import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { datasetRoot, paths, loadManifest, saveManifest, loadGroups } from './dataset'
import type { ManifestEntry } from './schema'

const PORT = Number(process.env.LABEL_PORT) || 7391
const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
}

const HANDLING_FLAGS = [
  'heavy', 'requires_disassembly', 'stairs', 'long_carry', 'narrow_access',
  'appliance_disposal_fee', 'mattress', 'construction_debris', 'hazardous_suspected',
  'fragile', 'bulky', 'elevator',
]

function page(entries: ManifestEntry[], groupCount: number): string {
  const pending = entries.filter(e => e.reviewStatus === 'pending').length
  const approved = entries.filter(e => e.reviewStatus === 'approved').length
  const rejected = entries.filter(e => e.reviewStatus === 'rejected').length
  return `<!doctype html><html><head><meta charset="utf-8"><title>Vision benchmark — review</title>
<style>
:root{color-scheme:dark}
body{font:14px/1.5 system-ui,sans-serif;margin:0;background:#0b0b0d;color:#e7e7ea}
header{position:sticky;top:0;background:#121216;border-bottom:1px solid #26262c;padding:12px 20px;z-index:10;display:flex;gap:20px;align-items:center;flex-wrap:wrap}
h1{font-size:15px;margin:0;font-weight:700}
.counts span{margin-right:14px;color:#9b9ba4}
.counts b{color:#e7e7ea}
main{padding:20px;display:grid;gap:20px;grid-template-columns:repeat(auto-fill,minmax(430px,1fr))}
.card{background:#131318;border:1px solid #26262c;border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
.card.approved{border-color:#1f6f43}.card.rejected{border-color:#7a2230;opacity:.55}
img{width:100%;height:260px;object-fit:contain;background:#000;cursor:zoom-in}
.body{padding:12px;display:grid;gap:9px}
.meta{font-size:11px;color:#8b8b95;line-height:1.45;word-break:break-all}
.meta a{color:#7aa2f7}
label{font-size:11px;color:#9b9ba4;display:block;margin-bottom:3px;text-transform:uppercase;letter-spacing:.04em}
input,select,textarea{width:100%;background:#0b0b0d;border:1px solid #33333b;color:#e7e7ea;border-radius:7px;padding:6px 8px;font:13px system-ui;box-sizing:border-box}
textarea{resize:vertical;min-height:42px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
.flags{display:flex;flex-wrap:wrap;gap:5px}
.flags label{display:inline-flex;align-items:center;gap:4px;background:#1b1b21;border:1px solid #33333b;border-radius:999px;padding:3px 9px;font-size:11px;text-transform:none;letter-spacing:0;color:#c9c9d1;cursor:pointer;margin:0}
.flags input{width:auto}
.actions{display:flex;gap:8px;margin-top:2px}
button{flex:1;border:0;border-radius:8px;padding:9px;font-weight:700;cursor:pointer;font-size:13px}
.ok{background:#1f6f43;color:#fff}.no{background:#7a2230;color:#fff}.save{background:#2b2b34;color:#e7e7ea}
.warn{background:#3a2f10;border:1px solid #6b5518;color:#f0d68a;padding:7px 9px;border-radius:7px;font-size:12px}
.hint{font-size:11px;color:#7b7b85;font-style:italic}
</style></head><body>
<header>
  <h1>Vision benchmark — human review</h1>
  <div class="counts"><span>pending <b id="c-pending">${pending}</b></span><span>approved <b id="c-approved">${approved}</b></span><span>rejected <b id="c-rejected">${rejected}</b></span><span>job groups <b>${groupCount}</b></span></div>
  <div class="hint">Ground truth is a RANGE. Leave blank rather than guess — a blank is honest, a guess corrupts the accuracy report.</div>
</header>
<main id="grid"></main>
<script>
const ENTRIES = ${JSON.stringify(entries)};
const FLAGS = ${JSON.stringify(HANDLING_FLAGS)};
const grid = document.getElementById('grid');

function card(e){
  const d = document.createElement('div');
  d.className = 'card ' + (e.reviewStatus==='approved'?'approved':e.reviewStatus==='rejected'?'rejected':'');
  d.dataset.id = e.id;
  const gt = (r,k)=> r? r[k] : '';
  d.innerHTML = \`
    <img loading="lazy" src="/img/\${encodeURIComponent(e.storedPath)}" onclick="window.open(this.src)">
    <div class="body">
      \${e.notes && e.notes.startsWith('AUTO:') ? '<div class="warn">⚠ '+e.notes.slice(5)+'</div>' : ''}
      <div class="meta">
        <b>\${e.id}</b><br>
        \${e.jobType} · \${e.category} · \${e.widthPx}×\${e.heightPx}<br>
        licence <b>\${e.license}</b> · <a href="\${e.sourcePageUrl}" target="_blank" rel="noopener">source page</a><br>
        query: "\${e.searchQuery}"
      </div>
      <label><input type="checkbox" class="lic" \${e.licenseVerified?'checked':''} style="width:auto"> licence verified on the source page</label>
      <label><input type="checkbox" class="ppl" \${e.containsPeople?'checked':''} style="width:auto"> contains identifiable people / documents / plates</label>
      <div><label>visible objects (comma separated)</label><input class="objs" value="\${(e.expectedObjects||[]).join(', ')}"></div>
      <div class="row3">
        <div><label>qty min</label><input class="qmin" type="number" value="\${gt(e.expectedQuantityRange,'min')}"></div>
        <div><label>qty max</label><input class="qmax" type="number" value="\${gt(e.expectedQuantityRange,'max')}"></div>
        <div><label>lighting</label><select class="light"><option value="">—</option>\${['bright','normal','dim'].map(o=>'<option '+(e.lighting===o?'selected':'')+'>'+o+'</option>').join('')}</select></div>
      </div>
      <div class="row">
        <div><label>cu yd min</label><input class="vmin" type="number" step="0.5" value="\${gt(e.expectedVolumeRangeCubicYards,'min')}"></div>
        <div><label>cu yd max</label><input class="vmax" type="number" step="0.5" value="\${gt(e.expectedVolumeRangeCubicYards,'max')}"></div>
      </div>
      <div class="row">
        <div><label>truck space % min</label><input class="tmin" type="number" value="\${gt(e.expectedTruckSpaceRangePercent,'min')}"></div>
        <div><label>truck space % max</label><input class="tmax" type="number" value="\${gt(e.expectedTruckSpaceRangePercent,'max')}"></div>
      </div>
      <div class="row3">
        <div><label>clutter</label><select class="clut"><option value="">—</option>\${['low','medium','high'].map(o=>'<option '+(e.clutter===o?'selected':'')+'>'+o+'</option>').join('')}</select></div>
        <div><label>image quality</label><select class="iq"><option value="">—</option>\${['high','medium','low'].map(o=>'<option '+(e.imageQuality===o?'selected':'')+'>'+o+'</option>').join('')}</select></div>
        <div><label>label confidence</label><select class="lc"><option value="">—</option>\${['high','medium','low'].map(o=>'<option '+((e.notes||'').includes('labelconf='+o)?'selected':'')+'>'+o+'</option>').join('')}</select></div>
      </div>
      <div><label>handling flags</label><div class="flags">\${FLAGS.map(f=>'<label><input type="checkbox" class="fl" value="'+f+'" '+((e.expectedHandlingFlags||[]).includes(f)?'checked':'')+'>'+f+'</label>').join('')}</div></div>
      <div><label>notes / ambiguity (add #edge to force the edge-case set)</label><textarea class="notes">\${(e.notes||'').replace(/^AUTO:[^\\n]*\\n?/,'')}</textarea></div>
      <div class="actions">
        <button class="save" onclick="save(this,'keep')">Save</button>
        <button class="ok" onclick="save(this,'approved')">Approve</button>
        <button class="no" onclick="save(this,'rejected')">Reject</button>
      </div>
    </div>\`;
  return d;
}
ENTRIES.forEach(e => grid.appendChild(card(e)));

function numOrNull(v){ const n = parseFloat(v); return Number.isFinite(n) ? n : null }
function rangeOf(c,a,b){ const min=numOrNull(c.querySelector(a).value), max=numOrNull(c.querySelector(b).value);
  return (min===null&&max===null) ? null : {min: min ?? max, max: max ?? min} }

async function save(btn, action){
  const c = btn.closest('.card');
  const lc = c.querySelector('.lc').value;
  const patch = {
    id: c.dataset.id,
    licenseVerified: c.querySelector('.lic').checked,
    containsPeople: c.querySelector('.ppl').checked,
    expectedObjects: c.querySelector('.objs').value.split(',').map(s=>s.trim()).filter(Boolean),
    expectedQuantityRange: rangeOf(c,'.qmin','.qmax'),
    expectedVolumeRangeCubicYards: rangeOf(c,'.vmin','.vmax'),
    expectedTruckSpaceRangePercent: rangeOf(c,'.tmin','.tmax'),
    expectedHandlingFlags: [...c.querySelectorAll('.fl:checked')].map(i=>i.value),
    lighting: c.querySelector('.light').value || null,
    clutter: c.querySelector('.clut').value || null,
    imageQuality: c.querySelector('.iq').value || null,
    notes: c.querySelector('.notes').value + (lc ? ' labelconf='+lc : ''),
  };
  if (action !== 'keep') patch.reviewStatus = action;
  const res = await fetch('/save', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});
  const j = await res.json();
  if (!j.ok) { alert(j.error || 'save failed'); return }
  c.className = 'card ' + (j.entry.reviewStatus==='approved'?'approved':j.entry.reviewStatus==='rejected'?'rejected':'');
  for (const k of ['pending','approved','rejected']) document.getElementById('c-'+k).textContent = j.counts[k];
}
</script></body></html>`
}

const root = datasetRoot()
const p = paths(root)

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)

  if (url.pathname === '/') {
    const entries = loadManifest(root)
    if (entries.length === 0) {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<body style="font:15px system-ui;padding:40px;background:#0b0b0d;color:#e7e7ea">No images yet. Run <code>npx tsx tools/vision-benchmark/acquire.ts</code> first.</body>')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(page(entries, loadGroups(root).length))
    return
  }

  if (url.pathname.startsWith('/img/')) {
    const rel = decodeURIComponent(url.pathname.slice(5))
    // Path containment: never serve outside the images directory.
    const abs = join(p.images, rel)
    if (!abs.startsWith(p.images) || !existsSync(abs)) { res.writeHead(404).end('not found'); return }
    res.writeHead(200, { 'Content-Type': MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream' })
    res.end(readFileSync(abs))
    return
  }

  if (url.pathname === '/save' && req.method === 'POST') {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      try {
        const patch = JSON.parse(body) as Partial<ManifestEntry> & { id: string }
        const entries = loadManifest(root)
        const i = entries.findIndex(e => e.id === patch.id)
        if (i < 0) { res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'unknown id' })); return }
        // Approval requires a verified licence and no identifiable people — the two
        // things a human is here to decide. Enforced server-side, not just in the UI.
        if (patch.reviewStatus === 'approved') {
          if (!patch.licenseVerified) { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'cannot approve: licence not verified' })); return }
          if (patch.containsPeople) { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'cannot approve: marked as containing people/documents — reject it' })); return }
        }
        entries[i] = { ...entries[i], ...patch }
        saveManifest(entries, root)
        const counts = {
          pending: entries.filter(e => e.reviewStatus === 'pending').length,
          approved: entries.filter(e => e.reviewStatus === 'approved').length,
          rejected: entries.filter(e => e.reviewStatus === 'rejected').length,
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, entry: entries[i], counts }))
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : 'bad request' }))
      }
    })
    return
  }

  res.writeHead(404).end('not found')
}).listen(PORT, () => {
  console.log(`\n  Vision benchmark review UI → http://localhost:${PORT}`)
  console.log(`  dataset: ${root}`)
  console.log(`  Approve requires: licence verified + no identifiable people.\n`)
})
