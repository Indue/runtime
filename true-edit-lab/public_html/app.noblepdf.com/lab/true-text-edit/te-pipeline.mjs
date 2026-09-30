// NoblePDF True Edit (Phase 9 lab): analysis, gating, planning, mutation, verification.
// Shared by the fixture suite, the interactive editor and Node CI. Nothing here commits
// anything: callers replace their working bytes only when verifyEdit(...).ok is true.
// ASCII only.
import * as V from './phase8-verify.mjs?v=1';
import { PdfDoc, interpretPage, showXs, apply as applyM, VALIDATED_FONT_CLASSES } from './te-pdf.mjs?v=1';
import { validateReplacement, toCodePoints, fromCodePoints, glyphsForCodePoints, layoutAnchored, naturalXs, monotonic, gapPolicy, advance } from './te-edit.mjs?v=1';
import { OBJ, SEARCH } from './te-engine.mjs?v=1';

export const TE_PIPELINE_VERSION = 'te-pipeline-1';
export const POS_TOL_PT = 0.01;
export const DISCRIMINATION_PT = 0.05;
export const MARK_TAGS_ALLOWED = new Set(['P', 'Span', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH', 'LI', 'Lbl', 'LBody', 'Caption', 'Link', 'Quote', 'Note', 'Code', 'Artifact']);
const reason = (stage, code, detail) => ({ stage, code, detail });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const occurrences = (hay, needle) => (needle ? hay.split(needle).length - 1 : 0);

// ------------------------------------------------------------------ PDF.js text helpers
export function pdfjsPage(items) {
  let str = '';
  const spans = [];
  for (const it of items) {
    const start = str.length;
    str += it.str || '';
    spans.push({ start, end: str.length, it });
    if (it.hasEOL) str += '\n';
  }
  return { str: str.replace(/\n+$/, ''), spans };
}
function locateInPdfjs(pj, text, origin, size) {
  let best = null;
  if (!text) return null;
  for (let at = pj.str.indexOf(text); at !== -1; at = pj.str.indexOf(text, at + 1)) {
    const sp = pj.spans.find((s) => at >= s.start && at < s.end);
    if (!sp || !sp.it.transform) continue;
    const [a, b, , , e, f] = sp.it.transform;
    const len = Math.hypot(a, b) || 1;
    const ux = a / len;
    const uy = b / len;
    const dx = origin.x - e;
    const dy = origin.y - f;
    const along = dx * ux + dy * uy;
    const perp = Math.abs(-dx * uy + dy * ux);
    const w = Number(sp.it.width) || 0;
    const frac = sp.end > sp.start ? (at - sp.start) / (sp.end - sp.start) : 0;
    const alongErr = Math.abs(along - frac * w);
    const inside = along >= -size && along <= w + size;
    if (!inside || perp > 0.5 * size) continue;
    const score = perp * 10 + alongErr;
    if (!best || score < best.score) best = { at, score, perp, alongErr };
  }
  return best;
}

// ------------------------------------------------------------------ analysis
// Collects engine facts and independent facts about one page. Plain data only.
export async function analyze(E, bytes, pageIndex = 0, { pdfjs = null } = {}) {
  const a = { pageIndex, doc: {}, page: {}, objects: [], pdfium: {}, independent: {}, pdfjs: null, mapping: { ok: false } };
  E.withDoc(bytes, pageIndex, (o) => {
    const p = E.p;
    a.doc.pageCount = p.FPDF_GetPageCount(o.doc);
    a.doc.signatures = p.FPDF_GetSignatureCount(o.doc);
    a.doc.permissions = p.FPDF_GetDocPermissions(o.doc) >>> 0;
    a.doc.securityRevision = p.FPDF_GetSecurityHandlerRevision(o.doc);
    a.doc.formType = p.FPDF_GetFormType(o.doc);
    a.page.rotation = p.FPDFPage_GetRotation(o.page);
    a.page.annots = p.FPDFPage_GetAnnotCount(o.page);
    a.page.census = E.census(o.page);
    const g = E.groups(o.textPage);
    const objs = E.objects(o.page);
    const idx = new Map(objs.map((h, i) => [h, i]));
    a.pdfium.chars = g.chars.map((c) => ({ cp: c.cp, unit: c.unit, units: c.units, generated: c.generated, objIndex: c.obj && idx.has(c.obj) ? idx.get(c.obj) : (c.obj ? -2 : -1) }));
    a.pdfium.pageText = E.pageText(o.textPage);
    objs.forEach((h, i) => {
      const type = p.FPDFPageObj_GetType(h);
      const rec = { index: i, type, bounds: E.bounds(h) };
      if (type === OBJ.TEXT) {
        const gr = g.map.get(h);
        rec.realText = gr ? gr.realText : '';
        rec.text = gr ? gr.text : '';
        rec.real = gr ? gr.real : [];
        rec.all = gr ? gr.indices : [];
        rec.matrix = E.matrix(h);
        rec.size = E.fontSize(h);
        rec.renderMode = p.FPDFTextObj_GetTextRenderMode(h);
        rec.origins = rec.real.map((gi) => E.charOrigin(o.textPage, g.chars[gi].unit));
        const [ma, mb, mc, md, me, mf] = rec.matrix;
        const det = ma * md - mb * mc;
        rec.objSpace = rec.origins.map((q) => { const x = q.x - me; const y = q.y - mf; return { x: (md * x - mc * y) / det, y: (-mb * x + ma * y) / det }; });
        rec.xs = rec.objSpace.map((q) => q.x);
        rec.baselineResidual = rec.objSpace.reduce((m, q) => Math.max(m, Math.abs(q.y)), 0);
        rec.marks = E.marks(h);
        rec.clipPaths = E.clipPaths(h);
        const font = p.FPDFTextObj_GetFont(h);
        rec.fontEmbedded = font ? p.FPDFFont_GetIsEmbedded(font) : -1;
      }
      a.objects.push(rec);
    });
  });
  const texts = a.objects.filter((o) => o.type === OBJ.TEXT);
  a.independent = { pageCount: null, shows: [], counters: { images: 0, inlineImages: 0, forms: 0, paths: 0, shadings: 0, streamRefs: new Set() }, unsupported: [], error: null };
  if (a.doc.securityRevision >= 0) {
    a.independent.error = 'encrypted document: the independent reader does not decrypt';
  } else {
    try {
      const pd = await PdfDoc.load(bytes);
      const pages = pd.pages();
      a.independent.pageCount = pages.length;
      const pg = pages[pageIndex];
      a.page.rotateIndependent = pg ? pg.rotate : null;
      const own = new Set((pg ? pg.contents : []).map((r) => r.num));
      a.page.sharedContent = pages.some((q, k) => k !== pageIndex && q.contents.some((r) => own.has(r.num)));
      const it = await interpretPage(pd, pageIndex);
      Object.assign(a.independent, { shows: it.shows, counters: it.counters, unsupported: it.unsupported, pdfDoc: pd });
    } catch (e) {
      a.independent.error = `independent reader failed: ${e.message}`;
    }
  }
  // Direct page text objects map, in content order, to shows outside forms.
  const shows = a.independent.shows.filter((x) => !x.inForm && x.glyphs.length > 0);
  a.mapping.ok = !a.independent.error && texts.length === shows.length;
  a.mapping.detail = a.independent.error || `${texts.length} direct text objects, ${shows.length} direct text-showing operations`;
  if (a.mapping.ok) texts.forEach((o, k) => { o.show = shows[k]; });
  if (pdfjs) {
    const tc = await pdfjs.textContent(bytes, pageIndex);
    a.pdfjs = { items: tc.items, page: pdfjsPage(tc.items), version: pdfjs.version || '' };
  }
  return a;
}

// ------------------------------------------------------------------ gates
export function documentGates(a) {
  const r = [];
  if (a.doc.signatures > 0) r.push(reason('document', 'signed-document', `${a.doc.signatures} signature(s); editing would invalidate them`));
  if (a.doc.securityRevision >= 0) r.push(reason('document', 'encrypted-document', `security handler revision ${a.doc.securityRevision}`));
  if ((a.doc.permissions & 8) === 0) r.push(reason('document', 'permissions-restrict-modify', `permission flags 0x${a.doc.permissions.toString(16)}`));
  if (a.doc.formType === 2 || a.doc.formType === 3) r.push(reason('document', 'xfa-form', `form type ${a.doc.formType}`));
  if (a.independent.error) r.push(reason('document', 'independent-reader-unavailable', a.independent.error));
  else if (a.independent.pageCount !== a.doc.pageCount) r.push(reason('document', 'page-tree-disagreement', `PDFium ${a.doc.pageCount} pages, independent reader ${a.independent.pageCount}`));
  if (a.page.rotation !== 0 || a.page.rotateIndependent) r.push(reason('page', 'page-rotation-not-validated', `/Rotate ${a.page.rotateIndependent}`));
  if (a.page.sharedContent) r.push(reason('page', 'shared-content-stream', 'this page shares a content stream with another page'));
  for (const u of a.independent.unsupported) r.push(reason('page', u.code, u.detail));
  if (!a.mapping.ok) r.push(reason('page', 'object-mapping-failed', a.mapping.detail));
  const editable = a.objects.filter((o) => o.type === OBJ.TEXT && o.real.length > 0 && o.renderMode !== 3);
  if (!editable.length) r.push(reason('page', 'no-editable-text', a.independent.counters.images + a.independent.counters.inlineImages > 0 ? 'image-only or invisible-text page (scanned?)' : 'no text objects'));
  return r;
}

export function targetGates(a, objIndex) {
  const r = [];
  const o = a.objects[objIndex];
  if (!o) return [reason('target', 'target-missing', `object ${objIndex}`)];
  if (o.type !== OBJ.TEXT) return [reason('target', 'target-not-text', `object type ${o.type}`)];
  if (!o.real.length) return [reason('target', 'target-empty', 'text object has no extractable characters')];
  const s = o.show;
  if (!s) r.push(reason('target', 'target-unmapped', 'no matching text-showing operation in the content stream'));
  if (o.all.length !== o.real.length) r.push(reason('extraction', 'original-extraction-inconsistent-pdfium', 'PDFium inserts generated characters inside this text object'));
  for (let k = 1; k < o.real.length; k++) if (o.real[k] !== o.real[0] + k) { r.push(reason('extraction', 'target-chars-not-contiguous', 'characters of this object are interleaved with other text')); break; }
  if (o.renderMode === 3) r.push(reason('target', 'invisible-text', 'text render mode 3 (OCR or hidden text layer)'));
  else if (o.renderMode !== 0) r.push(reason('target', 'render-mode-not-validated', `text render mode ${o.renderMode}`));
  if (o.clipPaths > 0) r.push(reason('target', 'target-clipped', `${o.clipPaths} clip path(s) apply to this text`));
  for (const mk of o.marks) {
    const keysOk = mk.keys.every((k) => k === 'MCID');
    if (!MARK_TAGS_ALLOWED.has(mk.name) || !keysOk) r.push(reason('target', 'marked-content-ambiguous', `marked content /${mk.name} with ${mk.keys.join(',') || 'no'} parameters`));
  }
  if (Math.abs(o.xs[0]) > 0.001) r.push(reason('target', 'first-glyph-not-at-origin', `x0 ${o.xs[0]}`));
  if (o.baselineResidual > 0.01) r.push(reason('target', 'baseline-not-horizontal', `residual ${o.baselineResidual.toFixed(4)}`));
  if (s) {
    for (const mk of s.marks) {
      if (mk.actualText || mk.alt || mk.expansion) r.push(reason('target', 'marked-content-actualtext', `/${mk.tag} carries ActualText/Alt/E`));
      if (mk.oc) r.push(reason('target', 'optional-content', 'text is in an optional content group'));
    }
    if (s.ts !== 0) r.push(reason('target', 'text-rise-not-validated', `Ts ${s.ts}`));
    if (s.clip) r.push(reason('target', 'target-clipped', 'clipping path active in the content stream'));
    const f = s.font;
    if (!f) r.push(reason('font', 'font-missing', `/${s.fontName}`));
    else if (f.unsupported) r.push(reason('font', f.unsupported.code, f.unsupported.detail));
    else if (!VALIDATED_FONT_CLASSES.includes(f.fontClass)) r.push(reason('font', 'font-class-not-validated', f.fontClass));
    if (f && !f.unsupported) {
      if (s.glyphs.length !== o.real.length) r.push(reason('target', 'engine-interpreter-count-mismatch', `${s.glyphs.length} glyphs vs ${o.real.length} PDFium chars`));
      else {
        const bad = s.glyphs.findIndex((g, k) => !g.cps || g.cps.length !== 1 || g.cps[0] !== a.pdfium.chars[o.real[k]].cp);
        if (bad >= 0) r.push(reason('font', 'unicode-mapping-disagreement', `glyph ${bad}: font maps code ${s.glyphs[bad].code} to ${JSON.stringify(s.glyphs[bad].cps)}, PDFium reports U+${a.pdfium.chars[o.real[bad]].cp.toString(16).toUpperCase()}`));
        const ix = showXs(s);
        const worst = ix.reduce((m, x, k) => Math.max(m, Math.abs(x - o.xs[k])), 0);
        if (worst > POS_TOL_PT) r.push(reason('font', 'engine-interpreter-position-disagreement', `max ${worst.toFixed(4)} (independent widths do not reproduce PDFium positions)`));
        if (Math.abs(s.size - o.size) > 1e-3) r.push(reason('target', 'font-size-disagreement', `${s.size} vs ${o.size}`));
      }
    }
  }
  return r;
}

// ------------------------------------------------------------------ planning
export function findInObject(a, objIndex, needle, occurrence = 0) {
  const o = a.objects[objIndex];
  const cps = toCodePoints(o.realText);
  const n = toCodePoints(needle);
  let seen = 0;
  for (let i = 0; i + n.length <= cps.length; i++) {
    let ok = true;
    for (let k = 0; k < n.length; k++) if (cps[i + k] !== n[k]) { ok = false; break; }
    if (ok) { if (seen === occurrence) return { start: i, end: i + n.length }; seen++; }
  }
  return null;
}

export function findTextObject(a, text) {
  const i = a.objects.findIndex((o) => o.type === OBJ.TEXT && o.realText === text);
  if (i >= 0) return i;
  return a.objects.findIndex((o) => o.type === OBJ.TEXT && o.show && o.show.glyphs.every((g) => g.cps) && o.show.glyphs.map((g) => String.fromCodePoint(...g.cps)).join('') === text);
}

function runBox(matrix, x0, x1, size) {
  const pts = [[x0, -0.25 * size], [x1, -0.25 * size], [x0, 0.9 * size], [x1, 0.9 * size]].map(([x, y]) => applyM(matrix, x, y));
  return { left: Math.min(...pts.map((q) => q.x)), right: Math.max(...pts.map((q) => q.x)), bottom: Math.min(...pts.map((q) => q.y)), top: Math.max(...pts.map((q) => q.y)) };
}
const grow = (b, d) => ({ left: b.left - d, right: b.right + d, bottom: b.bottom - d, top: b.top + d });
const intersects = (p, q) => p.left < q.right && q.left < p.right && p.bottom < q.top && q.bottom < p.top;

export async function planEdit(E, bytes, { pageIndex = 0, objIndex, start, end, replacement, fit = false, analysis = null, pdfjs = null }) {
  const a = analysis || await analyze(E, bytes, pageIndex, { pdfjs });
  const plan = { ok: false, reasons: [], pageIndex, objIndex, replacement, fit, notes: [] };
  plan.reasons.push(...documentGates(a), ...targetGates(a, objIndex));
  const o = a.objects[objIndex];
  if (!o || o.type !== OBJ.TEXT || !o.show || !o.show.font || o.show.font.unsupported || plan.reasons.some((x) => x.stage === 'target' && /missing|not-text|empty|unmapped|count-mismatch/.test(x.code))) return finishPlan(plan, a);
  const s = o.show;
  const font = s.font;
  const oldCps = toCodePoints(o.realText);
  plan.oldText = o.realText;
  if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= oldCps.length && start < end)) {
    plan.reasons.push(reason('input', 'invalid-selection', `selection [${start}, ${end}) of ${oldCps.length} characters`));
    return finishPlan(plan, a);
  }
  const vr = validateReplacement(replacement);
  if (!vr.ok) { plan.reasons.push(reason('input', vr.reason.code, vr.reason.detail)); return finishPlan(plan, a); }
  const oldGlyphs = s.glyphs.map((g) => ({ cp: g.cps[0], code: g.code, width1000: g.width1000 }));
  const mapped = glyphsForCodePoints(vr.cps, font);
  for (const e of mapped.errors) plan.reasons.push(reason('font', e.code, e.detail));
  if (mapped.errors.length) return finishPlan(plan, a);
  const newGlyphs = [...oldGlyphs.slice(0, start), ...mapped.glyphs, ...oldGlyphs.slice(end)];
  plan.selection = { start, end, oldSelected: fromCodePoints(oldCps.slice(start, end)) };
  plan.newText = fromCodePoints(newGlyphs.map((g) => g.cp));
  plan.oldCodes = oldGlyphs.map((g) => g.code);
  plan.newCodes = newGlyphs.map((g) => g.code);
  plan.oldBytes = font.encodeCodes(plan.oldCodes);
  plan.newBytes = font.encodeCodes(plan.newCodes);
  plan.oldSelBytes = font.encodeCodes(plan.oldCodes.slice(start, end));
  plan.font = { fontClass: font.fontClass, baseFont: font.baseFont, widthSource: font.widthSource, key: font.key, spaceWidth: font.spaceWidth, bytesPerCode: font.bytesPerCode };
  // Independent glyph availability in the embedded font program (te-ttf.mjs).
  if (font.fontFileRef) {
    let prog = null;
    try { prog = await font.program(); } catch (err) { plan.reasons.push(reason('font', 'font-program-unreadable', err.message)); }
    if (prog) for (const g of mapped.glyphs) {
      const gid = font.gidForCode(g.code, g.cp);
      if (!gid || !prog.hasGlyph(gid)) plan.reasons.push(reason('font', 'glyph-not-in-font-subset', `U+${g.cp.toString(16).toUpperCase()} (code ${g.code}) has no glyph in the embedded font program`));
      else if (g.cp !== 0x20 && !prog.hasOutline(gid)) plan.reasons.push(reason('font', 'glyph-outline-missing', `U+${g.cp.toString(16).toUpperCase()} maps to glyph ${gid}, which has no outline in the embedded subset`));
    }
  }
  // Engine cross-checks for the glyphs the replacement introduces.
  E.withDoc(bytes, pageIndex, (d) => {
    const h = E.objects(d.page)[objIndex];
    const fh = E.p.FPDFTextObj_GetFont(h);
    for (const g of mapped.glyphs) {
      if (g.cp > 0xffff && g.declared) { plan.notes.push(`U+${g.cp.toString(16).toUpperCase()}: PDFium's FPDFFont_GetGlyphWidth/GetGlyphPath take a Unicode value and cannot reverse-map supplementary-plane characters; width cross-check skipped, positions are verified after mutation (V05, V08) and glyph presence by the independent font reader`); continue; }
      if (!g.declared) { plan.reasons.push(reason('font', font.embedded ? 'glyph-not-in-font-subset' : 'glyph-width-undeclared', `U+${g.cp.toString(16).toUpperCase()} code ${g.code} has no declared non-zero width (glyph absent from the embedded subset or unused by the document)`)); continue; }
      const w = E.glyphWidthUnicode(fh, g.cp);
      if (w === null || Math.abs(w - g.width1000) > 0.5) plan.reasons.push(reason('font', 'metrics-disagree', `U+${g.cp.toString(16).toUpperCase()} code ${g.code}: independent width ${g.width1000} (${font.widthSource}), PDFium ${w === null ? 'none' : w.toFixed(2)}`));
      if (g.cp !== 0x20) {
        const segs = E.glyphPathSegments(fh, g.cp);
        if (segs <= 0) plan.reasons.push(reason('font', 'glyph-outline-missing', `U+${g.cp.toString(16).toUpperCase()} has no outline in this font`));
      }
    }
  });
  const run = { size: o.size, tc: s.tc, tw: s.tw, singleByte: font.bytesPerCode === 1 };
  plan.run = run;
  const layout = layoutAnchored({ oldGlyphs, oldXs: o.xs, newGlyphs, run, fit });
  plan.layout = { prefix: layout.prefix, suffix: layout.suffix, changedFrom: layout.changedFrom, changedTo: layout.changedTo, fit: layout.fit };
  plan.xs = layout.xs;
  if (!monotonic(layout.xs)) plan.reasons.push(reason('layout', 'non-monotonic-layout', 'positions would move backwards'));
  const gp = gapPolicy({ xs: layout.xs, glyphs: newGlyphs, run, font, layout, oldGlyphs, oldXs: o.xs });
  plan.gap = { bounds: gp.bounds, violations: gp.violations };
  for (const v of gp.violations) plan.reasons.push(reason('layout', v.code, v.detail));
  const nat = naturalXs(newGlyphs, run, layout.xs[0]);
  plan.naturalDelta = layout.xs.reduce((m, x, k) => Math.max(m, Math.abs(x - nat[k])), 0);
  plan.discriminating = plan.naturalDelta >= DISCRIMINATION_PT;
  plan.matrix = o.matrix;
  plan.expectedOrigins = layout.xs.map((x) => applyM(o.matrix, x, 0));
  // Collision: the new run must not grow into a neighbour it did not already touch.
  const lastAdv = (arr, xs) => xs[xs.length - 1] + advance(arr[arr.length - 1], run);
  const oldBox = runBox(o.matrix, o.xs[0], lastAdv(oldGlyphs, o.xs), o.size);
  const newBox = runBox(o.matrix, layout.xs[0], lastAdv(newGlyphs, layout.xs), o.size);
  const clearance = 0.25 * o.size;
  plan.collisions = [];
  for (const other of a.objects) {
    if (other.index === objIndex || !other.bounds) continue;
    if (intersects(grow(newBox, clearance), other.bounds) && !intersects(grow(oldBox, clearance), other.bounds)) plan.collisions.push({ index: other.index, type: other.type, text: other.realText || '' });
  }
  for (const c of plan.collisions) plan.reasons.push(reason('layout', 'collision-with-neighbour', `would run into object ${c.index}${c.text ? ` ("${c.text}")` : ''}`));
  plan.newBox = newBox;
  plan.oldBox = oldBox;
  // Expected extraction. PDFium: the object's characters are contiguous and real (gated).
  const cps = a.pdfium.chars.filter((c) => c.cp).map((c) => c.cp);
  const first = o.real[0];
  const last = o.real[o.real.length - 1];
  const before = a.pdfium.chars.slice(0, first).filter((c) => c.cp).map((c) => c.cp);
  const after = a.pdfium.chars.slice(last + 1).filter((c) => c.cp).map((c) => c.cp);
  plan.expected = { pdfiumText: fromCodePoints([...before, ...newGlyphs.map((g) => g.cp), ...after]), objText: plan.newText, pdfiumTextBefore: fromCodePoints(cps) };
  if (a.pdfjs) {
    const loc = locateInPdfjs(a.pdfjs.page, o.realText, o.origins[0], o.size);
    if (!loc) plan.reasons.push(reason('extraction', 'original-extraction-inconsistent-pdfjs', `PDF.js ${a.pdfjs.version} does not extract "${o.realText}" contiguously at this position`));
    else plan.expected.pdfjsText = a.pdfjs.page.str.slice(0, loc.at) + plan.newText + a.pdfjs.page.str.slice(loc.at + o.realText.length);
    plan.expected.pdfjsTextBefore = a.pdfjs.page.str;
  }
  return finishPlan(plan, a);
}

