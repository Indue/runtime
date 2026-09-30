// NoblePDF True Edit (Phase 10B lab): clip geometry for the corpus harness.
//
// Phase 9 blocks a text object with `target-clipped` whenever ANY clip is active: PDFium
// reports clip paths on the object (FPDFClipPath_CountPaths > 0) or the independent
// interpreter (te-pdf.mjs) saw W/W* earlier in the content stream (a boolean, no geometry).
// Real generators (Chromium/Skia, LibreOffice, Microsoft Word, Quartz) install a page-sized
// or content-area rectangle clip around all page content, so every text object is blocked,
// although PDFium itself drops such a clip as irrelevant (CPDF_ContentParser::CheckClip nulls
// a single rectangle clip that contains the object's glyph bounding box).
//
// This module replaces that coarse signal with geometry, for the Phase 10B corpus path only
// (the Phase 9 modules and pages are unchanged and keep blocking every clip):
//   - an independent interpreter of the page content stream that keeps the effective clip
//     region per text-showing operation: intersection of successive clips, q/Q, cm, W and
//     W*, re/m/l/c/v/y/h, path termination, text clipping render modes;
//   - PDFium's clip paths for the same object (FPDFClipPath_* geometry, page space);
//   - independent glyph ink bounds (TrueType glyf boxes of the embedded program, or the AFM
//     FontBBox plus a margin for non-embedded standard-14 fonts) and PDFium's object bounds.
// A clip is cleared only when BOTH sources agree on one known axis-aligned rectangle and the
// original run (independent and PDFium bounds) and the planned candidate run (independent
// bounds, before mutation) lie inside it. Anything else keeps `target-clipped` and adds one
// precise code. After the mutation, K01 re-checks the reopened output.
// Browser and Node. ASCII only.
import { PdfStr, parseValue, mul } from './te-pdf.mjs?v=1';
import { planEdit, targetGates, analyze } from './te-pipeline.mjs?v=1';
import { OBJ } from './te-engine.mjs?v=1';

export const TE_CLIP_VERSION = 'te-corpus-clip-1';
// Containment tolerance for float noise (same as the Phase 9 position tolerance).
export const CLIP_TOL_PT = 0.01;
// Rectangles and region comparisons: coordinates closer than this are equal.
const EPS = 1e-4;
// Non-embedded standard-14 text is drawn with the viewer's substitute font, whose glyph ink is
// not known exactly: the AFM FontBBox is expanded by this fraction of an em on every side.
export const STD14_MARGIN_EM = 0.1;
// Adobe Core14 AFM FontBBox values (glyph space, 1/1000 em).
export const STD14_FONT_BBOX = Object.freeze({
  Courier: [-23, -250, 715, 805], 'Courier-Bold': [-113, -250, 749, 801], 'Courier-Oblique': [-27, -250, 849, 805], 'Courier-BoldOblique': [-57, -250, 869, 801],
  Helvetica: [-166, -225, 1000, 931], 'Helvetica-Bold': [-170, -228, 1003, 962], 'Helvetica-Oblique': [-170, -225, 1116, 931], 'Helvetica-BoldOblique': [-174, -228, 1114, 962],
  'Times-Roman': [-168, -218, 1000, 898], 'Times-Bold': [-168, -218, 1000, 935], 'Times-Italic': [-169, -217, 1010, 883], 'Times-BoldItalic': [-200, -218, 996, 921],
  Symbol: [-180, -293, 1090, 1010], ZapfDingbats: [-1, -143, 981, 820],
});
// Precise codes added next to `target-clipped` when a clip is not proven irrelevant.
export const CLIP_CODES = Object.freeze({
  CUTS: 'clip-cuts-text', CANDIDATE: 'clip-candidate-outside', UNSUPPORTED: 'clip-geometry-unsupported', EMPTY: 'clip-empty',
  DISAGREE: 'clip-engine-interpreter-disagree', UNKNOWN: 'clip-geometry-unknown',
});
const reason = (stage, code, detail) => ({ stage, code, detail });
const r2 = (v) => Math.round(v * 100) / 100;
const rectOut = (r) => (r ? { x0: r2(r.x0), y0: r2(r.y0), x1: r2(r.x1), y1: r2(r.y1) } : null);
const boxOut = (b) => (b ? { left: r2(b.left), bottom: r2(b.bottom), right: r2(b.right), top: r2(b.top) } : null);

