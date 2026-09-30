// Phase 10B clipping: Node tests on the REAL Run #10 engine (hash-pinned) and PDF.js 3.11.174.
// Proves the root cause of "every real-PDF text object is target-clipped", the geometric rule
// that replaces the coarse Phase 9 clip signal on the corpus path, and that every clip that is
// not provably irrelevant stays blocked (with a precise code) before any mutation. Edits run
// the exact transaction (plan -> clone/mutate -> GenerateContent -> non-incremental save ->
// reopen -> V01..V13 + D01 + K01) and commit only when every check passes.
// Usage: node --test tests/node/phase10b-clip.test.mjs   (P10_ENGINE=stock: edit tests skipped)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { loadEngine } from './lib/engine-node.mjs';
import { pdfjsProvider } from './lib/pdfjs-node.mjs';
import { clipFixture, clipBlock, rewriteContent, helvPdf, LINE, wordLike, libreOfficeLike, skiaLike, formClip, textClip, ligaturePdf } from './lib/phase10b-clip-inputs.mjs';
import { analyzeDocument, runVerifiedEdit, CorpusSession, buildExport, STATUS } from '../../public_html/app.noblepdf.com/lab/true-text-edit/te-corpus.mjs?v=1';
import { analyze, targetGates, runEdit, findTextObject, findInObject } from '../../public_html/app.noblepdf.com/lab/true-text-edit/te-pipeline.mjs?v=1';
import { clipFacts, pathRegion, intersectRegion, decideClip, outputClipCheck, planEditClipAware, CLIP_CODES, STD14_MARGIN_EM } from '../../public_html/app.noblepdf.com/lab/true-text-edit/te-corpus-clip.mjs?v=1';
import { sha256Hex } from '../../public_html/app.noblepdf.com/lab/true-text-edit/phase8-verify.mjs?v=1';

const LAB = new URL('../../public_html/app.noblepdf.com/lab/true-text-edit/', import.meta.url);
const DIR = new URL('fixtures-phase9/', LAB);
const manifest = JSON.parse(readFileSync(new URL('manifest.txt', DIR)));
const FX = Object.fromEntries(manifest.fixtures.map((f) => [f.id, f]));
const fx = (id) => new Uint8Array(readFileSync(new URL(FX[id].before, DIR)));
const KIND = process.env.P10_ENGINE || 'patched';
const E = await loadEngine(KIND);
const pdfjs = await pdfjsProvider(3);
const EDITS = E.hasApi('FPDFText_SetPositions');
if (!EDITS && KIND !== 'stock') throw new Error('patched engine without FPDFText_SetPositions');
const needEdits = { skip: EDITS ? false : 'stock engine (local development only): no SetPositions' };
const T1 = LINE('Clipped cell value 99');
const obj = (rep, text) => rep.objects.find((o) => o.text === text);
const rect = (x0, y0, x1, y1) => ({ x0, y0, x1, y1 });
// Runs the manifest edit of a fixture (or its clipped variant) through the corpus path.
async function edit(bytes, id, { fit, replace } = {}) {
  const e = FX[id].edit;
  const a = await analyze(E, bytes, 0, { pdfjs });
  const oi = findTextObject(a, e.object);
  const sel = findInObject(a, oi, e.find, e.occurrence || 0);
  const before = await sha256Hex(bytes);
  const r = await runVerifiedEdit(E, bytes, { pageIndex: 0, objIndex: oi, expectedOldText: e.object, selection: { start: sel.start, end: sel.end, replacement: replace ?? e.replace }, fit: fit ?? !!e.fit, pdfjs });
  assert.equal(await sha256Hex(bytes), before, `${id}: source bytes never written`);
  if (r.status !== 'committed') assert.equal(r.bytes, null, `${id}: no output bytes unless committed`);
  return { r, a, oi };
}
const allPass = (r) => r.checks.length > 0 && r.checks.every((c) => c.pass);
const failed = (r) => r.checks.filter((c) => !c.pass).map((c) => `${c.id}: ${c.evidence.slice(0, 160)}`);

// ------------------------------------------------------------------ root cause
test('Run #10 exports the PDFium clip-geometry API used for the cross-check (no new engine needed)', () => {
  for (const n of ['FPDFPageObj_GetClipPath', 'FPDFClipPath_CountPaths', 'FPDFClipPath_CountPathSegments', 'FPDFClipPath_GetPathSegment', 'FPDFPathSegment_GetPoint', 'FPDFPathSegment_GetType', 'FPDFPathSegment_GetClose']) assert.ok(E.hasApi(n), `${KIND} engine exports ${n}`);
});

