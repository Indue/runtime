// Synthetic Phase 10 test inputs (tests only; independent of the lab code). Each builder
// returns the bytes of one small PDF (or non-PDF) that exercises a corpus-intake path:
// multi-page with metadata, incremental update, cross-reference stream + object stream,
// malformed, not a PDF, and a user-password encrypted document. No third-party content.
import { createHash } from 'node:crypto';

const bytesOf = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const pad10 = (n) => String(n).padStart(10, '0');
const stream = (data, dict = '') => `<< /Length ${data.length}${dict ? ` ${dict}` : ''} >>\nstream\n${data}\nendstream`;
const HELV = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

// Classic cross-reference table. objs[i] is the body of object i+1.
function classic(objs, trailer, header = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n') {
  let out = header;
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${pad10(o)} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} ${trailer} >>\nstartxref\n${x}\n%%EOF\n`;
  return { text: out, xref: x };
}

// Three pages with text on every page (page 3 rotated); `ref` changes page 2 only, so two
// variants differ in exactly one page (used to test D01 without an edit).
export function multipagePdf(ref = 'ABC-123') {
  const c1 = 'BT /F1 18 Tf 72 700 Td (Page one heading) Tj ET\nBT /F1 12 Tf 72 660 Td (Invoice Number: 12345) Tj ET';
  const c2 = `BT /F1 12 Tf 72 700 Td (Second page line) Tj ET\nBT /F1 12 Tf 72 670 Td (Reference code ${ref}) Tj ET`;
  const c3 = 'BT /F1 12 Tf 72 700 Td (Rotated page text) Tj ET';
  const page = (c, extra = '') => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents ${c} 0 R${extra} >>`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>', page(4), stream(c1), page(6), stream(c2), page(8, ' /Rotate 90'), stream(c3), HELV,
    '<< /Producer (Microsoft\\256 Word for Microsoft 365) /Creator (Microsoft\\256 Word for Microsoft 365) >>'];
  return bytesOf(classic(objs, '/Root 1 0 R /Info 10 0 R').text);
}