// ------------------------------------------------------------------ regions
// null = no clip; { kind: 'rect', x0, y0, x1, y1 }; { kind: 'empty', why }; { kind: 'complex', why }.
const complex = (why) => ({ kind: 'complex', why });
const empty = (why) => ({ kind: 'empty', why });
export function intersectRegion(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.kind === 'complex') return a;
  if (b.kind === 'complex') return b;
  if (a.kind === 'empty') return a;
  if (b.kind === 'empty') return b;
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  if (x1 - x0 <= EPS || y1 - y0 <= EPS) return empty('successive clips do not overlap');
  return { kind: 'rect', x0, y0, x1, y1 };
}
export function sameRegion(a, b, tol = CLIP_TOL_PT) {
  if (!a || !b) return !a && !b;
  if (a.kind !== b.kind) return false;
  if (a.kind !== 'rect') return true;
  return Math.abs(a.x0 - b.x0) <= tol && Math.abs(a.y0 - b.y0) <= tol && Math.abs(a.x1 - b.x1) <= tol && Math.abs(a.y1 - b.y1) <= tol;
}
export const boxInside = (b, r, tol = CLIP_TOL_PT) => !!b && !!r && r.kind === 'rect' && b.left >= r.x0 - tol && b.right <= r.x1 + tol && b.bottom >= r.y0 - tol && b.top <= r.y1 + tol;