test('root cause: a page-sized clip blocks every object in Phase 9 through the interpreter boolean while PDFium reports no clip; Phase 10B proves it irrelevant', async () => {
  const bytes = clipFixture(fx('invoice-number-longer'), '0 0 612 792 re W n');
  const a = await analyze(E, bytes, 0, { pdfjs });
  const texts = a.objects.filter((o) => o.type === 1);
  assert.equal(texts.length, 9);
  for (const o of texts) {
    const g = targetGates(a, o.index);
    assert.ok(g.some((r) => r.code === 'target-clipped' && /content stream/.test(r.detail)), `Phase 9 blocks ${o.realText} through the stream boolean`);
    assert.ok(o.clipPaths <= 0, `PDFium dropped the page clip for ${o.realText} (CheckClip): ${o.clipPaths}`);
  }
  const rep = await analyzeDocument(E, bytes, { pdfjs });
  assert.equal(rep.summary.supported, 9, JSON.stringify(rep.summary.blockReasons));
  for (const o of rep.objects) {
    assert.deepEqual([o.clip.kind, o.clip.verdict, o.clip.agree, o.clip.pdfiumClipPaths, o.clip.streamClipBoolean], ['rectangular-known', 'contained', true, -1, true]);
    assert.deepEqual(o.clip.effectiveRect, rect(0, 0, 612, 792));
    assert.ok(o.why.some((w) => /clip proven irrelevant/.test(w)), 'supported evidence names the clip decision');
  }
});

test('the two signals can disagree: PDFium keeps clips that are not one containing rectangle; decideClip fails closed on any disagreement', async () => {
  // Older smaller rectangle, then the page: PDFium keeps both paths, the effective region is the cell.
  const a = await analyze(E, helvPdf(`q 60 690 300 30 re W n q 0 0 612 792 re W n ${T1} Q Q`), 0);
  const f = await clipFacts(E, helvPdf(`q 60 690 300 30 re W n q 0 0 612 792 re W n ${T1} Q Q`), a);
  const e = f.get(0);
  assert.equal(e.pdfium.paths, 2);
  assert.equal(e.kind, 'rect');
  assert.ok(e.agree);
  assert.deepEqual([e.region.x0, e.region.y0, e.region.x1, e.region.y1], [60, 690, 360, 720]);
  const o = { bounds: { left: 72, bottom: 697, right: 182, top: 709 } };
  const R = (x0, y0, x1, y1) => ({ kind: 'rect', x0, y0, x1, y1 });
  const d = (stream, pdfium) => { const x = { pdfium: { paths: pdfium ? 1 : -1, region: pdfium }, stream: { region: stream, clipOps: stream ? 1 : 0 } }; decideClip(x, o); return x; };
  assert.equal(d(null, R(0, 0, 612, 792)).agree, false, 'PDFium clip the stream does not install');
  assert.equal(d(R(60, 690, 360, 720), R(60, 690, 300, 720)).agree, false, 'different rectangles');
  assert.equal(d(R(100, 690, 360, 720), null).agree, false, 'PDFium dropped a clip that does not contain its own bounds');
  assert.equal(d(R(60, 690, 360, 720), null).agree, true, 'PDFium dropped a containing rectangle (CheckClip)');
  assert.equal(d(null, null).kind, 'none');
});

