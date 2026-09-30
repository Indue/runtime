// NoblePDF True Edit Phase 8 V2 lab: one-fixture live SetPositions proof.
// Lab only. Never loads user PDFs. Never writes to the server.
// Differences from V1 are listed in CHANGELOG-PHASE8-V2.txt in the release package.
import { layoutReplacement, semanticGapLint, advance } from './phase8-layout.mjs?v=1';
import * as V from './phase8-verify.mjs?v=1';

const PAGE_VERSION = 'phase8-v2.1.1';

// ------------------------------------------------------------------ pinned identities
// Run #10 (Indue/runtime, branch noblepdf-setpositions-claude-audit, commit
// d492c759b1bfe1bdbc5b3edb3c42dfa173d2d1ae, run 36436331010, artifact 10976034795).
const RUN10 = Object.freeze({
  wasmSha256: 'c4f54bda9bc730c0aeb6579254f0431fa95886478cd19967555be6ea2a35ce11',
  wasmBytes: 4648757,
  indexJsSha256: '2af28659a83b5691ed1193bd0819a6a1339036fb08505826d561c7541762baf2',
});
// Stock engine hashes are recorded on every run. They are asserted only after you
// pin them here from a trusted deployment record (leave null to record only).
// V2.1.1: stock engine pinned to the npm @embedpdf/pdfium 2.15.1 dist files served live on 2026-09-29.
const STOCK_PINNED = Object.freeze({ wasmSha256: '5e4cd023c3dad4a895b3571ca573d3fc51bac6de48360d95283134385b954eaa', indexJsSha256: '0e31ce6c207b371384392242c560b5e88d90221843dfbbaebf3f5cff1e22f2e0' });
// Informational references from npm @embedpdf/pdfium@2.15.1 and pdfjs-dist@3.11.174.
const NPM_REFERENCE = Object.freeze({
  stockWasmSha256: '5e4cd023c3dad4a895b3571ca573d3fc51bac6de48360d95283134385b954eaa',
  stockIndexJsSha256: '0e31ce6c207b371384392242c560b5e88d90221843dfbbaebf3f5cff1e22f2e0',
  stockIndexBrowserJsSha256: '2b8b6db33451f2599385697fe5bf634abdfbb093fec497febd7fb60b5aeea8ca',
  pdfjsLibSha256: '5b5799e6f8c680663207ac5b42ee14eed2a406fa7af48f50c154f0c0b1566946',
  pdfjsWorkerSha256: 'feabdf309770ed24bba31a5467836cdc8cf639c705af27d52b585b041bb8527b',
});
const FIXTURES = Object.freeze({
  before: { url: './fixtures-phase8/pure-tj-before.pdf?v=1', sha256: '12f6055ccf4221a931cb4b8e48a16ba9150a782b229b6ee76adec3e16acab305' },
  reference: { url: './fixtures-phase8/pure-tj-reference.pdf?v=1', sha256: '17202332e5b3531f568ea5166fe687368bca9dc5ef732d305876c3a4ed8882f9' },
});
const LAYOUT_MODULE = Object.freeze({ url: './phase8-layout.mjs?v=1', sha256: '01476e596e146ec3cbe62516ed51333bfa4c7fb02ef288e8c7e8b84cb931ce9a' });
const PDFJS = Object.freeze({ version: '3.11.174', lib: '/vendor/pdfjs-3.11.174/pdf.min.js', worker: '/vendor/pdfjs-3.11.174/pdf.worker.min.js' });
const STOCK_BASE = '/vendor/pdfium-2.15.1/';
const PATCHED_BASE = '/vendor/pdfium-2.15.1-setpositions/';
const WASM_FALLBACK_SENTINEL = '/__phase8-v2-no-wasm-fallback__/pdfium.wasm';

// ------------------------------------------------------------------ fixture facts
// These constants describe the hash-pinned fixture only. They are why the lab may
// hardcode Tc = 0, Tw = 0, a simple font and ASCII code points.
const OLD_TEXT = 'WAVESKERN';
const NEW_TEXT = 'TOKYOLAKE';
const NEIGHBOUR_TEXT = 'Neighbouring context line must not move';
const FIXTURE_FONT = 'Helvetica';
const FIXTURE_SIZE = 18;
const FIXTURE_MATRIX = [1, 0, 0, 1, 72, 650];
const BEFORE_TJ_ADJUST = Object.freeze({ 0: 120, 1: -80, 2: 200, 3: -40, 4: 60 });
// Adobe Helvetica AFM advance widths (1/1000 em), keyed by code point.
const HELVETICA_AFM = Object.freeze({ 87: 944, 65: 667, 86: 667, 69: 667, 83: 667, 75: 667, 82: 722, 78: 722, 84: 611, 79: 778, 89: 667, 76: 556 });
const EDIT_BAND_PDF_Y = [636, 676];
const POS_TOL_PT = 0.01;
const PIXEL_TOL = 8;
const LEGACY_MIN_NATURAL_DELTA_PT = 1.0;

const FPDF_NO_INCREMENTAL = 1 << 1;
const FPDF_MATCHCASE = 0x1;
const FPDF_MATCHWHOLEWORD = 0x2;
const MODIFY_PERMISSION_BIT = 0x8;
const FPDF_PAGEOBJ_TEXT = 1;
const OBJ_TYPES = { 1: 'text', 2: 'path', 3: 'image', 4: 'shading', 5: 'form' };

const REQUIRED_API = [
  'FPDF_LoadMemDocument', 'FPDF_CloseDocument', 'FPDF_GetPageCount', 'FPDF_LoadPage', 'FPDF_ClosePage', 'FPDF_GetLastError',
  'FPDF_GetDocPermissions', 'FPDF_GetSignatureCount', 'FPDF_SaveAsCopy', 'FPDFText_LoadPage', 'FPDFText_ClosePage',
  'FPDFText_CountChars', 'FPDFText_GetUnicode', 'FPDFText_GetTextObject', 'FPDFText_IsGenerated', 'FPDFText_GetCharOrigin',
  'FPDFText_FindStart', 'FPDFText_FindNext', 'FPDFText_FindClose', 'FPDFText_GetSchResultIndex', 'FPDFText_GetSchCount',
  'FPDFText_SetCharcodes', 'FPDFPage_CountObjects', 'FPDFPage_GetObject', 'FPDFPage_GenerateContent', 'FPDFPage_GetAnnotCount',
  'FPDFPageObj_GetType', 'FPDFPageObj_GetMatrix', 'FPDFPageObj_CountMarks', 'FPDFTextObj_GetFont', 'FPDFTextObj_GetFontSize',
  'FPDFTextObj_GetTextRenderMode', 'FPDFFont_GetGlyphWidth', 'FPDFFont_GetBaseFontName', 'FPDFFont_GetIsEmbedded',
];

const $ = (id) => document.getElementById(id);
const state = {
  nonce: makeNonce(),
  engines: { patched: null, stock: null },
  fixtures: null,
  pdfjsWorker: null,
  pdfjsInfo: null,
  layoutInfo: null,
  preflightRows: [],
  ready: false,
  busy: false,
  resultBlobUrl: null,
};