// Three pages where only page 2 has text; pages 1 and 3 (rotated) hold vector graphics.
export function multipageGraphicsPdf() {
  const g1 = '0.2 0.4 0.8 rg 72 560 240 120 re f\n1 w 0 0 0 RG 72 520 m 400 520 l S';
  const c2 = 'BT /F1 12 Tf 72 700 Td (Second page line) Tj ET\nBT /F1 12 Tf 72 670 Td (Reference code ABC-123) Tj ET';
  const g3 = '0.8 0.2 0.2 rg 100 100 50 50 re f';
  const page = (c, extra = '') => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents ${c} 0 R${extra} >>`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>', page(4), stream(g1), page(6), stream(c2), page(8, ' /Rotate 90'), stream(g3), HELV];
  return bytesOf(classic(objs, '/Root 1 0 R').text);
}

// A one-page document plus one appended incremental update that replaces the content
// stream (12345 -> 67890) and adds an Info dictionary.
export function incrementalPdf() {
  const content = (n) => stream(`BT /F1 12 Tf 72 700 Td (Invoice Number: ${n}) Tj ET\nBT /F1 12 Tf 72 670 Td (Status: DRAFT) Tj ET`);
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', content(12345), HELV];
  const base = classic(objs, '/Root 1 0 R');
  let out = base.text;
  const o4 = out.length;
  out += `4 0 obj\n${content(67890)}\nendobj\n`;
  const o6 = out.length;
  out += '6 0 obj\n<< /Producer (LibreOffice 7.6) >>\nendobj\n';
  const x = out.length;
  out += `xref\n0 1\n0000000000 65535 f \n4 1\n${pad10(o4)} 00000 n \n6 1\n${pad10(o6)} 00000 n \n`;
  out += `trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R /Prev ${base.xref} >>\nstartxref\n${x}\n%%EOF\n`;
  return bytesOf(out);
}

// Catalog, pages, page, font and Info live in an (uncompressed) object stream; the
// content stream is a regular object; the cross-reference section is a stream.
export function xrefStreamPdf() {
  const inner = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 4 0 R >>', HELV, '<< /Producer (Skia/PDF m128) /Creator (Mozilla/5.0 Chrome/128.0.0.0) >>'];
  const nums = [1, 2, 3, 6, 7];
  let bodies = '';
  const head = [];
  inner.forEach((b, i) => { head.push(`${nums[i]} ${bodies.length}`); bodies += `${b}\n`; });
  const headStr = `${head.join(' ')}\n`;
  let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const off = {};
  off[4] = out.length;
  out += `4 0 obj\n${stream('BT /F1 12 Tf 72 700 Td (Chrome printed line) Tj ET')}\nendobj\n`;
  off[5] = out.length;
  out += `5 0 obj\n${stream(headStr + bodies, `/Type /ObjStm /N ${inner.length} /First ${headStr.length}`)}\nendobj\n`;
  off[8] = out.length;
  const rows = [[0, 0, 65535], [2, 5, 0], [2, 5, 1], [2, 5, 2], [1, off[4], 0], [1, off[5], 0], [2, 5, 3], [2, 5, 4], [1, off[8], 0]];
  let bin = '';
  for (const [t, a, b] of rows) bin += String.fromCharCode(t, (a >>> 24) & 255, (a >>> 16) & 255, (a >>> 8) & 255, a & 255, (b >>> 8) & 255, b & 255);
  out += `8 0 obj\n${stream(bin, '/Type /XRef /Size 9 /W [1 4 2] /Root 1 0 R /Info 7 0 R')}\nendobj\n`;
  out += `startxref\n${off[8]}\n%%EOF\n`;
  return bytesOf(out);
}

export function malformedPdf() {
  let junk = '';
  for (let i = 0; i < 600; i++) junk += String.fromCharCode((i * 73 + 41) % 251);
  return bytesOf(`%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R\n${junk}\nstartxref\n999999\n%%EOF\n`);
}

export function notPdf() {
  return bytesOf('This is a plain text file with a .pdf extension. It is not a PDF.\n');
}

// Standard security handler, V1 R2 (40-bit RC4), user password "secret". PDFium must refuse
// to open it without the password (FPDF_ERR_PASSWORD); the content is never reached.
const PADDING = [0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a];
function rc4(key, data) {
  const s = [...Array(256).keys()];
  let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
  let i = 0;
  j = 0;
  return data.map((b) => { i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]]; return b ^ s[(s[i] + s[j]) & 255]; });
}
const padPw = (pw) => [...bytesOf(pw), ...PADDING].slice(0, 32);
const md5 = (arr) => [...createHash('md5').update(Buffer.from(arr)).digest()];
const hex = (arr) => arr.map((b) => b.toString(16).padStart(2, '0')).join('');
export function passwordPdf(userPw = 'secret', ownerPw = 'owner-secret') {
  const id = [...createHash('md5').update('noblepdf-phase10-password-fixture').digest()];
  const O = rc4(md5(padPw(ownerPw)).slice(0, 5), padPw(userPw));
  const P = -44;
  const pBytes = [P & 255, (P >> 8) & 255, (P >> 16) & 255, (P >> 24) & 255];
  const key = md5([...padPw(userPw), ...O, ...pBytes, ...id]).slice(0, 5);
  const U = rc4(key, PADDING.slice());
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>', stream('encrypted content placeholder'),
    `<< /Filter /Standard /V 1 /R 2 /O <${hex(O)}> /U <${hex(U)}> /P ${P} >>`];
  return bytesOf(classic(objs, `/Root 1 0 R /Encrypt 5 0 R /ID [<${hex(id)}> <${hex(id)}>]`).text);
}

export const INPUTS = Object.freeze({
  'p10-multipage.pdf': () => multipagePdf(), 'p10-multipage-graphics.pdf': multipageGraphicsPdf, 'p10-incremental.pdf': incrementalPdf, 'p10-xref-stream.pdf': xrefStreamPdf,
  'p10-malformed.pdf': malformedPdf, 'p10-not-a-pdf.pdf': notPdf, 'p10-password.pdf': passwordPdf,
});