test('region primitives: rectangles from re and m/l/h (any CTM that keeps them axis-aligned), intersections, empties and everything else complex', () => {
  const P = (...xy) => ({ points: xy.map(([x, y]) => ({ x, y })), curve: false, malformed: null });
  assert.deepEqual(pathRegion([P([0, 0], [10, 0], [10, 5], [0, 5])]), { kind: 'rect', x0: 0, y0: 0, x1: 10, y1: 5 });
  assert.deepEqual(pathRegion([P([10, 5], [10, 0], [0, 0], [0, 5], [10, 5])]).kind, 'rect');
  assert.equal(pathRegion([P([0, 0], [10, 0], [5, 8])]).kind, 'complex');
  assert.equal(pathRegion([P([0, 0], [7, 7], [0, 14], [-7, 7])]).kind, 'complex', '45 degree square');
  assert.equal(pathRegion([{ ...P([0, 0], [10, 0], [10, 5], [0, 5]), curve: true }]).kind, 'complex');
  assert.equal(pathRegion([P([0, 0], [10, 0], [10, 5], [0, 5]), P([2, 2], [3, 2], [3, 3], [2, 3])]).kind, 'complex', 'two subpaths (W* holes)');
  assert.equal(pathRegion([P([3, 3])]).kind, 'empty');
  assert.equal(pathRegion([]).kind, 'complex');
  const a = { kind: 'rect', x0: 0, y0: 0, x1: 10, y1: 10 };
  assert.deepEqual(intersectRegion(a, { kind: 'rect', x0: 5, y0: -5, x1: 20, y1: 8 }), { kind: 'rect', x0: 5, y0: 0, x1: 10, y1: 8 });
  assert.equal(intersectRegion(a, { kind: 'rect', x0: 20, y0: 20, x1: 30, y1: 30 }).kind, 'empty');
  assert.equal(intersectRegion(a, { kind: 'complex', why: 'x' }).kind, 'complex');
  assert.equal(intersectRegion(null, a), a);
});

// ------------------------------------------------------------------ regression matrix
test('1. no clip: an existing supported edit still commits (no K01, clip kind none)', needEdits, async () => {
  const { r } = await edit(fx('invoice-number-longer'), 'invoice-number-longer');
  assert.equal(r.status, 'committed', failed(r).join(' | '));
  assert.equal(r.clip.kind, 'none');
  assert.ok(!r.checks.some((c) => c.id === 'K01'));
});

for (const [n, label, clip] of [[2, 'page-sized', '0 0 612 792 re W n'], [3, 'crop-sized', '36 36 540 720 re W n']]) {
  test(`${n}. ${label} rectangular clip containing the original and the replacement: SUPPORTED, the edit commits with V01..V13, D01 and K01`, needEdits, async () => {
    const bytes = clipFixture(fx('invoice-number-longer'), clip);
    const { r } = await edit(bytes, 'invoice-number-longer');
    assert.equal(r.status, 'committed', failed(r).join(' | '));
    assert.ok(allPass(r));
    const ids = r.checks.map((c) => c.id);
    for (const id of ['V01', 'V02', 'V03', 'V04', 'V05', 'V06', 'V07', 'V08', 'V09', 'V10', 'V11', 'V12', 'V13', 'D01', 'K01']) assert.ok(ids.includes(id), `${id} ran`);
    assert.equal(r.clip.verdict, 'contained');
    assert.ok(r.stages.some((s) => s.name === 'encode + plan' && /inside the clip rectangle/.test(s.detail)));
  });
}

test('4. a small rectangle that cuts the original text: BLOCKED (target-clipped + clip-cuts-text) before mutation', async () => {
  const bytes = clipBlock(fx('ttf-winansi-nonascii'), '<4D65>', '72 690 60 30 re W n');
  const rep = await analyzeDocument(E, bytes, { pdfjs });
  const o = obj(rep, 'Menu: Caf\u00e9 Z\u00fcrich');
  assert.equal(o.status, STATUS.BLOCKED);
  assert.ok(o.codes.includes('target-clipped') && o.codes.includes(CLIP_CODES.CUTS), o.codes.join(','));
  assert.equal(o.clip.verdict, 'cuts-text');
  assert.equal(obj(rep, 'Unrelated').status, STATUS.SUPPORTED, 'the unclipped line is unaffected');
  const { r } = await edit(bytes, 'ttf-winansi-nonascii');
  assert.equal(r.status, 'blocked');
  assert.ok(r.reasons.some((x) => x.code === CLIP_CODES.CUTS));
  assert.ok(!r.stages.some((s) => /mutate/.test(s.name)), 'no mutation stage ran');
});

