// Unit tests for phase8-verify.mjs (NoblePDF True Edit Phase 8 V2 lab).
// Run from the package root:  node --test tests/unit/
// Requires Node 20 or newer (WebCrypto, DecompressionStream, Blob, Response).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  sha256Hex, sha384Base64, latin1, scanPdf, analyzeStructure, decodeAllStreams, scanContent,
  streamTextEvidence, pdfjsLines, comparePixels, tjGlyphOrigins, maxAbsDiff, summarizeGates, startsWithBytes,
} from '../../public_html/app.noblepdf.com/lab/true-text-edit/phase8-verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const LAB = path.join(here, '../../public_html/app.noblepdf.com/lab/true-text-edit');
const read = (p) => new Uint8Array(readFileSync(p));
// The V2 package does not redistribute the V1 fixtures; they stay where V1 deployed them.
// Point FIXTURES_DIR at a V1 fixtures-phase8 folder (the audit pack or the live copy).
const FIX = process.env.FIXTURES_DIR || path.join(LAB, 'fixtures-phase8');
const BEFORE = read(path.join(FIX, 'pure-tj-before.pdf'));
const REFERENCE = read(path.join(FIX, 'pure-tj-reference.pdf'));
const STOCK_SAMPLE = read(path.join(here, 'samples/stock-2.15.1-setcharcodes-only.pdf'));
const NEIGHBOUR = 'Neighbouring context line must not move';
const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

