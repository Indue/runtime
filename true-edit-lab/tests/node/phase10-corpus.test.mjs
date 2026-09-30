// Phase 10 corpus harness: Node tests on the REAL Run #10 engine (hash-pinned) and PDF.js
// 3.11.174. Proves that the corpus path classifies and edits exactly as Phase 9 does on all
// 47 pinned fixtures, that blocked cases stay blocked, that a verifier rejection never
// replaces the working bytes, that stale selections and newly loaded files invalidate old
// handles, that documents cannot leak into one another, that malformed and encrypted input
// fails closed, and that the exported report carries no document text by default.
// Usage: node --test tests/node/phase10-corpus.test.mjs
// (P10_ENGINE=stock runs the analysis-only tests on the stock engine for local development;
// the edit tests are then skipped. CI always uses the patched engine and skips nothing.)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { loadEngine } from './lib/engine-node.mjs';
import { pdfjsProvider } from './lib/pdfjs-node.mjs';
import { multipagePdf, multipageGraphicsPdf, incrementalPdf, xrefStreamPdf, malformedPdf, notPdf, passwordPdf } from './lib/phase10-inputs.mjs';
import { analyzeDocument, classifyPage, runVerifiedEdit, documentInvariantCheck, CorpusSession, buildExport, sessionSummary, editRecord, diffText, generatorFamily, redactSample, failedReport, STATUS } from '../../public_html/app.noblepdf.com/lab/true-text-edit/te-corpus.mjs?v=1';
import { analyze, findTextObject, findInObject } from '../../public_html/app.noblepdf.com/lab/true-text-edit/te-pipeline.mjs?v=1';
import { compareWithReference } from '../../public_html/app.noblepdf.com/lab/true-text-edit/te-suite.mjs?v=1';
import { toCodePoints, fromCodePoints } from '../../public_html/app.noblepdf.com/lab/true-text-edit/te-edit.mjs?v=1';
import { sha256Hex, analyzeStructure } from '../../public_html/app.noblepdf.com/lab/true-text-edit/phase8-verify.mjs?v=1';
import { urlVerdict, LAB_QUERIES } from '../../public_html/app.noblepdf.com/lab/true-text-edit/te-corpus-env.mjs?v=1';

const LAB = new URL('../../public_html/app.noblepdf.com/lab/true-text-edit/', import.meta.url);
const DIR = new URL('fixtures-phase9/', LAB);
const manifest = JSON.parse(readFileSync(new URL('manifest.txt', DIR)));
const FX = Object.fromEntries(manifest.fixtures.map((f) => [f.id, f]));
const load = async (name) => new Uint8Array(readFileSync(new URL(name, DIR)));
const before = (id) => load(FX[id].before);
const KIND = process.env.P10_ENGINE || 'patched';
const E = await loadEngine(KIND);
const pdfjs = await pdfjsProvider(3);
const EDITS = E.hasApi('FPDFText_SetPositions');
if (!EDITS && KIND !== 'stock') throw new Error('patched engine without FPDFText_SetPositions');
const needEdits = { skip: EDITS ? false : 'stock engine (local development only): no SetPositions' };
const objByText = (rep, text, page = 0) => rep.objects.find((o) => o.page === page && o.text === text);
const replaced = (obj, find, repl) => { const i = obj.indexOf(find); return obj.slice(0, i) + repl + obj.slice(i + find.length); };

