// Phase 10B clipping test inputs (tests only; independent of the lab code). Builds synthetic
// PDFs and clipped variants of the pinned Phase 9 fixtures. The fixtures keep their fonts
// (standard-14, embedded simple TrueType, Type0/CIDFontType2); only the page content stream
// is rewritten (a text block wrapped in a clip) and the file is re-serialized with a fresh
// classic cross-reference table. The generator patterns (Word, LibreOffice, Chromium/Skia)
// are models of the page-clip operators those producers write, not their output.
const bytesOf = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const latin1 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return s; };
const pad10 = (n) => String(n).padStart(10, '0');
const HELV = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

// Objects of a classic, uncompressed-object PDF (all fixture streams have a direct /Length).
function objectsOf(s) {
  const out = [];
  const re = /(\d+) (\d+) obj\b/g;
  let m;
  while ((m = re.exec(s))) {
    const bodyStart = m.index + m[0].length;
    let k = s.indexOf('endobj', bodyStart);
    const si = s.indexOf('stream', bodyStart);
    if (si !== -1 && si < k && !/endstream/.test(s.slice(bodyStart, si))) {
      const dict = s.slice(bodyStart, si);
      const L = /\/Length (\d+)/.exec(dict);
      if (!L) throw new Error(`object ${m[1]}: stream without a direct /Length`);
      const ds = s[si + 6] === '\r' ? si + 8 : si + 7;
      const de = ds + Number(L[1]);
      k = s.indexOf('endobj', de);
      out.push({ num: +m[1], gen: +m[2], dict, data: s.slice(ds, de), tail: s.slice(de, k) });
    } else out.push({ num: +m[1], gen: +m[2], body: s.slice(bodyStart, k) });
    re.lastIndex = k + 6;
  }
  return out;
}
function serialize(objs, trailerDict) {
  let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offs = new Map();
  for (const o of objs) {
    offs.set(o.num, out.length);
    if (o.body !== undefined) out += `${o.num} ${o.gen} obj${o.body}endobj\n`;
    else out += `${o.num} ${o.gen} obj${o.dict.replace(/\/Length \d+/, `/Length ${o.data.length}`)}stream\n${o.data}${o.tail}endobj\n`;
  }
  const size = Math.max(...objs.map((o) => o.num)) + 1;
  const x = out.length;
  out += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n < size; n++) out += offs.has(n) ? `${pad10(offs.get(n))} 00000 n \n` : '0000000000 65535 f \n';
  out += `trailer\n<<${trailerDict.replace(/\/Size \d+/, `/Size ${size}`)}>>\nstartxref\n${x}\n%%EOF\n`;
  return bytesOf(out);
}
// Rewrites the (single) page content stream of a one-page classic PDF.
export function rewriteContent(bytes, fn) {
  const s = latin1(bytes);
  const objs = objectsOf(s);
  const c = /\/Contents (\d+) 0 R/.exec(s);
  if (!c) throw new Error('no /Contents reference');
  const target = objs.find((o) => o.num === Number(c[1]) && o.data !== undefined);
  if (!target) throw new Error('content stream not found');
  target.data = fn(target.data);
  const t = /trailer\s*<<([\s\S]*?)>>\s*startxref/.exec(s);
  if (!t) throw new Error('trailer not found');
  return serialize(objs, t[1]);
}
// Wraps the BT ... ET block containing `needle` (content-stream text, e.g. a hex string) in
// `q <clip> ... Q`.
export function wrapBlock(content, needle, clip) {
  const at = content.indexOf(needle);
  if (at < 0) throw new Error(`block with ${needle} not found`);
  const bt = content.lastIndexOf('BT', at);
  const et = content.indexOf('ET', at);
  if (bt < 0 || et < 0) throw new Error('BT/ET not found');
  return `${content.slice(0, bt)}q ${clip} ${content.slice(bt, et + 2)} Q${content.slice(et + 2)}`;
}
export const clipFixture = (bytes, clip) => rewriteContent(bytes, (c) => `q ${clip}\n${c}\nQ`);
export const clipBlock = (bytes, needle, clip) => rewriteContent(bytes, (c) => wrapBlock(c, needle, clip));

