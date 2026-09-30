// NoblePDF True Edit (Phase 9 lab): verified PDFium engine loading and a thin wrapper.
// Built from the audited Phase 8 V2 code. Browser and Node. ASCII only.
import { sha256Hex } from './phase8-verify.mjs?v=1';

export const TE_ENGINE_VERSION = 'te-engine-1';
export const RUN10 = Object.freeze({
  wasmSha256: 'c4f54bda9bc730c0aeb6579254f0431fa95886478cd19967555be6ea2a35ce11',
  wasmBytes: 4648757,
  indexJsSha256: '2af28659a83b5691ed1193bd0819a6a1339036fb08505826d561c7541762baf2',
});
export const STOCK_PINNED = Object.freeze({
  wasmSha256: '5e4cd023c3dad4a895b3571ca573d3fc51bac6de48360d95283134385b954eaa',
  indexJsSha256: '0e31ce6c207b371384392242c560b5e88d90221843dfbbaebf3f5cff1e22f2e0',
});
export const REQUIRED_API = [
  'FPDF_LoadMemDocument', 'FPDF_CloseDocument', 'FPDF_GetPageCount', 'FPDF_LoadPage', 'FPDF_ClosePage', 'FPDF_GetLastError',
  'FPDF_GetDocPermissions', 'FPDF_GetSignatureCount', 'FPDF_GetSecurityHandlerRevision', 'FPDF_GetFormType', 'FPDF_SaveAsCopy',
  'FPDFText_LoadPage', 'FPDFText_ClosePage', 'FPDFText_CountChars', 'FPDFText_GetUnicode', 'FPDFText_GetTextObject',
  'FPDFText_IsGenerated', 'FPDFText_GetCharOrigin', 'FPDFText_GetCharIndexAtPos', 'FPDFText_FindStart', 'FPDFText_FindNext',
  'FPDFText_FindClose', 'FPDFText_GetSchResultIndex', 'FPDFText_GetSchCount', 'FPDFText_SetCharcodes', 'FPDFText_SetPositions',
  'FPDFPage_CountObjects', 'FPDFPage_GetObject', 'FPDFPage_GenerateContent', 'FPDFPage_GetAnnotCount', 'FPDFPage_GetRotation',
  'FPDFPageObj_GetType', 'FPDFPageObj_GetMatrix', 'FPDFPageObj_GetBounds', 'FPDFPageObj_CountMarks', 'FPDFPageObj_GetMark',
  'FPDFPageObjMark_GetName', 'FPDFPageObjMark_CountParams', 'FPDFPageObjMark_GetParamKey', 'FPDFPageObj_GetClipPath',
  'FPDFClipPath_CountPaths', 'FPDFTextObj_GetFont', 'FPDFTextObj_GetFontSize', 'FPDFTextObj_GetTextRenderMode',
  'FPDFFont_GetGlyphWidth', 'FPDFFont_GetGlyphPath', 'FPDFGlyphPath_CountGlyphSegments', 'FPDFFont_GetBaseFontName', 'FPDFFont_GetIsEmbedded',
];
export const OBJ = { TEXT: 1, PATH: 2, IMAGE: 3, SHADING: 4, FORM: 5 };
export const SEARCH = { MATCHCASE: 1, WHOLEWORD: 2 };