// ------------------------------------------------------------------ parity with Phase 9
test('all 47 fixtures: corpus classification + corpus edit path reproduce every Phase 9 expectation (22 committed, 25 failed closed)', needEdits, async () => {
  const counts = { committed: 0, blocked: 0, rejected: 0 };
  const problems = [];
  for (const fx of manifest.fixtures) {
    const bytes = await load(fx.before);
    assert.equal(await sha256Hex(bytes), fx.sha256.before, `${fx.id}: fixture hash`);
    const e = fx.edit || {};
    const pageIndex = e.page || 0;
    const rep = await analyzeDocument(E, bytes, { name: fx.id, pdfjs });
    assert.equal(rep.status, 'analysed', `${fx.id}: analysed`);
    const a = await analyze(E, bytes, pageIndex, { pdfjs });
    const oi = e.object ? findTextObject(a, e.object) : -1;
    let status;
    let codes;
    if (oi < 0) {
      // Not a direct text object (Form XObject text, image-only page): the corpus report
      // must carry the reason at page/document level, exactly as runFixture derives it.
      status = 'blocked';
      codes = [...rep.documentReasons.map((r) => r.code), ...rep.pages.flatMap((p) => p.pageReasons.map((r) => r.code)), ...(rep.formText.shows && e.object && a.pdfium.chars.filter((c) => c.objIndex === -2 && c.cp).map((c) => String.fromCodePoint(c.cp)).join('').includes(e.object) ? ['text-in-form-xobject'] : [])];
      if (fx.id === 'blocked-form-xobject' && !(rep.summary.blockReasons['text-in-form-xobject'] > 0)) problems.push(`${fx.id}: summary lacks text-in-form-xobject`);
    } else {
      const sel = findInObject(a, oi, e.find, e.occurrence || 0);
      const r = await runVerifiedEdit(E, bytes, { pageIndex, objIndex: oi, expectedOldText: a.objects[oi].realText, selection: { start: sel.start, end: sel.end, replacement: e.replace }, fit: !!e.fit, pdfjs });
      status = r.status;
      codes = r.reasons.map((x) => x.code);
      assert.equal(await sha256Hex(bytes), fx.sha256.before, `${fx.id}: source bytes unchanged`);
      if (r.status !== 'committed') assert.equal(r.bytes, null, `${fx.id}: no output bytes unless committed`);
      if (r.status === 'committed') {
        const ref = await compareWithReference(E, r.bytes, await load(fx.reference), fx, r.plan, { pdfjs });
        for (const c of ref) if (!c.pass) problems.push(`${fx.id}: ${c.id} ${c.name} (${c.evidence.slice(0, 120)})`);
        const d01 = r.checks.find((c) => c.id === 'D01');
        if (!d01 || !d01.pass) problems.push(`${fx.id}: D01 missing or failed`);
      }
      // The corpus classification of the target object agrees with the gates the edit met.
      const cls = rep.objects.find((o) => o.page === pageIndex && o.objIndex === oi);
      const gateStage = r.stages.find((s) => s.name === 'classify');
      if (fx.expect.status === 'committed' && cls.status !== STATUS.SUPPORTED) problems.push(`${fx.id}: target classified ${cls.status} (${cls.codes}) but the edit commits`);
      if (gateStage && !gateStage.ok) {
        if (cls.status !== STATUS.BLOCKED) problems.push(`${fx.id}: gates block the edit but the object is classified ${cls.status}`);
        for (const c of codes) if (!cls.codes.includes(c)) problems.push(`${fx.id}: classification lacks gate code ${c}`);
      }
    }
    if (status !== fx.expect.status) problems.push(`${fx.id}: status ${status}, expected ${fx.expect.status} (${codes.join(',')})`);
    for (const c of fx.expect.reasons || []) if (fx.expect.status !== 'committed' && !codes.includes(c)) problems.push(`${fx.id}: missing reason ${c} (got ${codes.join(',')})`);
    counts[status] = (counts[status] || 0) + 1;
  }
  assert.deepEqual(problems, []);
  assert.equal(manifest.fixtures.length, 47);
  assert.deepEqual(counts, { committed: 22, blocked: 24, rejected: 1 });
});

test('SetPositions-disabled control through the corpus edit path is rejected (V05)', needEdits, async () => {
  const fx = FX['invoice-number-longer'];
  const bytes = await before(fx.id);
  const a = await analyze(E, bytes, 0, { pdfjs });
  const oi = findTextObject(a, fx.edit.object);
  const noop = Object.create(E);
  noop.setPositions = () => true;
  const r = await runVerifiedEdit(E, bytes, { pageIndex: 0, objIndex: oi, expectedOldText: fx.edit.object, newText: replaced(fx.edit.object, fx.edit.find, fx.edit.replace), pdfjs, applyEngine: noop });
  assert.equal(r.status, 'rejected');
  assert.ok(r.reasons.some((x) => x.code === 'V05'), r.reasons.map((x) => x.code).join(','));
  assert.equal(r.bytes, null);
});

// ------------------------------------------------------------------ classification of blocked cases
test('supported fixture is classified SUPPORTED with evidence; every object on the invoice page passes', async () => {
  const rep = await analyzeDocument(E, await before('invoice-number-longer'), { pdfjs });
  const o = objByText(rep, 'Invoice Number: 12345');
  assert.equal(o.status, STATUS.SUPPORTED);
  assert.deepEqual(o.codes, []);
  assert.ok(o.why.length >= 6 && o.why.some((w) => /planning probe/.test(w)) && o.why.some((w) => /independent interpreter agrees/.test(w)), o.why.join(' | '));
  assert.equal(rep.summary.supported, rep.summary.textObjects);
  assert.equal(rep.summary.safeEditExists, true);
  assert.equal(rep.summary.percentEditableObjects, 100);
});