function finishPlan(plan, a) {
  plan.ok = plan.reasons.length === 0;
  plan.analysis = a;
  return plan;
}

// ------------------------------------------------------------------ mutation
// Applies a verified plan to a copy of the input. Throws on any engine refusal.
export function applyEdit(E, bytes, plan) {
  if (!plan.ok) throw new Error('refusing to apply a plan that did not pass its gates');
  return E.withDoc(bytes, plan.pageIndex, (o) => {
    const h = E.objects(o.page)[plan.objIndex];
    if (!h || E.p.FPDFPageObj_GetType(h) !== OBJ.TEXT) throw new Error('target object is no longer a text object');
    const g = E.groups(o.textPage).map.get(h);
    if (!g || g.realText !== plan.oldText) throw new Error('target object changed since planning');
    E.closeTextPage(o);
    if (!E.setCharcodes(h, plan.newCodes)) throw new Error('FPDFText_SetCharcodes failed');
    if (plan.newCodes.length > 1) {
      const pos = plan.xs.slice(1).map((x) => x - plan.xs[0]);
      if (!E.setPositions(h, pos)) throw new Error('FPDFText_SetPositions failed');
    }
    if (!E.p.FPDFPage_GenerateContent(o.page)) throw new Error('FPDFPage_GenerateContent failed');
    return E.saveNoIncremental(o.doc);
  });
}

