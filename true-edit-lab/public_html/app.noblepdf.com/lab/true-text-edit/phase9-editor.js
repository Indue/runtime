// NoblePDF True Edit Phase 9 lab: interactive editor over pinned fixtures. ASCII only.
// Flow: PDF.js render -> click -> PDF coordinates -> PDFium char hit -> text object ->
// replacement -> gates + layout -> PDFium mutation -> GenerateContent -> non-incremental
// save -> reopen -> full verification (+ 288 dpi render outside the edit) -> commit.
// originalSourceBytes is never written after load; workingPdfBytes changes only on a
// fully verified commit; undo restores earlier verified states.
import { loadVerifiedEngine, RUN10, OBJ } from './te-engine.mjs?v=1';
import { analyze, targetGates, documentGates, planEdit, applyEdit, verifyEdit, findTextObject } from './te-pipeline.mjs?v=1';
import { toCodePoints, fromCodePoints } from './te-edit.mjs?v=1';
import { pdfjsLib, browserPdfjs, renderToCanvas, compareRenders, grow, union, PDFJS_PIN } from './te-render.mjs?v=1';
import { environmentAudit } from './te-env.mjs?v=1';
import { sha256Hex } from './phase8-verify.mjs?v=1';

const PAGE_VERSION = 'phase9-editor-1';
const MANIFEST = Object.freeze({ url: './fixtures-phase9/manifest.json?v=1', sha256: '9026394f2c900433e7e199ce943e509554311c324a34bea0b0fbfcb2e968eeee' });
const PATCHED_BASE = '/vendor/pdfium-2.15.1-setpositions/';
const DISPLAY_SCALE = 1.5;
const $ = (id) => document.getElementById(id);
const S = { E: null, pdfjs: null, manifest: null, fx: null, originalSourceBytes: null, originalSha: '', workingPdfBytes: null, undo: [], analysis: null, view: null, sel: null, busy: false, log: [] };