test('5. the original fits, a longer replacement would cross the clip: blocked (clip-candidate-outside) before mutation; canonical bytes unchanged', async () => {
  const bytes = clipBlock(fx('invoice-number-longer'), '<49> 30 <6E766F696365>', '60 660 170 30 re W n');
  const rep = await analyzeDocument(E, bytes, { pdfjs });
  const o = obj(rep, 'Invoice Number: 12345');
  assert.equal(o.status, STATUS.SUPPORTED, `the object itself is inside its clip: ${o.codes}`);
  assert.equal(o.clip.verdict, 'contained');
  const { r } = await edit(bytes, 'invoice-number-longer');
  assert.equal(r.status, 'blocked');
  assert.ok(r.reasons.some((x) => x.code === CLIP_CODES.CANDIDATE), r.reasons.map((x) => x.code).join(','));
  assert.ok(r.stages.some((s) => s.name === 'encode + plan' && !s.ok));
  assert.ok(!r.stages.some((s) => /mutate/.test(s.name)), 'no mutation stage ran');
  assert.equal(r.clip.verdict, 'candidate-outside');
  assert.ok(r.clip.candidateBox.right > 230);
  // A replacement that stays inside the same clip is allowed.
  const short = await edit(bytes, 'invoice-number-longer', { replace: '54321' });
  if (EDITS) assert.equal(short.r.status, 'committed', failed(short.r).join(' | '));
  else assert.notEqual(short.r.status, 'blocked', 'a same-width replacement is not blocked by the clip');
});

test('6. fit keeps the candidate inside the clip: natural layout blocked, fit layout planned inside and (Run #10) committed with K01', async () => {
  const bytes = clipBlock(fx('invoice-status-fit'), '<5374617475733A20', '60 500 164.5 30 re W n');
  const rep = await analyzeDocument(E, bytes, { pdfjs });
  assert.equal(obj(rep, 'Status: PENDING REVIEW').clip.verdict, 'contained');
  const natural = await edit(bytes, 'invoice-status-fit', { fit: false });
  assert.equal(natural.r.status, 'blocked');
  assert.ok(natural.r.reasons.some((x) => x.code === CLIP_CODES.CANDIDATE));
  const a = await analyze(E, bytes, 0, { pdfjs });
  const e = FX['invoice-status-fit'].edit;
  const oi = findTextObject(a, e.object);
  const sel = findInObject(a, oi, e.find, 0);
  const plan = await planEditClipAware(E, bytes, { pageIndex: 0, objIndex: oi, start: sel.start, end: sel.end, replacement: e.replace, fit: true, analysis: a, pdfjs });
  assert.ok(plan.ok, plan.reasons.map((x) => x.code).join(','));
  assert.equal(plan.clip.candidate.verdict, 'contained');
  if (EDITS) {
    const fit = await edit(bytes, 'invoice-status-fit', { fit: true });
    assert.equal(fit.r.status, 'committed', failed(fit.r).join(' | '));
    assert.ok(fit.r.checks.find((c) => c.id === 'K01').pass);
  }
});

test('7. non-rectangular clips (triangle, curve, 45 degree rectangle) stay BLOCKED (clip-geometry-unsupported)', async () => {
  for (const clip of ['0 0 m 612 0 l 306 792 l h W n', '60 690 m 360 690 l 360 720 l 200 740 260 740 60 720 c h W n', 'q 0.7071 0.7071 -0.7071 0.7071 306 0 cm 0 0 500 500 re W n Q 0.7071 0.7071 -0.7071 0.7071 306 0 cm 0 0 500 500 re W n 0.7071 -0.7071 0.7071 0.7071 -216.37 216.37 cm']) {
    const rep = await analyzeDocument(E, helvPdf(`q ${clip} ${T1} Q`), { pdfjs });
    const o = rep.objects[0];
    assert.equal(o.status, STATUS.BLOCKED, clip);
    assert.ok(o.codes.includes('target-clipped') && o.codes.includes(CLIP_CODES.UNSUPPORTED), `${clip}: ${o.codes}`);
    assert.equal(o.clip.kind, 'non-rectangular');
  }
});

test('8. nested q/Q clips: each object gets the effective clip of its graphics state; Q restores', async () => {
  const bytes = helvPdf(`q 0 0 612 792 re W n q 60 690 300 30 re W n ${T1} Q ${LINE('Second line 2', 72, 600)} Q ${LINE('Third line 3', 72, 500)}`);
  const rep = await analyzeDocument(E, bytes, { pdfjs });
  assert.deepEqual(obj(rep, 'Clipped cell value 99').clip.effectiveRect, rect(60, 690, 360, 720));
  assert.deepEqual(obj(rep, 'Second line 2').clip.effectiveRect, rect(0, 0, 612, 792));
  assert.equal(obj(rep, 'Third line 3').clip.kind, 'none');
  assert.equal(rep.summary.supported, 3, JSON.stringify(rep.summary.blockReasons));
});

