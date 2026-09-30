// HARNESS ONLY. This is NOT a PDFium build and must never be deployed.
// It stands in for /vendor/pdfium-2.15.1-setpositions/index.js during the local
// browser test matrix. It wraps the stock @embedpdf/pdfium 2.15.1 glue and emulates
// a patched engine (or a specific fault) so the lab gates can be exercised.
// Variant: __VARIANT__
import { init as stockInit } from '/__harness/stockglue/index.js';

const VARIANT = '__VARIANT__';
const AFM = { 87: 944, 65: 667, 86: 667, 69: 667, 83: 667, 75: 667, 82: 722, 78: 722, 84: 611, 79: 778, 89: 667, 76: 556 };
const SIZE = 18;
const NB_HEX = '4E65696768626F7572696E6720636F6E74657874206C696E65206D757374206E6F74206D6F7665';
const OLD_TJ = '[<57> 120 <41> -80 <56> 200 <45> -40 <53> 60 <4B45524E>] TJ';

const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const hex2 = (c) => c.toString(16).toUpperCase().padStart(2, '0');
const fmt = (v) => String(+v.toFixed(4));

function zlibStored(data) {
  const out = [0x78, 0x01];
  let i = 0;
  do {
    const len = Math.min(65535, data.length - i);
    const final = i + len >= data.length ? 1 : 0;
    out.push(final, len & 0xff, (len >> 8) & 0xff, ~len & 0xff, (~len >> 8) & 0xff);
    for (let k = 0; k < len; k++) out.push(data[i + k]);
    i += len;
  } while (i < data.length);
  let a = 1;
  let b = 0;
  for (const x of data) { a = (a + x) % 65521; b = (b + a) % 65521; }
  const ad = ((b << 16) | a) >>> 0;
  out.push((ad >>> 24) & 0xff, (ad >>> 16) & 0xff, (ad >>> 8) & 0xff, ad & 0xff);
  return Uint8Array.from(out);
}

// TJ array from charcodes and SetPositions offsets, the way a positions-aware
// generator would write it: adj = -((x[i+1] - x[i]) - w[i] * size / 1000) * 1000 / size
function tjFor(codes, positions) {
  const pos = [0, ...positions];
  if (VARIANT === 'glyphdrift') pos[4] += 0.05;
  const parts = [];
  let run = '';
  for (let i = 0; i < codes.length; i++) {
    run += hex2(codes[i]);
    if (i + 1 < codes.length) {
      const adv = (AFM[codes[i]] * SIZE) / 1000;
      const adj = -((pos[i + 1] - pos[i]) - adv) * 1000 / SIZE;
      if (Math.abs(adj) >= 0.0005) { parts.push(`<${run}>`, fmt(adj)); run = ''; }
    }
  }
  parts.push(`<${run}>`);
  return `[${parts.join(' ')}] TJ`;
}