// ------------------------------------------------------------------ small utilities
function makeNonce() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return V.toHex(b);
}
function row(id, group, name, pass, evidence, gated = true) {
  return { id, group, name, pass: pass === true, evidence: String(evidence ?? ''), gated };
}
function info(id, group, name, evidence) { return row(id, group, name, true, evidence, false); }
const pt = (v) => (Number.isFinite(v) ? `${v.toExponential(3)} pt` : String(v));
const short = (h) => (h ? `${h.slice(0, 12)}...${h.slice(-4)}` : 'n/a');
const js = (v) => JSON.stringify(v);
function sameMatches(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((m, i) => m[0] === b[i][0] && m[1] === b[i][1]);
}
function codePointsAscii(text) {
  const cps = Array.from(text, (ch) => ch.codePointAt(0));
  if (cps.length !== text.length || cps.some((c) => c < 0x20 || c > 0x7e)) {
    throw new Error(`Fixture-only lab: ${js(text)} is not printable ASCII, so UTF-16 index, code point and WinAnsi code would not coincide`);
  }
  return cps;
}
async function withTimeout(promise, ms, label, detail) {
  let timer = 0;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms${detail && detail() ? `: ${detail()}` : ''}`)), ms);
  });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}
async function fetchBytes(url) {
  const r = await fetch(url, { cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
function inversePoint(m, p) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-8) throw new Error('Degenerate text matrix');
  const x = p.x - e;
  const y = p.y - f;
  return { x: (d * x - c * y) / det, y: (-b * x + a * y) / det };
}
function applyMatrix(m, x, y = 0) { return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }; }

// ------------------------------------------------------------------ PDFium engine wrapper
class Engine {
  constructor(label, wrapped) {
    this.label = label;
    this.p = wrapped;
    this.m = wrapped.pdfium;
    if (!this.m || !this.m.HEAPU8) throw new Error(`${label}: Emscripten module or HEAPU8 unavailable`);
  }
  get heap() { return this.m.HEAPU8; }
  dv() { return new DataView(this.m.HEAPU8.buffer); }
  malloc(n) {
    const fn = (this.m.wasmExports && this.m.wasmExports.malloc) || this.m._malloc;
    if (typeof fn !== 'function') throw new Error(`${this.label}: malloc unavailable`);
    const ptr = fn(n) >>> 0;
    if (!ptr) throw new Error(`${this.label}: malloc(${n}) returned NULL`);
    return ptr;
  }
  free(ptr) {
    if (!ptr) return;
    const fn = (this.m.wasmExports && this.m.wasmExports.free) || this.m._free;
    if (typeof fn === 'function') fn(ptr);
  }
  hasApi(name) { return typeof this.p[name] === 'function'; }
  hasRawExport(name) {
    return typeof (this.m.wasmExports && this.m.wasmExports[name]) === 'function' || typeof this.m[`_${name}`] === 'function';
  }
  open(bytes) {
    const filePtr = this.malloc(bytes.length);
    this.heap.set(bytes, filePtr);
    const doc = this.p.FPDF_LoadMemDocument(filePtr, bytes.length, 0);
    if (!doc) {
      const err = this.p.FPDF_GetLastError();
      this.free(filePtr);
      throw new Error(`${this.label}: FPDF_LoadMemDocument failed (error ${err})`);
    }
    return { doc, filePtr, page: 0, textPage: 0 };
  }
  close(o) {
    if (!o) return;
    try { if (o.textPage) this.p.FPDFText_ClosePage(o.textPage); } catch (e) { /* keep closing */ }
    try { if (o.page) this.p.FPDF_ClosePage(o.page); } catch (e) { /* keep closing */ }
    try { if (o.doc) this.p.FPDF_CloseDocument(o.doc); } catch (e) { /* keep closing */ }
    try { this.free(o.filePtr); } catch (e) { /* keep closing */ }
    o.textPage = 0; o.page = 0; o.doc = 0; o.filePtr = 0;
  }
  loadPage(o) {
    o.page = this.p.FPDF_LoadPage(o.doc, 0);
    if (!o.page) throw new Error(`${this.label}: FPDF_LoadPage(0) returned NULL`);
    o.textPage = this.p.FPDFText_LoadPage(o.page);
    if (!o.textPage) throw new Error(`${this.label}: FPDFText_LoadPage returned NULL`);
  }
  charOrigin(textPage, index) {
    const ptr = this.malloc(16);
    try {
      if (!this.p.FPDFText_GetCharOrigin(textPage, index, ptr, ptr + 8)) throw new Error(`GetCharOrigin failed at ${index}`);
      const d = this.dv();
      return { x: d.getFloat64(ptr, true), y: d.getFloat64(ptr + 8, true) };
    } finally { this.free(ptr); }
  }
  matrix(obj) {
    const ptr = this.malloc(24);
    try {
      if (!this.p.FPDFPageObj_GetMatrix(obj, ptr)) throw new Error('FPDFPageObj_GetMatrix failed');
      const d = this.dv();
      return Array.from({ length: 6 }, (_, i) => d.getFloat32(ptr + i * 4, true));
    } finally { this.free(ptr); }
  }
  fontSize(obj) {
    const ptr = this.malloc(4);
    try {
      if (!this.p.FPDFTextObj_GetFontSize(obj, ptr)) throw new Error('FPDFTextObj_GetFontSize failed');
      return this.dv().getFloat32(ptr, true);
    } finally { this.free(ptr); }
  }
  // PDFium converts this argument with CharCodeFromUnicode(): it is a Unicode code
  // point, not a PDF charcode, and PDFium returns TRUE with a fallback width when the
  // font cannot map it. Callers must validate widths independently.
  glyphWidthUnicode(font, codePoint) {
    const ptr = this.malloc(4);
    try {
      this.dv().setFloat32(ptr, Number.NaN, true);
      if (!this.p.FPDFFont_GetGlyphWidth(font, codePoint, 1000, ptr)) throw new Error(`Glyph width unavailable for U+${codePoint.toString(16)}`);
      return this.dv().getFloat32(ptr, true);
    } finally { this.free(ptr); }
  }
  baseFontName(font) {
    const len = this.p.FPDFFont_GetBaseFontName(font, 0, 0);
    if (!len || len > 4096) return '';
    const ptr = this.malloc(len);
    try {
      this.p.FPDFFont_GetBaseFontName(font, ptr, len);
      return V.latin1(this.heap.slice(ptr, ptr + len - 1));
    } finally { this.free(ptr); }
  }
  pageText(textPage) {
    const n = this.p.FPDFText_CountChars(textPage);
    let s = '';
    for (let i = 0; i < n; i++) {
      const cp = this.p.FPDFText_GetUnicode(textPage, i) >>> 0;
      if (cp) s += cp <= 0x10ffff ? String.fromCodePoint(cp) : '\ufffd';
    }
    return s;
  }
  groups(textPage) {
    const n = this.p.FPDFText_CountChars(textPage);
    if (n < 0) throw new Error('FPDFText_CountChars failed');
    const map = new Map();
    const list = [];
    for (let i = 0; i < n; i++) {
      const obj = this.p.FPDFText_GetTextObject(textPage, i);
      if (!obj) continue;
      const cp = this.p.FPDFText_GetUnicode(textPage, i) >>> 0;
      const generated = this.p.FPDFText_IsGenerated(textPage, i) === 1;
      let g = map.get(obj);
      if (!g) { g = { obj, text: '', realText: '', indices: [], realIndices: [] }; map.set(obj, g); list.push(g); }
      const ch = cp ? (cp <= 0x10ffff ? String.fromCodePoint(cp) : '\ufffd') : '';
      g.indices.push(i);
      g.text += ch;
      if (!generated) { g.realIndices.push(i); g.realText += ch; }
    }
    return list;
  }
  search(textPage, needle, flags) {
    const ptr = this.malloc((needle.length + 1) * 2);
    let handle = 0;
    try {
      const d = this.dv();
      for (let i = 0; i < needle.length; i++) d.setUint16(ptr + i * 2, needle.charCodeAt(i), true);
      d.setUint16(ptr + needle.length * 2, 0, true);
      handle = this.p.FPDFText_FindStart(textPage, ptr, flags, 0);
      if (!handle) return [];
      const out = [];
      while (out.length < 64 && this.p.FPDFText_FindNext(handle)) {
        out.push([this.p.FPDFText_GetSchResultIndex(handle), this.p.FPDFText_GetSchCount(handle)]);
      }
      return out;
    } finally {
      if (handle) this.p.FPDFText_FindClose(handle);
      this.free(ptr);
    }
  }
  census(page) {
    const n = this.p.FPDFPage_CountObjects(page);
    const c = { total: n, text: 0, path: 0, image: 0, shading: 0, form: 0, other: 0 };
    for (let i = 0; i < n; i++) {
      const t = OBJ_TYPES[this.p.FPDFPageObj_GetType(this.p.FPDFPage_GetObject(page, i))] || 'other';
      c[t]++;
    }
    return c;
  }
  pageObjectIndex(page, obj) {
    const n = this.p.FPDFPage_CountObjects(page);
    for (let i = 0; i < n; i++) if (this.p.FPDFPage_GetObject(page, i) === obj) return i;
    return -1;
  }
  setCharcodes(obj, codes) {
    const ptr = this.malloc(Math.max(4, codes.length * 4));
    try {
      const d = this.dv();
      codes.forEach((c, i) => d.setUint32(ptr + i * 4, c, true));
      return !!this.p.FPDFText_SetCharcodes(obj, ptr, codes.length);
    } finally { this.free(ptr); }
  }
  setPositions(obj, positions) {
    if (!positions.every(Number.isFinite)) throw new Error('Refusing non-finite positions');
    const ptr = positions.length ? this.malloc(positions.length * 4) : 0;
    try {
      if (positions.length) {
        const d = this.dv();
        positions.forEach((v, i) => d.setFloat32(ptr + i * 4, v, true));
      }
      return !!this.p.FPDFText_SetPositions(obj, ptr, positions.length);
    } finally { this.free(ptr); }
  }
  // FPDF_FILEWRITE on wasm32: { int version; int (*WriteBlock)(FPDF_FILEWRITE*, const void*, unsigned long); }
  saveNoIncremental(doc) {
    const addFunction = this.m.addFunction;
    const removeFunction = this.m.removeFunction;
    if (typeof addFunction !== 'function' || typeof removeFunction !== 'function') throw new Error('Emscripten addFunction/removeFunction unavailable');
    const chunks = [];
    let cb = 0;
    let writer = 0;
    try {
      cb = addFunction((_self, dataPtr, size) => {
        const p0 = dataPtr >>> 0;
        const n = size >>> 0;
        chunks.push(this.heap.slice(p0, p0 + n));
        return 1;
      }, 'iiii');
      writer = this.malloc(8);
      const d = this.dv();
      d.setInt32(writer, 1, true);
      d.setUint32(writer + 4, cb >>> 0, true);
      if (!this.p.FPDF_SaveAsCopy(doc, writer, FPDF_NO_INCREMENTAL)) throw new Error('FPDF_SaveAsCopy returned false');
    } finally {
      if (writer) this.free(writer);
      if (cb) { try { removeFunction(cb); } catch (e) { /* table slot already gone */ } }
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    if (!total) throw new Error('Save produced zero bytes');
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }
}

// ------------------------------------------------------------------ verified engine loading
async function loadVerifiedEngine({ base, label, expected }) {
  const tag = `${label}-${state.nonce}`;
  const wasmUrl = new URL(`${base}pdfium.wasm?phase8v2=${tag}`, location.href).href;
  const jsUrl = new URL(`${base}index.js?phase8v2=${tag}`, location.href).href;
  const rec = {
    label, base, wasmUrl, jsUrl, wasmBytes: 0, wasmSha256: '', indexBytes: 0, indexSha256: '', indexSha256After: '',
    identityChecked: !!expected, identityOk: null, identityNote: '', importEntrySize: null,
    hookCalls: 0, instantiatedFromVerifiedBytes: false, engine: null, error: '',
  };
  try {
    const wasm = await fetchBytes(wasmUrl);
    rec.wasmBytes = wasm.length;
    rec.wasmSha256 = await V.sha256Hex(wasm);
    const js1 = await fetchBytes(jsUrl);
    rec.indexBytes = js1.length;
    rec.indexSha256 = await V.sha256Hex(js1);
    if (expected) {
      const problems = [];
      if (expected.wasmSha256 && rec.wasmSha256 !== expected.wasmSha256) problems.push(`pdfium.wasm SHA-256 ${rec.wasmSha256} is not ${expected.wasmSha256}`);
      if (expected.wasmBytes && rec.wasmBytes !== expected.wasmBytes) problems.push(`pdfium.wasm is ${rec.wasmBytes} B, expected ${expected.wasmBytes} B`);
      if (expected.indexJsSha256 && rec.indexSha256 !== expected.indexJsSha256) problems.push(`index.js SHA-256 ${rec.indexSha256} is not ${expected.indexJsSha256}`);
      rec.identityOk = problems.length === 0;
      rec.identityNote = problems.join('; ');
      if (!rec.identityOk) return rec; // never execute engine code that failed identity
    }
    const mod = await import(jsUrl);
    rec.indexSha256After = await V.sha256Hex(await fetchBytes(jsUrl));
    const entry = performance.getEntriesByName(jsUrl).find((e) => e.initiatorType !== 'fetch');
    rec.importEntrySize = entry && entry.decodedBodySize > 0 ? entry.decodedBodySize : null;
    const init = mod.init || mod.default;
    if (typeof init !== 'function') throw new Error(`${base}index.js does not export init()`);
    let hookError = null;
    const overrides = {
      wasmBinary: wasm.slice(),
      // Instantiate exactly the bytes that were hashed above. A glue that ignores this
      // hook is detected (hookCalls stays 0) and blocks the lab decision.
      instantiateWasm(imports, receiveInstance) {
        rec.hookCalls++;
        WebAssembly.instantiate(wasm, imports)
          .then((r) => { rec.instantiatedFromVerifiedBytes = true; receiveInstance(r.instance, r.module); })
          .catch((e) => { hookError = e; });
        return {};
      },
      // Any attempt to fetch a wasm file by URL goes to a same-origin path that does not exist.
      locateFile: () => new URL(WASM_FALLBACK_SENTINEL, location.href).href,
    };
    const wrapped = await withTimeout(init(overrides), 90000, `${label} engine init`, () => (hookError ? String(hookError) : ''));
    if (typeof wrapped.PDFiumExt_Init === 'function') wrapped.PDFiumExt_Init();
    rec.engine = new Engine(label, wrapped);
  } catch (e) {
    rec.error = String(e && e.message ? e.message : e);
  }
  return rec;
}

function wasmRequestAudit(allowedUrls) {
  const unexpected = [];
  for (const e of performance.getEntriesByType('resource')) {
    let u = null;
    try { u = new URL(e.name, location.href); } catch (err) { continue; }
    const isWasm = /\.wasm$/i.test(u.pathname);
    if ((isWasm && !allowedUrls.has(u.href)) || u.pathname.startsWith('/__phase8-v2-no-wasm-fallback__')) unexpected.push(u.href);
  }
  return unexpected;
}

// ------------------------------------------------------------------ environment audit
function environmentAudit() {
  const out = { pass: true, fail: [], warn: [], lines: [] };
  const guard = window.__phase8Guard;
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  if (!guard || !Array.isArray(guard.violations)) out.fail.push('CSP recorder (phase8-csp-guard.js) did not run');
  if (!meta) out.fail.push('CSP meta element missing');
  const here = new URL(import.meta.url);
  const expected = new Set([
    new URL('phase8-csp-guard.js', here).href.split('?')[0],
    new URL('phase8-v2.js', here).href.split('?')[0],
    new URL(PDFJS.lib, location.href).href,
    new URL(PDFJS.worker, location.href).href,
  ]);
  const violations = guard ? guard.violations.slice() : [];
  for (const s of document.scripts) {
    const src = s.src ? new URL(s.src, location.href) : null;
    const key = src ? `${src.origin}${src.pathname}` : '';
    if (src && expected.has(key)) continue;
    const beforeCsp = meta ? !!(s.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING) : true;
    const label = src ? src.href : `inline script (${(s.textContent || '').trim().slice(0, 40)})`;
    if (beforeCsp) out.fail.push(`unexpected script before the CSP element executed without the policy: ${label}`);
    else if (!src || src.origin !== location.origin) out.warn.push(`unexpected script after the CSP element (the policy blocks it): ${label}`);
    else out.fail.push(`unexpected same-origin script ran: ${label}`);
  }
  const resources = performance.getEntriesByType('resource').map((e) => {
    let origin = '(invalid)';
    try { origin = new URL(e.name, location.href).origin; } catch (err) { /* keep invalid */ }
    return { name: e.name, origin, type: e.initiatorType || '' };
  });
  // Chromium also lists CSP-blocked requests in Resource Timing, so an entry alone does
  // not prove a load. A cross-origin entry counts as blocked only when the recorder saw a
  // matching CSP violation; anything else is treated as loaded and fails the audit.
  const matchesViolation = (url) => violations.some((v) => {
    if (!v.blocked) return false;
    if (v.blocked === url) return true;
    try {
      const b = new URL(v.blocked, location.href);
      const u = new URL(url, location.href);
      return b.origin === u.origin && (b.pathname === u.pathname || b.pathname === '/');
    } catch (err) { return false; }
  });
  const external = resources.filter((r) => r.origin !== location.origin);
  const blockedExternal = external.filter((r) => matchesViolation(r.name));
  for (const r of external) {
    if (blockedExternal.includes(r)) out.warn.push(`cross-origin request blocked by CSP (Resource Timing still lists it): ${r.name}`);
    else out.fail.push(`cross-origin resource loaded (no matching CSP violation): ${r.name}`);
  }
  for (const v of violations) out.warn.push(`blocked by CSP: ${v.directive} ${v.blocked || '(inline)'}${v.source ? ` from ${v.source}` : ''}`);
  const sw = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  out.pass = out.fail.length === 0;
  out.serviceWorker = sw;
  out.violations = violations.length;
  out.lines = [
    `Origin: ${location.origin}`,
    `Resource Timing entries: ${resources.length} (cross-origin: ${external.length}, of which blocked by CSP: ${blockedExternal.length})`,
    `CSP-blocked attempts recorded: ${violations.length}`,
    `Service worker controlling this page: ${sw ? 'YES (hash gates still verify every engine and fixture byte)' : 'no'}`,
    `Verdict: ${out.pass ? 'PASS - nothing cross-origin loaded and no unexpected script ran' : 'FAIL - lab decision stays blocked'}`,
    ...out.fail.map((x) => `FAIL  ${x}`),
    ...out.warn.map((x) => `WARN  ${x}`),
    '',
    ...resources.map((r) => `${r.origin === location.origin ? 'LOCAL   ' : 'EXTERNAL'} ${r.type.padEnd(14)} ${r.name}`),
  ];
  return out;
}
function showEnvironment() {
  const env = environmentAudit();
  $('networkResults').textContent = env.lines.join('\n');
  $('privacyStatus').className = `status-line ${env.pass ? 'pass' : 'fail'}`;
  $('privacyStatus').textContent = env.pass
    ? `PASS - no cross-origin resource loaded and no unexpected script ran${env.violations ? ` (${env.violations} CSP-blocked attempt(s) recorded)` : ''}. Fixture-only lab.`
    : `FAIL - ${env.fail.length} integrity problem(s). The lab decision stays blocked. Fixture-only lab.`;
  return env;
}

// ------------------------------------------------------------------ PDF.js helpers
function pdfjsDocument(bytes) {
  return pdfjsLib.getDocument({ data: bytes.slice(), worker: state.pdfjsWorker, isEvalSupported: false, verbosity: 0 }).promise;
}
async function renderFull(page, vp, canvas) {
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
async function renderBand(page, vp, top, bottom) {
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width);
  c.height = bottom - top;
  const ctx = c.getContext('2d', { alpha: false, willReadFrequently: true });
  await page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, 0, -top] }).promise;
  const img = ctx.getImageData(0, 0, c.width, c.height);
  c.width = 0;
  c.height = 0;
  return img;
}
function bandRows(vp) {
  const yTop = vp.convertToViewportPoint(0, EDIT_BAND_PDF_Y[1])[1];
  const yBottom = vp.convertToViewportPoint(0, EDIT_BAND_PDF_Y[0])[1];
  return [Math.floor(Math.min(yTop, yBottom)), Math.ceil(Math.max(yTop, yBottom))];
}
async function inspectPdfjs(bytes, canvas) {
  const doc = await pdfjsDocument(bytes);
  try {
    const page = await doc.getPage(1);
    const vp2 = page.getViewport({ scale: 2 });
    const vp4 = page.getViewport({ scale: 4 });
    const full = await renderFull(page, vp2, canvas || document.createElement('canvas'));
    const rows4 = bandRows(vp4);
    const band = await renderBand(page, vp4, rows4[0], rows4[1]);
    const tc = await page.getTextContent();
    const items = tc.items.map((it) => ({ str: it.str, hasEOL: !!it.hasEOL, x: it.transform[4], y: it.transform[5], w: it.width }));
    page.cleanup();
    return { numPages: doc.numPages, full, band, rows2: bandRows(vp2), items, lines: V.pdfjsLines(tc.items) };
  } finally {
    await doc.destroy();
  }
}

// ------------------------------------------------------------------ PDFium inspection and mutation
function inspectPdfium(E, bytes) {
  const o = E.open(bytes);
  try {
    const pageCount = E.p.FPDF_GetPageCount(o.doc);
    E.loadPage(o);
    const groups = E.groups(o.textPage);
    const describe = (g) => ({
      text: g.text, realText: g.realText, count: g.indices.length, real: g.realIndices.length,
      generated: g.indices.length - g.realIndices.length, firstIndex: g.indices[0],
      objIndex: E.pageObjectIndex(o.page, g.obj), type: E.p.FPDFPageObj_GetType(g.obj),
      origins: g.realIndices.map((i) => E.charOrigin(o.textPage, i)),
    });
    const byReal = (t) => groups.filter((g) => g.realText === t).map(describe);
    return {
      pageCount,
      pageText: E.pageText(o.textPage),
      census: E.census(o.page),
      annots: E.p.FPDFPage_GetAnnotCount(o.page),
      groupTexts: groups.map((g) => g.text),
      newGroups: byReal(NEW_TEXT),
      oldGroups: byReal(OLD_TEXT),
      neighbourGroups: byReal(NEIGHBOUR_TEXT),
      searchNewExact: E.search(o.textPage, NEW_TEXT, FPDF_MATCHCASE | FPDF_MATCHWHOLEWORD),
      searchOldExact: E.search(o.textPage, OLD_TEXT, FPDF_MATCHCASE | FPDF_MATCHWHOLEWORD),
      searchNewLoose: E.search(o.textPage, NEW_TEXT, 0),
      searchOldLoose: E.search(o.textPage, OLD_TEXT, 0),
    };
  } finally {
    E.close(o);
  }
}

function snapshotTarget(E, o) {
  const matches = E.groups(o.textPage).filter((g) => g.text === OLD_TEXT && g.realText === OLD_TEXT);
  if (matches.length !== 1) throw new Error(`Expected exactly one ${OLD_TEXT} text object, found ${matches.length}`);
  const g = matches[0];
  const index = E.pageObjectIndex(o.page, g.obj);
  if (index < 0) throw new Error('Target is not a direct page object');
  const type = E.p.FPDFPageObj_GetType(g.obj);
  if (type !== FPDF_PAGEOBJ_TEXT) throw new Error(`Target page object type ${type} is not text`);
  const matrix = E.matrix(g.obj);
  const origins = g.realIndices.map((i) => E.charOrigin(o.textPage, i));
  const objectPts = origins.map((p) => inversePoint(matrix, p));
  const font = E.p.FPDFTextObj_GetFont(g.obj);
  if (!font) throw new Error('FPDFTextObj_GetFont returned NULL');
  return {
    obj: g.obj, font, index, matrix, origins,
    xs: objectPts.map((p) => p.x),
    baselineResidual: Math.max(...objectPts.map((p) => Math.abs(p.y))),
    fontSize: E.fontSize(g.obj),
    marks: E.p.FPDFPageObj_CountMarks(g.obj),
    renderMode: E.p.FPDFTextObj_GetTextRenderMode(g.obj),
    baseFont: E.baseFontName(font),
    embedded: E.p.FPDFFont_GetIsEmbedded(font),
  };
}

function mutateArm(E, bytes, mode, { useSetPositions = true } = {}) {
  const o = E.open(bytes);
  try {
    if (E.p.FPDF_GetPageCount(o.doc) !== 1) throw new Error('Fixture must have exactly one page');
    E.loadPage(o);
    const beforeCensus = E.census(o.page);
    const beforeAnnots = E.p.FPDFPage_GetAnnotCount(o.page);
    const s = snapshotTarget(E, o);
    if (s.marks !== 0) throw new Error(`Target has ${s.marks} content marks`);
    if (E.p.FPDF_GetSignatureCount(o.doc) !== 0) throw new Error('Document contains a signature');
    if (((E.p.FPDF_GetDocPermissions(o.doc) >>> 0) & MODIFY_PERMISSION_BIT) === 0) throw new Error('Document modification is not permitted');
    if (s.baselineResidual > POS_TOL_PT) throw new Error(`Object-space baseline residual ${s.baselineResidual}`);
    if (Math.abs(s.xs[0]) > 0.001) throw new Error(`First glyph is not at the object origin (x0 = ${s.xs[0]}); SetPositions offsets would be misread`);

    const oldCps = codePointsAscii(OLD_TEXT);
    const newCps = codePointsAscii(NEW_TEXT);
    // WinAnsi maps printable ASCII to itself, so for this pinned fixture the code
    // points above are also the PDF charcodes passed to SetCharcodes.
    const widths = new Map();
    const widthOf = (cp) => {
      if (!widths.has(cp)) widths.set(cp, E.glyphWidthUnicode(s.font, cp));
      return widths.get(cp);
    };
    oldCps.forEach(widthOf);
    const run = { size: s.fontSize, tc: 0, tw: 0, fontIsSimple: true };
    const layout = mode === 'legacy'
      ? { xs: s.xs.slice(0, newCps.length), prefix: 0, suffix: 0, fit: null }
      : layoutReplacement({ oldCodes: oldCps, oldXs: s.xs, newCodes: newCps, newText: NEW_TEXT, run, widthOf, fit: false });
    const lint = semanticGapLint({ xs: layout.xs, newCodes: newCps, newText: NEW_TEXT, run, widthOf });
    const natural = [s.xs[0]];
    for (let i = 0; i + 1 < newCps.length; i++) natural.push(natural[i] + advance(newCps[i], NEW_TEXT[i] === ' ', run, widthOf));
    const naturalDelta = V.maxAbsDiff(layout.xs, natural);
    const expectedPage = layout.xs.map((x) => applyMatrix(s.matrix, x, 0));

    E.p.FPDFText_ClosePage(o.textPage);
    o.textPage = 0;
    if (!E.setCharcodes(s.obj, newCps)) throw new Error('FPDFText_SetCharcodes failed');
    if (useSetPositions && !E.setPositions(s.obj, layout.xs.slice(1))) throw new Error('FPDFText_SetPositions failed');
    if (!E.p.FPDFPage_GenerateContent(o.page)) throw new Error('FPDFPage_GenerateContent failed');
    const out = E.saveNoIncremental(o.doc);
    return {
      mode, useSetPositions, bytes: out, lint, layout, natural, naturalDelta, expectedPage, beforeCensus, beforeAnnots,
      widths: Object.fromEntries(widths),
      snapshot: {
        index: s.index, matrix: s.matrix, xs: s.xs, fontSize: s.fontSize, marks: s.marks, renderMode: s.renderMode,
        baseFont: s.baseFont, embedded: s.embedded, baselineResidual: s.baselineResidual, origins: s.origins,
      },
    };
  } finally {
    E.close(o);
  }
}

async function saveEvidence(bytes, original) {
  const st = V.analyzeStructure(bytes, original);
  const streams = await V.decodeAllStreams(bytes, st.scan);
  const old = V.streamTextEvidence(st.scan, streams, OLD_TEXT);
  const masked = st.scan.masked;
  return {
    st, old,
    newBlocks: old.blocks.filter((b) => b.text === NEW_TEXT).length,
    neighbourBlocks: old.blocks.filter((b) => b.text === NEIGHBOUR_TEXT).length,
    textBlocks: old.blocks.filter((b) => b.text.length > 0).length,
    annotsKey: /\/Annots(?![A-Za-z0-9])/.test(masked),
    xobjectKey: /\/XObject(?![A-Za-z0-9])/.test(masked),
  };
}
function structureSummary(e) {
  const s = e.st;
  return `${s.bytes} B; %%EOF x${s.eofCount}${s.eofAtEnd ? ' at end' : ' NOT at end'}; startxref x${s.startxrefCount}; /Prev x${s.prevCount}; `
    + `xref ${s.xref.classic ? 'classic' : (s.xref.xrefStream ? 'stream' : 'missing')} ${js(s.xref.subsections)} in-use ${s.xref.inUse}, bad offsets ${s.xref.invalid.length}; `
    + `duplicate objects ${js(s.duplicateObjects)}; starts with original bytes ${s.startsWithOriginal ? 'YES' : 'no'}`;
}

// ------------------------------------------------------------------ UI rendering
function td(text) { const c = document.createElement('td'); c.textContent = text; return c; }
function renderGates(rows) {
  const tbody = $('gatesBody');
  tbody.replaceChildren();
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.append(td(r.id), td(r.group), td(r.name));
    const res = document.createElement('td');
    const span = document.createElement('span');
    span.className = r.gated === false ? 'gate-info' : (r.pass ? 'gate-pass' : 'gate-fail');
    span.textContent = r.gated === false ? 'INFO' : (r.pass ? 'PASS' : 'FAIL');
    res.append(span);
    tr.append(res, td(r.evidence));
    tbody.append(tr);
  }
}
function gateLines(rows) {
  return rows.map((r) => `${r.id.padEnd(4)} ${(r.gated === false ? 'INFO' : (r.pass ? 'PASS' : 'FAIL')).padEnd(4)} ${r.name} :: ${r.evidence}`);
}
function setBusy(b) {
  state.busy = b;
  $('runPreflight').disabled = b;
  $('runProof').disabled = b || !state.ready;
}
function revokeResult() {
  if (state.resultBlobUrl) URL.revokeObjectURL(state.resultBlobUrl);
  state.resultBlobUrl = null;
  $('downloadResult').disabled = true;
}

// ------------------------------------------------------------------ preflight
async function runPreflight() {
  if (state.busy) return;
  setBusy(true);
  state.ready = false;
  $('readyStatus').textContent = 'NO';
  $('preflightReport').textContent = 'Running V2 preflight...';
  const rows = [];
  const notes = [];
  try {
    performance.setResourceTimingBufferSize(2000);
    // P01 page, module and recorder versions
    const handshake = document.documentElement.dataset.phase8 === 'v2';
    const guard = window.__phase8Guard;
    rows.push(row('P01', 'Preflight', 'V2 page, module and CSP recorder versions agree', handshake && !!guard,
      `html data-phase8=${js(document.documentElement.dataset.phase8)}; module ${PAGE_VERSION}; verify ${V.VERIFY_VERSION}; recorder ${guard ? guard.version : 'MISSING'}`));

    // P02 PDF.js API version, worker start and version agreement
    let pdfjsOk = false;
    let pdfjsEvidence = '';
    try {
      if (!window.pdfjsLib) throw new Error('pdfjsLib global missing');
      if (pdfjsLib.version !== PDFJS.version) throw new Error(`pdfjsLib.version is ${pdfjsLib.version}, expected ${PDFJS.version}`);
      pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS.worker;
      if (!state.pdfjsWorker) state.pdfjsWorker = new pdfjsLib.PDFWorker({ name: 'noblepdf-phase8-v2' });
      await withTimeout(state.pdfjsWorker.promise, 30000, 'PDF.js worker start');
      pdfjsOk = true;
      pdfjsEvidence = `API ${pdfjsLib.version} build ${pdfjsLib.build}; worker ${state.pdfjsWorker._webWorker ? 'dedicated Worker' : 'fake worker on main thread'}`;
    } catch (e) {
      pdfjsEvidence = String(e && e.message ? e.message : e);
    }

    // P03 fixtures, P04 layout module identity
    const [beforeBytes, referenceBytes, layoutBytes] = await Promise.all([
      fetchBytes(FIXTURES.before.url), fetchBytes(FIXTURES.reference.url), fetchBytes(LAYOUT_MODULE.url),
    ]);
    const [beforeSha, referenceSha, layoutSha] = await Promise.all([V.sha256Hex(beforeBytes), V.sha256Hex(referenceBytes), V.sha256Hex(layoutBytes)]);
    state.fixtures = { before: beforeBytes, reference: referenceBytes };
    if (pdfjsOk) {
      try {
        const d = await pdfjsDocument(beforeBytes);
        const n = d.numPages;
        await d.destroy();
        pdfjsEvidence += `; opened fixture (${n} page), API and worker versions agree`;
      } catch (e) {
        pdfjsOk = false;
        pdfjsEvidence += `; opening fixture failed: ${e && e.message ? e.message : e}`;
      }
    }
    rows.push(row('P02', 'Preflight', `PDF.js is ${PDFJS.version} (thresholds were measured against this version)`, pdfjsOk, pdfjsEvidence));
    rows.push(row('P03', 'Preflight', 'Fixture SHA-256 pinned (before, reference)',
      beforeSha === FIXTURES.before.sha256 && referenceSha === FIXTURES.reference.sha256,
      `before ${short(beforeSha)} (${beforeBytes.length} B); reference ${short(referenceSha)} (${referenceBytes.length} B)`));
    rows.push(row('P04', 'Preflight', 'Layout module is the audited Run #10 port (SHA-256)', layoutSha === LAYOUT_MODULE.sha256,
      `phase8-layout.mjs ${short(layoutSha)} (${layoutBytes.length} B)`));

    // P05 to P08 patched engine
    if (!state.engines.patched || !state.engines.patched.engine) {
      state.engines.patched = await loadVerifiedEngine({ base: PATCHED_BASE, label: 'patched', expected: RUN10 });
    }
    const P = state.engines.patched;
    rows.push(row('P05', 'Preflight', 'Patched pdfium.wasm matches Run #10 (SHA-256 and size)',
      P.wasmSha256 === RUN10.wasmSha256 && P.wasmBytes === RUN10.wasmBytes,
      `${P.wasmSha256 || 'not fetched'} (${P.wasmBytes} B)`));
    const idxAfterOk = !P.indexSha256After || P.indexSha256After === P.indexSha256;
    const importSizeOk = P.importEntrySize === null || P.importEntrySize === P.indexBytes;
    rows.push(row('P06', 'Preflight', 'Patched index.js matches Run #10 before it runs, and is unchanged after import',
      P.indexSha256 === RUN10.indexJsSha256 && P.identityOk === true && !!P.indexSha256After && idxAfterOk && importSizeOk,
      `${P.indexSha256 || 'not fetched'} (${P.indexBytes} B); after import ${P.indexSha256After ? short(P.indexSha256After) : 'not imported'}; import entry ${P.importEntrySize === null ? 'size n/a' : `${P.importEntrySize} B`}${P.identityNote ? `; ${P.identityNote}` : ''}`));

    // P09 stock engine (loaded with the same verified-bytes path)
    if (!state.engines.stock || !state.engines.stock.engine) {
      const pinned = STOCK_PINNED.wasmSha256 || STOCK_PINNED.indexJsSha256 ? { wasmSha256: STOCK_PINNED.wasmSha256, indexJsSha256: STOCK_PINNED.indexJsSha256 } : null;
      state.engines.stock = await loadVerifiedEngine({ base: STOCK_BASE, label: 'stock', expected: pinned });
    }
    const S = state.engines.stock;
    const allowedWasm = new Set([P.wasmUrl, S.wasmUrl]);
    const unexpectedWasm = wasmRequestAudit(allowedWasm);
    rows.push(row('P07', 'Preflight', 'Patched engine instantiated only from the verified bytes',
      !!P.engine && P.hookCalls === 1 && P.instantiatedFromVerifiedBytes && unexpectedWasm.length === 0,
      `instantiateWasm hook calls ${P.hookCalls}; instantiated from verified bytes ${P.instantiatedFromVerifiedBytes}; other .wasm requests ${unexpectedWasm.length ? js(unexpectedWasm) : 'none'}${P.error ? `; error ${P.error}` : ''}`));
    let apiOk = false;
    let apiEvidence = 'engine not loaded';
    if (P.engine) {
      const missing = REQUIRED_API.filter((n) => !P.engine.hasApi(n));
      const runtimeOk = typeof P.engine.m.addFunction === 'function' && typeof P.engine.m.removeFunction === 'function';
      const setPosWrapper = P.engine.hasApi('FPDFText_SetPositions');
      const setPosRaw = P.engine.hasRawExport('FPDFText_SetPositions');
      apiOk = missing.length === 0 && runtimeOk && setPosWrapper && setPosRaw;
      apiEvidence = `missing ${missing.length ? js(missing) : 'none'}; SetPositions wrapper ${setPosWrapper}, raw export ${setPosRaw}; addFunction/removeFunction ${runtimeOk}`;
    }
    rows.push(row('P08', 'Preflight', 'Patched API surface includes FPDFText_SetPositions and every call this lab makes', apiOk, apiEvidence));
    $('setPositionsStatus').textContent = apiOk ? 'PRESENT' : 'MISSING';

    const stockHas = S.engine ? (S.engine.hasApi('FPDFText_SetPositions') || S.engine.hasRawExport('FPDFText_SetPositions')) : null;
    const stockPinnedOk = S.identityChecked ? S.identityOk === true : true;
    const stockDistinct = !!S.wasmSha256 && S.wasmSha256 !== P.wasmSha256;
    const stockOk = !!S.engine && stockHas === false && stockDistinct && stockPinnedOk && S.hookCalls === 1;
    const npmMatch = S.wasmSha256 === NPM_REFERENCE.stockWasmSha256 ? 'matches npm @embedpdf/pdfium@2.15.1 dist/pdfium.wasm' : 'differs from the npm dist/pdfium.wasm reference';
    rows.push(row('P09', 'Preflight', 'Stock engine lacks SetPositions and differs from the patched build',
      stockOk,
      `stock SetPositions ${stockHas === null ? 'engine not loaded' : stockHas}; wasm ${short(S.wasmSha256)} (${S.wasmBytes} B, ${npmMatch}); index.js ${short(S.indexSha256)}; ${S.identityChecked ? `pinned identity ${S.identityOk ? 'matches' : `MISMATCH ${S.identityNote}`}` : 'hashes recorded, not pinned (set STOCK_PINNED to assert)'}${S.error ? `; error ${S.error}` : ''}`));
    $('stockStatus').textContent = stockOk ? (S.identityChecked ? 'PASS (pinned)' : 'PASS (recorded)') : 'FAIL';
    $('identityStatus').textContent = P.identityOk === true && P.engine ? 'RUN #10 MATCH' : 'MISMATCH';

    // P10 environment
    const env = showEnvironment();
    rows.push(row('P10', 'Preflight', 'No cross-origin resource loaded and no unexpected script ran', env.pass,
      env.pass ? `clean; ${env.violations} CSP-blocked attempt(s) recorded` : env.fail.join(' | ')));

    // Informational PDF.js file hashes (ready for SRI pinning)
    try {
      const [lib, wk] = await Promise.all([fetchBytes(PDFJS.lib), fetchBytes(PDFJS.worker)]);
      const [libSha, wkSha, libSri] = await Promise.all([V.sha256Hex(lib), V.sha256Hex(wk), V.sha384Base64(lib)]);
      state.pdfjsInfo = { libSha, wkSha, libSri };
      rows.push(info('I00', 'Info', 'PDF.js vendor files (not gated)',
        `pdf.min.js ${short(libSha)} ${libSha === NPM_REFERENCE.pdfjsLibSha256 ? '(= npm pdfjs-dist@3.11.174)' : '(differs from npm reference)'}; worker ${short(wkSha)} ${wkSha === NPM_REFERENCE.pdfjsWorkerSha256 ? '(= npm)' : '(differs from npm reference)'}; SRI sha384-${libSri}`));
    } catch (e) {
      rows.push(info('I00', 'Info', 'PDF.js vendor files (not gated)', `could not hash: ${e && e.message ? e.message : e}`));
    }

    const summary = V.summarizeGates(rows);
    state.ready = summary.pass;
    state.preflightRows = rows;
    notes.push(
      'NoblePDF True Edit - Phase 8 V2 live preflight',
      `Time: ${new Date().toISOString()}  Page: ${PAGE_VERSION}`,
      `Patched: ${P.wasmUrl.split('?')[0]}  wasm ${P.wasmSha256} (${P.wasmBytes} B)  index.js ${P.indexSha256}`,
      `Stock:   ${S.wasmUrl.split('?')[0]}  wasm ${S.wasmSha256} (${S.wasmBytes} B)  index.js ${S.indexSha256}`,
      `Run #10 expected: wasm ${RUN10.wasmSha256} (${RUN10.wasmBytes} B)  index.js ${RUN10.indexJsSha256}`,
      '',
      ...gateLines(rows),
      '',
      `PREFLIGHT: ${summary.pass ? 'READY' : `BLOCKED (${summary.failed.join(', ')})`}`,
    );
    $('preflightReport').textContent = notes.join('\n');
    $('readyStatus').textContent = summary.pass ? 'YES' : 'NO';
    renderGates(rows);
  } catch (e) {
    state.ready = false;
    state.preflightRows = rows;
    $('readyStatus').textContent = 'NO';
    $('preflightReport').textContent = [...gateLines(rows), '', `ERROR: ${e && e.stack ? e.stack : e}`].join('\n');
    renderGates(rows);
  } finally {
    setBusy(false);
  }
}