test('signed document: every object BLOCKED (signed-document), no safe edit, edit refused before mutation', async () => {
  const bytes = await before('blocked-signed');
  const rep = await analyzeDocument(E, bytes, { pdfjs });
  assert.ok(rep.documentReasons.some((r) => r.code === 'signed-document'));
  assert.ok(rep.objects.length > 0 && rep.objects.every((o) => o.status === STATUS.BLOCKED && o.codes.includes('signed-document')));
  assert.equal(rep.summary.safeEditExists, false);
  assert.equal(rep.doc.signatures, 1);
  assert.ok(rep.structure.catalog.sigFields >= 1 && rep.structure.catalog.signedSigFields >= 1);
  const o = objByText(rep, 'Invoice Number: 12345');
  const r = await runVerifiedEdit(E, bytes, { pageIndex: 0, objIndex: o.objIndex, expectedOldText: o.text, newText: 'Invoice Number: 99999', pdfjs });
  assert.equal(r.status, 'blocked');
  assert.ok(r.reasons.some((x) => x.code === 'signed-document'));
  assert.equal(r.stages.find((s) => s.name === 'classify').ok, false);
});

test('Form XObject text is blocked (text-in-form-xobject) and never offered as a direct object', async () => {
  const rep = await analyzeDocument(E, await before('blocked-form-xobject'), { pdfjs });
  assert.ok(rep.formText.shows >= 1 && rep.formText.pdfiumChars > 0);
  assert.ok(rep.summary.blockReasons['text-in-form-xobject'] >= 1);
  assert.ok(rep.summary.unsupportedFeatures.includes('text-in-form-xobject'));
  assert.equal(objByText(rep, 'Form text 123'), undefined);
  assert.ok(rep.summary.percentEditableChars < 100);
});

test('Type3, vertical, text rise, clip, optional content, ActualText, rotation, shared content stay BLOCKED with every code', async () => {
  const want = { 'blocked-type3': ['abab', ['font-type3']], 'blocked-vertical': ['Vertical text', ['font-vertical']], 'blocked-text-rise': ['Raised note', ['text-rise-not-validated']], 'blocked-clip': ['Clipped cell value 99', ['target-clipped']],
    'blocked-optional-content': ['Layered words', ['optional-content']], 'blocked-page-rotate': ['Rotated page text', ['page-rotation-not-validated']], 'blocked-shared-content': ['Shared content 42', ['shared-content-stream']], 'blocked-no-unicode-map': [null, ['font-no-unicode-map']] };
  for (const [id, [text, codes]] of Object.entries(want)) {
    const rep = await analyzeDocument(E, await before(id), { pdfjs });
    const objs = text ? rep.objects.filter((o) => o.text === text) : rep.objects.filter((o) => o.codes.includes(codes[0]));
    assert.ok(objs.length >= 1, `${id}: object found`);
    for (const o of objs) {
      assert.equal(o.status, STATUS.BLOCKED, `${id}: ${o.text}`);
      for (const c of codes) assert.ok(o.codes.includes(c), `${id}: ${c} in ${o.codes}`);
      assert.equal(o.codes.length, new Set(o.reasons.map((r) => r.code)).size, `${id}: codes list every distinct reason`);
    }
  }
  const v = await analyzeDocument(E, await before('blocked-vertical'), { pdfjs });
  assert.ok(v.fonts.some((f) => f.vertical && f.blockCode === 'font-vertical' && f.kind === 'Type0/CIDFontType2'));
  assert.ok(objByText(v, 'Vertical text').codes.length >= 2, 'multiple reasons are not hidden');
  const t3 = await analyzeDocument(E, await before('blocked-type3'), { pdfjs });
  assert.ok(t3.fonts.some((f) => f.subtype === 'Type3' && f.blockCode === 'font-type3'));
});

test('missing glyph: the object is supported, but an edit needing an absent glyph is blocked before mutation', needEdits, async () => {
  const fx = FX['blocked-glyph-missing'];
  const bytes = await before(fx.id);
  const rep = await analyzeDocument(E, bytes, { pdfjs });
  const o = objByText(rep, fx.edit.object);
  assert.equal(o.status, STATUS.SUPPORTED);
  const r = await runVerifiedEdit(E, bytes, { pageIndex: 0, objIndex: o.objIndex, expectedOldText: o.text, newText: replaced(o.text, fx.edit.find, fx.edit.replace), pdfjs });
  assert.equal(r.status, 'blocked');
  assert.ok(r.reasons.some((x) => x.code === 'glyph-not-in-font-subset'));
  assert.equal(r.bytes, null);
});