// One path (list of subpaths, page-space points) -> region. Only a single subpath without
// curves whose vertices form an axis-aligned rectangle is a known region; a single point is
// empty (PDFium clips to a 0x0 rectangle); everything else is complex (fail closed). The fill
// rule (W or W*) does not change a single simple rectangle.
export function pathRegion(subpaths) {
  if (!subpaths.length) return complex('clip operator without a current path');
  if (subpaths.length > 1) return complex(`clip path with ${subpaths.length} subpaths`);
  const sp = subpaths[0];
  if (sp.curve) return complex('curved clip path');
  if (sp.malformed) return complex(`malformed clip path (${sp.malformed})`);
  let pts = sp.points.slice();
  if (pts.length === 1) return empty('clip path is a single point');
  const same = (p, q) => Math.abs(p.x - q.x) <= EPS && Math.abs(p.y - q.y) <= EPS;
  pts = pts.filter((p, i) => i === 0 || !same(p, pts[i - 1]));
  if (pts.length > 1 && same(pts[0], pts[pts.length - 1])) pts.pop();
  if (pts.length === 1) return empty('clip path is a single point');
  if (pts.length === 2) return empty('clip path is a line (no area)');
  if (pts.length !== 4) return complex(`clip polygon with ${pts.length} vertices`);
  const horiz = (p, q) => Math.abs(p.y - q.y) <= EPS;
  const vert = (p, q) => Math.abs(p.x - q.x) <= EPS;
  const e = [0, 1, 2, 3].map((i) => [pts[i], pts[(i + 1) % 4]]);
  const hv = e.every(([p, q], i) => (i % 2 === 0 ? horiz(p, q) : vert(p, q)));
  const vh = e.every(([p, q], i) => (i % 2 === 0 ? vert(p, q) : horiz(p, q)));
  if (!hv && !vh) return complex('clip polygon is not an axis-aligned rectangle (rotated, skewed or irregular)');
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const r = { kind: 'rect', x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  if (r.x1 - r.x0 <= EPS || r.y1 - r.y0 <= EPS) return empty('clip rectangle has no area');
  return r;
}

// ------------------------------------------------------------------ content tokenizer
// The same operator sequence as te-pdf.mjs contentOps() (same whitespace, comment, operand
// and inline-image rules), so opIndex values line up with the Phase 9 show records. The
// alignment is checked for every show; any mismatch makes the clip state unknown.
const WS = ' \t\r\n\f\0';
const DELIMS = '()<>[]{}/%';
const isWs = (c) => c !== undefined && WS.includes(c);
const isDelim = (c) => c !== undefined && DELIMS.includes(c);
function skip(s, i) {
  for (;;) {
    while (i < s.length && isWs(s[i])) i++;
    if (s[i] === '%') { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
    return i;
  }
}
function readToken(s, i) {
  let k = i;
  while (k < s.length && !isWs(s[k]) && !isDelim(s[k])) k++;
  return { tok: s.slice(i, k), pos: k };
}
function* contentOps(s) {
  let i = 0;
  let args = [];
  while (i < s.length) {
    i = skip(s, i);
    if (i >= s.length) break;
    const c = s[i];
    if (c === '/' || c === '(' || c === '[' || c === '<' || c === '+' || c === '-' || c === '.' || (c >= '0' && c <= '9')) {
      const v = parseValue(s, i);
      args.push(v.value);
      i = v.pos;
      continue;
    }
    if (c === ')' || c === ']' || c === '>' || c === '{' || c === '}') { i++; continue; }
    const t = readToken(s, i);
    i = t.pos;
    if (t.tok === 'true' || t.tok === 'false' || t.tok === 'null') { args.push(t.tok === 'true' ? true : (t.tok === 'false' ? false : null)); continue; }
    if (t.tok === 'BI') {
      const idAt = s.indexOf('ID', i);
      const re = /[ \t\r\n\f\0]EI(?=[ \t\r\n\f\0]|$)/g;
      re.lastIndex = idAt === -1 ? s.length : idAt + 2;
      const m = re.exec(s);
      i = m ? m.index + 3 : s.length;
      yield { op: 'BI', args: [] };
      args = [];
      continue;
    }
    yield { op: t.tok, args };
    args = [];
  }
}
const latin1 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return s; };
const ID = [1, 0, 0, 1, 0, 0];
const applyM = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

// Effective clip region of every page-level text-showing operation (Forms are not entered:
// a Do cannot change the caller's clip, and text inside forms is blocked by the form gate).
export async function interpretClips(pdfDoc, pageIndex) {
  const page = pdfDoc.pages()[pageIndex];
  if (!page) throw new Error(`page ${pageIndex} missing`);
  const parts = [];
  for (const ref of page.contents) { const e = pdfDoc.entry(ref); if (e) parts.push(latin1(await pdfDoc.streamBytes(e))); }
  const text = parts.join('\n');
  const shows = [];
  const stack = [];
  let gs = { ctm: ID.slice(), clip: null, clipOps: 0, pathClipOps: 0, tr: 0 };
  let subpaths = [];
  let cur = null;
  let pendingClip = null;
  let textClip = false;
  let opIndex = 0;
  const pt = (x, y) => applyM(gs.ctm, x, y);
  const newSub = (p) => { cur = { points: [p], curve: false, malformed: null }; subpaths.push(cur); };
  const addPoint = (p, curve = false) => {
    if (!cur) { const s0 = { points: [], curve: false, malformed: 'segment without a current point' }; subpaths.push(s0); cur = s0; }
    if (curve) cur.curve = true;
    cur.points.push(p);
  };
  for (const { op, args } of contentOps(text)) {
    opIndex++;
    const n = (k) => Number(args[k]);
    switch (op) {
      case 'q': stack.push({ ...gs, ctm: gs.ctm.slice() }); break;
      case 'Q': if (stack.length) gs = stack.pop(); break;
      case 'cm': gs.ctm = mul([n(0), n(1), n(2), n(3), n(4), n(5)], gs.ctm); break;
      case 'Tr': gs.tr = n(0); break;
      case 'BT': textClip = false; break;
      case 'ET': if (textClip) { gs.clip = intersectRegion(gs.clip, complex('text clipping render mode (Tr 4-7) adds glyph outlines to the clip')); gs.clipOps++; } textClip = false; break;
      case 'Tj': case 'TJ': case "'": case '"': {
        const okArg = op === 'TJ' ? Array.isArray(args[0]) : (op === '"' ? args[2] instanceof PdfStr : args[0] instanceof PdfStr);
        if (okArg) { shows.push({ opIndex, op, clip: gs.clip, clipOps: gs.clipOps, pathClipOps: gs.pathClipOps, ctm: gs.ctm.slice() }); if (gs.tr >= 4 && gs.tr <= 7) textClip = true; }
        break;
      }
      case 'm': newSub(pt(n(0), n(1))); break;
      case 'l': addPoint(pt(n(0), n(1))); break;
      case 'c': addPoint(pt(n(0), n(1)), true); addPoint(pt(n(2), n(3)), true); addPoint(pt(n(4), n(5)), true); break;
      case 'v': case 'y': addPoint(pt(n(0), n(1)), true); addPoint(pt(n(2), n(3)), true); break;
      case 'h': if (cur) { cur.closed = true; cur = null; } break;
      case 're': {
        const x = n(0); const y = n(1); const w = n(2); const h = n(3);
        newSub(pt(x, y));
        addPoint(pt(x + w, y)); addPoint(pt(x + w, y + h)); addPoint(pt(x, y + h));
        cur.closed = true; cur = null;
        break;
      }
      case 'W': case 'W*': pendingClip = op; break;
      case 'S': case 's': case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*': case 'n':
        if (pendingClip) { gs.clip = intersectRegion(gs.clip, pathRegion(subpaths)); gs.clipOps++; gs.pathClipOps++; pendingClip = null; }
        subpaths = []; cur = null;
        break;
      default: break;
    }
  }
  return { shows, opCount: opIndex, streams: page.contents.length };
}

// ------------------------------------------------------------------ PDFium clip geometry
// FPDFPageObj_GetClipPath always returns the object's clip; CountPaths is -1 when no clip is
// set. Paths are in page space (PDFium applies the CTM when it records them). Segment types:
// 0 lineto, 1 bezierto, 2 moveto. A clip with no paths but a reference holds text clips.
export function pdfiumClip(E, h) {
  const p = E.p;
  const c = p.FPDFPageObj_GetClipPath(h);
  const n = c ? p.FPDFClipPath_CountPaths(c) : -1;
  if (n < 0) return { paths: -1, region: null, segments: [] };
  if (n === 0) return { paths: 0, region: complex('PDFium clip without paths (text clip)'), segments: [] };
  let region = null;
  const segments = [];
  const ptr = E.malloc(8);
  try {
    for (let i = 0; i < n; i++) {
      const ns = p.FPDFClipPath_CountPathSegments(c, i);
      segments.push(ns);
      const subs = [];
      let sub = null;
      if (ns <= 0) { region = intersectRegion(region, complex('PDFium clip path without segments')); continue; }
      for (let j = 0; j < ns; j++) {
        const s = p.FPDFClipPath_GetPathSegment(c, i, j);
        if (!s || !p.FPDFPathSegment_GetPoint(s, ptr, ptr + 4)) { sub = null; subs.push({ points: [], curve: false, malformed: 'unreadable PDFium segment' }); continue; }
        const d = E.dv();
        const q = { x: d.getFloat32(ptr, true), y: d.getFloat32(ptr + 4, true) };
        const type = p.FPDFPathSegment_GetType(s);
        if (type === 2 || !sub) { sub = { points: [q], curve: false, malformed: type === 2 ? null : 'path does not start with moveto' }; subs.push(sub); }
        else { if (type === 1) sub.curve = true; else if (type !== 0) sub.malformed = `segment type ${type}`; sub.points.push(q); }
      }
      region = intersectRegion(region, pathRegion(subs));
    }
  } finally { E.free(ptr); }
  return { paths: n, region, segments };
}

// ------------------------------------------------------------------ glyph ink bounds
// Glyph bounding boxes (em units) from an embedded TrueType program: head.unitsPerEm and the
// glyf header (xMin, yMin, xMax, yMax) of each glyph. Independent of PDFium and te-ttf.mjs.
export function trueTypeGlyphBoxes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  if (tag(0) === 'ttcf') throw new Error('TrueType collection');
  const numTables = dv.getUint16(4);
  const t = {};
  for (let i = 0; i < numTables; i++) { const o = 12 + 16 * i; t[tag(o)] = { off: dv.getUint32(o + 8), len: dv.getUint32(o + 12) }; }
  for (const k of ['head', 'maxp', 'loca', 'glyf']) if (!t[k]) throw new Error(`missing ${k} table`);
  const upm = dv.getUint16(t.head.off + 18);
  if (!upm) throw new Error('unitsPerEm is 0');
  const longLoca = dv.getInt16(t.head.off + 50) === 1;
  const numGlyphs = dv.getUint16(t.maxp.off + 4);
  const loca = (g) => (longLoca ? dv.getUint32(t.loca.off + 4 * g) : dv.getUint16(t.loca.off + 2 * g) * 2);
  return {
    upm,
    numGlyphs,
    // null: no outline (no ink); undefined: glyph id outside the font.
    box(gid) {
      if (!Number.isInteger(gid) || gid < 0 || gid >= numGlyphs) return undefined;
      const a = loca(gid);
      const b = loca(gid + 1);
      if (b <= a) return null;
      const o = t.glyf.off + a;
      if (o + 10 > u8.length) throw new Error(`glyph ${gid} outside the glyf table`);
      return { x0: dv.getInt16(o + 2) / upm, y0: dv.getInt16(o + 4) / upm, x1: dv.getInt16(o + 6) / upm, y1: dv.getInt16(o + 8) / upm };
    },
  };
}

