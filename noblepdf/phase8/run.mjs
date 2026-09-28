#!/usr/bin/env node
// NoblePDF True Edit — Phase 8 mutation/regression suite.
//
//   node run.mjs --engine <dist dir> [--out <dir>] [--expect-wasm <sha256>]
//
// Runs every fixture against the given @embedpdf/pdfium dist (the patched
// 2.15.1 build with FPDFText_SetPositions), prints PASS/FAIL per fixture and
// check, writes report.json + report.md, and exits non-zero if the
// production-readiness gate fails.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  loadEngine,
  pageToObjectPositions,
  apply,
  FPDF_PAGEOBJ_TEXT,
  FPDF_PAGEOBJ_IMAGE,
} from './lib/engine.mjs';
import { buildPdf, specShow, cidWidths, hasFractionalWidths } from './lib/fixtures.mjs';
import * as pdfjsLane from './lib/pdfjs.mjs';
import { diff } from './lib/image.mjs';
import { showSequences, containsSequence } from './lib/content.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);
const ENGINE = resolve(args.engine ?? 'node_modules/@embedpdf/pdfium/dist');
const OUT = resolve(args.out ?? 'out');
const SCALE = 4; // 288 dpi renders for pixel comparison
const TOL = {
  glyphDriftPt: 0.01, // PDFium glyph origins after save/reopen
  pdfjsOriginPt: 0.05, // PDF.js text-run origin
  editedRegionChangedFrac: 0.002, // edited object vs independent reference
};

// ---------------------------------------------------------------------------
// Fixtures
const deg = (d) => (d * Math.PI) / 180;
const rot = (d, x, y) => [Math.cos(deg(d)), Math.sin(deg(d)), -Math.sin(deg(d)), Math.cos(deg(d)), x, y];
const context = (font, y) => ({
  id: 'context',
  font,
  size: 11,
  tc: 0.25,
  tw: 2,
  tm: [1, 0, 0, 1, 72, y],
  show: ['Neighbouring ', -200, 'context', 50, ' line must not move'],
});
const marker = (font) => ({ id: 'marker', font, size: 9, tm: [1, 0, 0, 1, 72, 40], show: ['marker'] });

