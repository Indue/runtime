// Thin, explicit wrapper over the @embedpdf/pdfium 2.15.1 cwrap interface
// (the same object NoblePDF uses), plus the True Edit V1 reference mutation.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const FPDF_PAGEOBJ_TEXT = 1;
export const FPDF_PAGEOBJ_PATH = 2;
export const FPDF_PAGEOBJ_IMAGE = 3;
export const FPDF_PAGEOBJ_SHADING = 4;
export const FPDF_PAGEOBJ_FORM = 5;

export async function loadEngine(distDir) {
  const wasmBytes = readFileSync(`${distDir}/pdfium.wasm`);
  const { init } = await import(`${distDir}/index.js`);
  // Always pass the wasm explicitly: DEFAULT_PDFIUM_WASM_URL in the bundle
  // points at the stock jsDelivr build.
  const m = await init({ wasmBinary: wasmBytes });
  m.PDFiumExt_Init();
  return new Engine(m, {
    wasmSha256: createHash('sha256').update(wasmBytes).digest('hex'),
    wasmBytes: wasmBytes.length,
    jsSha256: createHash('sha256')
      .update(readFileSync(`${distDir}/index.js`))
      .digest('hex'),
  });
}

export class Engine {
  constructor(m, info) {
    this.m = m;
    this.p = m.pdfium;
    this.info = info;
    this.hasSetPositions = typeof m.FPDFText_SetPositions === 'function';
  }

  malloc(n) {
    const ptr = this.p.wasmExports.malloc(n);
    if (!ptr) throw new Error('malloc failed');
    return ptr;
  }
  free(ptr) {
    if (ptr) this.p.wasmExports.free(ptr);
  }
  withAlloc(n, fn) {
    const ptr = this.malloc(n);
    try {
      return fn(ptr);
    } finally {
      this.free(ptr);
    }
  }

  // ---- documents -----------------------------------------------------------
  openDocument(bytes) {
    const ptr = this.malloc(bytes.length);
    this.p.HEAPU8.set(bytes, ptr);
    const doc = this.m.FPDF_LoadMemDocument(ptr, bytes.length, '');
    if (!doc) {
      this.free(ptr);
      throw new Error(`FPDF_LoadMemDocument failed: ${this.m.FPDF_GetLastError()}`);
    }
    return { doc, ptr };
  }
  closeDocument(d) {
    this.m.FPDF_CloseDocument(d.doc);
    this.free(d.ptr);
  }
  saveNonIncremental(d) {
    // PDFiumExt_SaveAsCopy calls FPDF_SaveAsCopy(doc, writer, 0): a full
    // rewrite (FPDF_INCREMENTAL not set).
    const w = this.m.PDFiumExt_OpenFileWriter();
    try {
      if (!this.m.PDFiumExt_SaveAsCopy(d.doc, w)) throw new Error('save failed');
      const size = this.m.PDFiumExt_GetFileWriterSize(w);
      return this.withAlloc(size, (buf) => {
        this.m.PDFiumExt_GetFileWriterData(w, buf, size);
        return this.p.HEAPU8.slice(buf, buf + size);
      });
    } finally {
      this.m.PDFiumExt_CloseFileWriter(w);
    }
  }