// ------------------------------------------------------------------ commit / reject / download
test('verifier rejection never replaces the working bytes; a committed edit enables verified download', needEdits, async () => {
  const s = new CorpusSession();
  s.beginLoad();
  const rb = await before('rejected-untouched-grouping');
  const d = s.addDocument({ name: 'r.pdf', bytes: rb, sha256: await sha256Hex(rb) });
  d.report = await analyzeDocument(E, d.original, { pdfjs });
  s.setActive(d.id);
  const o = objByText(d.report, 'Editable line');
  const sel = s.select(d.id, 0, o.objIndex, o.text);
  const r = await runVerifiedEdit(E, d.working.bytes, { pageIndex: 0, objIndex: o.objIndex, expectedOldText: o.text, newText: 'Editable row', pdfjs });
  assert.equal(r.status, 'rejected');
  assert.ok(r.checks.some((c) => c.id === 'V12' && !c.pass));
  const cm = await s.commit(sel, r);
  assert.equal(cm.ok, false);
  assert.equal(cm.code, 'not-verified');
  assert.equal(d.working.sha, d.originalSha);
  assert.equal(await sha256Hex(d.working.bytes), d.originalSha);
  assert.equal(await s.verifiedBytes(d.id), null, 'download stays disabled');
  // Successful edit on a second document.
  const ib = await before('invoice-number-longer');
  const d2 = s.addDocument({ name: 'i.pdf', bytes: ib, sha256: await sha256Hex(ib) });
  d2.report = await analyzeDocument(E, d2.original, { pdfjs });
  s.setActive(d2.id);
  const o2 = objByText(d2.report, 'Invoice Number: 12345');
  const sel2 = s.select(d2.id, 0, o2.objIndex, o2.text);
  const r2 = await runVerifiedEdit(E, d2.working.bytes, { pageIndex: 0, objIndex: o2.objIndex, expectedOldText: o2.text, newText: 'Invoice Number: INV-2026-0012345', pdfjs });
  assert.equal(r2.status, 'committed', JSON.stringify(r2.reasons));
  assert.ok(r2.checks.length >= 14 && r2.checks.every((c) => c.pass));
  assert.equal((await s.commit(sel2, r2)).ok, true);
  const dl = await s.verifiedBytes(d2.id);
  assert.ok(dl && (await sha256Hex(dl)) === r2.outputSha);
  const st = analyzeStructure(dl, d2.original);
  assert.ok(st.singleRevision, 'download is a single non-incremental revision');
  assert.equal(await sha256Hex(d2.original), d2.originalSha, 'original bytes untouched');
  s.undo(d2.id);
  assert.equal(await s.verifiedBytes(d2.id), null, 'after undo to the original, download is disabled again');
  assert.equal(d.working.sha, d.originalSha, 'the other document is untouched');
});

test('stale selection, stale revision and a newly loaded PDF cannot commit', needEdits, async () => {
  const s = new CorpusSession();
  s.beginLoad();
  const ib = await before('invoice-number-longer');
  const d = s.addDocument({ name: 'i.pdf', bytes: ib, sha256: await sha256Hex(ib) });
  d.report = await analyzeDocument(E, d.original, { pdfjs, probe: false });
  s.setActive(d.id);
  const o = objByText(d.report, 'Invoice Number: 12345');
  const sel1 = s.select(d.id, 0, o.objIndex, o.text);
  const r1 = await runVerifiedEdit(E, d.working.bytes, { pageIndex: 0, objIndex: o.objIndex, expectedOldText: o.text, newText: 'Invoice Number: 777', pdfjs });
  assert.equal(r1.status, 'committed');
  // Revision changed underneath the selection.
  d.revision++;
  assert.equal(s.checkSelection(sel1).code, 'stale-revision');
  assert.equal((await s.commit(sel1, r1)).ok, false);
  d.revision--;
  assert.equal((await s.commit(sel1, r1)).ok, true);
  // The old selection token is spent: a second commit with it is refused.
  assert.equal(s.checkSelection(sel1).code, 'stale-selection');
  assert.equal((await s.commit(sel1, r1)).ok, false);
  // The analysed object text no longer matches: the edit path itself refuses (stale-object).
  const r2 = await runVerifiedEdit(E, d.working.bytes, { pageIndex: 0, objIndex: o.objIndex, expectedOldText: 'Invoice Number: 12345', newText: 'Invoice Number: 1', pdfjs });
  assert.equal(r2.status, 'stale');
  // A result computed from other bytes is refused even with a fresh selection.
  const sel2 = s.select(d.id, 0, o.objIndex, 'Invoice Number: 777');
  assert.equal((await s.commit(sel2, r1)).code, 'stale-bytes');
  // Loading new files invalidates the selection.
  s.beginLoad();
  assert.equal(s.checkSelection(sel2).code, 'stale-generation');
  const w = d.working.sha;
  const r3 = await runVerifiedEdit(E, d.working.bytes, { pageIndex: 0, objIndex: o.objIndex, expectedOldText: 'Invoice Number: 777', newText: 'Invoice Number: 888', pdfjs });
  assert.equal(r3.status, 'committed');
  assert.equal((await s.commit(sel2, r3)).code, 'stale-generation');
  assert.equal(d.working.sha, w);
});