const FIXTURES = [
  {
    id: 'A',
    title: 'Untouched Tc/Tw page regenerated',
    fonts: { F1: 'helv' },
    runs: [
      { id: 't1', font: 'F1', size: 14, tc: 1.2, tw: 6, tm: [1, 0, 0, 1, 72, 700], show: ['Untouched text with word spacing'] },
      { id: 't2', font: 'F1', size: 12, tc: 0.4, tz: 85, tm: [1, 0, 0, 1, 72, 670], show: ['Kern', -300, 'ed', 120, ' run with Tc'] },
      { id: 't3', font: 'F1', size: 16, tc: -0.3, tw: 9, tm: [1.2, 0, 0.3, 1, 72, 630], show: ['Skewed ', -90, 'and spaced'] },
      marker('F1'),
    ],
    regenerateOnly: true,
  },
  {
    id: 'B',
    title: 'Pure TJ kerning (Helvetica /Widths)',
    fonts: { F1: 'helv' },
    runs: [
      { id: 'target', font: 'F1', size: 18, tm: [1, 0, 0, 1, 72, 650], show: ['W', 120, 'A', -80, 'V', 200, 'E', -40, 'S', 60, 'KERN'] },
      context('F1', 620),
    ],
    edit: { target: 'target', old: 'WAVESKERN', neu: 'TOKYOLAKE', layout: 'preserve' },
  },
  {
    id: 'C',
    title: 'Scaled Tm + Tz + Tc/Tw',
    fonts: { F1: 'helv' },
    runs: [
      { id: 'target', font: 'F1', size: 12, tz: 90, tc: 0.8, tw: 4, tm: [1.6, 0, 0, 0.9, 72, 560], show: ['Scaled words here'] },
      context('F1', 530),
    ],
    edit: { target: 'target', old: 'Scaled words here', neu: 'Resized items too', layout: 'preserve' },
  },
  {
    id: 'D',
    title: 'Rotated TJ text (30°)',
    fonts: { F1: 'helv' },
    runs: [
      { id: 'target', font: 'F1', size: 16, tc: 0.2, tm: rot(30, 220, 380), show: ['Rotated', -150, 'TJ', 80, 'line'] },
      context('F1', 330),
    ],
    edit: { target: 'target', old: 'RotatedTJline', neu: 'Spinning text', layout: 'preserve' },
  },
  {
    id: 'E',
    title: 'Embedded TrueType (simple, WinAnsi, integer /Widths)',
    fonts: { F1: 'lib' },
    runs: [
      { id: 'target', font: 'F1', size: 16, tc: 0.3, tm: [1, 0, 0, 1, 72, 470], show: ['True', -60, 'Type', 90, ' subset'] },
      context('F1', 440),
    ],
    edit: { target: 'target', old: 'TrueType subset', neu: 'Liberation font', layout: 'preserve' },
  },
  {
    id: 'F',
    title: 'Standard Helvetica (no /Widths, non-embedded)',
    fonts: { F1: 'helvNoWidths' },
    runs: [
      { id: 'target', font: 'F1', size: 14, tm: [1, 0, 0, 1, 72, 430], show: ['Standard Helvetica'] },
      context('F1', 400),
    ],
    edit: { target: 'target', old: 'Standard Helvetica', neu: 'Replaced Helvetica', layout: 'preserve' },
    // PDFium substitutes its own Helvetica metrics; spec viewers use the AFM.
    pdfjsGeometryAdvisory: true,
  },
  {
    id: 'G',
    title: 'Real spaces with Tw + Tc',
    fonts: { F1: 'helv' },
    runs: [
      { id: 'target', font: 'F1', size: 13, tw: 5, tc: 0.2, tm: [1, 0, 0, 1, 72, 390], show: ['Words with real spaces'] },
      context('F1', 360),
    ],
    edit: { target: 'target', old: 'Words with real spaces', neu: 'Texts have more gaps!!', layout: 'preserve' },
  },
  {
    id: 'H',
    title: 'CID horizontal (Type0 Identity-H, embedded TrueType subset)',
    fonts: { F1: 'cid' },
    roundCidWidths: true,
    runs: [
      { id: 'target', font: 'F1', size: 16, tc: 0.2, tm: [1, 0, 0, 1, 72, 340], show: ['Unicode', -120, 'CID', 60, ' run'] },
      context('F1', 310),
      { id: 'pool', font: 'F1', size: 8, tm: [1, 0, 0, 1, 72, 60], show: ['glyph pool: Identity font!'] },
    ],
    edit: { target: 'target', old: 'UnicodeCID run', neu: 'Identity font!', layout: 'preserve' },
  },
  {
    id: 'I',
    title: 'Same-length replacement (single digit)',
    fonts: { F1: 'helv' },
    runs: [
      { id: 'target', font: 'F1', size: 12, tc: 0.1, tm: [1, 0, 0, 1, 72, 280], show: ['Invoice ', -50, '2024'] },
      context('F1', 250),
    ],
    edit: { target: 'target', old: 'Invoice 2024', neu: 'Invoice 2025', layout: 'preserve' },
  },
  {
    id: 'J1',
    title: 'Different length: shorter → longer (natural advance)',
    fonts: { F1: 'helv' },
    runs: [
      { id: 'target', font: 'F1', size: 14, tc: 0.5, tw: 1, tm: [1, 0, 0, 1, 72, 220], show: ['Short', -100, 'er'] },
      context('F1', 190),
    ],
    edit: { target: 'target', old: 'Shorter', neu: 'A considerably longer run', layout: 'natural' },
  },
  {
    id: 'J2',
    title: 'Different length: longer → shorter (justified to original width)',
    fonts: { F1: 'helv' },
    runs: [
      { id: 'target', font: 'F1', size: 14, tc: 0.2, tw: 2, tm: [1, 0, 0, 1, 72, 160], show: ['This sentence gets ', -120, 'shortened'] },
      context('F1', 130),
    ],
    edit: { target: 'target', old: 'This sentence gets shortened', neu: 'Brief text', layout: 'justify' },
  },
  {
    id: 'K1',
    title: 'RISK: fractional /Widths (simple TrueType)',
    risk: true,
    fonts: { F1: 'libFrac' },
    runs: [
      { id: 'target', font: 'F1', size: 16, tm: [1, 0, 0, 1, 72, 520], show: ['Fractional', -40, ' widths'] },
      context('F1', 500),
    ],
    edit: { target: 'target', old: 'Fractional widths', neu: 'Truncated metrics', layout: 'preserve' },
  },
  {
    id: 'K2',
    title: 'RISK: fractional W (pdf-lib CID output, unmodified)',
    risk: true,
    fonts: { F1: 'cid' },
    runs: [
      { id: 'target', font: 'F1', size: 16, tc: 0.2, tm: [1, 0, 0, 1, 72, 520], show: ['Unicode', -120, 'CID', 60, ' run'] },
      context('F1', 500),
      { id: 'pool', font: 'F1', size: 8, tm: [1, 0, 0, 1, 72, 60], show: ['glyph pool: Identity font!'] },
    ],
    edit: { target: 'target', old: 'UnicodeCID run', neu: 'Identity font!', layout: 'preserve' },
  },
];