// Per-glyph ink boxes (em) for a font model and glyph list [{ code, cp }]. Returns
// { boxes, source } or { unknown: why }. A null box is a glyph without ink (space).
export async function glyphInkBoxes(pdfDoc, font, glyphs) {
  if (!font || font.unsupported) return { unknown: 'font not interpreted' };
  if (font.fontClass === 'std14-type1') {
    const b = STD14_FONT_BBOX[font.std14];
    if (!b) return { unknown: `no FontBBox for standard font ${font.std14}` };
    const m = STD14_MARGIN_EM;
    const box = { x0: b[0] / 1000 - m, y0: b[1] / 1000 - m, x1: b[2] / 1000 + m, y1: b[3] / 1000 + m };
    return { boxes: glyphs.map(() => box), source: `std14 AFM FontBBox + ${m} em (substitute font)` };
  }
  if (!font.fontFileRef) return { unknown: 'no embedded font program' };
  try {
    if (!font._clipBoxes) font._clipBoxes = trueTypeGlyphBoxes(await pdfDoc.streamBytes(font.fontFileRef));
    await font.program();
  } catch (e) { return { unknown: `font program unreadable: ${e.message}` }; }
  const tt = font._clipBoxes;
  const boxes = [];
  for (const g of glyphs) {
    const gid = font.gidForCode(g.code, g.cp);
    // .notdef (0) would give the box of the wrong glyph: bounds unknown, fail closed.
    if (!gid) return { unknown: `code ${g.code} maps to no glyph (or .notdef) in the embedded program` };
    const bx = tt.box(gid);
    if (bx === undefined) return { unknown: `glyph ${gid} outside the font program` };
    boxes.push(bx);
  }
  return { boxes, source: `TrueType glyf boxes (unitsPerEm ${tt.upm})` };
}