async function fetchBytes(url) {
  const r = await fetch(url, { cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
const nonce = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
const setBusy = (b) => { S.busy = b; for (const id of ['apply', 'undo', 'reset', 'download', 'fixture', 'suggest']) $(id).disabled = b || !S.E || (id !== 'fixture' && !S.workingPdfBytes); if (!b) { $('undo').disabled = !S.undo.length; $('apply').disabled = !S.sel || !S.sel.editable; } };
function status(text, ok) { $('result').className = `status-line ${ok === true ? 'pass' : (ok === false ? 'fail' : '')}`; $('result').textContent = text; }

async function audit() {
  const env = await environmentAudit({ expectedScripts: ['phase8-csp-guard.js', 'phase9-editor.js', PDFJS_PIN.lib, PDFJS_PIN.worker] });
  $('networkResults').textContent = env.lines.join('\n');
  $('privacyStatus').className = `status-line ${env.pass ? 'pass' : 'fail'}`;
  $('privacyStatus').textContent = env.pass ? `PASS - no cross-origin resource, no unexpected script executed, eval blocked${env.violations ? ` (${env.violations} blocked attempt(s) recorded)` : ''}.` : `FAIL - ${env.fail.length} problem(s). Editing stays disabled.`;
  return env;
}

async function start() {
  $('start').disabled = true;
  try {
    const env = await audit();
    if (!env.pass) throw new Error('runtime audit failed');
    const rec = await loadVerifiedEngine({ base: PATCHED_BASE, label: 'patched', expected: RUN10, nonce: nonce() });
    if (!rec.ok) throw new Error(`engine refused: ${rec.problems.join('; ')}`);
    const missing = rec.engine.missingApi();
    if (missing.length) throw new Error(`engine lacks ${missing.join(', ')}`);
    const mb = await fetchBytes(MANIFEST.url);
    if ((await sha256Hex(mb)) !== MANIFEST.sha256) throw new Error('fixture manifest does not match its pin');
    S.manifest = JSON.parse(new TextDecoder().decode(mb));
    S.E = rec.engine;
    S.pdfjs = browserPdfjs(pdfjsLib());
    const sel = $('fixture');
    for (const f of S.manifest.fixtures) {
      if (f.id.startsWith('input-')) continue;
      const o = document.createElement('option');
      o.value = f.id;
      o.textContent = `${f.expect.status === 'committed' ? 'editable' : f.expect.status}: ${f.id}`;
      sel.append(o);
    }
    sel.disabled = false;
    $('engineStatus').textContent = `Run #10 engine verified (wasm ${rec.wasmSha256.slice(0, 12)}...), PDF.js ${S.pdfjs.version}.`;
  } catch (e) {
    $('engineStatus').textContent = `Blocked: ${e.message}`;
    $('start').disabled = false;
  }
}

async function loadFixture(id) {
  const fx = S.manifest.fixtures.find((f) => f.id === id);
  if (!fx) return;
  setBusy(true);
  try {
    const bytes = await fetchBytes(`./fixtures-phase9/${encodeURIComponent(fx.before)}?v=1`);
    const sha = await sha256Hex(bytes);
    if (sha !== fx.sha256.before) throw new Error('fixture bytes do not match the manifest');
    S.fx = fx;
    S.originalSourceBytes = bytes.slice();
    S.originalSha = sha;
    S.workingPdfBytes = bytes.slice();
    S.undo = [];
    await refresh();
    $('suggest').disabled = !(fx.edit && fx.edit.object);
    status(`Loaded ${fx.id}. ${fx.title}`);
  } catch (e) { status(`Could not load: ${e.message}`, false); }
  setBusy(false);
}

async function refresh() {
  S.sel = null;
  $('reasons').textContent = '';
  $('checks').textContent = '';
  $('text').value = '';
  $('text').disabled = true;
  $('fit').disabled = true;
  document.querySelectorAll('.hl').forEach((n) => n.remove());
  S.view = await renderToCanvas(pdfjsLib(), S.workingPdfBytes, 0, { fitWidth: Math.max(320, $('pageWrap').clientWidth - 4), max: DISPLAY_SCALE }, $('page'));
  S.analysis = await analyze(S.E, S.workingPdfBytes, 0, { pdfjs: S.pdfjs });
  const sha = await sha256Hex(S.workingPdfBytes);
  $('docStatus').textContent = `${S.fx.id}: working ${sha.slice(0, 12)}... (${S.workingPdfBytes.length} B), ${S.undo.length} verified edit(s) on the undo stack, original ${S.originalSha.slice(0, 12)}... (immutable)`;
  const dg = documentGates(S.analysis);
  $('hint').textContent = dg.length ? `This page cannot be edited: ${dg.map((r) => r.code).join(', ')}` : 'Click a line of text on the page.';
}

function highlight(bounds, blocked) {
  document.querySelectorAll('.hl').forEach((n) => n.remove());
  if (!bounds) return;
  const q = S.view.viewport.convertToViewportRectangle([bounds.left, bounds.bottom, bounds.right, bounds.top]);
  const d = document.createElement('div');
  d.className = `hl${blocked ? ' blocked' : ''}`;
  const canvas = $('page');
  d.style.left = `${canvas.offsetLeft + Math.min(q[0], q[2]) - 2}px`;
  d.style.top = `${canvas.offsetTop + Math.min(q[1], q[3]) - 2}px`;
  d.style.width = `${Math.abs(q[2] - q[0]) + 4}px`;
  d.style.height = `${Math.abs(q[3] - q[1]) + 4}px`;
  $('pageWrap').append(d);
}

function selectAt(clientX, clientY) {
  if (!S.analysis || S.busy) return;
  const r = $('page').getBoundingClientRect();
  const [x, y] = S.view.viewport.convertToPdfPoint(clientX - r.left, clientY - r.top);
  const unit = S.E.withDoc(S.workingPdfBytes, 0, (d) => S.E.hitTest(d.textPage, x, y, 3));
  const ch = S.analysis.pdfium.chars.find((c) => unit >= c.unit && unit < c.unit + c.units);
  $('reasons').textContent = '';
  const inside = (b, pad) => b && x >= b.left - pad && x <= b.right + pad && y >= b.bottom - pad && y <= b.top + pad;
  const formBlock = () => { S.sel = null; highlight(null); showReasons([{ code: 'text-in-form-xobject', detail: 'this content is drawn by a Form XObject (possibly shared); blocked' }]); $('hint').textContent = 'This text cannot be edited.'; setBusy(false); };
  if (unit >= 0 && ch) {
    if (ch.objIndex === -2) { formBlock(); return; }
    if (ch.objIndex >= 0) { selectObject(ch.objIndex); return; }
  }
  // No character box under the pointer (for example between glyphs, or text whose
  // extraction is replaced by /ActualText): fall back to the text object's bounds.
  const hit = S.analysis.objects.find((o) => o.type === OBJ.TEXT && inside(o.bounds, 1));
  if (hit) { selectObject(hit.index); return; }
  if (S.analysis.objects.some((o) => o.type === OBJ.FORM && inside(o.bounds, 0))) { formBlock(); return; }
  S.sel = null;
  highlight(null);
  $('hint').textContent = 'No text there. Click directly on a line of text.';
  setBusy(false);
}

function selectObject(objIndex) {
  const o = S.analysis.objects[objIndex];
  const gates = [...documentGates(S.analysis), ...targetGates(S.analysis, objIndex)];
  S.sel = { objIndex, editable: gates.length === 0 };
  highlight(o.bounds, gates.length > 0);
  $('text').value = o.realText;
  $('text').disabled = gates.length > 0;
  $('fit').disabled = gates.length > 0;
  $('hint').textContent = gates.length ? 'This text cannot be edited (fails closed):' : `Object ${objIndex}: ${o.show.font.baseFont} ${o.size} pt (${o.show.font.fontClass}). Edit the text and apply.`;
  showReasons(gates);
  setBusy(false);
}

function showReasons(list) {
  const ul = $('reasons');
  ul.textContent = '';
  for (const r of list) { const li = document.createElement('li'); li.textContent = `${r.code}: ${r.detail}`; ul.append(li); }
}
function showChecks(checks) {
  const tb = $('checks');
  tb.textContent = '';
  for (const c of checks) {
    const tr = document.createElement('tr');
    const a = document.createElement('td'); a.textContent = c.id;
    const b = document.createElement('td'); b.textContent = `${c.name} - ${c.evidence}`; b.className = 'small';
    const d = document.createElement('td'); d.textContent = c.pass ? 'PASS' : 'FAIL'; d.className = c.pass ? 'pass' : 'fail';
    tr.append(a, b, d);
    tb.append(tr);
  }
}

// Old text -> new text as one replacement on code points, widened to whole
// whitespace-delimited words: insertions and deletions then become ordinary word
// replacements (never an empty selection or an empty replacement), and the search
// checks see the whole edited token.
const isWs = (cp) => cp === 0x20 || cp === 0x09 || cp === 0xa0;
function diff(oldText, newText) {
  const a = toCodePoints(oldText);
  const b = toCodePoints(newText);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const same = a.length === b.length && p === a.length;
  let start = p;
  let end = a.length - s;
  while (start > 0 && !isWs(a[start - 1])) start--;
  while (end < a.length && !isWs(a[end])) end++;
  let repl = b.slice(start, b.length - (a.length - end));
  if ((start === end || !repl.length) && b.length) {
    // still empty: take one neighbouring character into both sides
    if (start > 0) start--; else end++;
    repl = b.slice(start, b.length - (a.length - end));
  }
  return { start, end, replacement: fromCodePoints(repl), same };
}

async function apply() {
  if (!S.sel || !S.sel.editable || S.busy) return;
  const o = S.analysis.objects[S.sel.objIndex];
  const newText = $('text').value;
  const d = diff(o.realText, newText);
  if (d.same) { status('Nothing changed.'); return; }
  setBusy(true);
  status('Planning, mutating and verifying...');
  showChecks([]);
  const before = S.workingPdfBytes;
  try {
    const plan = await planEdit(S.E, before, { pageIndex: 0, objIndex: S.sel.objIndex, start: d.start, end: d.end, replacement: newText.length ? d.replacement : '', fit: $('fit').checked, analysis: S.analysis, pdfjs: S.pdfjs });
    if (!plan.ok) { showReasons(plan.reasons); status(`Blocked before mutation (${plan.reasons.length} reason(s)). The document was not changed.`, false); setBusy(false); return; }
    const out = applyEdit(S.E, before, plan);
    const v = await verifyEdit(S.E, before, out, plan, { pdfjs: S.pdfjs });
    const box = grow(union(plan.oldBox, plan.newBox), 2);
    const rc = await compareRenders(pdfjsLib(), before, out, { pageIndex: 0, scale: 4, exclude: box });
    const checks = [...v.checks, { id: 'X01', name: 'outside the edit the page renders identically at 288 dpi', pass: rc.ok, evidence: rc.detail }];
    showChecks(checks);
    if (!checks.every((c) => c.pass)) {
      showReasons(checks.filter((c) => !c.pass).map((c) => ({ code: c.id, detail: c.name })));
      status('Rejected by verification. The working document was NOT replaced.', false);
      setBusy(false);
      return;
    }
    S.undo.push(before);
    S.workingPdfBytes = out;
    S.log.push({ fixture: S.fx.id, from: o.realText, to: plan.newText, discriminating: plan.discriminating });
    await refresh();
    showReasons([]);
    status(`Committed: "${o.realText}" -> "${plan.newText}" (${checks.length} checks passed${plan.discriminating ? '; layout needed SetPositions' : ''}).`, true);
  } catch (e) {
    status(`Failed closed: ${e.message}. The working document was NOT replaced.`, false);
  }
  setBusy(false);
}

async function undo() {
  if (!S.undo.length || S.busy) return;
  setBusy(true);
  S.workingPdfBytes = S.undo.pop();
  await refresh();
  status('Undone: restored the previous verified document.', true);
  setBusy(false);
}
async function reset() {
  if (!S.originalSourceBytes || S.busy) return;
  setBusy(true);
  const sha = await sha256Hex(S.originalSourceBytes);
  if (sha !== S.originalSha) { status('Original bytes changed in memory; refusing to reset.', false); setBusy(false); return; }
  S.workingPdfBytes = S.originalSourceBytes.slice();
  S.undo = [];
  await refresh();
  status('Reset to the original fixture.', true);
  setBusy(false);
}
function download() {
  if (!S.workingPdfBytes) return;
  const url = URL.createObjectURL(new Blob([S.workingPdfBytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `noblepdf-phase9-${S.fx.id}-verified.pdf`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function suggest() {
  const e = S.fx && S.fx.edit;
  if (!e || !e.object) return;
  const i = findTextObject(S.analysis, e.object);
  if (i < 0) { status('The suggested object is not a direct text object on this page.', false); return; }
  selectObject(i);
  if (!S.sel.editable) return;
  const cps = toCodePoints(e.object);
  const f = toCodePoints(e.find);
  let at = -1;
  for (let k = 0; k + f.length <= cps.length && at < 0; k++) if (f.every((c, j) => cps[k + j] === c)) at = k;
  if (at >= 0) $('text').value = fromCodePoints([...cps.slice(0, at), ...toCodePoints(e.replace), ...cps.slice(at + f.length)]);
  $('fit').checked = !!e.fit;
}

// Test hook for the browser harness: client coordinates of an object's middle glyph,
// so automated runs exercise the real click path.
window.__phase9Editor = Object.freeze({
  version: PAGE_VERSION,
  pointFor(text) {
    let p = null;
    const i = findTextObject(S.analysis, text);
    if (i >= 0) {
      const b = S.analysis.objects[i].bounds;
      p = { x: (b.left + b.right) / 2, y: (b.bottom + b.top) / 2 };
    } else {
      p = S.E.withDoc(S.workingPdfBytes, 0, (d) => { const h = S.E.search(d.textPage, text, 0); if (!h.length) return null; const q = S.E.charOrigin(d.textPage, h[0][0] + Math.floor(h[0][1] / 2)); return { x: q.x, y: q.y + 2 }; });
    }
    if (!p) return null;
    const [vx, vy] = S.view.viewport.convertToViewportPoint(p.x, p.y);
    const r = $('page').getBoundingClientRect();
    return { x: r.left + vx, y: r.top + vy };
  },
  state: () => ({ undo: S.undo.length, workingLength: S.workingPdfBytes ? S.workingPdfBytes.length : 0, selected: S.sel, result: $('result').textContent, log: S.log.slice() }),
  workingSha: () => (S.workingPdfBytes ? sha256Hex(S.workingPdfBytes) : ''),
  originalSha: () => S.originalSha,
});

function boot() {
  if (document.documentElement.dataset.phase9 !== 'editor-1') { $('privacyStatus').textContent = 'FAIL - page/module version mismatch (stale cache?)'; return; }
  $('start').addEventListener('click', start);
  $('fixture').addEventListener('change', (e) => loadFixture(e.target.value));
  $('page').addEventListener('click', (e) => selectAt(e.clientX, e.clientY));
  $('apply').addEventListener('click', apply);
  $('undo').addEventListener('click', undo);
  $('reset').addEventListener('click', reset);
  $('download').addEventListener('click', download);
  $('suggest').addEventListener('click', suggest);
  audit();
}
boot();