// Output shaped like the stock PDFium 2.15.1 writer (CRLF, renumbered objects,
// Flate content stream as object 7), with the target run written as a TJ array.
function buildRewrite(edit) {
  const tj = tjFor(edit.codes, edit.positions);
  const nbY = VARIANT === 'neighbourshift' ? '620.02' : '620';
  let extra = '';
  if (VARIANT === 'hiddenold') extra = `q 0 g 0 G 1 0 0 1 72 650 cm BT 1 0 0 1 0 0 Tm /FXF1 18 Tf 3 Tr ${OLD_TJ} ET Q\n`;
  if (VARIANT === 'overlay') extra = 'q 1 0 0 1 500 50 cm /FXX1 Do Q\n';
  const content = `q\n1 w 0 J 0 j\n/FXE1 gs q 0 g 0 G 1 0 0 1 72 650 cm BT 1 0 0 1 0 0 Tm /FXF1 18 Tf 0 Tr ${tj} ET Q\n`
    + `q 0 g 0 G 1 0 0 1 72 ${nbY} cm BT 1 0 0 1 0 0 Tm /FXF1 12 Tf 0 Tr <${NB_HEX}> Tj ET Q\n${extra}Q\n`;
  const z = zlibStored(enc(content));
  const xobj = VARIANT === 'overlay' ? '/XObject<</FXX1 8 0 R >>' : '';
  const objs = [
    [1, '<</Pages 2 0 R /Type/Catalog>>'],
    [2, '<</Count 1/Kids[ 3 0 R ]/Type/Pages>>'],
    [3, `<</Contents 7 0 R /MediaBox[ 0 0 612 792]/Parent 2 0 R /Resources<</ExtGState<</FXE1 6 0 R >>/Font<</FXF1 5 0 R >>${xobj}>>/Type/Page>>`],
    [5, '<</BaseFont/Helvetica/Encoding/WinAnsiEncoding/Subtype/Type1/Type/Font>>'],
    [6, '<</BM/Normal/CA 1/ca 1>>'],
    [7, null],
  ];
  if (VARIANT === 'orphan') {
    const old = `q BT /F1 18 Tf 1 0 0 1 72 650 Tm ${OLD_TJ} ET Q\n`;
    objs.push([8, `<</Length ${old.length}>>stream\r\n${old}\r\nendstream`]);
  }
  if (VARIANT === 'overlay') objs.push([8, '<</BitsPerComponent 8/ColorSpace/DeviceGray/Height 1/Length 1/Subtype/Image/Type/XObject/Width 1>>stream\r\n\xff\r\nendstream']);
  const chunks = [];
  let len = 0;
  const push = (u8) => { chunks.push(u8); len += u8.length; };
  push(enc('%PDF-1.7\r\n%\xa1\xb3\xc5\xd7\r\n'));
  const offs = {};
  for (const [num, body] of objs) {
    offs[num] = len;
    if (num === 7) {
      push(enc(`7 0 obj\r\n<</Filter/FlateDecode/Length ${z.length}>>stream\r\n`));
      push(z);
      push(enc('\r\nendstream\r\nendobj\r\n'));
    } else {
      push(enc(`${num} 0 obj\r\n${body}\r\nendobj\r\n`));
    }
  }
  const xr = len;
  const last = objs[objs.length - 1][0];
  let x = 'xref\r\n0 4\r\n0000000000 65535 f\r\n';
  for (const n of [1, 2, 3]) x += `${String(offs[n]).padStart(10, '0')} 00000 n\r\n`;
  x += `5 ${last - 4}\r\n`;
  for (let n = 5; n <= last; n++) x += `${String(offs[n]).padStart(10, '0')} 00000 n\r\n`;
  x += `trailer\r\n<</Root 1 0 R /Size ${last + 1}/ID[<6E6F626C65706466706861736538763200><6E6F626C65706466706861736538763200>]>>\r\nstartxref\r\n${xr}\r\n%%EOF\r\n`;
  push(enc(x));
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// Original bytes plus an appended incremental revision (the fault a clean
// non-incremental save must never produce).
function buildIncremental(original, edit) {
  const s = Array.from(original, (c) => String.fromCharCode(c)).join('');
  const prev = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(s)[1];
  const content = `q BT /F1 18 Tf 1 0 0 1 72 650 Tm ${tjFor(edit.codes, edit.positions)} ET Q\nq BT /F1 12 Tf 1 0 0 1 72 620 Tm <${NB_HEX}> Tj ET Q\n`;
  let upd = '';
  const base = original.length;
  const off6 = base + upd.length;
  upd += `6 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`;
  const off3 = base + upd.length;
  upd += '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>\nendobj\n';
  const xr = base + upd.length;
  upd += `xref\n0 1\n0000000000 65535 f \n3 1\n${String(off3).padStart(10, '0')} 00000 n \n6 1\n${String(off6).padStart(10, '0')} 00000 n \n`;
  upd += `trailer\n<< /Size 7 /Root 1 0 R /Prev ${prev} >>\nstartxref\n${xr}\n%%EOF\n`;
  const tail = enc(upd);
  const out = new Uint8Array(original.length + tail.length);
  out.set(original, 0);
  out.set(tail, original.length);
  return out;
}

export async function init(overrides) {
  // 'fallback' ignores every override: the glue then fetches its own pdfium.wasm by URL.
  const wrapped = await stockInit(VARIANT === 'fallback' ? {} : overrides);
  const m = wrapped.pdfium;
  const edits = new Map();
  let last = null;
  let lastLoaded = null;

  const stockLoad = wrapped.FPDF_LoadMemDocument;
  wrapped.FPDF_LoadMemDocument = (ptr, size, pw) => {
    lastLoaded = m.HEAPU8.slice(ptr >>> 0, (ptr >>> 0) + (size >>> 0));
    return stockLoad(ptr, size, pw);
  };
  const stockSetCharcodes = wrapped.FPDFText_SetCharcodes;
  wrapped.FPDFText_SetCharcodes = (obj, ptr, count) => {
    const ok = stockSetCharcodes(obj, ptr, count);
    if (ok) {
      const dv = new DataView(m.HEAPU8.buffer);
      const codes = [];
      for (let i = 0; i < count; i++) codes.push(dv.getUint32((ptr >>> 0) + 4 * i, true));
      last = { obj, codes, positions: null, original: lastLoaded };
      edits.set(obj, last);
    }
    return ok;
  };
  const setPositions = (obj, ptr, count) => {
    if (VARIANT === 'noop') return true;
    const e = edits.get(obj);
    if (!e || count !== e.codes.length - 1 || (count && !ptr)) return false;
    const dv = new DataView(m.HEAPU8.buffer);
    const pos = [];
    for (let i = 0; i < count; i++) {
      const v = dv.getFloat32((ptr >>> 0) + 4 * i, true);
      if (!Number.isFinite(v)) return false;
      pos.push(v);
    }
    e.positions = pos;
    return true;
  };
  wrapped.FPDFText_SetPositions = setPositions;
  m._FPDFText_SetPositions = setPositions; // stands in for the real wasm export

  const stockSave = wrapped.FPDF_SaveAsCopy;
  wrapped.FPDF_SaveAsCopy = (doc, writer, flags) => {
    const e = last;
    last = null;
    if (!e || !e.positions) return stockSave(doc, writer, flags);
    const bytes = VARIANT === 'incremental' ? buildIncremental(e.original, e) : buildRewrite(e);
    const dv = new DataView(m.HEAPU8.buffer);
    const writeBlock = m.wasmExports.__indirect_function_table.get(dv.getUint32((writer >>> 0) + 4, true));
    const half = Math.floor(bytes.length / 2);
    for (const part of [bytes.subarray(0, half), bytes.subarray(half)]) {
      const p = m.wasmExports.malloc(part.length);
      m.HEAPU8.set(part, p);
      const ok = writeBlock(writer, p, part.length);
      m.wasmExports.free(p);
      if (!ok) return false;
    }
    return true;
  };
  return wrapped;
}