export class Engine {
  constructor(label, wrapped) {
    this.label = label;
    this.p = wrapped;
    this.m = wrapped.pdfium;
    if (!this.m || !this.m.HEAPU8) throw new Error(`${label}: Emscripten module unavailable`);
  }
  get heap() { return this.m.HEAPU8; }
  dv() { return new DataView(this.m.HEAPU8.buffer); }
  malloc(n) { const ptr = this.m.wasmExports.malloc(n) >>> 0; if (!ptr) throw new Error(`${this.label}: malloc(${n}) failed`); return ptr; }
  free(ptr) { if (ptr) this.m.wasmExports.free(ptr); }
  hasApi(name) { return typeof this.p[name] === 'function'; }
  hasRawExport(name) { return typeof (this.m.wasmExports && this.m.wasmExports[name]) === 'function' || typeof this.m[`_${name}`] === 'function'; }
  missingApi() { return REQUIRED_API.filter((n) => !this.hasApi(n)); }
  open(bytes) {
    const filePtr = this.malloc(bytes.length);
    this.heap.set(bytes, filePtr);
    const doc = this.p.FPDF_LoadMemDocument(filePtr, bytes.length, 0);
    if (!doc) { const err = this.p.FPDF_GetLastError(); this.free(filePtr); throw new Error(`${this.label}: document failed to load (PDFium error ${err})`); }
    return { doc, filePtr, page: 0, textPage: 0 };
  }
  loadPage(o, index) {
    o.page = this.p.FPDF_LoadPage(o.doc, index);
    if (!o.page) throw new Error(`${this.label}: page ${index} failed to load`);
    o.textPage = this.p.FPDFText_LoadPage(o.page);
    if (!o.textPage) throw new Error(`${this.label}: text page failed to load`);
  }
  closeTextPage(o) { if (o.textPage) this.p.FPDFText_ClosePage(o.textPage); o.textPage = 0; }
  close(o) {
    if (!o) return;
    try { this.closeTextPage(o); } catch (e) { /* continue */ }
    try { if (o.page) this.p.FPDF_ClosePage(o.page); } catch (e) { /* continue */ }
    try { if (o.doc) this.p.FPDF_CloseDocument(o.doc); } catch (e) { /* continue */ }
    try { this.free(o.filePtr); } catch (e) { /* continue */ }
    o.page = 0; o.doc = 0; o.filePtr = 0;
  }
  withDoc(bytes, pageIndex, fn) {
    const o = this.open(bytes);
    try { if (pageIndex !== null && pageIndex !== undefined) this.loadPage(o, pageIndex); return fn(o); } finally { this.close(o); }
  }
  f64pair(fn) {
    const ptr = this.malloc(16);
    try { if (!fn(ptr, ptr + 8)) return null; const d = this.dv(); return { x: d.getFloat64(ptr, true), y: d.getFloat64(ptr + 8, true) }; } finally { this.free(ptr); }
  }
  charOrigin(tp, i) { const r = this.f64pair((a, b) => this.p.FPDFText_GetCharOrigin(tp, i, a, b)); if (!r) throw new Error(`char origin ${i}`); return r; }
  matrix(obj) {
    const ptr = this.malloc(24);
    try { if (!this.p.FPDFPageObj_GetMatrix(obj, ptr)) throw new Error('matrix'); const d = this.dv(); return [0, 1, 2, 3, 4, 5].map((i) => d.getFloat32(ptr + i * 4, true)); } finally { this.free(ptr); }
  }
  bounds(obj) {
    const ptr = this.malloc(16);
    try { if (!this.p.FPDFPageObj_GetBounds(obj, ptr, ptr + 4, ptr + 8, ptr + 12)) return null; const d = this.dv(); return { left: d.getFloat32(ptr, true), bottom: d.getFloat32(ptr + 4, true), right: d.getFloat32(ptr + 8, true), top: d.getFloat32(ptr + 12, true) }; } finally { this.free(ptr); }
  }
  fontSize(obj) {
    const ptr = this.malloc(4);
    try { if (!this.p.FPDFTextObj_GetFontSize(obj, ptr)) throw new Error('font size'); return this.dv().getFloat32(ptr, true); } finally { this.free(ptr); }
  }
  // Unicode argument (PDFium converts with CharCodeFromUnicode). Returns null when PDFium
  // reports failure; callers compare the value with the independent font model.
  glyphWidthUnicode(font, cp) {
    const ptr = this.malloc(4);
    try { this.dv().setFloat32(ptr, Number.NaN, true); if (!this.p.FPDFFont_GetGlyphWidth(font, cp, 1000, ptr)) return null; return this.dv().getFloat32(ptr, true); } finally { this.free(ptr); }
  }
  glyphPathSegments(font, cp) {
    const path = this.p.FPDFFont_GetGlyphPath(font, cp, 1000);
    return path ? this.p.FPDFGlyphPath_CountGlyphSegments(path) : -1;
  }
  utf16Out(fn) {
    const lenPtr = this.malloc(8);
    try {
      this.dv().setUint32(lenPtr, 0, true);
      fn(0, 0, lenPtr);
      const n = this.dv().getUint32(lenPtr, true);
      if (!n || n > 1 << 20) return '';
      const buf = this.malloc(n);
      try { fn(buf, n, lenPtr); const d = this.dv(); let s = ''; for (let i = 0; i + 1 < n; i += 2) { const u = d.getUint16(buf + i, true); if (!u) break; s += String.fromCharCode(u); } return s; } finally { this.free(buf); }
    } finally { this.free(lenPtr); }
  }
  marks(obj) {
    const n = this.p.FPDFPageObj_CountMarks(obj);
    const out = [];
    for (let i = 0; i < n; i++) {
      const mk = this.p.FPDFPageObj_GetMark(obj, i);
      const name = this.utf16Out((b, l, o) => this.p.FPDFPageObjMark_GetName(mk, b, l, o));
      const keys = [];
      const np = this.p.FPDFPageObjMark_CountParams(mk);
      for (let k = 0; k < np; k++) keys.push(this.utf16Out((b, l, o) => this.p.FPDFPageObjMark_GetParamKey(mk, k, b, l, o)));
      out.push({ name, keys });
    }
    return out;
  }
  clipPaths(obj) { const c = this.p.FPDFPageObj_GetClipPath(obj); return c ? this.p.FPDFClipPath_CountPaths(c) : 0; }
  hitTest(tp, x, y, tol = 2) { return this.p.FPDFText_GetCharIndexAtPos(tp, x, y, tol, tol); }
  objects(page) { return [...Array(this.p.FPDFPage_CountObjects(page)).keys()].map((i) => this.p.FPDFPage_GetObject(page, i)); }
  census(page) {
    const c = { total: 0, text: 0, path: 0, image: 0, shading: 0, form: 0, other: 0 };
    const names = { 1: 'text', 2: 'path', 3: 'image', 4: 'shading', 5: 'form' };
    for (const o of this.objects(page)) { c.total++; c[names[this.p.FPDFPageObj_GetType(o)] || 'other']++; }
    return c;
  }
  // Characters grouped by text object, in text-page order, with generated flags.
  // PDFium's text page is indexed in UTF-16 units: an astral character occupies two
  // consecutive indices (high and low surrogate). Everything above this wrapper works
  // on glyph entries instead: { gi, unit, units, cp, generated, obj }.
  groups(tp) {
    const n = this.p.FPDFText_CountChars(tp);
    const map = new Map();
    const list = [];
    const chars = [];
    for (let i = 0; i < n; i++) {
      const obj = this.p.FPDFText_GetTextObject(tp, i);
      let cp = this.p.FPDFText_GetUnicode(tp, i) >>> 0;
      const generated = this.p.FPDFText_IsGenerated(tp, i) === 1;
      let units = 1;
      if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < n) {
        const lo = this.p.FPDFText_GetUnicode(tp, i + 1) >>> 0;
        if (lo >= 0xdc00 && lo <= 0xdfff && this.p.FPDFText_GetTextObject(tp, i + 1) === obj) { cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00); units = 2; }
      }
      const c = { gi: chars.length, unit: i, units, obj, cp, generated };
      chars.push(c);
      i += units - 1;
      if (!obj) continue;
      let g = map.get(obj);
      if (!g) { g = { obj, text: '', realText: '', indices: [], real: [] }; map.set(obj, g); list.push(g); }
      const ch = cp && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '';
      g.indices.push(c.gi);
      g.text += ch;
      if (!generated) { g.real.push(c.gi); g.realText += ch; }
    }
    return { list, map, chars };
  }
  pageText(tp) {
    let s = '';
    const n = this.p.FPDFText_CountChars(tp);
    for (let i = 0; i < n; i++) { const cp = this.p.FPDFText_GetUnicode(tp, i) >>> 0; if (cp && cp <= 0x10ffff) s += String.fromCodePoint(cp); }
    return s;
  }
  search(tp, needle, flags) {
    const units = [];
    for (const ch of needle) { const cp = ch.codePointAt(0); if (cp > 0xffff) { units.push(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)); } else units.push(cp); }
    const ptr = this.malloc((units.length + 1) * 2);
    let h = 0;
    try {
      const d = this.dv();
      units.forEach((u, i) => d.setUint16(ptr + i * 2, u, true));
      d.setUint16(ptr + units.length * 2, 0, true);
      h = this.p.FPDFText_FindStart(tp, ptr, flags, 0);
      if (!h) return [];
      const out = [];
      while (out.length < 256 && this.p.FPDFText_FindNext(h)) out.push([this.p.FPDFText_GetSchResultIndex(h), this.p.FPDFText_GetSchCount(h)]);
      return out;
    } finally { if (h) this.p.FPDFText_FindClose(h); this.free(ptr); }
  }
  setCharcodes(obj, codes) {
    const ptr = this.malloc(Math.max(4, codes.length * 4));
    try { const d = this.dv(); codes.forEach((c, i) => d.setUint32(ptr + i * 4, c, true)); return !!this.p.FPDFText_SetCharcodes(obj, ptr, codes.length); } finally { this.free(ptr); }
  }
  // Real Run #10 API facts (tests/node/setpositions-api.test.mjs): count must equal
  // glyphs - 1, count 0 is rejected even for a one-glyph object, NaN/Infinity are
  // rejected, decreasing or negative positions are ACCEPTED (callers must check).
  setPositions(obj, positions) {
    if (!positions.length) throw new Error('setPositions: no positions (one-glyph objects must skip this call)');
    if (!positions.every(Number.isFinite)) throw new Error('setPositions: non-finite position');
    const ptr = this.malloc(positions.length * 4);
    try { const d = this.dv(); positions.forEach((v, i) => d.setFloat32(ptr + i * 4, v, true)); return !!this.p.FPDFText_SetPositions(obj, ptr, positions.length); } finally { this.free(ptr); }
  }
  saveNoIncremental(doc) {
    const chunks = [];
    let cb = 0;
    let writer = 0;
    try {
      cb = this.m.addFunction((_s, dataPtr, size) => { const p0 = dataPtr >>> 0; chunks.push(this.heap.slice(p0, p0 + (size >>> 0))); return 1; }, 'iiii');
      writer = this.malloc(8);
      const d = this.dv();
      d.setInt32(writer, 1, true);
      d.setUint32(writer + 4, cb >>> 0, true);
      if (!this.p.FPDF_SaveAsCopy(doc, writer, 2)) throw new Error('FPDF_SaveAsCopy failed');
    } finally {
      if (writer) this.free(writer);
      if (cb) { try { this.m.removeFunction(cb); } catch (e) { /* ignore */ } }
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    if (!total) throw new Error('save produced zero bytes');
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }
}