// ------------------------------------------------------------------ verification
function isContentLike(dict) {
  if (/\/Subtype\s*\/Image\b/.test(dict)) return false;
  if (/\/Length[123]\b/.test(dict) || /\/Subtype\s*\/(Type1C|CIDFontType0C|OpenType)\b/.test(dict)) return false;
  if (/\/Type\s*\/(Metadata|XRef|ObjStm|EmbeddedFile)\b/.test(dict)) return false;
  if (/\/N\s+\d/.test(dict) && !/\/Subtype\s*\/Form\b/.test(dict)) return false;
  return true;
}

export async function verifyEdit(E, before, after, plan, { pdfjs = null } = {}) {
  const checks = [];
  const add = (id, name, pass, evidence) => checks.push({ id, name, pass: !!pass, evidence: String(evidence) });
  const a0 = plan.analysis;
  const oi = plan.objIndex;
  const structure = V.analyzeStructure(after, before);
  add('V01', 'clean single non-incremental revision (1 EOF, 1 startxref, no /Prev, valid classic xref)', structure.singleRevision,
    `eof ${structure.eofCount}, startxref ${structure.startxrefCount}, prev ${structure.prevCount}, xrefStm ${structure.xrefStmCount}, objStm ${structure.objStmCount}, invalid xref ${structure.xref.invalid.length}, duplicates ${structure.duplicateObjects.length}, starts with original ${structure.startsWithOriginal}`);
  let a1;
  try { a1 = await analyze(E, after, plan.pageIndex, { pdfjs }); } catch (e) { add('V02', 'output reopens', false, e.message); return summarize(checks); }
  const c0 = a0.page.census;
  const c1 = a1.page.census;
  add('V02', 'output reopens; page count, object census and annotation census unchanged', a1.doc.pageCount === a0.doc.pageCount && JSON.stringify(c0) === JSON.stringify(c1) && a1.page.annots === a0.page.annots,
    `pages ${a0.doc.pageCount}->${a1.doc.pageCount}, census ${JSON.stringify(c0)} -> ${JSON.stringify(c1)}, annots ${a0.page.annots}->${a1.page.annots}`);
  add('V03', 'exact PDFium page text', a1.pdfium.pageText === plan.expected.pdfiumText, `${JSON.stringify(a1.pdfium.pageText.slice(0, 160))} vs expected ${JSON.stringify(plan.expected.pdfiumText.slice(0, 160))}`);
  const t0 = a0.objects.map((o) => (o.type === OBJ.TEXT ? o.realText : null));
  const t1 = a1.objects.map((o) => (o.type === OBJ.TEXT ? o.realText : null));
  const changed = t1.map((t, k) => (t !== t0[k] ? k : -1)).filter((k) => k >= 0);
  const tgt = a1.objects[oi];
  add('V04', 'exactly one text object changed, at the target index, to the expected text', changed.length === 1 && changed[0] === oi && tgt && tgt.realText === plan.newText && tgt.all.length === tgt.real.length,
    `changed objects ${JSON.stringify(changed)}, target ${JSON.stringify(tgt && tgt.realText)}, generated chars inside ${tgt ? tgt.all.length - tgt.real.length : 'n/a'}`);
  let geo = Infinity;
  if (tgt && tgt.origins.length === plan.expectedOrigins.length) geo = tgt.origins.reduce((m, q, k) => Math.max(m, dist(q, plan.expectedOrigins[k])), 0);
  add('V05', `target glyph origins match the planned layout within ${POS_TOL_PT} pt (PDFium, reopened)`, geo <= POS_TOL_PT, `max deviation ${geo === Infinity ? 'count mismatch' : geo.toExponential(2)} pt; SetPositions discrimination ${plan.naturalDelta.toFixed(3)} (${plan.discriminating ? 'discriminating' : 'not discriminating'})`);
  let untouched = 0;
  let untouchedBad = [];
  a0.objects.forEach((o, k) => {
    if (k === oi) return;
    const n = a1.objects[k];
    if (!n || n.type !== o.type) { untouchedBad.push(`${k}: type`); return; }
    if (o.type === OBJ.TEXT) {
      if (n.realText !== o.realText || n.origins.length !== o.origins.length) { untouchedBad.push(`${k}: text ${JSON.stringify(o.realText)} -> ${JSON.stringify(n.realText)}`); return; }
      const d = o.origins.reduce((m, q, j) => Math.max(m, dist(q, n.origins[j])), 0);
      untouched = Math.max(untouched, d);
      if (d > POS_TOL_PT) untouchedBad.push(`${k}: moved ${d.toFixed(4)}`);
    } else if (o.bounds && n.bounds) {
      const d = Math.max(Math.abs(o.bounds.left - n.bounds.left), Math.abs(o.bounds.right - n.bounds.right), Math.abs(o.bounds.bottom - n.bounds.bottom), Math.abs(o.bounds.top - n.bounds.top));
      if (d > POS_TOL_PT) untouchedBad.push(`${k}: bounds moved ${d.toFixed(4)}`);
    }
  });
  add('V06', 'untouched objects: identical text, glyph origins and bounds within tolerance (PDFium)', untouchedBad.length === 0, untouchedBad.length ? untouchedBad.slice(0, 6).join('; ') : `max untouched glyph movement ${untouched.toExponential(2)} pt over ${a0.objects.length - 1} objects`);
  // Search: new text findable, old selection gone from the target.
  const sr = E.withDoc(after, plan.pageIndex, (d) => {
    const g = E.groups(d.textPage);
    const h = E.objects(d.page)[oi];
    const gr = g.map.get(h);
    const lo = gr ? g.chars[gr.real[0]].unit : -1;
    const lastG = gr ? g.chars[gr.real[gr.real.length - 1]] : null;
    const hi = lastG ? lastG.unit + lastG.units - 1 : -1;
    const inside = (hit) => hit[0] <= hi && hit[0] + hit[1] - 1 >= lo;
    const words = plan.replacement.split(' ').filter((w) => w && new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}\\p{N}]|$)`, 'u').test(plan.newText));
    const wordHits = words.map((w) => ({ w, inside: E.search(d.textPage, w, SEARCH.MATCHCASE | SEARCH.WHOLEWORD).some(inside) }));
    const replHit = E.search(d.textPage, plan.replacement, SEARCH.MATCHCASE).some(inside);
    const oldHits = E.search(d.textPage, plan.selection.oldSelected, SEARCH.MATCHCASE);
    return { wordHits, replHit, oldInside: oldHits.filter(inside).length, oldTotal: oldHits.length };
  });
  const oldBefore = E.withDoc(before, plan.pageIndex, (d) => E.search(d.textPage, plan.selection.oldSelected, SEARCH.MATCHCASE).length);
  const expectOld = oldBefore - occurrences(plan.oldText, plan.selection.oldSelected) + occurrences(plan.newText, plan.selection.oldSelected);
  const newHasOld = plan.newText.includes(plan.selection.oldSelected);
  const astral = (str) => toCodePoints(str).some((cp) => cp > 0xffff);
  const oldInPageBefore = occurrences(plan.expected.pdfiumTextBefore, plan.selection.oldSelected);
  if ((astral(plan.replacement) || astral(plan.selection.oldSelected)) && oldBefore === 0 && oldInPageBefore > 0) {
    // Control: PDFium cannot find the original text either, so search is not applicable.
    add('V07', 'search: not applicable to supplementary-plane text (PDFium engine limitation, confirmed by a control search on the original)', sr.oldTotal === 0 && !sr.replHit,
      `control: original page contains "${plan.selection.oldSelected}" ${oldInPageBefore}x but PDFium search finds ${oldBefore}; presence and absence are proven by the exact text checks V03, V04 and V12 instead`);
  } else {
    add('V07', 'search: replacement found in the target (match case, whole word where applicable); old text gone from the target', sr.replHit && sr.wordHits.every((w) => w.inside) && (newHasOld || sr.oldInside === 0) && sr.oldTotal === expectOld,
      `replacement hit ${sr.replHit}, whole words ${JSON.stringify(sr.wordHits)}, old "${plan.selection.oldSelected}" inside target ${sr.oldInside}, on page ${oldBefore}->${sr.oldTotal} (expected ${expectOld})`);
  }
  // Independent interpreter on the output.
  const s0 = a0.independent.shows;
  const s1 = a1.independent.shows;
  let indepBad = [];
  if (!a1.mapping.ok) indepBad.push(`mapping: ${a1.mapping.detail}`);
  else {
    a1.objects.filter((o) => o.type === OBJ.TEXT).forEach((o) => {
      const sh = o.show;
      if (!sh || sh.glyphs.length !== o.origins.length) { indepBad.push(`object ${o.index}: glyph count`); return; }
      if (!sh.font || sh.font.unsupported) return;
      const d = sh.glyphs.reduce((m, g, j) => Math.max(m, dist(g.origin, o.origins[j])), 0);
      if (d > POS_TOL_PT) indepBad.push(`object ${o.index}: independent origin vs PDFium ${d.toFixed(4)}`);
    });
    const ts = tgt && tgt.show;
    if (!ts || JSON.stringify(ts.glyphs.map((g) => g.code)) !== JSON.stringify(plan.newCodes)) indepBad.push('target codes differ from the plan');
    if (ts && plan.font.key && ts.font && ts.font.key !== plan.font.key) indepBad.push(`target font changed ${plan.font.key} -> ${ts.font.key}`);
    if (ts) {
      const d = ts.glyphs.reduce((m, g, j) => Math.max(m, dist(g.origin, plan.expectedOrigins[j] || { x: 1e9, y: 1e9 })), 0);
      if (d > POS_TOL_PT) indepBad.push(`target independent origins vs plan ${d.toFixed(4)}`);
    }
  }
  const d0 = s0.filter((x) => !x.inForm && x.glyphs.length);
  const d1 = s1.filter((x) => !x.inForm && x.glyphs.length);
  if (d0.length === d1.length) {
    const tIdx = a0.objects.filter((o) => o.type === OBJ.TEXT).findIndex((o) => o.index === oi);
    d0.forEach((x, k) => {
      if (k === tIdx) return;
      const y = d1[k];
      if (x.bytes !== y.bytes) { indepBad.push(`show ${k}: bytes changed`); return; }
      const d = x.glyphs.reduce((m, g, j) => Math.max(m, dist(g.origin, y.glyphs[j].origin)), 0);
      if (d > POS_TOL_PT) indepBad.push(`show ${k}: independent origin moved ${d.toFixed(4)}`);
    });
  } else indepBad.push(`direct shows ${d0.length} -> ${d1.length}`);
  add('V08', 'independent interpreter: output origins agree with PDFium, target codes and positions match the plan, untouched shows unchanged', indepBad.length === 0, indepBad.length ? indepBad.slice(0, 6).join('; ') : `${d1.length} shows checked against PDFium and the original`);
  const k0 = a0.independent.counters;
  const k1 = a1.independent.counters;
  const keys = ['images', 'inlineImages', 'forms', 'shadings'];
  add('V09', 'no image, form or shading added or removed (no overlay, no XObject substitute)', keys.every((k) => k0[k] === k1[k]),
    keys.map((k) => `${k} ${k0[k]}->${k1[k]}`).join(', ') + `, paths ${k0.paths}->${k1.paths}`);
  const bag = (arr) => arr.map((x) => `${x.inForm || ''}|${x.bytes}`).sort();
  const expectBag = bag(s0.map((x) => ({ inForm: x.inForm, bytes: !x.inForm && x.bytes === plan.oldBytes && x === (a0.objects[oi].show) ? plan.newBytes : x.bytes })));
  const gotBag = bag(s1);
  add('V10', 'shown text multiset equals the original with only the target replaced (all referenced content, including forms)', JSON.stringify(expectBag) === JSON.stringify(gotBag),
    `${s0.length} -> ${s1.length} shows`);
  const scan1 = V.scanPdf(after);
  const dec1 = await V.decodeAllStreams(after, scan1);
  const dec0 = await V.decodeAllStreams(before, V.scanPdf(before));
  const refs1 = a1.independent.counters.streamRefs;
  const orphan = [];
  let undecodable = 0;
  let oldAll = 0;
  let invisible0 = 0;
  let invisible1 = 0;
  const dictOf = new Map(scan1.objects.map((o) => [o.num, o.dict]));
  for (const st of dec1) {
    if (st.isImage || !isContentLike(dictOf.get(st.num) || '')) continue;
    if (!st.decoded) { undecodable++; continue; }
    const sc = V.scanContent(st.decoded);
    invisible1 += sc.invisibleShows;
    const shows = sc.blocks.filter((b) => b.shows > 0);
    if (shows.length && !refs1.has(st.num)) orphan.push(st.num);
    for (const b of shows) oldAll += occurrences(b.text, plan.oldSelBytes);
  }
  const scan0 = V.scanPdf(before);
  const dictOf0 = new Map(scan0.objects.map((o) => [o.num, o.dict]));
  for (const st of dec0) if (!st.isImage && st.decoded && isContentLike(dictOf0.get(st.num) || '')) invisible0 += V.scanContent(st.decoded).invisibleShows;
  const oldRef = s1.reduce((n, x) => n + occurrences(x.bytes, plan.oldSelBytes), 0);
  add('V11', 'no text in unreferenced streams; old text bytes only where verified content shows them; invisible text unchanged', orphan.length === 0 && undecodable === 0 && oldAll === oldRef && invisible1 === invisible0,
    `orphan text streams ${JSON.stringify(orphan)}, undecodable ${undecodable}, old-byte occurrences all streams ${oldAll} vs referenced ${oldRef}, invisible ${invisible0}->${invisible1}`);
  if (pdfjs) {
    const got = a1.pdfjs ? a1.pdfjs.page.str : '';
    add('V12', `exact PDF.js ${a1.pdfjs ? a1.pdfjs.version : ''} page text`, plan.expected.pdfjsText !== undefined && got === plan.expected.pdfjsText, `${JSON.stringify(got.slice(0, 160))} vs expected ${JSON.stringify((plan.expected.pdfjsText || '').slice(0, 160))}`);
    const loc = a1.pdfjs ? locateInPdfjs(a1.pdfjs.page, plan.newText, plan.expectedOrigins[0], a0.objects[oi].size) : null;
    add('V13', 'PDF.js places the new text at the target position', !!loc, loc ? `baseline offset ${loc.perp.toFixed(3)} pt` : 'not found near the target');
  }
  return summarize(checks);
}

function summarize(checks) {
  return { ok: checks.length > 0 && checks.every((c) => c.pass), checks, failed: checks.filter((c) => !c.pass).map((c) => c.id) };
}

// Plan + apply + verify. Never returns output bytes unless every check passed.
export async function runEdit(E, bytes, opts) {
  const plan = await planEdit(E, bytes, opts);
  if (!plan.ok) return { status: 'blocked', plan, reasons: plan.reasons };
  let out;
  try { out = applyEdit(E, bytes, plan); } catch (e) { return { status: 'failed', plan, error: e.message, reasons: [reason('mutation', 'engine-refused', e.message)] }; }
  const verification = await verifyEdit(E, bytes, out, plan, { pdfjs: opts.pdfjs || null });
  if (!verification.ok) return { status: 'rejected', plan, verification, reasons: verification.checks.filter((c) => !c.pass).map((c) => reason('verification', c.id, c.name)) };
  return { status: 'committed', plan, verification, bytes: out };
}