// Page-space union of glyph boxes. origins: page-space glyph origins; lin: linear part
// [a, b, c, d] of Tm x CTM; size: Tfs; th: horizontal scaling (Tz / 100).
export function inkBox(origins, lin, size, th, boxes) {
  let b = null;
  origins.forEach((o, k) => {
    const g = boxes[k];
    if (!g) return;
    for (const [ex, ey] of [[g.x0, g.y0], [g.x1, g.y0], [g.x0, g.y1], [g.x1, g.y1]]) {
      const tx = ex * size * th;
      const ty = ey * size;
      const x = o.x + lin[0] * tx + lin[2] * ty;
      const y = o.y + lin[1] * tx + lin[3] * ty;
      if (!b) b = { left: x, right: x, bottom: y, top: y };
      else { b.left = Math.min(b.left, x); b.right = Math.max(b.right, x); b.bottom = Math.min(b.bottom, y); b.top = Math.max(b.top, y); }
    }
  });
  return b;
}
const unionBox = (a, b) => (!a ? b : !b ? a : { left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), bottom: Math.min(a.bottom, b.bottom), top: Math.max(a.top, b.top) });
const showLin = (s) => { const t = mul(s.tmStart, s.ctm); return [t[0], t[1], t[2], t[3]]; };

// ------------------------------------------------------------------ per-page facts
// Clip facts of every direct text object of an analysed page (analyze() output `a`).
// { objIndex -> entry }, entry = { pdfium, stream, region, kind, agree, verdict, ... }.
export async function clipFacts(E, bytes, a) {
  const out = new Map();
  const texts = a.objects.filter((o) => o.type === OBJ.TEXT);
  if (!texts.length) return out;
  const pdf = E.withDoc(bytes, a.pageIndex, (d) => { const hs = E.objects(d.page); return texts.map((o) => pdfiumClip(E, hs[o.index])); });
  let ic = null;
  let icError = null;
  if (a.independent.pdfDoc && !a.independent.error) {
    try { ic = await interpretClips(a.independent.pdfDoc, a.pageIndex); } catch (e) { icError = e.message; }
  } else icError = a.independent.error || 'independent reader unavailable';
  const byOp = new Map((ic ? ic.shows : []).map((x) => [x.opIndex, x]));
  for (let k = 0; k < texts.length; k++) {
    const o = texts[k];
    const pd = pdf[k];
    const e = { objIndex: o.index, pdfium: { paths: pd.paths, segments: pd.segments, region: pd.region }, stream: null, streamBoolean: o.show ? !!o.show.clip : null, opIndex: o.show ? o.show.opIndex : null };
    const sh = o.show && !o.show.inForm ? byOp.get(o.show.opIndex) : null;
    if (!o.show) e.problem = 'not mapped to a content operation';
    else if (icError) e.problem = `clip interpreter: ${icError}`;
    else if (!sh || sh.op !== o.show.op) e.problem = `clip interpreter out of step with the content interpreter at op #${o.show.opIndex}`;
    // Phase 9's boolean records path clips only (W/W* + path end), never text clip modes.
    else if ((sh.pathClipOps > 0) !== !!o.show.clip) e.problem = 'clip interpreter and content interpreter disagree about an active clip';
    else e.stream = { region: sh.clip, clipOps: sh.clipOps };
    decideClip(e, o);
    out.set(o.index, e);
  }
  return out;
}