// Instantiates engine glue with exactly the given wasm bytes (browser or Node).
export async function instantiateEngine(label, init, wasmBytes) {
  const rec = { hookCalls: 0, fromVerifiedBytes: false };
  let hookError = null;
  const wrapped = await init({
    wasmBinary: wasmBytes.slice(),
    instantiateWasm(imports, receive) {
      rec.hookCalls++;
      WebAssembly.instantiate(wasmBytes, imports).then((r) => { rec.fromVerifiedBytes = true; receive(r.instance, r.module); }).catch((e) => { hookError = e; });
      return {};
    },
    locateFile: () => '/__te-no-wasm-fallback__/pdfium.wasm',
  });
  if (hookError) throw hookError;
  if (typeof wrapped.PDFiumExt_Init === 'function') wrapped.PDFiumExt_Init();
  return { engine: new Engine(label, wrapped), ...rec };
}

// Browser: fetch, hash and only then execute. Refuses unverified engine code.
export async function loadVerifiedEngine({ base, label, expected, nonce }) {
  const rec = { label, base, ok: false, problems: [], wasmSha256: '', wasmBytes: 0, indexSha256: '', indexSha256After: '', hookCalls: 0, fromVerifiedBytes: false, engine: null, wasmUrl: '', jsUrl: '' };
  const tag = `${label}-${nonce}`;
  rec.wasmUrl = new URL(`${base}pdfium.wasm?te=${tag}`, location.href).href;
  rec.jsUrl = new URL(`${base}index.js?te=${tag}`, location.href).href;
  const get = async (u) => { const r = await fetch(u, { cache: 'no-store', credentials: 'same-origin', redirect: 'error' }); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return new Uint8Array(await r.arrayBuffer()); };
  try {
    const wasm = await get(rec.wasmUrl);
    rec.wasmBytes = wasm.length;
    rec.wasmSha256 = await sha256Hex(wasm);
    const js = await get(rec.jsUrl);
    rec.indexSha256 = await sha256Hex(js);
    if (expected.wasmSha256 && rec.wasmSha256 !== expected.wasmSha256) rec.problems.push(`pdfium.wasm SHA-256 ${rec.wasmSha256}`);
    if (expected.wasmBytes && rec.wasmBytes !== expected.wasmBytes) rec.problems.push(`pdfium.wasm size ${rec.wasmBytes}`);
    if (expected.indexJsSha256 && rec.indexSha256 !== expected.indexJsSha256) rec.problems.push(`index.js SHA-256 ${rec.indexSha256}`);
    if (rec.problems.length) return rec;
    const mod = await import(rec.jsUrl);
    rec.indexSha256After = await sha256Hex(await get(rec.jsUrl));
    if (rec.indexSha256After !== rec.indexSha256) { rec.problems.push('index.js changed during import'); return rec; }
    const r = await instantiateEngine(label, mod.init || mod.default, wasm);
    Object.assign(rec, { engine: r.engine, hookCalls: r.hookCalls, fromVerifiedBytes: r.fromVerifiedBytes });
    if (r.hookCalls !== 1 || !r.fromVerifiedBytes) rec.problems.push('engine not instantiated from the verified bytes');
    rec.ok = rec.problems.length === 0;
  } catch (e) {
    rec.problems.push(String(e && e.message ? e.message : e));
  }
  return rec;
}