test('9. clip rectangles under cm: 90 degree rotation and a flipped/scaled (Skia-style) transform are exact rectangles; 45 degrees fails closed', async () => {
  const r90 = await analyzeDocument(E, helvPdf(`q 0 1 -1 0 612 0 cm 0 0 792 612 re W n 0 -1 1 0 0 612 cm ${T1} Q`), { pdfjs });
  assert.deepEqual(r90.objects[0].clip.effectiveRect, rect(0, 0, 612, 792));
  assert.equal(r90.objects[0].status, STATUS.SUPPORTED, r90.objects[0].codes.join(','));
  const sk = await analyzeDocument(E, skiaLike(), { pdfjs });
  for (const o of sk.objects) { assert.deepEqual(o.clip.effectiveRect, rect(36, 36, 576, 756)); assert.equal(o.status, STATUS.SUPPORTED, o.codes.join(',')); }
  const r45 = await analyzeDocument(E, helvPdf(`q 0.7071 0.7071 -0.7071 0.7071 306 0 cm 0 0 500 500 re W n 0.7071 -0.7071 0.7071 0.7071 -216.37 216.37 cm ${T1} Q`), { pdfjs });
  assert.ok(r45.objects[0].codes.includes(CLIP_CODES.UNSUPPORTED));
});

test('10. successive W / W* clips intersect; W* with several subpaths (holes) is not a rectangle; disjoint clips are empty', async () => {
  const inter = await analyzeDocument(E, helvPdf(`q 50 650 400 100 re W* n 60 690 300 30 re W n ${T1} Q`), { pdfjs });
  assert.deepEqual(inter.objects[0].clip.effectiveRect, rect(60, 690, 360, 720));
  assert.equal(inter.objects[0].status, STATUS.SUPPORTED, inter.objects[0].codes.join(','));
  const holes = await analyzeDocument(E, helvPdf(`q 60 690 300 30 re 100 695 20 10 re W* n ${T1} Q`), { pdfjs });
  assert.ok(holes.objects[0].codes.includes(CLIP_CODES.UNSUPPORTED), holes.objects[0].codes.join(','));
  const disjoint = await analyzeDocument(E, helvPdf(`q 0 0 100 100 re W n 200 200 100 100 re W n ${T1} Q`), { pdfjs });
  assert.ok(disjoint.objects[0].codes.includes(CLIP_CODES.EMPTY));
  const point = await analyzeDocument(E, helvPdf(`q 60 690 m W n ${T1} Q`), { pdfjs });
  assert.ok(point.objects[0].codes.includes(CLIP_CODES.EMPTY));
});

test('11. clip inside a Form XObject: the form gate still wins; the form clip does not leak to the direct text after the Do', async () => {
  const rep = await analyzeDocument(E, formClip(), { pdfjs });
  assert.ok(rep.summary.blockReasons['text-in-form-xobject'] > 0 || rep.formText.shows > 0, 'form text found and not offered as a direct object');
  assert.ok(!rep.objects.some((o) => o.text === 'Form text 123'), 'form text is not a direct object');
  const d = obj(rep, 'Direct after form 42');
  assert.equal(d.clip.kind, 'none');
  assert.equal(d.status, STATUS.SUPPORTED, d.codes.join(','));
});

test('12. Phase 9 blocked-clip fixture: Phase 9 still blocks it (unchanged); its clip provably contains original and replacement, so Phase 10B supports it', async () => {
  const bytes = fx('blocked-clip');
  const a = await analyze(E, bytes, 0, { pdfjs });
  const oi = findTextObject(a, 'Clipped cell value 99');
  assert.ok(targetGates(a, oi).some((r) => r.code === 'target-clipped'), 'Phase 9 targetGates unchanged');
  const e = FX['blocked-clip'].edit;
  const sel = findInObject(a, oi, e.find, 0);
  const p9 = await runEdit(E, bytes, { pageIndex: 0, objIndex: oi, start: sel.start, end: sel.end, replacement: e.replace, pdfjs });
  assert.equal(p9.status, 'blocked', 'Phase 9 runEdit still blocks');
  assert.ok(p9.reasons.some((r) => r.code === 'target-clipped'));
  const rep = await analyzeDocument(E, bytes, { pdfjs });
  const o = obj(rep, 'Clipped cell value 99');
  assert.equal(o.status, STATUS.SUPPORTED, o.codes.join(','));
  assert.deepEqual(o.clip.effectiveRect, rect(60, 690, 360, 720));
  // Containment with margin: conservative Helvetica boxes (FontBBox + margin) inside the cell.
  assert.ok(o.clip.textBoxIndependent.left >= 60 && o.clip.textBoxIndependent.right <= 360 && o.clip.textBoxIndependent.bottom >= 690 && o.clip.textBoxIndependent.top <= 720, JSON.stringify(o.clip));
  assert.ok(STD14_MARGIN_EM > 0);
  if (EDITS) {
    const r = await runVerifiedEdit(E, bytes, { pageIndex: 0, objIndex: oi, expectedOldText: e.object, selection: { start: sel.start, end: sel.end, replacement: e.replace }, pdfjs });
    assert.equal(r.status, 'committed', failed(r).join(' | '));
    assert.ok(r.checks.find((c) => c.id === 'K01').pass);
  }
});