// ---------------------------------------------------------------------------
function flatText(run) {
  return run.show.filter((s) => typeof s === 'string').join('');
}
function allStrings(fx) {
  const s = fx.runs.map(flatText);
  if (fx.edit) s.push(fx.edit.neu);
  return s;
}

function openPage(engine, bytes) {
  const d = engine.openDocument(bytes);
  const page = engine.m.FPDF_LoadPage(d.doc, 0);
  const tp = engine.m.FPDFText_LoadPage(page);
  return {
    d,
    page,
    tp,
    close() {
      engine.m.FPDFText_ClosePage(tp);
      engine.m.FPDF_ClosePage(page);
      engine.closeDocument(d);
    },
  };
}

// Groups the text page's real glyphs by owning text object.
function objectsByText(engine, pg) {
  const groups = new Map();
  for (const g of engine.glyphs(pg.tp)) {
    if (!groups.has(g.obj)) groups.set(g.obj, []);
    groups.get(g.obj).push(g);
  }
  return groups;
}
function findTarget(engine, pg, text) {
  for (const [obj, gs] of objectsByText(engine, pg)) {
    if (gs.map((g) => String.fromCharCode(g.unicode)).join('') === text) return { obj, glyphs: gs };
  }
  return null;
}
function census(engine, pg) {
  const objs = engine.pageObjects(pg.page);
  return {
    total: objs.length,
    text: objs.filter((o) => o.type === FPDF_PAGEOBJ_TEXT).length,
    image: objs.filter((o) => o.type === FPDF_PAGEOBJ_IMAGE).length,
    types: objs.map((o) => o.type).join(','),
    modes: objs.filter((o) => o.type === FPDF_PAGEOBJ_TEXT).map((o) => engine.textRenderMode(o.obj)).join(','),
  };
}
const unionRect = (...rs) => ({
  left: Math.min(...rs.map((r) => r.left)),
  bottom: Math.min(...rs.map((r) => r.bottom)),
  right: Math.max(...rs.map((r) => r.right)),
  top: Math.max(...rs.map((r) => r.top)),
});
const norm = (s) => s.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ');

function targetPositions(fx, widthOf, run, originalXs, newCodes) {
  const n = newCodes.length;
  const adv = (c) => (widthOf(c) * run.size) / 1000 + (run.tc ?? 0) + (c === 32 && run.fontIsSimple ? run.tw ?? 0 : 0);
  if (fx.edit.layout === 'preserve') return originalXs.slice(0, n);
  const xs = [0];
  for (let i = 0; i + 1 < n; i++) xs.push(xs[i] + adv(newCodes[i]));
  if (fx.edit.layout === 'justify') {
    // Spread the new glyphs so the last glyph starts where the old last did.
    const target = originalXs[originalXs.length - 1];
    const extra = (target - xs[n - 1]) / (n - 1);
    return xs.map((x, i) => x + extra * i);
  }
  return xs;
}