// Classifies the clip of one object and cross-checks PDFium with the stream.
export function decideClip(e, o) {
  const P = e.pdfium.region;
  if (e.problem) { e.kind = 'unknown'; e.agree = false; e.detail = e.problem; return; }
  const I = e.stream.region;
  if (!I && !P) { e.kind = 'none'; e.agree = true; e.detail = 'no clip (PDFium and content stream)'; return; }
  if (I && I.kind === 'complex') { e.kind = 'complex'; e.region = I; e.agree = !!P; e.detail = `content stream: ${I.why}`; return; }
  if (P && P.kind === 'complex') { e.kind = 'complex'; e.region = P; e.agree = !!I; e.detail = `PDFium: ${P.why}`; return; }
  if ((I && I.kind === 'empty') || (P && P.kind === 'empty')) { e.kind = 'empty'; e.region = empty((I && I.why) || (P && P.why)); e.agree = !!I && !!P && I.kind === P.kind; e.detail = `clip region is empty: ${e.region.why}`; return; }
  if (!I && P) { e.kind = 'rect'; e.region = P; e.agree = false; e.detail = 'PDFium reports a clip the content stream does not install'; return; }
  e.kind = 'rect';
  e.region = I;
  if (P) {
    e.agree = sameRegion(I, P);
    e.detail = e.agree ? `PDFium and the content stream agree on one rectangle clip (${e.pdfium.paths} PDFium path(s))` : 'PDFium clip rectangle differs from the content-stream clip';
  } else {
    // PDFium dropped the clip (CheckClip): a single rectangle containing the object's bounds.
    e.agree = !!o.bounds && boxInside(o.bounds, I);
    e.detail = e.agree ? 'PDFium dropped this clip as containing the object (single rectangle); the content stream holds it' : 'PDFium reports no clip, but the content-stream clip does not contain the PDFium bounds';
  }
}

// Independent ink box of the original run and the verdict for the original text.
export async function originalVerdict(a, objIndex, e) {
  const o = a.objects[objIndex];
  const s = o && o.show;
  if (!e) return { verdict: 'unknown', code: CLIP_CODES.UNKNOWN, detail: 'no clip facts' };
  if (e.kind === 'none') return { verdict: 'none' };
  if (e.kind === 'unknown') return { verdict: 'unknown', code: CLIP_CODES.UNKNOWN, detail: e.detail };
  if (e.kind === 'complex') return { verdict: 'unsupported', code: CLIP_CODES.UNSUPPORTED, detail: e.detail };
  if (e.kind === 'empty') return { verdict: 'empty', code: CLIP_CODES.EMPTY, detail: e.detail };
  if (!e.agree) return { verdict: 'disagree', code: CLIP_CODES.DISAGREE, detail: e.detail };
  if (!s || !s.font) return { verdict: 'unknown', code: CLIP_CODES.UNKNOWN, detail: 'text not interpreted' };
  const ink = await glyphInkBoxes(a.independent.pdfDoc, s.font, s.glyphs.map((g) => ({ code: g.code, cp: g.cps && g.cps.length === 1 ? g.cps[0] : null })));
  if (ink.unknown) return { verdict: 'unknown', code: CLIP_CODES.UNKNOWN, detail: `glyph bounds unknown: ${ink.unknown}` };
  const indep = inkBox(s.glyphs.map((g) => g.origin), showLin(s), s.size, s.tz / 100, ink.boxes);
  e.inkSource = ink.source;
  e.textBoxIndependent = indep;
  e.textBoxPdfium = o.bounds;
  const inI = !indep || boxInside(indep, e.region);
  const inP = !o.bounds || boxInside(o.bounds, e.region);
  if (!inI || !inP) return { verdict: 'cuts-text', code: CLIP_CODES.CUTS, detail: `the clip ${JSON.stringify(rectOut(e.region))} cuts the text (${!inI ? 'independent glyph bounds' : ''}${!inI && !inP ? ' and ' : ''}${!inP ? 'PDFium bounds' : ''} outside)` };
  return { verdict: 'contained', detail: `one rectangle clip ${JSON.stringify(rectOut(e.region))} contains the text (independent ${ink.source} and PDFium bounds)` };
}

// Candidate run (planned, before mutation): independent glyph boxes at the planned positions,
// computed both with the independent text matrix and with PDFium's object matrix.
export async function candidateVerdict(a, plan, e) {
  const o = a.objects[plan.objIndex];
  const s = o.show;
  const cps = plan.newText ? [...plan.newText].map((ch) => ch.codePointAt(0)) : [];
  const glyphs = plan.newCodes.map((code, k) => ({ code, cp: cps[k] ?? null }));
  const ink = await glyphInkBoxes(a.independent.pdfDoc, s.font, glyphs);
  if (ink.unknown) return { verdict: 'unknown', code: CLIP_CODES.UNKNOWN, detail: `candidate glyph bounds unknown: ${ink.unknown}` };
  const lin = showLin(s);
  const th = s.tz / 100;
  const o0 = s.glyphs[0].origin;
  const x0 = o.xs[0] || 0;
  const indepOrigins = plan.xs.map((x) => ({ x: o0.x + lin[0] * th * (x - x0), y: o0.y + lin[1] * th * (x - x0) }));
  const m = plan.matrix;
  const pdfOrigins = plan.xs.map((x) => applyM(m, x, 0));
  const mLin = [m[0] / th, m[1] / th, m[2], m[3]];
  const box = unionBox(inkBox(indepOrigins, lin, s.size, th, ink.boxes), inkBox(pdfOrigins, mLin, s.size, th, ink.boxes));
  e.candidateBox = box;
  if (box && !boxInside(box, e.region)) return { verdict: 'candidate-outside', code: CLIP_CODES.CANDIDATE, detail: `the replacement would reach ${JSON.stringify(boxOut(box))}, outside the clip ${JSON.stringify(rectOut(e.region))}` };
  return { verdict: 'contained', detail: `the planned replacement ${JSON.stringify(boxOut(box))} stays inside the clip ${JSON.stringify(rectOut(e.region))}` };
}