test('13. verifier rejection with a benign clip (SetPositions disabled): rejected (V05), no output bytes, session working bytes never replaced', needEdits, async () => {
  const bytes = clipFixture(fx('invoice-number-longer'), '0 0 612 792 re W n');
  const a = await analyze(E, bytes, 0, { pdfjs });
  const oi = findTextObject(a, 'Invoice Number: 12345');
  const noop = Object.create(E);
  noop.setPositions = () => true;
  const s = new CorpusSession();
  s.beginLoad();
  const d = s.addDocument({ name: 'clip.pdf', bytes, sha256: await sha256Hex(bytes) });
  s.setActive(d.id);
  const sel = s.select(d.id, 0, oi, 'Invoice Number: 12345');
  const work = d.working.sha;
  const r = await runVerifiedEdit(E, d.working.bytes, { pageIndex: 0, objIndex: oi, expectedOldText: 'Invoice Number: 12345', newText: 'Invoice Number: INV-2026-0012345', pdfjs, applyEngine: noop });
  assert.equal(r.status, 'rejected');
  assert.ok(r.reasons.some((x) => x.code === 'V05'), r.reasons.map((x) => x.code).join(','));
  assert.equal(r.bytes, null);
  const c = await s.commit(sel, r);
  assert.equal(c.ok, false);
  assert.equal(c.code, 'not-verified');
  assert.equal(await sha256Hex(d.working.bytes), work, 'working bytes unchanged');
  assert.equal(await sha256Hex(d.original), work, 'original bytes unchanged');
  assert.equal(d.revision, 0);
});

test('14. redacted diagnostic: clip facts (kinds, rectangles, bounds, verdicts, agreement) are exported by default; no text and no file name', async () => {
  const s = new CorpusSession();
  s.beginLoad();
  for (const [name, bytes] of [['Private Client clipped.pdf', clipFixture(fx('invoice-number-longer'), '0 0 612 792 re W n')], ['Menu cut.pdf', clipBlock(fx('ttf-winansi-nonascii'), '<4D65>', '72 690 60 30 re W n')], ['word.pdf', wordLike()]]) {
    const d = s.addDocument({ name, bytes, sha256: await sha256Hex(bytes) });
    d.report = await analyzeDocument(E, bytes, { name, pdfjs });
  }
  const ex = buildExport(s);
  const str = JSON.stringify(ex);
  for (const leak of ['Invoice', 'Caf\u00e9', 'Menu', 'Private Client', 'clipped.pdf', 'Total due', 'target-clipped: ']) assert.ok(!str.includes(leak), `default export must not contain ${leak}`);
  const objs = ex.documents.flatMap((d) => d.objects);
  const cut = objs.find((o) => o.clip && o.clip.verdict === 'cuts-text');
  assert.ok(cut, 'a cuts-text diagnostic is exported');
  for (const k of ['pdfiumClipPaths', 'streamClipBoolean', 'kind', 'effectiveRect', 'agree', 'textBoxPdfium', 'textBoxIndependent', 'verdict', 'opIndex', 'code']) assert.ok(k in cut.clip, `clip.${k} exported`);
  assert.deepEqual(cut.clip.effectiveRect, rect(72, 690, 132, 720));
  assert.ok(ex.documents.every((d) => d.pagesDetail.every((p) => Array.isArray(p.mediaBox))), 'MediaBox per page');
  assert.ok(objs.filter((o) => o.clip && o.clip.verdict === 'contained').length >= 11);
});