// ---------------------------------------------------------------------------
async function runFixture(engine, fx) {
  const checks = [];
  const add = (name, pass, detail, { advisory = false } = {}) =>
    checks.push({ name, pass: !!pass, advisory, detail });
  const spec = { fonts: fx.fonts, runs: fx.runs, allStrings: allStrings(fx), roundCidWidths: fx.roundCidWidths, edit: fx.edit };
  const { bytes: original, fonts } = await buildPdf(spec);
  const font = fonts.F1;
  const isCid = font.kind === 'cid';
  const widthOf = isCid ? ((m) => (c) => m.get(c) ?? 1000)(await cidWidths(original)) : font.widthOf;

  // ---- baseline on the original ---------------------------------------------
  const before = openPage(engine, original);
  const beforeCensus = census(engine, before);
  const beforeText = engine.pageText(before.tp);
  const beforeGlyphs = engine.glyphs(before.tp);
  const beforeRender = engine.render(before.page, SCALE);
  const pageHeight = engine.m.FPDF_GetPageHeightF(before.page);

  let target = null;
  let M = null;
  let expectedPage = null;
  let newCodes = null;
  let oldCodes = null;
  let refBytes = null;
  let edited;

  if (fx.regenerateOnly) {
    // Dirty one unrelated object (same render mode) so EmbedPDF regenerates
    // the whole page from the object model, as any edit on the page would.
    const mk = findTarget(engine, before, 'marker');
    add('marker found', !!mk);
    engine.m.FPDFTextObj_SetTextRenderMode(mk.obj, engine.textRenderMode(mk.obj));
    add('GenerateContent', engine.m.FPDFPage_GenerateContent(before.page));
    edited = engine.saveNonIncremental(before.d);
    before.close();
  } else {
    const run = { ...fx.runs.find((r) => r.id === fx.edit.target), fontIsSimple: !isCid };
    target = findTarget(engine, before, fx.edit.old);
    add('target object uniquely located', !!target, target ? `${target.glyphs.length} glyphs` : 'not found');
    if (!target) {
      before.close();
      return { checks };
    }
    M = engine.matrix(target.obj);
    const conv = pageToObjectPositions(M, target.glyphs);
    add('page→object geometry gate', conv.ok, conv.ok ? `baseline residual ${conv.worstY.toExponential(2)}, fwd ${conv.worstFwd.toExponential(2)}pt` : conv.reason);
    oldCodes = font.encode(fx.edit.old);
    newCodes = font.encode(fx.edit.neu);
    // P8_DEV_NATURAL=1 (local development on a stock engine only): skip
    // SetPositions and expect SetCharcodes' natural layout, to exercise the
    // rest of the pipeline. Never set in CI.
    const devNatural = process.env.P8_DEV_NATURAL === '1' && !engine.hasSetPositions;
    const xs = targetPositions(devNatural ? { edit: { layout: 'natural' } } : fx, widthOf, run, conv.xs, newCodes);
    expectedPage = xs.map((x) => apply(M, x, 0));

    const frac = hasFractionalWidths(widthOf, [...new Set([...oldCodes, ...newCodes])]);
    add('fractional-width gate', fx.risk ? frac : !frac, frac ? 'fractional widths → True Edit must BLOCK' : 'integer widths');

    if (!engine.hasSetPositions && !devNatural) {
      add('FPDFText_SetPositions exported', false, 'engine lacks SetPositions');
      before.close();
      return { checks };
    }

    // Negative API checks (must fail and leave the object untouched) are run
    // on the dedicated R fixture; here: the real edit.
    add('SetCharcodes', engine.setCharcodes(target.obj, newCodes));
    if (devNatural) add('SetPositions', false, 'DEV MODE: skipped (stock engine)');
    else add('SetPositions', engine.setPositions(target.obj, xs.slice(1)));
    add('GenerateContent', engine.m.FPDFPage_GenerateContent(before.page));
    edited = engine.saveNonIncremental(before.d);
    before.close();

    // Independent reference: same page, target authored with spec TJ math.
    ({ bytes: refBytes } = await buildPdf(spec, {
      replaceTarget: (r) => ({ ...r, show: specShow(newCodes, xs.slice(1), { ...run }, widthOf) }),
    }));
  }

  // ---- save / reopen ---------------------------------------------------------
  const eofs = Buffer.from(edited).toString('latin1').split('%%EOF').length - 1;
  const prefix = Buffer.from(edited.subarray(0, 64)).equals(Buffer.from(original.subarray(0, 64)));
  add('non-incremental save', eofs === 1, `%%EOF x${eofs}, shares original prefix: ${prefix}`);
  let after;
  try {
    after = openPage(engine, edited);
    add('reopen in PDFium', true);
  } catch (e) {
    add('reopen in PDFium', false, String(e));
    return { checks };
  }
  let pj;
  try {
    pj = await pdfjsLane.extract(edited);
    add('reopen in PDF.js', true);
  } catch (e) {
    add('reopen in PDF.js', false, String(e));
  }

  const afterCensus = census(engine, after);
  const afterText = engine.pageText(after.tp);
  const afterRender = engine.render(after.page, SCALE);
  const pjBefore = await pdfjsLane.extract(original);
  const pjRenderBefore = await pdfjsLane.render(original, SCALE);
  const pjRenderAfter = await pdfjsLane.render(edited, SCALE);

  if (fx.regenerateOnly) {
    add('PDFium text identical', afterText === beforeText);
    add('PDF.js text identical', pj && pj.text === pjBefore.text);
    const ag = engine.glyphs(after.tp);
    let drift = ag.length === beforeGlyphs.length ? 0 : Infinity;
    ag.forEach((g, i) => {
      if (beforeGlyphs[i]) drift = Math.max(drift, Math.hypot(g.x - beforeGlyphs[i].x, g.y - beforeGlyphs[i].y));
    });
    add('glyph origin drift (all glyphs)', drift <= 1e-4, `${drift.toExponential(2)} pt over ${ag.length} glyphs`);
    add('object census unchanged', JSON.stringify(afterCensus) === JSON.stringify(beforeCensus), JSON.stringify(afterCensus));
    const d1 = diff(beforeRender, afterRender, {});
    add('PDFium full-page pixels (288 dpi)', d1.changed === 0, `${d1.changed} changed, max Δ ${d1.maxDelta}`);
    const d2 = diff(pjRenderBefore, pjRenderAfter, {});
    add('PDF.js full-page pixels (288 dpi)', d2.changed === 0, `${d2.changed} changed, max Δ ${d2.maxDelta}`);
    after.close();
    return { checks };
  }

  // ---- edited fixture checks -------------------------------------------------
  add('PDFium extraction: new present', afterText.includes(fx.edit.neu), JSON.stringify(afterText.slice(0, 120)));
  add('PDFium extraction: old absent', !afterText.includes(fx.edit.old));
  const fNew = engine.find(after.tp, fx.edit.neu);
  const fOld = engine.find(after.tp, fx.edit.old);
  add('PDFium search/copy: new found', fNew.found && fNew.cnt === fx.edit.neu.length, JSON.stringify(fNew));
  add('PDFium search: old not found', !fOld.found);
  if (pj) {
    const t = norm(pj.text);
    const exact = t.includes(fx.edit.neu);
    const compact = t.replace(/ /g, '').includes(fx.edit.neu.replace(/ /g, ''));
    add('PDF.js extraction: new present', exact, exact ? 'exact' : compact ? 'only without spaces (generated-space mapping differs)' : JSON.stringify(t.slice(0, 120)));
    add('PDF.js extraction: old absent', !t.replace(/ /g, '').includes(fx.edit.old.replace(/ /g, '')));
  }
  const scan = await showSequences(edited, isCid ? 2 : 1);
  add('old glyph codes absent from all content streams', !containsSequence(scan.seqs, oldCodes), `${scan.seqs.length} show ops scanned`);
  add('new glyph codes present in content', containsSequence(scan.seqs, newCodes.filter((c) => c !== undefined)));

  const newTarget = findTarget(engine, after, fx.edit.neu);
  add('one logical text object holds the new text', !!newTarget, newTarget ? `${newTarget.glyphs.length} glyphs in one object` : 'split or missing');
  add(
    'object census (no overlay/raster/extra objects)',
    afterCensus.text === beforeCensus.text && afterCensus.image === beforeCensus.image && afterCensus.total === beforeCensus.total && afterCensus.modes === beforeCensus.modes,
    `before ${JSON.stringify(beforeCensus)} after ${JSON.stringify(afterCensus)}`,
  );

  let drift = Infinity;
  if (newTarget && newTarget.glyphs.length === expectedPage.length) {
    drift = 0;
    newTarget.glyphs.forEach((g, i) => {
      drift = Math.max(drift, Math.hypot(g.x - expectedPage[i].x, g.y - expectedPage[i].y));
    });
  }
  add('glyph origin drift (PDFium, reopened)', drift <= TOL.glyphDriftPt, `${Number.isFinite(drift) ? drift.toExponential(3) : drift} pt (tol ${TOL.glyphDriftPt})`);

  if (pj) {
    const first = expectedPage[0];
    const item = pj.items.find((it) => it.str && fx.edit.neu.startsWith(it.str.trimEnd().slice(0, 3)));
    const d = item ? Math.hypot(item.x - first.x, item.y - first.y) : Infinity;
    add('PDF.js run origin', d <= TOL.pdfjsOriginPt, `${Number.isFinite(d) ? d.toFixed(4) : 'no item'} pt`, { advisory: !!fx.pdfjsGeometryAdvisory });
  }

  // Pixels: everything outside the edited object must be identical.
  const newBounds = newTarget ? engine.bounds(newTarget.obj) : null;
  const origPg = openPage(engine, original);
  const origT = findTarget(engine, origPg, fx.edit.old);
  const oldBounds = engine.bounds(origT.obj);
  origPg.close();
  const refPg = openPage(engine, refBytes);
  const refT = findTarget(engine, refPg, fx.edit.neu);
  const refBounds = refT ? engine.bounds(refT.obj) : oldBounds;
  const refRender = engine.render(refPg.page, SCALE);
  let refDrift = Infinity;
  if (refT && refT.glyphs.length === expectedPage.length) {
    refDrift = 0;
    refT.glyphs.forEach((g, i) => (refDrift = Math.max(refDrift, Math.hypot(g.x - expectedPage[i].x, g.y - expectedPage[i].y))));
  }
  refPg.close();
  const editRect = unionRect(oldBounds, newBounds ?? oldBounds, refBounds);
  const u1 = diff(beforeRender, afterRender, { scale: SCALE, pageHeight, exclude: [editRect] });
  add('PDFium untouched-area pixels (288 dpi)', u1.changed === 0, `${u1.changed} changed of ${u1.total}, max Δ ${u1.maxDelta}`);
  const u2 = diff(pjRenderBefore, pjRenderAfter, { scale: SCALE, pageHeight, exclude: [editRect] });
  add('PDF.js untouched-area pixels (288 dpi)', u2.changed === 0, `${u2.changed} changed of ${u2.total}, max Δ ${u2.maxDelta}`);

  // Edited object vs an independently authored reference at the same
  // positions.
  add('reference PDF glyph geometry (sanity)', refDrift <= TOL.glyphDriftPt, `${Number.isFinite(refDrift) ? refDrift.toExponential(3) : refDrift} pt`, { advisory: true });
  const e1 = diff(refRender, afterRender, { scale: SCALE, pageHeight, include: [editRect] });
  add('PDFium edited region vs reference', e1.changed / Math.max(1, e1.total) <= TOL.editedRegionChangedFrac, `${e1.changed} changed of ${e1.total}, max Δ ${e1.maxDelta}`);
  const pjRef = await pdfjsLane.render(refBytes, SCALE);
  const e2 = diff(pjRef, pjRenderAfter, { scale: SCALE, pageHeight, include: [editRect] });
  add('PDF.js edited region vs reference', e2.changed / Math.max(1, e2.total) <= TOL.editedRegionChangedFrac, `${e2.changed} changed of ${e2.total}, max Δ ${e2.maxDelta}`, { advisory: !!fx.pdfjsGeometryAdvisory || !!fx.risk });

  after.close();
  return { checks };
}