test('multiple PDFs keep separate bytes, selections, histories and reports', needEdits, async () => {
  const s = new CorpusSession();
  s.beginLoad();
  const ib = await before('invoice-number-longer');
  const A = s.addDocument({ name: 'a.pdf', bytes: ib, sha256: await sha256Hex(ib) });
  const B = s.addDocument({ name: 'b.pdf', bytes: ib, sha256: await sha256Hex(ib) });
  const cb = await before('cid-greek');
  const C = s.addDocument({ name: 'c.pdf', bytes: cb, sha256: await sha256Hex(cb) });
  for (const d of [A, B, C]) d.report = await analyzeDocument(E, d.original, { pdfjs, probe: false });
  assert.notEqual(A.original, B.original, 'each document owns a copy of its bytes');
  assert.notEqual(A.report.objects, B.report.objects);
  s.setActive(A.id);
  const o = objByText(A.report, 'Invoice Number: 12345');
  const selA = s.select(A.id, 0, o.objIndex, o.text);
  const r = await runVerifiedEdit(E, A.working.bytes, { pageIndex: 0, objIndex: o.objIndex, expectedOldText: o.text, newText: 'Invoice Number: 42', pdfjs });
  s.setActive(B.id);
  assert.equal(s.checkSelection(selA).ok, false, 'switching documents invalidates the selection');
  assert.equal((await s.commit(selA, r)).ok, false);
  s.setActive(A.id);
  const selA2 = s.select(A.id, 0, o.objIndex, o.text);
  assert.equal((await s.commit(selA2, r)).ok, true);
  A.edits.push(editRecord(selA2, r));
  assert.equal(B.working.sha, B.originalSha);
  assert.equal(C.working.sha, C.originalSha);
  assert.equal(B.revision, 0);
  assert.equal(B.edits.length, 0);
  assert.equal(await s.verifiedBytes(B.id), null);
  A.report.objects[0].text = 'mutated in A only';
  assert.notEqual(B.report.objects[0].text, 'mutated in A only');
  const sum = sessionSummary(s);
  assert.equal(sum.documents, 3);
  assert.equal(sum.committedEdits, 1);
});

// ------------------------------------------------------------------ intake failures
test('malformed, non-PDF, password-protected and oversized inputs fail closed', async () => {
  const cases = [[malformedPdf(), ['malformed-pdf', 'document-open-failed']], [notPdf(), ['pdf-header-missing']], [passwordPdf(), ['password-required']]];
  for (const [bytes, codes] of cases) {
    const rep = await analyzeDocument(E, bytes, { pdfjs });
    assert.equal(rep.status, 'failed');
    assert.ok(codes.includes(rep.intake[0].code), rep.intake[0].code);
    assert.equal(rep.objects.length, 0);
    assert.equal(rep.summary.supported, 0);
    assert.equal(rep.summary.safeEditExists, false);
  }
  const big = failedReport('big.pdf', 200 * 1024 * 1024, '', 'file-too-large', 'not read');
  assert.equal(big.status, 'failed');
  assert.equal(big.summary.textObjects, 0);
  const enc = await analyzeDocument(E, await before('blocked-encrypted-restricted'), { pdfjs });
  assert.equal(enc.status, 'analysed');
  assert.ok(enc.doc.securityRevision >= 0);
  for (const c of ['encrypted-document', 'permissions-restrict-modify']) assert.ok(enc.documentReasons.some((r) => r.code === c));
  assert.ok(enc.objects.every((o) => o.status === STATUS.BLOCKED));
});