// ------------------------------------------------------------------ gating
const isClipReason = (r) => r.code === 'target-clipped';
// Target gates with the Phase 9 clip reasons replaced by the geometric verdict: removed only
// when the verdict is `contained`; otherwise kept, with one precise code added. A clip that
// the Phase 9 signals did not report but the geometry finds blocks too.
export async function clipAwareTargetGates(a, objIndex, facts) {
  const base = targetGates(a, objIndex);
  const clipR = base.filter(isClipReason);
  const others = base.filter((r) => !isClipReason(r));
  const e = facts ? facts.get(objIndex) : null;
  const o = a.objects[objIndex];
  if (!o || o.type !== OBJ.TEXT) return { reasons: base, verdict: null };
  if (!clipR.length && (!e || e.kind === 'none' || !o.show)) return { reasons: base, verdict: e ? { verdict: 'none' } : null };
  // A clip the Phase 9 signals missed (for example a text clip, Tr 4-7: PDFium counts no
  // path and the Phase 9 boolean records W/W* only) is decided like any other clip.
  const missed = clipR.length ? [] : [reason('target', 'target-clipped', `clip found by the Phase 10B clip interpreter (${e.kind}); not reported by the Phase 9 signals`)];
  const v = await originalVerdict(a, objIndex, e);
  if (v.verdict === 'contained') return { reasons: others, verdict: v };
  return { reasons: [...base, ...missed, reason('target', v.code || CLIP_CODES.UNKNOWN, v.detail || 'clip not proven irrelevant')], verdict: v };
}

// planEdit() with the clip reasons decided by geometry. The Phase 9 plan is computed in full
// (a clip reason does not stop planning); it is re-issued as ok only when its ONLY reasons are
// `target-clipped` AND the original and the candidate are both inside one agreed rectangle.
export async function planEditClipAware(E, bytes, opts, facts) {
  const plan = await planEdit(E, bytes, opts);
  const a = plan.analysis;
  const f = facts || await clipFacts(E, bytes, a);
  const e = f.get(opts.objIndex);
  const clipR = plan.reasons.filter(isClipReason);
  const others = plan.reasons.filter((r) => !isClipReason(r));
  plan.clipFacts = f;
  if (!clipR.length && (!e || e.kind === 'none' || !a.objects[opts.objIndex] || !a.objects[opts.objIndex].show)) return plan;
  if (!clipR.length) plan.reasons.push(reason('target', 'target-clipped', `clip found by the Phase 10B clip interpreter (${e.kind}); not reported by the Phase 9 signals`));
  const v = await originalVerdict(a, opts.objIndex, e);
  const block = (code, detail, cand = null) => { plan.reasons.push(reason('target', code, detail)); plan.ok = false; plan.clip = cand ? { original: v, candidate: cand } : { original: v }; return plan; };
  if (v.verdict !== 'contained') return block(v.code || CLIP_CODES.UNKNOWN, v.detail);
  // Planning stopped early for another reason: that reason blocks; the clip is not the cause.
  if (!plan.xs || !plan.newCodes) { if (others.length) { plan.reasons = others; plan.clip = { original: v }; return plan; } return block(CLIP_CODES.UNKNOWN, 'no planned layout to check against the clip'); }
  const c = await candidateVerdict(a, plan, e);
  if (c.verdict !== 'contained') return block(c.code || CLIP_CODES.UNKNOWN, c.detail, c);
  plan.clip = { original: v, candidate: c, region: rectOut(e.region), agree: e.agree };
  // Geometry proved the clip irrelevant: only the remaining (non-clip) reasons decide.
  plan.reasons = others;
  plan.ok = others.length === 0;
  return plan;
}