// Negative API checks: each call must return false and leave the object
// exactly as it was.
async function runNegative(engine) {
  const checks = [];
  const fx = FIXTURES.find((f) => f.id === 'B');
  const spec = { fonts: fx.fonts, runs: [...fx.runs, { id: 'one', font: 'F1', size: 12, tm: [1, 0, 0, 1, 300, 100], show: ['X'] }], allStrings: [] };
  const { bytes } = await buildPdf(spec);
  const base = openPage(engine, bytes);
  const baseRender = engine.render(base.page, SCALE);
  const baseGlyphs = engine.glyphs(base.tp);
  base.close();
  if (!engine.hasSetPositions) {
    checks.push({ name: 'FPDFText_SetPositions exported', pass: false, detail: 'missing' });
    return { checks };
  }
  const pg = openPage(engine, bytes);
  const t = findTarget(engine, pg, fx.edit.old);
  const one = findTarget(engine, pg, 'X');
  const n = t.glyphs.length;
  const good = Array.from({ length: n - 1 }, (_, i) => 10 * (i + 1));
  const cases = [
    ['NaN position', () => engine.setPositions(t.obj, good.map((v, i) => (i === 3 ? NaN : v)))],
    ['+Inf position', () => engine.setPositions(t.obj, good.map((v, i) => (i === 0 ? Infinity : v)))],
    ['-Inf position', () => engine.setPositions(t.obj, good.map((v, i) => (i === n - 2 ? -Infinity : v)))],
    ['overflowing position (3e38)', () => engine.setPositions(t.obj, good.map((v, i) => (i === 2 ? 3e38 : v)))],
    ['count N (too many)', () => engine.setPositions(t.obj, [...good, 999])],
    ['count N-2 (too few)', () => engine.setPositions(t.obj, good.slice(1))],
    ['count 0', () => engine.setPositions(t.obj, [])],
    ['null positions, count>0', () => engine.setPositions(t.obj, null, n - 1)],
    ['single-glyph object (N=1)', () => engine.setPositions(one.obj, [])],
    ['null object', () => !!engine.m.FPDFText_SetPositions(0, 0, 0)],
  ];
  for (const [name, fn] of cases) {
    let ret;
    try {
      ret = fn();
    } catch (e) {
      ret = `threw ${e}`;
    }
    checks.push({ name: `rejects ${name}`, pass: ret === false, detail: `returned ${ret}` });
  }
  engine.m.FPDFPage_GenerateContent(pg.page);
  const saved = engine.saveNonIncremental(pg.d);
  pg.close();
  const re = openPage(engine, saved);
  const d = diff(baseRender, engine.render(re.page, SCALE), {});
  const g = engine.glyphs(re.tp);
  let drift = g.length === baseGlyphs.length ? 0 : Infinity;
  g.forEach((x, i) => baseGlyphs[i] && (drift = Math.max(drift, Math.hypot(x.x - baseGlyphs[i].x, x.y - baseGlyphs[i].y))));
  re.close();
  checks.push({ name: 'rejected calls left page unchanged (pixels)', pass: d.changed === 0, detail: `${d.changed} changed` });
  checks.push({ name: 'rejected calls left glyph origins unchanged', pass: drift <= 1e-4, detail: `${drift} pt` });
  return { checks };
}