// ------------------------------------------------------------------ real-world structures
test('multi-page document with text on other pages: per-page classification; an edit is REJECTED by Phase 9 V11 (page-scoped), never committed; D01 compares the other pages', async () => {
  const bytes = multipagePdf();
  const rep = await analyzeDocument(E, bytes, { pdfjs });
  assert.equal(rep.summary.pages, 3);
  assert.equal(rep.summary.pagesAnalysed, 3);
  assert.equal(rep.generator, 'Microsoft Word');
  assert.ok(rep.pages[2].pageReasons.some((r) => r.code === 'page-rotation-not-validated'));
  assert.equal(objByText(rep, 'Rotated page text', 2).status, STATUS.BLOCKED);
  const o = objByText(rep, 'Reference code ABC-123', 1);
  assert.equal(o.status, STATUS.SUPPORTED);
  // D01 on independently built variants: only page 2 differs.
  const variant = multipagePdf('XYZ-98765');
  const pos = documentInvariantCheck(E, bytes, variant, 1);
  assert.ok(pos.pass && /2 other page\(s\) identical/.test(pos.evidence), pos.evidence);
  const neg = documentInvariantCheck(E, bytes, variant, 0);
  assert.equal(neg.pass, false);
  assert.match(neg.evidence, /page 2 changed/);
  if (!EDITS) return;
  // Phase 9 V11 builds its reference set from the edited page only, so the text streams of
  // the other pages count as unreferenced: the edit fails closed. Phase 10 must not relax it.
  const r = await runVerifiedEdit(E, bytes, { pageIndex: 1, objIndex: o.objIndex, expectedOldText: o.text, newText: 'Reference code XYZ-98765', pdfjs });
  assert.equal(r.status, 'rejected');
  assert.deepEqual(r.checks.filter((c) => !c.pass).map((c) => c.id), ['V11']);
  assert.match(r.checks.find((c) => c.id === 'V11').evidence, /orphan text streams \[\d+,\d+\]/);
  assert.ok(r.checks.find((c) => c.id === 'D01').pass);
  assert.equal(r.bytes, null);
  assert.equal(await sha256Hex(bytes), await sha256Hex(multipagePdf()), 'source bytes unchanged');
});

test('multi-page document whose other pages hold no text: an edit on page 2 commits and D01 proves both other pages unchanged', needEdits, async () => {
  const bytes = multipageGraphicsPdf();
  const rep = await analyzeDocument(E, bytes, { pdfjs });
  assert.equal(rep.summary.pages, 3);
  const o = objByText(rep, 'Reference code ABC-123', 1);
  assert.equal(o.status, STATUS.SUPPORTED);
  const r = await runVerifiedEdit(E, bytes, { pageIndex: 1, objIndex: o.objIndex, expectedOldText: o.text, newText: 'Reference code XYZ-98765', pdfjs });
  assert.equal(r.status, 'committed', JSON.stringify(r.reasons));
  const d01 = r.checks.find((c) => c.id === 'D01');
  assert.ok(d01.pass && /2 other page\(s\) identical/.test(d01.evidence), d01.evidence);
  assert.ok(analyzeStructure(r.bytes, bytes).singleRevision);
});

test('incremental update and cross-reference stream documents are detected and still edit into one clean revision', async () => {
  const inc = await analyzeDocument(E, incrementalPdf(), { pdfjs });
  assert.equal(inc.doc.trailerEnds, 2);
  assert.equal(inc.structure.eofCount, 2);
  assert.equal(inc.structure.prevCount, 1);
  assert.equal(inc.structure.incrementalUpdatesEstimate, 1);
  assert.ok(objByText(inc, 'Invoice Number: 67890'), 'the latest revision is analysed');
  assert.equal(inc.generator, 'LibreOffice / OpenOffice');
  const xs = await analyzeDocument(E, xrefStreamPdf(), { pdfjs });
  assert.equal(xs.structure.xrefStyle, 'cross-reference stream');
  assert.equal(xs.structure.objStmCount, 1);
  assert.equal(xs.generator, 'Chrome print (Skia)');
  assert.equal(objByText(xs, 'Chrome printed line').status, STATUS.SUPPORTED);
  if (!EDITS) return;
  for (const [bytes, text, next] of [[incrementalPdf(), 'Invoice Number: 67890', 'Invoice Number: 67891'], [xrefStreamPdf(), 'Chrome printed line', 'Chrome printed page']]) {
    const c = await classifyPage(E, bytes, 0, { pdfjs });
    const o = c.records.find((x) => x.text === text);
    const r = await runVerifiedEdit(E, bytes, { pageIndex: 0, objIndex: o.objIndex, expectedOldText: text, newText: next, pdfjs });
    assert.equal(r.status, 'committed', `${text}: ${JSON.stringify(r.reasons)}`);
    assert.ok(r.checks.find((x) => x.id === 'V01').pass);
  }
});

