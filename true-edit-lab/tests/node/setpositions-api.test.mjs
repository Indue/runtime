// F15: direct tests of the real Run #10 FPDFText_SetPositions API (and what the lab
// relies on). Every assertion here is discriminating: each one fails on an engine or
// wrapper that ignores positions, accepts count 0, or places glyph 0 away from 0.
// Usage: node tests/node/setpositions-api.test.mjs   (PATCHED_ENGINE_DIR=<dir with index.js + pdfium.wasm>)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadEngine } from './lib/engine-node.mjs';
import { monotonic } from '../../public_html/app.noblepdf.com/lab/true-text-edit/te-edit.mjs';

const E = await loadEngine('patched');
function pdf(content) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'];
  let out = '%PDF-1.7\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Uint8Array.from(out, (c) => c.codePointAt(0));
}
const CONTENT = [
  'BT /F1 12 Tf 72 700 Td (X) Tj ET',
  'BT /F1 12 Tf 72 680 Td (Blue text) Tj ET',
  'BT /F1 12 Tf 72 660 Td [-400 (Lead)] TJ ET',
  'BT /F1 12 Tf 150 Tz 72 640 Td (Wide) Tj 100 Tz ET',
].join('\n');
const snapshot = (bytes) => E.withDoc(bytes, 0, (o) => {
  const g = E.groups(o.textPage);
  return g.list.map((gr) => ({ text: gr.realText, origins: gr.real.map((gi) => E.charOrigin(o.textPage, g.chars[gi].unit)), matrix: E.matrix(gr.obj) }));
});
const raw = (o, obj, arr, count, nullPtr = false) => {
  const ptr = nullPtr ? 0 : E.malloc(Math.max(4, arr.length * 4));
  try { arr.forEach((v, i) => E.dv().setFloat32(ptr + 4 * i, v, true)); return !!E.p.FPDFText_SetPositions(obj, ptr, count); } finally { if (ptr) E.free(ptr); }
};
const edit = (bytes, fn) => E.withDoc(bytes, 0, (o) => {
  const objs = E.objects(o.page);
  E.closeTextPage(o);
  const r = fn(o, objs);
  if (!E.p.FPDFPage_GenerateContent(o.page)) throw new Error('generate');
  return { r, out: E.saveNoIncremental(o.doc) };
});
const base = pdf(CONTENT);
const before = snapshot(base);

test('engine is the pinned Run #10 build with the SetPositions export', () => {
  assert.equal(typeof E.p.FPDFText_SetPositions, 'function');
  assert.deepEqual(E.missingApi(), []);
});

test('one-glyph object: count 0 is rejected with and without a pointer; the lab skips the call', () => {
  const { r, out } = edit(base, (o, objs) => ({
    codes: E.setCharcodes(objs[0], [89]),
    nullCount0: raw(o, objs[0], [], 0, true),
    ptrCount0: raw(o, objs[0], [1], 0),
    count1: raw(o, objs[0], [5], 1),
  }));
  assert.equal(r.codes, true);
  assert.equal(r.nullCount0, false, 'count 0 with NULL must be rejected');
  assert.equal(r.ptrCount0, false, 'count 0 with a pointer must be rejected');
  assert.equal(r.count1, false, 'count 1 for a one-glyph object is a count mismatch');
  const s = snapshot(out);
  assert.equal(s[0].text, 'Y');
  assert.ok(Math.abs(s[0].origins[0].x - before[0].origins[0].x) < 1e-6, 'glyph 0 stays at the object origin');
  assert.throws(() => E.setPositions(0, []), /one-glyph objects must skip this call/);
});

test('count mismatch, NaN and Infinity are rejected', () => {
  edit(base, (o, objs) => {
    assert.equal(raw(o, objs[1], [1, 2, 3], 3), false);
    assert.equal(raw(o, objs[1], [1, 2, 3, Number.NaN, 5, 6, 7, 8], 8), false);
    assert.equal(raw(o, objs[1], [1, 2, 3, Number.POSITIVE_INFINITY, 5, 6, 7, 8], 8), false);
  });
});

test('decreasing and negative positions are ACCEPTED by the engine, so the lab must refuse them', () => {
  edit(base, (o, objs) => {
    assert.equal(raw(o, objs[1], [8, 7, 6, 5, 4, 3, 2, 1], 8), true);
    assert.equal(raw(o, objs[1], [-1, -2, -3, -4, -5, -6, -7, -8], 8), true);
  });
  assert.equal(monotonic([0, 8, 7, 6]), false);
  assert.equal(monotonic([0, -1]), false);
  assert.equal(monotonic([0, 1, 1, 2]), true);
});

test('positions are honoured exactly (a +1 pt move of glyph 3 survives save and reopen)', () => {
  const xs = before[1].origins.map((q) => q.x - before[1].matrix[4]);
  const moved = xs.slice(1).map((x, i) => (i + 1 >= 3 ? x + 1 : x));
  const { r, out } = edit(base, (o, objs) => ({ c: E.setCharcodes(objs[1], [...'Blue text'].map((ch) => ch.codePointAt(0))), p: E.setPositions(objs[1], moved) }));
  assert.deepEqual(r, { c: true, p: true });
  const s = snapshot(out)[1];
  for (let i = 0; i < xs.length; i++) {
    const want = before[1].origins[i].x + (i >= 3 ? 1 : 0);
    assert.ok(Math.abs(s.origins[i].x - want) < 1e-3, `glyph ${i}: ${s.origins[i].x} vs ${want}`);
  }
});

test('identity round trip: SetCharcodes(same) + SetPositions(xs) moves nothing', () => {
  const xs = before[1].origins.map((q) => q.x - before[1].matrix[4]);
  const { out } = edit(base, (o, objs) => { E.setCharcodes(objs[1], [...'Blue text'].map((ch) => ch.codePointAt(0))); return E.setPositions(objs[1], xs.slice(1)); });
  const s = snapshot(out)[1];
  const d = Math.max(...s.origins.map((q, i) => Math.abs(q.x - before[1].origins[i].x)));
  assert.ok(d < 1e-4, `drift ${d}`);
});

test('leading TJ offset is folded into the object matrix; glyph 0 is at object-space 0', () => {
  const lead = before[2];
  assert.equal(lead.text, 'Lead');
  assert.ok(Math.abs(lead.matrix[4] - (72 + 0.4 * 12)) < 1e-4, `matrix e ${lead.matrix[4]}`);
  assert.ok(Math.abs(lead.origins[0].x - lead.matrix[4]) < 1e-4, 'x0 must be 0 in object space');
});

test('Tz is part of the object matrix, so object-space positions are unscaled', () => {
  const wide = before[3];
  assert.ok(Math.abs(wide.matrix[0] - 1.5) < 1e-6, `matrix a ${wide.matrix[0]}`);
  const x1 = (wide.origins[1].x - wide.matrix[4]) / wide.matrix[0];
  assert.ok(Math.abs(x1 - 944 * 12 / 1000) < 1e-3, `object-space x1 ${x1} (Helvetica W = 944)`);
});