  // ---- page objects --------------------------------------------------------
  pageObjects(page) {
    const n = this.m.FPDFPage_CountObjects(page);
    const out = [];
    for (let i = 0; i < n; i++) {
      const obj = this.m.FPDFPage_GetObject(page, i);
      out.push({ obj, type: this.m.FPDFPageObj_GetType(obj) });
    }
    return out;
  }
  matrix(obj) {
    return this.withAlloc(24, (ptr) => {
      if (!this.m.FPDFPageObj_GetMatrix(obj, ptr)) throw new Error('GetMatrix failed');
      const f = this.p.HEAPF32.subarray(ptr >> 2, (ptr >> 2) + 6);
      return { a: f[0], b: f[1], c: f[2], d: f[3], e: f[4], f: f[5] };
    });
  }
  bounds(obj) {
    return this.withAlloc(16, (ptr) => {
      const q = ptr >> 2;
      this.m.FPDFPageObj_GetBounds(obj, ptr, ptr + 4, ptr + 8, ptr + 12);
      const f = this.p.HEAPF32;
      return { left: f[q], bottom: f[q + 1], right: f[q + 2], top: f[q + 3] };
    });
  }
  textRenderMode(obj) {
    return this.m.FPDFTextObj_GetTextRenderMode(obj);
  }
  textObjText(obj, textPage) {
    const len = this.m.FPDFTextObj_GetText(obj, textPage, 0, 0);
    if (len <= 0) return '';
    return this.withAlloc(len, (ptr) => {
      this.m.FPDFTextObj_GetText(obj, textPage, ptr, len);
      return utf16(this.p.HEAPU8, ptr, len);
    });
  }

  // ---- text page -----------------------------------------------------------
  pageText(textPage) {
    const n = this.m.FPDFText_CountChars(textPage);
    if (n <= 0) return '';
    return this.withAlloc((n + 1) * 2, (ptr) => {
      this.m.FPDFText_GetText(textPage, 0, n, ptr);
      return utf16(this.p.HEAPU8, ptr, n * 2);
    });
  }
  find(textPage, needle) {
    const bytes = encodeUtf16z(needle);
    return this.withAlloc(bytes.length, (ptr) => {
      this.p.HEAPU8.set(bytes, ptr);
      const h = this.m.FPDFText_FindStart(textPage, ptr, 0, 0);
      const found = !!this.m.FPDFText_FindNext(h);
      const idx = found ? this.m.FPDFText_GetSchResultIndex(h) : -1;
      const cnt = found ? this.m.FPDFText_GetSchCount(h) : 0;
      this.m.FPDFText_FindClose(h);
      return { found, idx, cnt };
    });
  }
  // Real (non-generated) glyphs on the text page, with the owning object.
  glyphs(textPage) {
    const n = this.m.FPDFText_CountChars(textPage);
    const out = [];
    this.withAlloc(16, (ptr) => {
      for (let i = 0; i < n; i++) {
        if (this.m.FPDFText_IsGenerated(textPage, i) === 1) continue;
        this.m.FPDFText_GetCharOrigin(textPage, i, ptr, ptr + 8);
        const d = this.p.HEAPF64;
        out.push({
          index: i,
          unicode: this.m.FPDFText_GetUnicode(textPage, i),
          obj: this.m.FPDFText_GetTextObject(textPage, i),
          x: d[ptr >> 3],
          y: d[(ptr >> 3) + 1],
        });
      }
    });
    return out;
  }

  // ---- rendering -----------------------------------------------------------
  // Returns RGBA pixels of the page rendered at `scale` (1 = 72 dpi).
  render(page, scale) {
    const w = Math.round(this.m.FPDF_GetPageWidthF(page) * scale);
    const h = Math.round(this.m.FPDF_GetPageHeightF(page) * scale);
    const bmp = this.m.FPDFBitmap_Create(w, h, 1);
    this.m.FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xffffffff);
    this.m.FPDF_RenderPageBitmap(bmp, page, 0, 0, w, h, 0, 0);
    const buf = this.m.FPDFBitmap_GetBuffer(bmp);
    const stride = this.m.FPDFBitmap_GetStride(bmp);
    const rgba = new Uint8Array(w * h * 4);
    const heap = this.p.HEAPU8;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = buf + y * stride + x * 4; // BGRA
        const t = (y * w + x) * 4;
        rgba[t] = heap[s + 2];
        rgba[t + 1] = heap[s + 1];
        rgba[t + 2] = heap[s];
        rgba[t + 3] = 255;
      }
    }
    this.m.FPDFBitmap_Destroy(bmp);
    return { w, h, rgba };
  }

  // ---- mutation primitives ---------------------------------------------------
  setCharcodes(obj, codes) {
    return this.withAlloc(Math.max(4, codes.length * 4), (ptr) => {
      this.p.HEAPU32.set(codes, ptr >> 2);
      return !!this.m.FPDFText_SetCharcodes(obj, ptr, codes.length);
    });
  }
  setPositions(obj, positions, countOverride) {
    if (!this.hasSetPositions) throw new Error('FPDFText_SetPositions missing');
    const count = countOverride ?? positions.length;
    if (positions === null) return !!this.m.FPDFText_SetPositions(obj, 0, count);
    return this.withAlloc(Math.max(4, positions.length * 4), (ptr) => {
      this.p.HEAPF32.set(positions, ptr >> 2);
      return !!this.m.FPDFText_SetPositions(obj, ptr, count);
    });
  }
}