// ------------------------------------------------------------------ proof
async function runProof() {
  if (state.busy || !state.ready) return;
  setBusy(true);
  revokeResult();
  $('copyReport').disabled = true;
  $('legacyStatus').textContent = 'RUNNING';
  $('anchoredStatus').textContent = 'RUNNING';
  $('decisionStatus').textContent = '-';
  $('verificationReport').textContent = 'Running V2 live mutation proof...';
  const rows = [...state.preflightRows];
  renderGates(rows);
  const E = state.engines.patched.engine;
  const S = state.engines.stock && state.engines.stock.engine;
  const before = state.fixtures.before;
  const reference = state.fixtures.reference;
  let anchoredBytes = null;
  const report = [];
  try {
    const beforeShaStart = await V.sha256Hex(before);

    // ---------------- positive controls on the untouched documents
    const bP = inspectPdfium(E, before);
    const rP = inspectPdfium(E, reference);
    const bJ = await inspectPdfjs(before, $('beforeCanvas'));
    const rJ = await inspectPdfjs(reference, $('referenceCanvas'));
    const bOld = bP.oldGroups[0];
    rows.push(row('C01', 'Control', 'Original: PDFium exact text, exact search finds WAVESKERN once at the target, TOKYOLAKE absent',
      bP.pageCount === 1 && bP.pageText === `${OLD_TEXT}\r\n${NEIGHBOUR_TEXT}` && bP.oldGroups.length === 1 && bOld.generated === 0
        && sameMatches(bP.searchOldExact, [[bOld.firstIndex, OLD_TEXT.length]]) && bP.searchNewLoose.length === 0,
      `text ${js(bP.pageText)}; search ${js(bP.searchOldExact)}; new ${js(bP.searchNewLoose)}`));
    rows.push(row('C02', 'Control', 'Original: PDF.js lines exact', V.sameStringArray(bJ.lines, [OLD_TEXT, NEIGHBOUR_TEXT]), js(bJ.lines)));

    // Target snapshot on the original, compared with an independent hand calculation.
    const probe = E.open(before);
    let snap;
    const widthRows = [];
    try {
      E.loadPage(probe);
      const s = snapshotTarget(E, probe);
      snap = { xs: s.xs, matrix: s.matrix, fontSize: s.fontSize, baseFont: s.baseFont, embedded: s.embedded, renderMode: s.renderMode, marks: s.marks, index: s.index };
      const cps = [...new Set([...codePointsAscii(OLD_TEXT), ...codePointsAscii(NEW_TEXT)])];
      for (const cp of cps) widthRows.push({ ch: String.fromCodePoint(cp), got: E.glyphWidthUnicode(s.font, cp), want: HELVETICA_AFM[cp] });
    } finally { E.close(probe); }
    const handBefore = V.tjGlyphOrigins(codePointsAscii(OLD_TEXT), BEFORE_TJ_ADJUST, HELVETICA_AFM, FIXTURE_SIZE);
    const xsErr = V.maxAbsDiff(snap.xs, handBefore);
    const mErr = V.maxAbsDiff(snap.matrix, FIXTURE_MATRIX);
    rows.push(row('C03', 'Control', 'Original glyph origins equal the hand-calculated TJ layout; target is a direct, unmarked, filled Helvetica 18 pt text object',
      xsErr <= POS_TOL_PT && mErr <= 1e-4 && Math.abs(snap.fontSize - FIXTURE_SIZE) < 1e-4 && snap.baseFont === FIXTURE_FONT && snap.embedded === 0
        && snap.renderMode === 0 && snap.marks === 0 && snap.index >= 0,
      `max origin error ${pt(xsErr)}; matrix ${js(snap.matrix)}; ${snap.baseFont} ${snap.fontSize} pt embedded=${snap.embedded} Tr=${snap.renderMode} marks=${snap.marks} page object #${snap.index}`));
    const badWidths = widthRows.filter((w) => !(Math.abs(w.got - w.want) < 1e-3));
    rows.push(row('C04', 'Control', 'FPDFFont_GetGlyphWidth (Unicode argument) returns the Helvetica AFM widths for every fixture glyph',
      badWidths.length === 0, badWidths.length ? `mismatch ${js(badWidths)}` : widthRows.map((w) => `${w.ch}=${w.got}`).join(' ')));
    const handAnchoredPage = V.tjGlyphOrigins(codePointsAscii(NEW_TEXT), {}, HELVETICA_AFM, FIXTURE_SIZE).map((x) => applyMatrix(FIXTURE_MATRIX, x, 0));
    const rNew = rP.newGroups[0];
    const refDrift = rNew ? V.maxPointDistance(rNew.origins, handAnchoredPage) : Infinity;
    rows.push(row('C05', 'Control', 'Independent reference: exact PDFium and PDF.js text, exact search, origins equal the hand-calculated natural layout',
      rP.pageText === `${NEW_TEXT}\r\n${NEIGHBOUR_TEXT}` && rP.newGroups.length === 1 && rNew.text === NEW_TEXT && rNew.generated === 0
        && sameMatches(rP.searchNewExact, [[rNew.firstIndex, NEW_TEXT.length]]) && rP.searchOldLoose.length === 0
        && V.sameStringArray(rJ.lines, [NEW_TEXT, NEIGHBOUR_TEXT]) && refDrift <= POS_TOL_PT,
      `PDFium ${js(rP.pageText)}; PDF.js ${js(rJ.lines)}; origin error ${pt(refDrift)}`));
    const refOutside = V.comparePixels(rJ.full, bJ.full, { tolerance: PIXEL_TOL, excludeRows: bJ.rows2 });
    rows.push(row('C06', 'Control', 'Reference differs from the original only inside the edited band (scale 2)',
      refOutside.comparable && refOutside.overTolerance === 0,
      `outside band: ${refOutside.overTolerance} px over ${PIXEL_TOL}/255, max delta ${refOutside.maxDelta}`));
    const bEv = await saveEvidence(before, new Uint8Array(0));
    const rEv = await saveEvidence(reference, new Uint8Array(0));
    const rScanNew = V.streamTextEvidence(rEv.st.scan, await V.decodeAllStreams(reference, rEv.st.scan), NEW_TEXT);
    rows.push(row('C07', 'Control', 'Content scanner detects WAVESKERN in the original and TOKYOLAKE in the reference',
      bEv.old.hits.length > 0 && V.sameStringArray(bEv.old.blocks.map((x) => x.text), [OLD_TEXT, NEIGHBOUR_TEXT]) && rScanNew.hits.length > 0,
      `original hits ${bEv.old.hits.length}, blocks ${js(bEv.old.blocks.map((x) => x.text))}; reference hits ${rScanNew.hits.length}`));

    // ---------------- legacy arm: gated negative control and SetPositions efficacy proof
    const legacy = mutateArm(E, before, 'legacy');
    const lP = inspectPdfium(E, legacy.bytes);
    const lJ = await inspectPdfjs(legacy.bytes, $('legacyCanvas'));
    const lEv = await saveEvidence(legacy.bytes, before);
    const lNew = lP.newGroups[0];
    const lDrift = lNew && lNew.real === NEW_TEXT.length ? V.maxPointDistance(lNew.origins, legacy.expectedPage) : Infinity;
    const lBand = V.comparePixels(lJ.band, rJ.band, { tolerance: PIXEL_TOL });
    const lintPairs = legacy.lint.bad.map((b) => b.pair);
    rows.push(row('L01', 'Legacy control', 'Semantic gap lint rejects the legacy per-glyph-origin layout',
      !legacy.lint.ok && lintPairs.includes('TO'), `rejected ${!legacy.lint.ok}; worst ${js(legacy.lint.worst)}; bad ${js(legacy.lint.bad)}`));
    rows.push(row('L02', 'Legacy control', 'SetPositions efficacy: requested positions are far from natural and the saved, reopened glyphs sit exactly there',
      legacy.naturalDelta >= LEGACY_MIN_NATURAL_DELTA_PT && lDrift <= POS_TOL_PT,
      `requested vs natural ${legacy.naturalDelta.toFixed(3)} pt (must be >= ${LEGACY_MIN_NATURAL_DELTA_PT}); reopened vs requested ${pt(lDrift)} (must be <= ${POS_TOL_PT})`));
    rows.push(row('L03', 'Legacy control', 'PDFium detects the historical failure (object text is not exactly TOKYOLAKE, exact search fails)',
      !!lNew && lNew.text !== NEW_TEXT && lP.searchNewExact.length === 0, `object text ${js(lNew ? lNew.text : null)}; exact search ${js(lP.searchNewExact)}`));
    rows.push(row('L04', 'Legacy control', 'PDF.js detects the historical failure (first line is not TOKYOLAKE)',
      lJ.lines.length > 0 && lJ.lines[0] !== NEW_TEXT, js(lJ.lines)));
    rows.push(row('L05', 'Legacy control', 'Edited band at 288 dpi differs from the independent reference (visual check is sensitive)',
      lBand.comparable && lBand.overTolerance > 0, `${lBand.overTolerance} px over ${PIXEL_TOL}/255; max delta ${lBand.maxDelta}`));
    rows.push(row('L06', 'Legacy control', 'Legacy save is also a clean single revision without old text',
      lEv.st.singleRevision && lEv.old.hits.length === 0 && lEv.old.undecodable === 0, `${structureSummary(lEv)}; old-text hits ${js(lEv.old.hits)}`));

    // ---------------- anchored arm: the subject of the proof
    const anch = mutateArm(E, before, 'anchored');
    anchoredBytes = anch.bytes;
    const aP = inspectPdfium(E, anch.bytes);
    const aJ = await inspectPdfjs(anch.bytes, $('anchoredCanvas'));
    const aEv = await saveEvidence(anch.bytes, before);
    const aNew = aP.newGroups[0];
    const aDrift = aNew && aNew.real === NEW_TEXT.length ? V.maxPointDistance(aNew.origins, anch.expectedPage) : Infinity;
    const bNb = bP.neighbourGroups[0];
    const aNb = aP.neighbourGroups[0];
    const nbDrift = aNb && bNb ? V.maxPointDistance(aNb.origins, bNb.origins) : Infinity;
    const refItem = rJ.items.find((x) => x.str === NEW_TEXT);
    const outItem = aJ.items.find((x) => x.str === NEW_TEXT);
    const itemErr = refItem && outItem ? Math.max(Math.abs(refItem.x - outItem.x), Math.abs(refItem.y - outItem.y), Math.abs(refItem.w - outItem.w)) : Infinity;
    const aFull = V.comparePixels(aJ.full, rJ.full, { tolerance: PIXEL_TOL });
    const aBand = V.comparePixels(aJ.band, rJ.band, { tolerance: PIXEL_TOL });
    const aOutside = V.comparePixels(aJ.full, bJ.full, { tolerance: PIXEL_TOL, excludeRows: bJ.rows2 });
    rows.push(row('A01', 'Anchored', 'Semantic gap lint passes', anch.lint.ok, `worst ${js(anch.lint.worst)}; bad ${js(anch.lint.bad)}`));
    rows.push(row('A02', 'Anchored', 'Reopens in PDFium with one page and the exact expected page text',
      aP.pageCount === 1 && aP.pageText === `${NEW_TEXT}\r\n${NEIGHBOUR_TEXT}`, `${aP.pageCount} page; ${js(aP.pageText)}`));
    rows.push(row('A03', 'Anchored', 'Exactly one direct text object reads TOKYOLAKE with 9 real glyphs and no generated characters',
      aP.newGroups.length === 1 && aNew.text === NEW_TEXT && aNew.generated === 0 && aNew.real === NEW_TEXT.length && aNew.type === FPDF_PAGEOBJ_TEXT && aNew.objIndex >= 0,
      aNew ? `object #${aNew.objIndex} (was #${anch.snapshot.index}); text ${js(aNew.text)}; real ${aNew.real}; generated ${aNew.generated}` : `groups ${js(aP.groupTexts)}`));
    rows.push(row('A04', 'Anchored', 'PDFium match-case whole-word search finds TOKYOLAKE once, at the target, 9 characters long',
      !!aNew && sameMatches(aP.searchNewExact, [[aNew.firstIndex, NEW_TEXT.length]]), `matches ${js(aP.searchNewExact)}`));
    rows.push(row('A05', 'Anchored', 'Old text absent (PDFium case-insensitive search, PDFium text, PDF.js text)',
      aP.searchOldLoose.length === 0 && aP.oldGroups.length === 0 && !aP.pageText.includes(OLD_TEXT) && !aJ.lines.join('\n').includes(OLD_TEXT),
      `search ${js(aP.searchOldLoose)}; groups ${js(aP.groupTexts)}`));
    rows.push(row('A06', 'Anchored', `Reopened glyph origins match the requested layout within ${POS_TOL_PT} pt`, aDrift <= POS_TOL_PT, pt(aDrift)));
    rows.push(row('A07', 'Anchored', `Neighbour line text exact and every glyph origin unchanged within ${POS_TOL_PT} pt`,
      aP.neighbourGroups.length === 1 && aNb.text === NEIGHBOUR_TEXT && aNb.generated === 0 && nbDrift <= POS_TOL_PT,
      `${aNb ? js(aNb.text) : 'missing'}; max move ${pt(nbDrift)}`));
    rows.push(row('A08', 'Anchored', 'PDFium object census and annotation count unchanged',
      js(aP.census) === js(anch.beforeCensus) && aP.annots === anch.beforeAnnots, `before ${js(anch.beforeCensus)} annots ${anch.beforeAnnots}; after ${js(aP.census)} annots ${aP.annots}`));
    rows.push(row('A09', 'Anchored', 'PDF.js lines exact and the TOKYOLAKE item geometry equals the reference',
      aJ.numPages === 1 && V.sameStringArray(aJ.lines, [NEW_TEXT, NEIGHBOUR_TEXT]) && itemErr <= POS_TOL_PT,
      `${js(aJ.lines)}; item x/y/width error ${pt(itemErr)}`));
    rows.push(row('A10', 'Anchored', `Full page at scale 2 matches the independent reference (tolerance ${PIXEL_TOL}/255 per channel)`,
      aFull.comparable && aFull.overTolerance === 0, `${aFull.overTolerance} px over tolerance; ${aFull.anyDifference} px differ at all; max delta ${aFull.maxDelta}`));
    rows.push(row('A11', 'Anchored', `Edited band at 288 dpi (scale 4) matches the independent reference (tolerance ${PIXEL_TOL}/255)`,
      aBand.comparable && aBand.overTolerance === 0, `${aBand.overTolerance} px over tolerance; ${aBand.anyDifference} px differ at all; max delta ${aBand.maxDelta}`));
    rows.push(row('A12', 'Anchored', `Everything outside the edited band matches the original render (scale 2, tolerance ${PIXEL_TOL}/255)`,
      aOutside.comparable && aOutside.overTolerance === 0, `${aOutside.overTolerance} px over tolerance; ${aOutside.anyDifference} px differ at all; max delta ${aOutside.maxDelta}`));
    rows.push(row('A13', 'Anchored', 'Save is one clean non-incremental revision (single %%EOF and startxref, no /Prev, valid xref, not an append)',
      aEv.st.singleRevision, structureSummary(aEv)));
    rows.push(row('A14', 'Anchored', 'Streams: no old text anywhere (including unreferenced streams), one TOKYOLAKE block, no invisible text, images, XObjects or annotations',
      aEv.old.hits.length === 0 && aEv.old.undecodable === 0 && aEv.newBlocks === 1 && aEv.neighbourBlocks === 1 && aEv.textBlocks === 2
        && aEv.old.invisibleShows === 0 && aEv.old.doCount === 0 && aEv.old.inlineImages === 0 && aEv.old.images === 0
        && aEv.old.showsOutsideBT === 0 && !aEv.annotsKey && !aEv.xobjectKey,
      `old hits ${js(aEv.old.hits)}; blocks ${js(aEv.old.blocks.map((x) => x.text))}; invisible ${aEv.old.invisibleShows}; Do ${aEv.old.doCount}; inline images ${aEv.old.inlineImages}; image streams ${aEv.old.images}; /Annots ${aEv.annotsKey}; /XObject ${aEv.xobjectKey}`));
    const beforeShaEnd = await V.sha256Hex(before);
    rows.push(row('A15', 'Anchored', 'Source fixture bytes in memory are unchanged after both arms', beforeShaEnd === beforeShaStart && beforeShaEnd === FIXTURES.before.sha256, short(beforeShaEnd)));

    // ---------------- informational evidence
    if (S) {
      try {
        const sa = mutateArm(S, before, 'anchored', { useSetPositions: false });
        const sl = mutateArm(S, before, 'legacy', { useSetPositions: false });
        const saP = inspectPdfium(S, sa.bytes);
        const slP = inspectPdfium(S, sl.bytes);
        const sad = saP.newGroups[0] ? V.maxPointDistance(saP.newGroups[0].origins, anch.expectedPage) : Infinity;
        const sld = slP.newGroups[0] ? V.maxPointDistance(slP.newGroups[0].origins, legacy.expectedPage) : Infinity;
        rows.push(info('I01', 'Info', 'Discrimination: stock engine with SetCharcodes only (no SetPositions)',
          `anchored drift ${pt(sad)}, text ${js(saP.pageText.split('\r\n')[0])} (indistinguishable from a working patch, which is why L02 is required); legacy drift ${pt(sld)} (distinguishable)`));
      } catch (e) {
        rows.push(info('I01', 'Info', 'Discrimination: stock engine with SetCharcodes only', `not run: ${e && e.message ? e.message : e}`));
      }
    }
    rows.push(info('I02', 'Info', 'Layout path exercised by this fixture',
      `prefix ${anch.layout.prefix}, suffix ${anch.layout.suffix}, fit ${js(anch.layout.fit)}, anchored requested vs natural ${anch.naturalDelta.toExponential(2)} pt: prefix anchoring, suffix shift and width fitting are NOT exercised`));
    rows.push(info('I03', 'Info', 'Save sizes and header (64-byte prefix is not a rewrite proof on its own)',
      `anchored ${aEv.st.bytes} B, legacy ${lEv.st.bytes} B, original ${before.length} B; first 64 bytes equal original: ${aEv.st.samePrefix64}`));

    const env = showEnvironment();
    rows.push(row('E01', 'Environment', 'Still no cross-origin resource and no unexpected script at decision time', env.pass,
      env.pass ? `clean; ${env.violations} CSP-blocked attempt(s) recorded; service worker ${env.serviceWorker ? 'YES' : 'no'}` : env.fail.join(' | ')));

    // ---------------- decision
    const summary = V.summarizeGates(rows);
    const lOk = rows.filter((r) => r.id.startsWith('L')).every((r) => r.pass);
    const aOk = rows.filter((r) => r.id.startsWith('A')).every((r) => r.pass);
    $('legacyStatus').textContent = lOk ? 'CONTROL VALID (failed as designed)' : 'CONTROL INVALID';
    $('anchoredStatus').textContent = aOk ? 'PASS' : 'FAIL';
    $('decisionStatus').textContent = summary.pass ? 'PHASE 8 V2 PASS (this fixture only)' : 'KEEP BLOCKED';
    renderGates(rows);
    report.push(
      'NoblePDF True Edit - Phase 8 V2 live mutation report',
      `Time: ${new Date().toISOString()}  Page: ${PAGE_VERSION}  Verify: ${V.VERIFY_VERSION}`,
      `Target: ${OLD_TEXT} -> ${NEW_TEXT} (one hash-pinned fixture)`,
      `Legacy requested xs: ${js(legacy.layout.xs.map((x) => +x.toFixed(4)))}`,
      `Anchored requested xs: ${js(anch.layout.xs.map((x) => +x.toFixed(4)))}`,
      '',
      ...gateLines(rows),
      '',
      `DECISION: ${summary.pass ? 'PHASE 8 V2 PASS for this fixture only' : `KEEP BLOCKED (failed: ${summary.failed.join(', ')})`}`,
      'Scope: one fixture (standard Helvetica, WinAnsi, ASCII, same length, prefix 0, suffix 0, Tc 0, Tw 0, Tz 100).',
      'This result does not show that arbitrary user PDFs, fonts or Unicode text are production-ready. Run #10 CI remains the authority for the other cases.',
    );
    $('verificationReport').textContent = report.join('\n');
    if (summary.pass && anchoredBytes) {
      state.resultBlobUrl = URL.createObjectURL(new Blob([anchoredBytes], { type: 'application/pdf' }));
      $('downloadResult').disabled = false;
    }
    $('copyReport').disabled = false;
  } catch (e) {
    $('anchoredStatus').textContent = 'ERROR';
    $('legacyStatus').textContent = $('legacyStatus').textContent === 'RUNNING' ? 'NOT COMPLETED' : $('legacyStatus').textContent;
    $('decisionStatus').textContent = 'KEEP BLOCKED';
    renderGates(rows);
    $('verificationReport').textContent = [...gateLines(rows), '', `ERROR: ${e && e.stack ? e.stack : e}`, '', 'DECISION: KEEP BLOCKED'].join('\n');
    $('copyReport').disabled = false;
  } finally {
    setBusy(false);
  }
}

