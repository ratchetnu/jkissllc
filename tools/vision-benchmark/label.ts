// ─────────────────────────────────────────────────────────────────────────────
// Vision benchmark — human review and labelling interface.
//
// One image at a time, keyboard-driven, with the source page one click away.
// A grid was fine for triaging licence and content; entering ground truth needs
// the image large enough to judge volume from, and needs the labeller's hands to
// stay on the keyboard.
//
// WHY A HUMAN IS REQUIRED HERE, not merely allowed:
//   • Licence — the API's field is a signal. A person confirms it.
//   • Content — a text screen cannot see a photograph. Identifiable people,
//     children, documents, plates and addresses are a visual judgement.
//   • Ground truth — cubic yards cannot be derived from a stranger's photo by
//     the system under test. If the model supplied the answers, the benchmark
//     would be grading its own homework.
//   • Hazard classification and operational reasonableness — safety calls.
//
// NOTHING IS PREFILLED. Every ground-truth field starts empty. The reference
// card in the sidebar is static domain knowledge (a couch is 3–5 cubic yards),
// not model output — it speeds a human up without handing them an answer.
//
// TWO INDEPENDENT STATES. `reviewStatus` (approved / rejected) clears licence and
// content. `labelStatus` (unlabelled / draft / verified) is the ground truth.
// Only `verified` is scored; a draft is excluded exactly like a blank, so a
// labeller can save half-finished work without corrupting the accuracy report.
//
// Run: npx tsx tools/vision-benchmark/label.ts   → http://localhost:7391
// ─────────────────────────────────────────────────────────────────────────────

import { createServer } from 'node:http'
import { Script } from 'node:vm'
import { readFileSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { datasetRoot, paths, loadManifest, saveManifest } from './dataset'
import {
  validateLabel, DISPOSAL_FLAGS, ACCESS_CONCERNS, TRUCK_CUBIC_YARDS,
  type ManifestEntry,
} from './schema'

const PORT = Number(process.env.LABEL_PORT) || 7391
const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
}

const HANDLING_FLAGS = [
  'heavy', 'bulky', 'fragile', 'requires_disassembly', 'two_person_lift', 'awkward_shape',
]

/** Static domain reference — NOT model output. Helps a human calibrate quickly. */
const VOLUME_REFERENCE = [
  ['24 ft box truck (full)', `${TRUCK_CUBIC_YARDS} cu yd = 100%`],
  ['3-seat sofa', '3–5 cu yd'],
  ['Mattress + box spring', '2–3 cu yd'],
  ['Fridge / washer', '1–2 cu yd each'],
  ['Pickup-truck bed, heaped', '3–4 cu yd'],
  ['Standard skip / small dumpster', '8–12 cu yd'],
  ['Single-car garage, floor to waist', '15–25 cu yd'],
]