// ---- True Edit V1 reference geometry --------------------------------------

export function invert(M) {
  const det = M.a * M.d - M.b * M.c;
  return {
    det,
    a: M.d / det,
    b: -M.b / det,
    c: -M.c / det,
    d: M.a / det,
    e: (M.c * M.f - M.d * M.e) / det,
    f: (M.b * M.e - M.a * M.f) / det,
  };
}
export function apply(M, x, y) {
  return { x: M.a * x + M.c * y + M.e, y: M.b * x + M.d * y + M.f };
}

// Scale-invariant degeneracy gate (recommended in the audit instead of an
// absolute |det| < 1e-8): sine of the angle between the matrix axes.
export function matrixGate(M) {
  const vals = [M.a, M.b, M.c, M.d, M.e, M.f];
  if (!vals.every(Number.isFinite)) return { ok: false, reason: 'non-finite matrix' };
  const n1 = Math.hypot(M.a, M.b);
  const n2 = Math.hypot(M.c, M.d);
  if (n1 < 1e-9 || n2 < 1e-9 || n1 > 1e9 || n2 > 1e9) {
    return { ok: false, reason: `axis norm out of range (${n1}, ${n2})` };
  }
  const sin = Math.abs(M.a * M.d - M.b * M.c) / (n1 * n2);
  if (sin < 1e-6) return { ok: false, reason: `degenerate (sin=${sin})` };
  return { ok: true, sin };
}

// Converts page-space glyph origins into text-object baseline offsets.
// Fails if the matrix is degenerate or any origin is off the baseline.
export function pageToObjectPositions(M, origins, { maxBaselineResidual = 0.01 } = {}) {
  const g = matrixGate(M);
  if (!g.ok) return { ok: false, reason: g.reason };
  const inv = invert(M);
  const xs = [];
  let worstY = 0;
  for (const o of origins) {
    const p = apply(inv, o.x, o.y);
    worstY = Math.max(worstY, Math.abs(p.y));
    xs.push(p.x);
  }
  if (worstY > maxBaselineResidual) {
    return { ok: false, reason: `origin off baseline by ${worstY}` };
  }
  // Forward-verify the round trip in page space.
  let worstFwd = 0;
  xs.forEach((x, i) => {
    const q = apply(M, x, 0);
    worstFwd = Math.max(worstFwd, Math.hypot(q.x - origins[i].x, q.y - origins[i].y));
  });
  if (worstFwd > 0.01) return { ok: false, reason: `forward check ${worstFwd}pt` };
  return { ok: true, xs, worstY, worstFwd };
}

// ---- utils ----------------------------------------------------------------
function utf16(heap, ptr, byteLen) {
  let s = '';
  for (let i = 0; i + 1 < byteLen; i += 2) {
    const c = heap[ptr + i] | (heap[ptr + i + 1] << 8);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}
function encodeUtf16z(str) {
  const out = new Uint8Array((str.length + 1) * 2);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    out[i * 2] = c & 0xff;
    out[i * 2 + 1] = c >> 8;
  }
  return out;
}