// ------------------------------------------------------------------ export and privacy of the report
test('export: no file names, no document text, no reason details, no raw Producer/Creator and no PDF bytes by default; each only on request', async () => {
  const s = new CorpusSession();
  s.beginLoad();
  for (const id of ['invoice-number-longer', 'blocked-signed', 'blocked-tracked-text']) {
    const b = await before(id);
    const d = s.addDocument({ name: `Private Client ${id}.pdf`, bytes: b, sha256: await sha256Hex(b) });
    d.report = await analyzeDocument(E, d.original, { name: d.name, pdfjs });
  }
  for (const [name, b] of [['Private Client chrome.pdf', xrefStreamPdf()], ['Private Client word.pdf', multipagePdf()]]) {
    const d = s.addDocument({ name, bytes: b, sha256: await sha256Hex(b) });
    d.report = await analyzeDocument(E, d.original, { name, pdfjs, probe: false });
  }
  const secrets = ['Invoice Number', 'Jane Citizen', 'Consulting services', 'Tracked heading', 'Private Client', '%PDF', 'Skia/PDF m128', 'Mozilla/5.0', 'for Microsoft 365'];
  const def = JSON.stringify(buildExport(s));
  for (const x of secrets) assert.ok(!def.includes(x), `default export leaks ${x}`);
  const rep = JSON.parse(def);
  assert.equal(rep.schema, 'noblepdf-phase10-corpus-report/1');
  assert.equal(rep.documents.length, 5);
  assert.equal(rep.documents[0].fileName, null);
  assert.equal(rep.privacy.generatorStrings, false);
  assert.deepEqual(rep.documents.slice(3).map((x) => x.generator), [{ family: 'Chrome print (Skia)' }, { family: 'Microsoft Word' }], 'generator family exported, raw strings withheld');
  const gen = buildExport(s, { includeGeneratorStrings: true });
  assert.deepEqual([gen.documents[3].generator.producer, gen.documents[3].generator.creator], ['Skia/PDF m128', 'Mozilla/5.0 Chrome/128.0.0.0'], 'raw strings only on explicit opt-in');
  assert.equal(gen.privacy.generatorStrings, true);
  assert.ok(rep.documents[0].sha256.length === 64 && rep.documents[0].objects.length > 0 && rep.documents[0].objects.every((o) => o.sample === undefined && o.details === undefined));
  assert.ok(rep.documents[1].objects.every((o) => o.codes.includes('signed-document')));
  assert.equal(rep.privacy.pdfBytes, false);
  assert.ok(def.length < 200000);
  const red = buildExport(s, { samples: 'redacted' });
  const inv = red.documents[0].objects.find((o) => o.sample === 'Aaaaaaa Aaaaaa: 99999');
  assert.ok(inv, 'redacted sample keeps only the shape');
  assert.ok(!JSON.stringify(red).includes('Invoice Number'));
  const plain = buildExport(s, { samples: 'plain', includeFileNames: true });
  assert.ok(JSON.stringify(plain).includes('Invoice Number: 12345'));
  assert.equal(plain.documents[0].fileName, 'Private Client invoice-number-longer.pdf');
  assert.equal(redactSample('Total 1,234.50 AUD'), 'Aaaaa 9,999.99 AAA');
});