// ---------------------------------------------------------------------------
const engine = await loadEngine(ENGINE);
console.log(`engine: ${ENGINE}`);
console.log(`  pdfium.wasm sha256 ${engine.info.wasmSha256} (${engine.info.wasmBytes} B)`);
console.log(`  index.js    sha256 ${engine.info.jsSha256}`);
console.log(`  FPDFText_SetPositions: ${engine.hasSetPositions ? 'present' : 'MISSING'}`);

const results = [];
const engineChecks = [
  { name: 'FPDFText_SetPositions exported', pass: engine.hasSetPositions, detail: '' },
];
if (args['expect-wasm']) {
  engineChecks.push({ name: 'pdfium.wasm matches expected build', pass: engine.info.wasmSha256 === args['expect-wasm'], detail: `expected ${args['expect-wasm']}` });
}
results.push({ id: 'ENGINE', title: 'Engine identity', checks: engineChecks });

for (const fx of FIXTURES) {
  let r;
  try {
    r = await runFixture(engine, fx);
  } catch (e) {
    r = { checks: [{ name: 'fixture ran', pass: false, detail: e.stack?.split('\n').slice(0, 3).join(' | ') }] };
  }
  results.push({ id: fx.id, title: fx.title, risk: !!fx.risk, ...r });
}
try {
  results.push({ id: 'R', title: 'API rejection (no mutation on invalid input)', ...(await runNegative(engine)) });
} catch (e) {
  results.push({ id: 'R', title: 'API rejection', checks: [{ name: 'fixture ran', pass: false, detail: String(e) }] });
}