function page(entries: ManifestEntry[]): string {
  const j = (v: unknown) => JSON.stringify(v)
  return `<!doctype html><html><head><meta charset="utf-8"><title>Benchmark labelling</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{font:14px/1.5 system-ui,sans-serif;margin:0;background:#0b0b0d;color:#e7e7ea;overflow:hidden}
header{height:52px;background:#121216;border-bottom:1px solid #26262c;display:flex;align-items:center;gap:18px;padding:0 18px}
h1{font-size:14px;margin:0;font-weight:700;white-space:nowrap}
.counts span{margin-right:12px;color:#9b9ba4;font-size:12px}
.counts b{color:#e7e7ea}
main{display:grid;grid-template-columns:1fr 460px;height:calc(100vh - 52px)}
.viewer{background:#000;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}
.viewer img{max-width:100%;max-height:100%;object-fit:contain;transition:transform .12s;cursor:zoom-in}
.viewer img.zoom{transform:scale(2.4);cursor:zoom-out}
.nav{position:absolute;bottom:14px;left:50%;transform:translateX(-50%);display:flex;gap:8px;background:rgba(0,0,0,.72);padding:7px 11px;border-radius:999px;border:1px solid #33333b}
.nav button{background:#1b1b21;border:1px solid #33333b;color:#e7e7ea;border-radius:7px;padding:5px 11px;cursor:pointer;font-size:12px}
.side{overflow-y:auto;padding:14px;border-left:1px solid #26262c}
.meta{font-size:11px;color:#8b8b95;line-height:1.5;word-break:break-all;margin-bottom:10px}
.meta a{color:#7aa2f7}
label{font-size:10px;color:#9b9ba4;display:block;margin-bottom:3px;text-transform:uppercase;letter-spacing:.05em}
input,select,textarea{width:100%;background:#0b0b0d;border:1px solid #33333b;color:#e7e7ea;border-radius:6px;padding:5px 7px;font:13px system-ui}
textarea{resize:vertical;min-height:38px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:8px}
.row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px;margin-bottom:8px}
.fld{margin-bottom:8px}
.flags{display:flex;flex-wrap:wrap;gap:4px}
.flags label{display:inline-flex;align-items:center;gap:3px;background:#1b1b21;border:1px solid #33333b;border-radius:999px;padding:2px 8px;font-size:11px;text-transform:none;letter-spacing:0;color:#c9c9d1;cursor:pointer;margin:0}
.flags input{width:auto}
.actions{display:flex;gap:6px;margin:12px 0 8px}
button.act{flex:1;border:0;border-radius:7px;padding:9px;font-weight:700;cursor:pointer;font-size:12px}
.ok{background:#1f6f43;color:#fff}.no{background:#7a2230;color:#fff}.save{background:#2b2b34;color:#e7e7ea}.ver{background:#1d4ed8;color:#fff}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700}
.b-ver{background:#1d4ed8}.b-draft{background:#6b5518}.b-un{background:#33333b;color:#9b9ba4}
.b-app{background:#1f6f43}.b-rej{background:#7a2230}.b-pend{background:#33333b;color:#9b9ba4}
.warn{background:#3a2f10;border:1px solid #6b5518;color:#f0d68a;padding:6px 8px;border-radius:6px;font-size:11px;margin-bottom:8px}
.err{background:#3a1010;border:1px solid #7a2230;color:#ffb4b4;padding:6px 8px;border-radius:6px;font-size:11px;margin-bottom:8px;white-space:pre-line}
.ref{font-size:11px;color:#8b8b95;border-top:1px solid #26262c;margin-top:12px;padding-top:10px}
.ref table{width:100%;border-collapse:collapse}
.ref td{padding:1px 0}.ref td:last-child{text-align:right;color:#c9c9d1}
.keys{font-size:10px;color:#6b6b75;margin-top:8px;line-height:1.7}
kbd{background:#1b1b21;border:1px solid #33333b;border-radius:4px;padding:0 4px;font-size:10px}
</style></head><body>
<header>
  <h1>Benchmark labelling</h1>
  <div class="counts">
    <span>image <b id="pos">–</b>/<b id="total">–</b></span>
    <span>verified <b id="c-ver">0</b></span>
    <span>draft <b id="c-draft">0</b></span>
    <span>approved <b id="c-app">0</b></span>
    <span>rejected <b id="c-rej">0</b></span>
  </div>
  <div style="margin-left:auto"><label style="display:inline;margin:0"><input type="checkbox" id="onlyApproved" checked style="width:auto"> approved only</label></div>
</header>
<main>
  <div class="viewer">
    <img id="img" onclick="this.classList.toggle('zoom')">
    <div class="nav">
      <button onclick="go(-1)">← prev</button>
      <button onclick="go(1)">next →</button>
      <button onclick="nextUnlabelled()">next unlabelled</button>
    </div>
  </div>
  <div class="side" id="side"></div>
</main>
<script>
const ALL = ${j(entries)};
const DISPOSAL = ${j(DISPOSAL_FLAGS)};
const ACCESS = ${j(ACCESS_CONCERNS)};
const HANDLING = ${j(HANDLING_FLAGS)};
const REF = ${j(VOLUME_REFERENCE)};
let list = [], i = 0, dirty = false;

function rebuild(){
  const onlyApproved = document.getElementById('onlyApproved').checked;
  const keep = ALL.filter(e => onlyApproved ? e.reviewStatus === 'approved' : e.reviewStatus !== 'rejected');
  const currentId = list[i] && list[i].id;
  list = keep;
  const found = list.findIndex(e => e.id === currentId);
  i = found >= 0 ? found : 0;
  render();
}
function counts(){
  document.getElementById('c-ver').textContent = ALL.filter(e=>e.labelStatus==='verified').length;
  document.getElementById('c-draft').textContent = ALL.filter(e=>e.labelStatus==='draft').length;
  document.getElementById('c-app').textContent = ALL.filter(e=>e.reviewStatus==='approved').length;
  document.getElementById('c-rej').textContent = ALL.filter(e=>e.reviewStatus==='rejected').length;
}
function go(d){
  if (dirty && !confirm('Unsaved changes on this image. Move anyway?')) return;
  i = Math.max(0, Math.min(list.length - 1, i + d)); render();
}
function nextUnlabelled(){
  const from = list.findIndex((e,n) => n > i && e.labelStatus !== 'verified');
  i = from >= 0 ? from : i; render();
}
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null };
const gt = (r,k) => r ? r[k] : '';

function render(){
  counts();
  const e = list[i];
  document.getElementById('pos').textContent = list.length ? (i+1) : 0;
  document.getElementById('total').textContent = list.length;
  if (!e){ document.getElementById('side').innerHTML = '<p style="color:#8b8b95">No images match this filter.</p>'; document.getElementById('img').src=''; return }
  dirty = false;
  document.getElementById('img').src = '/img/' + encodeURIComponent(e.storedPath);
  document.getElementById('img').classList.remove('zoom');
  const flagRow = (arr, cls, sel) => arr.map(f =>
    '<label><input type="checkbox" class="'+cls+'" value="'+f+'" '+((sel||[]).includes(f)?'checked':'')+'>'+f+'</label>').join('');
  const sel = (cls, opts, cur) => '<select class="'+cls+'"><option value="">—</option>' +
    opts.map(o=>'<option '+(cur===o?'selected':'')+'>'+o+'</option>').join('') + '</select>';

  document.getElementById('side').innerHTML = \`
    <div>
      <span class="badge \${e.labelStatus==='verified'?'b-ver':e.labelStatus==='draft'?'b-draft':'b-un'}">\${e.labelStatus}</span>
      <span class="badge \${e.reviewStatus==='approved'?'b-app':e.reviewStatus==='rejected'?'b-rej':'b-pend'}">\${e.reviewStatus}</span>
      <span class="badge b-un">\${e.split}</span>
    </div>
    \${e.labelStatus==='verified' ? '<div class="warn" style="margin-top:8px">Verified. Editing requires Save draft first — it will drop back to draft.</div>':''}
    <div class="meta" style="margin-top:8px">
      <b>\${e.id}</b><br>\${e.jobType} · \${e.category} · \${e.widthPx}×\${e.heightPx}<br>
      licence <b>\${e.license}</b> \${e.licenseVerified?'✓ verified':'(unverified)'} ·
      <a href="\${e.sourcePageUrl}" target="_blank" rel="noopener">source page</a><br>
      \${e.sourceDomain} · query: "\${e.searchQuery}"
    </div>
    <div id="errbox"></div>
    <div class="fld"><label>visible objects (comma separated) *</label><input class="objs" value="\${(e.expectedObjects||[]).join(', ')}"></div>
    <div class="row">
      <div><label>qty min</label><input class="qmin" type="number" min="0" value="\${gt(e.expectedQuantityRange,'min')}"></div>
      <div><label>qty max</label><input class="qmax" type="number" min="0" value="\${gt(e.expectedQuantityRange,'max')}"></div>
    </div>
    <div class="row">
      <div><label>cubic yards min *</label><input class="vmin" type="number" step="0.5" min="0" value="\${gt(e.expectedVolumeRangeCubicYards,'min')}"></div>
      <div><label>cubic yards max *</label><input class="vmax" type="number" step="0.5" min="0" value="\${gt(e.expectedVolumeRangeCubicYards,'max')}"></div>
    </div>
    <div class="row">
      <div><label>truck space % min *</label><input class="tmin" type="number" min="0" max="100" value="\${gt(e.expectedTruckSpaceRangePercent,'min')}"></div>
      <div><label>truck space % max *</label><input class="tmax" type="number" min="0" max="100" value="\${gt(e.expectedTruckSpaceRangePercent,'max')}"></div>
    </div>
    <div class="row">
      <div><label>crew size min</label><input class="cmin" type="number" min="0" value="\${gt(e.expectedCrewRange,'min')}"></div>
      <div><label>crew size max</label><input class="cmax" type="number" min="0" value="\${gt(e.expectedCrewRange,'max')}"></div>
    </div>
    <div class="row">
      <div><label>labor hours min</label><input class="hmin" type="number" step="0.5" min="0" value="\${gt(e.expectedLaborHoursRange,'min')}"></div>
      <div><label>labor hours max</label><input class="hmax" type="number" step="0.5" min="0" value="\${gt(e.expectedLaborHoursRange,'max')}"></div>
    </div>
    <div class="fld"><label>handling flags</label><div class="flags">\${flagRow(HANDLING,'fl-h',e.expectedHandlingFlags)}</div></div>
    <div class="fld"><label>disposal flags</label><div class="flags">\${flagRow(DISPOSAL,'fl-d',e.disposalFlags)}</div></div>
    <div class="fld"><label>access concerns</label><div class="flags">\${flagRow(ACCESS,'fl-a',e.accessConcerns)}</div></div>
    <div class="row3">
      <div><label>lighting</label>\${sel('light',['bright','normal','dim'],e.lighting)}</div>
      <div><label>clutter</label>\${sel('clut',['low','medium','high'],e.clutter)}</div>
      <div><label>image quality</label>\${sel('iq',['high','medium','low'],e.imageQuality)}</div>
    </div>
    <div class="row">
      <div><label>difficulty *</label>\${sel('diff',['easy','normal','difficult'],e.difficulty)}</div>
      <div><label>label confidence *</label>\${sel('lc',['high','medium','low'],e.labelConfidence)}</div>
    </div>
    <div class="fld"><label>ambiguity notes (add #edge for the edge-case set)</label><textarea class="notes">\${(e.notes||'').replace(/^(AUTO|REVIEW):[^\\n]*\\n?/,'')}</textarea></div>
    <label style="text-transform:none"><input type="checkbox" class="ppl" \${e.containsPeople?'checked':''} style="width:auto"> contains identifiable people / documents / plates</label>
    <div class="actions">
      <button class="act save" onclick="save('draft')">Save draft</button>
      <button class="act ver" onclick="save('verified')">Mark verified</button>
    </div>
    <div class="actions">
      <button class="act ok" onclick="review('approved')">Approve</button>
      <button class="act no" onclick="review('rejected')">Reject</button>
    </div>
    <div class="ref"><b>Volume reference</b> (static, not model output)
      <table>\${REF.map(r=>'<tr><td>'+r[0]+'</td><td>'+r[1]+'</td></tr>').join('')}</table>
    </div>
    <div class="keys">
      <kbd>←</kbd>/<kbd>→</kbd> prev/next · <kbd>u</kbd> next unlabelled · <kbd>z</kbd> zoom<br>
      <kbd>s</kbd> save draft · <kbd>v</kbd> mark verified · <kbd>⇧A</kbd> approve · <kbd>⇧R</kbd> reject<br>
      * required before an image can be verified
    </div>\`;
  document.querySelectorAll('.side input, .side select, .side textarea')
    .forEach(el => el.addEventListener('input', () => { dirty = true }));
}

function collect(){
  const q = c => document.querySelector('.'+c);
  const range = (a,b) => { const mn=num(q(a).value), mx=num(q(b).value);
    return (mn===null&&mx===null)?null:{min: mn ?? mx, max: mx ?? mn} };
  const flags = c => [...document.querySelectorAll('.'+c+':checked')].map(x=>x.value);
  return {
    id: list[i].id,
    expectedObjects: q('objs').value.split(',').map(s=>s.trim()).filter(Boolean),
    expectedQuantityRange: range('qmin','qmax'),
    expectedVolumeRangeCubicYards: range('vmin','vmax'),
    expectedTruckSpaceRangePercent: range('tmin','tmax'),
    expectedCrewRange: range('cmin','cmax'),
    expectedLaborHoursRange: range('hmin','hmax'),
    expectedHandlingFlags: flags('fl-h'),
    disposalFlags: flags('fl-d'),
    accessConcerns: flags('fl-a'),
    lighting: q('light').value || null,
    clutter: q('clut').value || null,
    imageQuality: q('iq').value || null,
    difficulty: q('diff').value || null,
    labelConfidence: q('lc').value || null,
    containsPeople: q('ppl').checked,
    notes: q('notes').value,
  };
}
async function post(patch){
  const res = await fetch('/save', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});
  const out = await res.json();
  const box = document.getElementById('errbox');
  if (!out.ok){ if (box) box.innerHTML = '<div class="err">'+(out.problems||[out.error]).join('\\n')+'</div>'; return false }
  if (box) box.innerHTML = '';
  const n = ALL.findIndex(x=>x.id===out.entry.id); if (n>=0) ALL[n] = out.entry;
  const m = list.findIndex(x=>x.id===out.entry.id); if (m>=0) list[m] = out.entry;
  dirty = false; render(); return true;
}
async function save(status){ await post({...collect(), labelStatus: status}) }
// Approve/reject change ONLY reviewStatus. They must never submit the form:
// doing so wrote whatever was on screen — including empty fields — over saved
// ground truth, which is how six completed labels were destroyed.
async function review(status){
  const e = list[i];
  const hasWork = (e.expectedObjects||[]).length || e.expectedVolumeRangeCubicYards || e.labelStatus !== 'unlabelled';
  if (status === 'rejected' && hasWork &&
      !confirm('This image has label data. Rejecting removes it from the benchmark. Reject anyway?')) return;
  if (dirty && !confirm('Unsaved edits will be discarded. Continue?')) return;
  if (await post({ id: e.id, reviewStatus: status })) go(1);
}

document.getElementById('onlyApproved').addEventListener('change', rebuild);
document.addEventListener('keydown', ev => {
  if (['INPUT','TEXTAREA','SELECT'].includes(ev.target.tagName)) return;
  const k = ev.key.toLowerCase();
  if (ev.key === 'ArrowLeft') go(-1);
  else if (ev.key === 'ArrowRight') go(1);
  else if (k === 'u') nextUnlabelled();
  else if (k === 'z') document.getElementById('img').classList.toggle('zoom');
  else if (k === 's') save('draft');
  else if (k === 'v') save('verified');
  // Approve/reject need Shift. Bare 'r' sat one key from 'v' (verify) and
  // rejecting is destructive and advances — a single mis-key cost real work.
  else if (k === 'a' && ev.shiftKey) review('approved');
  else if (k === 'r' && ev.shiftKey) review('rejected');
});
window.addEventListener('beforeunload', ev => { if (dirty){ ev.preventDefault(); ev.returnValue = '' } });
rebuild();
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
      res.end('<body style="font:15px system-ui;padding:40px;background:#0b0b0d;color:#e7e7ea">No images yet. Run <code>acquire.ts</code> first.</body>')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(page(entries))
    return
  }

  if (url.pathname.startsWith('/img/')) {
    const rel = decodeURIComponent(url.pathname.slice(5))
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
      const json = (code: number, payload: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload))
      }
      try {
        const patch = JSON.parse(body) as Partial<ManifestEntry> & { id: string }
        const entries = loadManifest(root)
        const idx = entries.findIndex(e => e.id === patch.id)
        if (idx < 0) return json(404, { ok: false, error: 'unknown id' })

        const prev = entries[idx]
        const next: ManifestEntry = { ...prev, ...patch, labelStatus: patch.labelStatus ?? prev.labelStatus }

        // Demote a verified label to draft ONLY when the ground truth itself
        // changed. The earlier rule demoted on ANY save, so re-saving a finished
        // label silently un-verified it — verification has to survive an
        // unrelated edit, or nobody can trust the badge.
        if (prev.labelStatus === 'verified' && patch.labelStatus !== 'verified') {
          const GROUND_TRUTH: Array<keyof ManifestEntry> = [
            'expectedObjects', 'expectedQuantityRange', 'expectedVolumeRangeCubicYards',
            'expectedTruckSpaceRangePercent', 'expectedCrewRange', 'expectedLaborHoursRange',
            'expectedHandlingFlags', 'disposalFlags', 'accessConcerns',
            'labelConfidence', 'difficulty',
          ]
          const changed = GROUND_TRUTH.some(k =>
            k in patch && JSON.stringify(patch[k]) !== JSON.stringify(prev[k]))
          next.labelStatus = changed ? 'draft' : 'verified'
        }
        // Splits are permanent — never accept one from the client.
        next.split = prev.split

        if (next.reviewStatus === 'approved') {
          if (!next.licenseVerified) return json(200, { ok: false, problems: ['cannot approve: licence not verified on the source page'] })
          if (next.containsPeople) return json(200, { ok: false, problems: ['cannot approve: marked as containing identifiable people — reject it'] })
        }
        // A rejected image is excluded from the benchmark by `hasGroundTruth`,
        // which already requires reviewStatus === 'approved'. It is NOT necessary
        // to erase the label to achieve that, and erasing it made a mis-keyed
        // rejection unrecoverable. Keep the human's work; exclusion is enforced
        // at read time, not by destroying data.

        const problems = validateLabel(next)
        if (problems.length) return json(200, { ok: false, problems })

        if (next.labelStatus === 'verified' && prev.labelStatus !== 'verified') {
          next.verifiedAt = new Date().toISOString()
        }
        entries[idx] = next
        saveManifest(entries, root)
        return json(200, { ok: true, entry: next })
      } catch (e) {
        return json(400, { ok: false, error: e instanceof Error ? e.message : 'bad request' })
      }
    })
    return
  }

  res.writeHead(404).end('not found')
}).listen(PORT, () => {
  const entries = loadManifest(root)

  // The page is generated as a STRING, so a template-literal mistake produces a
  // browser SyntaxError and a silently blank page — the server still returns 200
  // and the terminal shows nothing wrong. That happened once: a `\n` inside the
  // template expanded to a real newline inside a JS string literal. Compile the
  // generated script at startup (compile only — it is never executed here) so a
  // broken page fails loudly in the terminal instead of quietly in the browser.
  if (entries.length > 0) {
    const script = /<script>([\s\S]*)<\/script>/.exec(page(entries))?.[1] ?? ''
    try {
      new Script(script)
    } catch (e) {
      console.error(`\n  ✖ GENERATED PAGE IS BROKEN — the browser would render a blank screen.`)
      console.error(`    ${e instanceof Error ? e.message : e}\n`)
      process.exit(1)
    }
  }
  const approved = entries.filter(e => e.reviewStatus === 'approved')
  console.log(`\n  Benchmark labelling → http://localhost:${PORT}`)
  console.log(`  dataset  : ${root}`)
  console.log(`  approved : ${approved.length} (${approved.filter(e => e.jobType === 'junk_removal').length} junk removal)`)
  console.log(`  verified : ${entries.filter(e => e.labelStatus === 'verified').length}`)
  console.log(`\n  Nothing is prefilled. Verify requires: objects, cubic yards, truck %, difficulty, confidence.\n`)
})