// Tiny classic-xref PDF builder for synthetic fault files.
function buildPdf(objs, { header = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', trailerExtra = '' } = {}) {
  let out = header;
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${xref}\n%%EOF\n`;
  return enc(out);
}
const page = (extraRes = '') => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> ${extraRes}>> /Contents 4 0 R >>`;
const font = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
const stream = (content) => `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
const CONTENT_NEW = `q BT /F1 18 Tf 1 0 0 1 72 650 Tm <544F4B594F4C414B45> Tj ET Q\nq BT /F1 12 Tf 1 0 0 1 72 620 Tm (${NEIGHBOUR}) Tj ET Q`;
const CONTENT_OLD = 'q BT /F1 18 Tf 1 0 0 1 72 650 Tm [<57> 120 <41> -80 <56> 200 <45> -40 <53> 60 <4B45524E>] TJ ET Q';

test('sha256Hex and sha384Base64 match node:crypto', async () => {
  const data = enc('abc');
  assert.equal(await sha256Hex(data), createHash('sha256').update('abc').digest('hex'));
  assert.equal(await sha384Base64(data), createHash('sha384').update('abc').digest('base64'));
  assert.equal(await sha256Hex(BEFORE), '12f6055ccf4221a931cb4b8e48a16ba9150a782b229b6ee76adec3e16acab305');
  assert.equal(await sha256Hex(REFERENCE), '17202332e5b3531f568ea5166fe687368bca9dc5ef732d305876c3a4ed8882f9');
});

test('latin1 is byte exact', () => {
  const b = Uint8Array.from([0x25, 0x80, 0x9f, 0xff, 0x00]);
  const s = latin1(b);
  assert.equal(s.length, 5);
  assert.deepEqual(Array.from(s, (c) => c.charCodeAt(0)), [0x25, 0x80, 0x9f, 0xff, 0x00]);
});

test('before fixture: valid classic xref, but identical to original so not a rewrite', () => {
  const a = analyzeStructure(BEFORE, BEFORE);
  assert.equal(a.xref.classic, true);
  assert.deepEqual(a.xref.invalid, []);
  assert.equal(a.xref.inUse, 5);
  assert.equal(a.eofCount, 1);
  assert.equal(a.eofAtEnd, true);
  assert.equal(a.identicalToOriginal, true);
  assert.equal(a.singleRevision, false, 'an unmodified copy must not count as a clean rewrite');
});

test('reference fixture: valid single-revision classic file', () => {
  const a = analyzeStructure(REFERENCE, BEFORE);
  assert.deepEqual(a.xref.invalid, []);
  assert.equal(a.singleRevision, true);
});

test('stock PDFium 2.15.1 writer output: single revision, renumbered, not an append', async () => {
  const a = analyzeStructure(STOCK_SAMPLE, BEFORE);
  assert.equal(a.singleRevision, true, JSON.stringify({ ...a, scan: undefined }));
  assert.deepEqual(a.xref.subsections, [[0, 4], [5, 3]]);
  assert.equal(a.xref.inUse, 6);
  assert.equal(a.samePrefix64, false);
  assert.equal(a.startsWithOriginal, false);
  assert.equal(a.prevCount, 0);
  const streams = await decodeAllStreams(STOCK_SAMPLE, a.scan);
  assert.equal(streams.length, 1);
  assert.deepEqual(streams[0].filters, ['FlateDecode']);
  const text = latin1(streams[0].decoded);
  assert.match(text, /<544F4B594F4C414B45> Tj/);
  const sc = scanContent(text);
  assert.deepEqual(sc.blocks.map((b) => b.text), ['TOKYOLAKE', NEIGHBOUR]);
  assert.deepEqual(sc.blocks.map((b) => b.trModes), [[0], [0]]);
  assert.equal(sc.doCount, 0);
  const ev = streamTextEvidence(a.scan, streams, 'WAVESKERN');
  assert.deepEqual(ev.hits, []);
});

test('scanner sees the old text in the before fixture (positive control)', async () => {
  const scan = scanPdf(BEFORE);
  const streams = await decodeAllStreams(BEFORE, scan);
  const ev = streamTextEvidence(scan, streams, 'WAVESKERN');
  assert.ok(ev.hits.length > 0);
  assert.deepEqual(ev.blocks.map((b) => b.text), ['WAVESKERN', NEIGHBOUR]);
  const evNew = streamTextEvidence(scan, streams, 'TOKYOLAKE');
  assert.deepEqual(evNew.hits, []);
});

test('incremental append is flagged', () => {
  const beforeText = latin1(BEFORE);
  const base = BEFORE.length;
  let upd = '';
  const off6 = base + upd.length;
  upd += `6 0 obj\n${stream(CONTENT_NEW)}\nendobj\n`;
  const off3 = base + upd.length;
  upd += `3 0 obj\n${page().replace('4 0 R', '6 0 R')}\nendobj\n`;
  const xr = base + upd.length;
  upd += `xref\n0 1\n0000000000 65535 f \n3 1\n${String(off3).padStart(10, '0')} 00000 n \n6 1\n${String(off6).padStart(10, '0')} 00000 n \n`;
  upd += `trailer\n<< /Size 7 /Root 1 0 R /Prev ${/startxref\s+(\d+)/.exec(beforeText)[1]} >>\nstartxref\n${xr}\n%%EOF\n`;
  const inc = new Uint8Array([...BEFORE, ...enc(upd)]);
  const a = analyzeStructure(inc, BEFORE);
  assert.equal(a.eofCount, 2);
  assert.equal(a.startxrefCount, 2);
  assert.equal(a.prevCount, 1);
  assert.equal(a.startsWithOriginal, true);
  assert.equal(a.singleRevision, false);
  assert.ok(startsWithBytes(inc, BEFORE));
});

test('orphaned old content stream is found even when unreferenced', async () => {
  const pdf = buildPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', page(), stream(CONTENT_NEW), font, stream(CONTENT_OLD)]);
  const a = analyzeStructure(pdf, BEFORE);
  assert.equal(a.singleRevision, true, 'structure alone cannot see an orphan');
  const streams = await decodeAllStreams(pdf, a.scan);
  const ev = streamTextEvidence(a.scan, streams, 'WAVESKERN');
  assert.ok(ev.hits.some((h) => h.startsWith('object 6')), JSON.stringify(ev.hits));
});

test('Flate-compressed orphan is inflated and found', async () => {
  const z = deflateSync(Buffer.from(CONTENT_OLD, 'latin1'));
  const zs = latin1(new Uint8Array(z));
  const pdf = buildPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', page(), stream(CONTENT_NEW), font, `<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n${zs}\nendstream`]);
  const a = analyzeStructure(pdf, BEFORE);
  const streams = await decodeAllStreams(pdf, a.scan);
  assert.equal(streams[1].error, null);
  const ev = streamTextEvidence(a.scan, streams, 'WAVESKERN');
  assert.ok(ev.hits.length > 0);
});

test('unsupported filters fail closed', async () => {
  const pdf = buildPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', page(), stream(CONTENT_NEW), font, '<< /Length 4 /Filter /LZWDecode >>\nstream\nABCD\nendstream']);
  const a = analyzeStructure(pdf, BEFORE);
  const streams = await decodeAllStreams(pdf, a.scan);
  const ev = streamTextEvidence(a.scan, streams, 'WAVESKERN');
  assert.equal(ev.undecodable, 1);
  assert.ok(ev.hits.length > 0);
});

test('invisible text, XObject painting and inline images are reported', () => {
  const sc = scanContent('q BT /F1 18 Tf 3 Tr 1 0 0 1 72 650 Tm (WAVESKERN) Tj ET Q q 1 0 0 1 500 50 cm /Im1 Do Q BI /W 1 /H 1 /CS /G /BPC 8 ID \xff EI BT /F1 9 Tf (X) Tj ET');
  assert.equal(sc.invisibleShows, 1);
  assert.equal(sc.doCount, 1);
  assert.equal(sc.inlineImages, 1);
  assert.deepEqual(sc.blocks.map((b) => b.text), ['WAVESKERN', 'X']);
  assert.deepEqual(sc.blocks[1].trModes, [0], 'q/Q restores the text render mode');
});

test('literal strings with escapes, octal and nested parentheses', () => {
  const sc = scanContent('BT (W\\101VES\\(K\\) (n)) Tj [(TO) -10 <4B59>] TJ ET');
  assert.deepEqual(sc.blocks.map((b) => b.text), ['WAVES(K) (n)TOKY']);
});

test('bad xref offset is reported', () => {
  const pdf = buildPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', page(), stream(CONTENT_NEW), font]);
  const s = latin1(pdf).replace(/0000000015 00000 n/, '0000000016 00000 n');
  const a = analyzeStructure(enc(s), BEFORE);
  assert.equal(a.xref.invalid.length, 1);
  assert.equal(a.singleRevision, false);
});

test('indirect /Length is resolved', () => {
  const c = CONTENT_NEW;
  const pdf = buildPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', page(), `<< /Length 6 0 R >>\nstream\n${c}\nendstream`, font, String(c.length)]);
  const scan = scanPdf(pdf);
  const s4 = scan.objects.find((o) => o.num === 4);
  assert.equal(s4.stream.declaredLength, c.length);
  assert.equal(s4.stream.lengthOk, true);
});

test('pdfjsLines matches PDF.js 3.11.174 item layout for the fixture', () => {
  const items = [
    { str: 'TOKYOLAKE', hasEOL: false }, { str: '', hasEOL: true }, { str: NEIGHBOUR, hasEOL: false },
  ];
  assert.deepEqual(pdfjsLines(items), ['TOKYOLAKE', NEIGHBOUR]);
  assert.deepEqual(pdfjsLines([{ str: 'T', hasEOL: false }, { str: ' ', hasEOL: false }, { str: 'OKYOL AKE', hasEOL: true }]), ['T OKYOL AKE']);
});

test('comparePixels thresholds and row exclusion', () => {
  const mk = () => ({ width: 2, height: 2, data: new Uint8ClampedArray(16).fill(255) });
  const a = mk();
  const b = mk();
  assert.deepEqual(comparePixels(a, b), { comparable: true, compared: 4, overTolerance: 0, anyDifference: 0, maxDelta: 0, tolerance: 8 });
  b.data[4] = 255 - 9;
  let r = comparePixels(a, b);
  assert.equal(r.overTolerance, 1);
  assert.equal(r.maxDelta, 9);
  b.data[4] = 255 - 8;
  r = comparePixels(a, b);
  assert.equal(r.overTolerance, 0);
  assert.equal(r.anyDifference, 1);
  b.data[4] = 0;
  r = comparePixels(a, b, { excludeRows: [0, 1] });
  assert.equal(r.compared, 2);
  assert.equal(r.overTolerance, 0);
  assert.equal(comparePixels(a, { width: 3, height: 2, data: new Uint8ClampedArray(24) }).comparable, false);
});

test('hand-calculated glyph origins for both fixture texts', () => {
  const AFM = { 87: 944, 65: 667, 86: 667, 69: 667, 83: 667, 75: 667, 82: 722, 78: 722, 84: 611, 79: 778, 89: 667, 76: 556 };
  const cp = (t) => Array.from(t, (c) => c.codePointAt(0));
  const before = tjGlyphOrigins(cp('WAVESKERN'), { 0: 120, 1: -80, 2: 200, 3: -40, 4: 60 }, AFM, 18);
  assert.ok(maxAbsDiff(before, [0, 14.832, 28.278, 36.684, 49.41, 60.336, 72.342, 84.348, 97.344]) < 1e-9);
  const natural = tjGlyphOrigins(cp('TOKYOLAKE'), {}, AFM, 18);
  assert.ok(maxAbsDiff(natural, [0, 10.998, 25.002, 37.008, 49.014, 63.018, 73.026, 85.032, 97.038]) < 1e-9);
  // Legacy (old origins) vs natural: the no-op SetPositions signature is 3.834 pt.
  assert.ok(Math.abs(maxAbsDiff(before, natural) - 3.834) < 1e-9);
});

test('summarizeGates treats informational rows as non-gating and empty as fail', () => {
  assert.deepEqual(summarizeGates([]), { pass: false, failed: [], gatedCount: 0 });
  assert.deepEqual(summarizeGates([{ id: 'A', pass: true }, { id: 'I', pass: false, gated: false }]), { pass: true, failed: [], gatedCount: 1 });
  assert.deepEqual(summarizeGates([{ id: 'A', pass: true }, { id: 'B', pass: false }, { id: 'C' }]).failed, ['B', 'C']);
});