// ------------------------------------------------------------------ units
test('exact URL policy: pinned path AND its one exact query; everything else fails closed', () => {
  const P = 'https://app.noblepdf.com/lab/true-text-edit/phase10-corpus.html';
  const ok = (u) => urlVerdict(u, P).ok;
  const why = (u) => urlVerdict(u, P).why || '';
  for (const [f, q] of Object.entries(LAB_QUERIES)) assert.ok(ok(`${f}${q}`), `${f}${q} allowed`);
  assert.ok(ok('phase10-favicon.png?v=1'));
  assert.ok(ok('phase10-base.css?v=1'), 'the Phase 10-owned base stylesheet is allowed');
  assert.equal(Object.prototype.hasOwnProperty.call(LAB_QUERIES, 'phase8.css'), false, 'phase8.css is not a Phase 10 dependency');
  assert.ok(ok('/vendor/pdfium-2.15.1-setpositions/pdfium.wasm?te=patched-0123456789ab') && ok('/vendor/pdfium-2.15.1-setpositions/index.js?te=patched-a1b2c3d4e5f6'));
  assert.ok(ok('/vendor/pdfjs-3.11.174/pdf.min.js') && ok('/vendor/pdfjs-3.11.174/pdf.worker.min.js'));
  const refused = [
    'phase10.css?secret=JaneCitizen', 'phase10.css?data=%25PDF-1.7', 'phase10.css?q=Invoice%20Number%3A%2012345', 'phase10.css?rt=1', 'phase10.css?v=2', 'phase10.css?v=1&x=1',
    'phase10.css?x=1&v=1', 'phase10.css?v=01', 'phase10.css?V=1', 'phase10.css?v=1&', 'phase10.css', 'phase10.css?v=1#frag', 'te-env.mjs?v=1', 'phase8.css?v=1',
    'phase8.css?v=2', 'phase8.css', 'phase10-base.css', 'phase10-base.css?v=2', 'phase10-base.css?v=1&v=1',
    '/vendor/pdfium-2.15.1-setpositions/index.js?te=patched-XYZ', '/vendor/pdfium-2.15.1-setpositions/index.js?te=patched-0123456789AB', '/vendor/pdfium-2.15.1-setpositions/index.js?te=patched-0123456789abc',
    '/vendor/pdfium-2.15.1-setpositions/index.js?te=stock-0123456789ab', '/vendor/pdfium-2.15.1-setpositions/index.js?te=patched-0123456789ab&x=1', '/vendor/pdfium-2.15.1-setpositions/index.js',
    '/vendor/pdfjs-3.11.174/pdf.min.js?v=1', '/vendor/pdfjs-3.11.174/pdf.worker.min.js?x', '/favicon.ico', 'favicon.ico', 'phase10-favicon.png', 'phase10-favicon.png?v=2', 'other-favicon.png?v=1',
    'fixtures-phase9/manifest.txt?v=1', 'sub/phase10.css?v=1', '/lab/true-text-edit/../x.css', 'https://example.com/phase10.css?v=1', 'https://user:pw@app.noblepdf.com/lab/true-text-edit/phase10.css?v=1',
  ];
  for (const u of refused) assert.equal(ok(u), false, `${u} must be refused`);
  assert.match(why('phase10.css?secret=JaneCitizen'), /unexpected query/);
  assert.match(why('/vendor/pdfium-2.15.1-setpositions/index.js?te=patched-XYZ'), /unexpected query .* engine/);
  assert.match(why('/favicon.ico'), /outside the pinned file list/);
  assert.match(why('phase8.css?v=2'), /outside the pinned file list \(\/lab\/true-text-edit\/phase8\.css\)/, 'the Phase 9 stylesheet URL is not allowed on the Phase 10 page');
});

test('diffText is exactly the Phase 9 editor diff (source extracted from phase9-editor.js)', () => {
  const src = readFileSync(new URL('phase9-editor.js', LAB), 'utf8');
  const from = src.indexOf('const isWs = ');
  const to = src.indexOf('async function apply()');
  assert.ok(from > 0 && to > from, 'diff source located');
  const phase9Diff = new Function('toCodePoints', 'fromCodePoints', `${src.slice(from, to)}\nreturn diff;`)(toCodePoints, fromCodePoints);
  const words = ['', 'a', 'Invoice', 'Number:', '12345', 'INV-2026-0012345', '\u{10300}\u{10301}', 'Caf\u00e9', ' ', '  ', '\u00a0', 'x y'];
  let n = 0;
  for (const a of words) for (const b of words) for (const c of words) {
    const oldT = `${a} ${b}`;
    const newT = `${a} ${c}`;
    assert.deepEqual(diffText(oldT, newT), phase9Diff(oldT, newT), `${JSON.stringify(oldT)} -> ${JSON.stringify(newT)}`);
    assert.deepEqual(diffText(newT, oldT), phase9Diff(newT, oldT));
    n++;
  }
  assert.ok(n > 1000);
});

test('generator families from Producer/Creator', () => {
  assert.equal(generatorFamily('Microsoft\u00ae Word for Microsoft 365', 'Microsoft\u00ae Word for Microsoft 365'), 'Microsoft Word');
  assert.equal(generatorFamily('Skia/PDF m118 Google Docs Renderer', ''), 'Google Docs');
  assert.equal(generatorFamily('Skia/PDF m120', 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0'), 'Edge print (Skia)');
  assert.equal(generatorFamily('macOS Version 14.4 (Build 23E214) Quartz PDFContext', ''), 'macOS Quartz / Preview');
  assert.equal(generatorFamily('LibreOffice 7.6', 'Writer'), 'LibreOffice / OpenOffice');
  assert.equal(generatorFamily('Canva', ''), 'Canva');
  assert.equal(generatorFamily('', ''), 'Unknown (no Producer/Creator metadata)');
  assert.equal(generatorFamily('SomethingNew 1.0', ''), 'Other');
});