// ------------------------------------------------------------------ K01 (after mutation)
// Reopened output: the target's PDFium bounds and independent glyph bounds lie inside the
// original clip rectangle, and the output either keeps that clip for the target or has none
// (PDFium drops a single containing rectangle when it regenerates the content).
export async function outputClipCheck(E, after, plan) {
  const name = 'clip: the edited text lies inside its original clip rectangle after the edit (PDFium and independent bounds, reopened output)';
  const region = plan.clip && plan.clip.region;
  if (!region) return { id: 'K01', name, pass: false, evidence: 'no clip rectangle recorded in the plan' };
  const R = { kind: 'rect', ...region };
  let a1;
  try { a1 = await analyze(E, after, plan.pageIndex); } catch (err) { return { id: 'K01', name, pass: false, evidence: `output did not reopen: ${err.message}` }; }
  const t = a1.objects[plan.objIndex];
  if (!t || t.type !== OBJ.TEXT || !t.show || !t.show.font) return { id: 'K01', name, pass: false, evidence: 'target not found or not interpreted in the output' };
  const ink = await glyphInkBoxes(a1.independent.pdfDoc, t.show.font, t.show.glyphs.map((g) => ({ code: g.code, cp: g.cps && g.cps.length === 1 ? g.cps[0] : null })));
  if (ink.unknown) return { id: 'K01', name, pass: false, evidence: `output glyph bounds unknown: ${ink.unknown}` };
  const ib = inkBox(t.show.glyphs.map((g) => g.origin), showLin(t.show), t.show.size, t.show.tz / 100, ink.boxes);
  const f1 = await clipFacts(E, after, a1);
  const e1 = f1.get(plan.objIndex);
  const clipOk = e1 && (e1.kind === 'none' || (e1.kind === 'rect' && e1.agree && sameRegion(e1.region, R)));
  const inI = !ib || boxInside(ib, R);
  const inP = !t.bounds || boxInside(t.bounds, R);
  return { id: 'K01', name, pass: clipOk && inI && inP,
    evidence: `clip ${JSON.stringify(region)}; output target PDFium bounds ${JSON.stringify(boxOut(t.bounds))} ${inP ? 'inside' : 'OUTSIDE'}, independent ${JSON.stringify(boxOut(ib))} ${inI ? 'inside' : 'OUTSIDE'}; output clip of the target: ${e1 ? `${e1.kind}${e1.kind === 'rect' ? ` ${JSON.stringify(rectOut(e1.region))}` : ''}` : 'unknown'}${clipOk ? '' : ' (changed)'}` };
}

// ------------------------------------------------------------------ diagnostics
// Numbers and codes only (no text): safe for the default export.
export function clipDiagnostic(e, v) {
  if (!e) return null;
  const P = e.pdfium.region;
  const I = e.stream ? e.stream.region : undefined;
  const kindOf = (r) => (r === undefined ? 'unknown' : !r ? 'none' : r.kind === 'rect' ? 'rectangular-known' : r.kind === 'empty' ? 'empty' : 'non-rectangular');
  return {
    pdfiumClipPaths: e.pdfium.paths, pdfiumSegments: e.pdfium.segments, pdfiumKind: kindOf(P), pdfiumRect: P && P.kind === 'rect' ? rectOut(P) : null,
    streamClipBoolean: e.streamBoolean, streamKind: kindOf(I), streamRect: I && I.kind === 'rect' ? rectOut(I) : null, streamClipOps: e.stream ? e.stream.clipOps : null, opIndex: e.opIndex,
    kind: e.kind === 'rect' ? 'rectangular-known' : e.kind === 'complex' ? 'non-rectangular' : e.kind, effectiveRect: e.region && e.region.kind === 'rect' ? rectOut(e.region) : null,
    agree: !!e.agree, textBoxPdfium: boxOut(e.textBoxPdfium || null), textBoxIndependent: boxOut(e.textBoxIndependent || null), inkSource: e.inkSource || null,
    candidateBox: boxOut(e.candidateBox || null), verdict: v ? v.verdict : null, code: v && v.code ? v.code : null,
  };
}

// engine-interpreter-count-mismatch is a separate Phase 9 gate (kept as is). This explains it:
// a glyph whose ToUnicode maps to several code points (a ligature such as "ff") is one glyph
// for the interpreter but several characters for PDFium's text page.
export function countMismatchCause(a, objIndex) {
  const o = a.objects[objIndex];
  const s = o && o.show;
  if (!s || !s.font || s.font.unsupported || s.glyphs.length === o.real.length) return null;
  const multi = s.glyphs.filter((g) => g.cps && g.cps.length > 1).length;
  const unmapped = s.glyphs.filter((g) => !g.cps || !g.cps.length).length;
  const expanded = s.glyphs.flatMap((g) => g.cps || []);
  const pd = o.real.map((gi) => a.pdfium.chars[gi].cp);
  const sameSeq = expanded.length === pd.length && expanded.every((cp, k) => cp === pd[k]);
  const cause = multi && sameSeq ? 'multi-codepoint-glyph' : (unmapped ? 'unmapped-glyph' : 'unexplained');
  return { interpreterGlyphs: s.glyphs.length, pdfiumChars: o.real.length, multiCodepointGlyphs: multi, unmappedGlyphs: unmapped, expandedMatchesPdfium: sameSeq, cause };
}