// ---------------------------------------------------------------------------
// Gate: every required (non-advisory) check of every fixture must pass. For
// RISK fixtures only the gate checks are required: the engine cannot place
// glyphs correctly for spec viewers there, so NoblePDF must detect and block.
const RISK_REQUIRED = new Set([
  'target object uniquely located',
  'page→object geometry gate',
  'fractional-width gate',
  'FPDFText_SetPositions exported',
  'SetCharcodes',
  'SetPositions',
  'GenerateContent',
  'non-incremental save',
  'reopen in PDFium',
  'reopen in PDF.js',
]);
let gatePass = true;
const lines = [];
const md = ['# NoblePDF True Edit — Phase 8 regression report', '', `Engine: \`pdfium.wasm\` sha256 \`${engine.info.wasmSha256}\` (${engine.info.wasmBytes} B), \`index.js\` sha256 \`${engine.info.jsSha256}\``, '', '| Fixture | Result | Failed required checks |', '|---|---|---|'];
for (const r of results) {
  const required = r.checks.filter((c) => !c.advisory && (!r.risk || RISK_REQUIRED.has(c.name)));
  const failed = required.filter((c) => !c.pass);
  const pass = failed.length === 0 && r.checks.length > 0;
  r.result = pass ? 'PASS' : 'FAIL';
  if (!pass) gatePass = false;
  lines.push(`\n[${r.result}] ${r.id} — ${r.title}${r.risk ? ' (risk fixture: must be blocked)' : ''}`);
  for (const c of r.checks) {
    const tag = c.pass ? 'pass' : c.advisory || (r.risk && !required.includes(c)) ? 'info' : 'FAIL';
    lines.push(`    ${tag.padEnd(4)}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  md.push(`| ${r.id} — ${r.title} | **${r.result}** | ${failed.map((c) => `${c.name} (${c.detail ?? ''})`).join('; ') || '—'} |`);
}
md.push('', `## Production-readiness gate: **${gatePass ? 'PASS' : 'FAIL'}**`, '', '<details><summary>All checks</summary>', '', '```', ...lines, '```', '</details>');
console.log(lines.join('\n'));
console.log(`\nPRODUCTION-READINESS GATE: ${gatePass ? 'PASS' : 'FAIL'}`);
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/report.json`, JSON.stringify({ engine: engine.info, gate: gatePass ? 'PASS' : 'FAIL', tolerances: TOL, results }, null, 2));
writeFileSync(`${OUT}/report.md`, md.join('\n') + '\n');
process.exit(gatePass ? 0 : 1);