// ------------------------------------------------------------------ further fail-closed cases
test('text clipping render mode (Tr 7): Phase 9 misses it (PDFium counts no path, the boolean ignores it); Phase 10B blocks it', async () => {
  const bytes = textClip();
  const a = await analyze(E, bytes, 0, { pdfjs });
  const oi = findTextObject(a, 'Clipped cell value 99');
  assert.ok(!targetGates(a, oi).some((r) => r.code === 'target-clipped'), 'Phase 9 signals do not see the text clip');
  const rep = await analyzeDocument(E, bytes, { pdfjs });
  const o = obj(rep, 'Clipped cell value 99');
  assert.equal(o.status, STATUS.BLOCKED);
  assert.ok(o.codes.includes('target-clipped') && o.codes.includes(CLIP_CODES.UNSUPPORTED), o.codes.join(','));
});

test('generator page-clip patterns (Word, LibreOffice, Chromium/Skia models): the page clip no longer blocks ordinary text', async () => {
  for (const [label, bytes] of [['word', wordLike()], ['libreoffice', libreOfficeLike()], ['skia', skiaLike()]]) {
    const rep = await analyzeDocument(E, bytes, { pdfjs });
    assert.equal(rep.summary.textObjects, 2, label);
    assert.equal(rep.summary.supported, 2, `${label}: ${JSON.stringify(rep.summary.blockReasons)}`);
    for (const o of rep.objects) assert.equal(o.clip.verdict, 'contained', label);
    const a = await analyze(E, bytes, 0, { pdfjs });
    assert.ok(a.objects.filter((x) => x.type === 1).every((x) => targetGates(a, x.index).some((r) => r.code === 'target-clipped')), `${label}: Phase 9 blocks every object`);
  }
});

test('K01 is a real check: the output of a committed clip edit fails it against a smaller rectangle', needEdits, async () => {
  const bytes = clipFixture(fx('invoice-number-longer'), '0 0 612 792 re W n');
  const { r } = await edit(bytes, 'invoice-number-longer');
  assert.equal(r.status, 'committed', failed(r).join(' | '));
  const k = await outputClipCheck(E, r.bytes, { ...r.plan, clip: { region: { x0: 60, y0: 660, x1: 200, y1: 690 } } });
  assert.equal(k.pass, false, k.evidence);
  const ok = await outputClipCheck(E, r.bytes, r.plan);
  assert.equal(ok.pass, true, ok.evidence);
});

test('engine-interpreter-count-mismatch (separate from clipping): a ligature glyph is one glyph but two PDFium characters; still blocked, cause diagnosed', async () => {
  const rep = await analyzeDocument(E, ligaturePdf(), { pdfjs });
  const lig = rep.objects.find((o) => o.codes.includes('engine-interpreter-count-mismatch'));
  assert.ok(lig, 'the ligature object is blocked by engine-interpreter-count-mismatch');
  assert.equal(lig.status, STATUS.BLOCKED);
  assert.deepEqual(lig.countMismatch, { interpreterGlyphs: 6, pdfiumChars: 7, multiCodepointGlyphs: 1, unmappedGlyphs: 0, expandedMatchesPdfium: true, cause: 'multi-codepoint-glyph' });
  assert.equal(lig.clip.kind, 'none', 'unrelated to clipping');
  assert.equal(obj(rep, 'Plain line 7').status, STATUS.SUPPORTED);
  const s = new CorpusSession();
  s.beginLoad();
  const d = s.addDocument({ name: 'lig.pdf', bytes: ligaturePdf(), sha256: 'x' });
  d.report = rep;
  const ex = buildExport(s).documents[0].objects.find((o) => o.countMismatch);
  assert.equal(ex.countMismatch.cause, 'multi-codepoint-glyph');
  assert.ok(!JSON.stringify(ex).includes('cut'), 'no text in the exported diagnostic');
});

test('rewritten fixtures are valid and otherwise unchanged (control: the same content without a clip classifies as the original)', async () => {
  const same = rewriteContent(fx('invoice-number-longer'), (c) => c);
  const a = await analyzeDocument(E, same, { pdfjs });
  const b = await analyzeDocument(E, fx('invoice-number-longer'), { pdfjs });
  assert.deepEqual(a.objects.map((o) => [o.text, o.status, o.codes.join()]), b.objects.map((o) => [o.text, o.status, o.codes.join()]));
});