// One page, Helvetica (WinAnsi), arbitrary content; extra objects appended (forms etc.).
export function helvPdf(content, { extraObjects = [], resources = '' } = {}) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [18 18 594 774] /Resources << /Font << /F1 5 0 R >>${resources} >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, HELV, ...extraObjects];
  let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${pad10(o)} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return bytesOf(out);
}
export const LINE = (text, x = 72, y = 700, size = 12) => `BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm (${text}) Tj ET`;

// Generator patterns (models of the operators, see the header).
// Microsoft Word: every text block in q ... Q with a page-size rectangle, even-odd, tagged.
export const wordLike = () => helvPdf([
  `/P <</MCID 0>> BDC q 0.000008871 0 595.32 841.92 re W* n BT /F1 11.04 Tf 1 0 0 1 72.024 709.54 Tm [(Invoice Number: 12345)] TJ ET Q EMC`,
  `/P <</MCID 1>> BDC q 0.000008871 0 595.32 841.92 re W* n BT /F1 11.04 Tf 1 0 0 1 72.024 690.1 Tm [(Total due: 570.00)] TJ ET Q EMC`,
].join('\n'));
// LibreOffice: one page-size even-odd clip opened in an Artifact at the start, closed at the end.
export const libreOfficeLike = () => helvPdf([
  '0.1 w /Artifact BMC q 0 0.028 612 791.972 re W* n EMC',
  '/P <</MCID 0>> BDC q 0 0 0 rg BT 56.8 700.2 Td /F1 12 Tf (Invoice Number: 12345) Tj ET Q EMC',
  '/P <</MCID 1>> BDC q 0 0 0 rg BT 56.8 680.2 Td /F1 12 Tf (Total due: 570.00) Tj ET Q EMC',
  'Q',
].join('\n'));
// Chromium/Skia: flipped, scaled device transform, content-area rectangle (even-odd), text
// with a flipped text matrix inside a scaled CTM.
export const skiaLike = () => helvPdf([
  '.75 0 0 -.75 0 792 cm q 48 48 720 960 re W* n q 1 0 0 1 72 96 cm',
  'BT /F1 16 Tf 1 0 0 -1 0 25 Tm (Invoice Number: 12345) Tj ET',
  'BT /F1 16 Tf 1 0 0 -1 0 55 Tm (Total due: 570.00) Tj ET',
  'Q Q',
].join('\n'));
// Text drawn in a Form XObject whose own content clips; a direct text object after the Do.
export const formClip = () => helvPdf(`/Fm1 Do\n${LINE('Direct after form 42', 72, 600)}`, {
  resources: ' /XObject << /Fm1 6 0 R >>',
  extraObjects: [(() => { const f = `q 72 690 20 20 re W n ${LINE('Form text 123')} Q`; return `<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Length ${f.length} >>\nstream\n${f}\nendstream`; })()],
});
// Text clipping render mode (Tr 7) installs a clip PDFium does not count as a path.
export const textClip = () => helvPdf(`q BT 7 Tr /F1 40 Tf 1 0 0 1 60 680 Tm (CLIPMASK) Tj ET 0 Tr ${LINE('Clipped cell value 99')} Q`);
// A ligature glyph: code 0x41 draws "A" but ToUnicode maps it to "ff" (U+0066 U+0066).
export function ligaturePdf() {
  const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Lig def 1 begincodespacerange <00> <FF> endcodespacerange 2 beginbfchar <41> <00660066> <42> <0042> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end';
  const content = `BT /F1 12 Tf 1 0 0 1 72 700 Tm (cut oA) Tj ET\n${LINE('Plain line 7', 72, 680)}`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 6 0 R >>',
    `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`];
  let out = '%PDF-1.7\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${pad10(o)} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return bytesOf(out);
}