// ------------------------------------------------------------------ wiring
function boot() {
  if (document.documentElement.dataset.phase8 !== 'v2') {
    $('preflightReport').textContent = 'ERROR: phase8-v2.js loaded into a page that is not phase8-v2.html. Reload the V2 page.';
    $('runPreflight').disabled = true;
    return;
  }
  $('runPreflight').addEventListener('click', runPreflight);
  $('runProof').addEventListener('click', runProof);
  $('copyReport').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText([$('preflightReport').textContent, $('verificationReport').textContent, $('networkResults').textContent].join('\n\n'));
      $('copyReport').textContent = 'Copied';
      setTimeout(() => { $('copyReport').textContent = 'Copy report'; }, 1200);
    } catch (e) { /* clipboard unavailable */ }
  });
  $('downloadResult').addEventListener('click', () => {
    if (!state.resultBlobUrl) return;
    const a = document.createElement('a');
    a.href = state.resultBlobUrl;
    a.download = 'noblepdf-phase8-v2-anchored-output.pdf';
    document.body.append(a);
    a.click();
    a.remove();
  });
  window.addEventListener('pagehide', () => {
    revokeResult();
    try { if (state.pdfjsWorker) state.pdfjsWorker.destroy(); } catch (e) { /* ignore */ }
  });
  setTimeout(showEnvironment, 250);
}
boot();
