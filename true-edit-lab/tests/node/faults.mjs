// Fault injection: each fault reproduces a known defect or a known way to fake an edit.
// A fault test only counts as evidence on fixtures where the fault actually changes the
// result (discriminating); the run fails if any discriminating case is still committed,
// or if a fault never discriminates at all (a test that cannot fail proves nothing).
// Usage: node tests/node/faults.mjs [--json out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { loadEngine } from './lib/engine-node.mjs';
import { pdfjsProvider } from './lib/pdfjs-node.mjs';
import { runFixture } from '../../public_html/app.noblepdf.com/lab/true-text-edit/te-suite.mjs';
import { verifyEdit } from '../../public_html/app.noblepdf.com/lab/true-text-edit/te-pipeline.mjs';
import { toCodePoints } from '../../public_html/app.noblepdf.com/lab/true-text-edit/te-edit.mjs';
import { layoutReplacement } from '../../public_html/app.noblepdf.com/lab/true-text-edit/phase8-layout.mjs';
import { scanPdf, latin1 } from '../../public_html/app.noblepdf.com/lab/true-text-edit/phase8-verify.mjs';
import { OBJ } from '../../public_html/app.noblepdf.com/lab/true-text-edit/te-engine.mjs';

const DIR = new URL('../../public_html/app.noblepdf.com/lab/true-text-edit/fixtures-phase9/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', DIR)));
const load = async (n) => new Uint8Array(readFileSync(new URL(n, DIR)));
const E = await loadEngine('patched');
const pdfjs = await pdfjsProvider(3);
const committed = manifest.fixtures.filter((f) => f.expect.status === 'committed');
const enc = (s) => Uint8Array.from(s, (c) => c.codePointAt(0) & 0xff);
const maxAbs = (a, b) => (a.length !== b.length ? Infinity : a.reduce((m, x, i) => Math.max(m, Math.abs(x - b[i])), 0));

// ---- engine and plan faults (applied before or during mutation)
const noopSetPositions = Object.create(E);
noopSetPositions.setPositions = () => true;
const legacyAlwaysSetPositions = Object.create(E);
legacyAlwaysSetPositions.setCharcodes = function (obj, codes) {
  const ok = E.setCharcodes(obj, codes);
  if (ok && codes.length === 1 && !E.p.FPDFText_SetPositions(obj, 0, 0)) throw new Error('FPDFText_SetPositions(count 0) rejected (legacy path)');
  return ok;
};
const faults = [
  { id: 'FI-01', name: 'SetPositions is a no-op (stock engine or broken patch)', applyEngine: noopSetPositions, disc: (p) => p.discriminating },
  { id: 'FI-02', name: 'legacy F15: SetPositions called with count 0 for one-glyph results', applyEngine: legacyAlwaysSetPositions, disc: (p) => p.newCodes.length === 1 },
  { id: 'FI-03', name: 'legacy F7: character codes taken from Unicode (code == Unicode assumption)', planMutator: (p) => ({ ...p, newCodes: toCodePoints(p.newText) }), disc: (p) => JSON.stringify(toCodePoints(p.newText)) !== JSON.stringify(p.newCodes) },
  { id: 'FI-04', name: 'legacy F9: Run #10 layout with UTF-16 string indexing', planMutator: (p) => ({ ...p, xs: legacyXs(p) }), disc: (p) => maxAbs(legacyXs(p), p.xs) > 0.01 },
];
function legacyXs(p) {
  const o = p.analysis.objects[p.objIndex];
  const font = o.show.font;
  const run = { size: p.run.size, tc: p.run.tc, tw: p.run.tw, fontIsSimple: p.font.bytesPerCode === 1 };
  return layoutReplacement({ oldCodes: p.oldCodes, oldXs: o.xs, newCodes: p.newCodes, newText: p.newText, run, widthOf: (c) => font.width(c), fit: p.fit }).xs;
}

// ---- output tampering (applied to a correct committed output)
function rewriteWithExtraObject(bytes, body) {
  const s = latin1(bytes);
  const sc = scanPdf(bytes);
  const at = s.lastIndexOf('\nxref');
  const trailer = /trailer\s*<<([\s\S]*?)>>\s*startxref/.exec(s.slice(at))[1];
  const nums = sc.objects.map((o) => o.num);
  const n = Math.max(...nums) + 1;
  let head = s.slice(0, at + 1);
  const offs = new Map(sc.objects.map((o) => [o.num, o.offset]));
  offs.set(n, head.length);
  head += `${n} 0 obj\n${body}\nendobj\n`;
  const x = head.length;
  let xref = `xref\n0 ${n + 1}\n0000000000 65535 f \n`;
  for (let k = 1; k <= n; k++) xref += offs.has(k) ? `${String(offs.get(k)).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
  const tr = trailer.replace(/\/Size\s+\d+/, `/Size ${n + 1}`);
  return enc(`${head}${xref}trailer\n<<${tr}>>\nstartxref\n${x}\n%%EOF\n`);
}
const pdfiumTamper = (fn) => (bytes, plan) => E.withDoc(bytes, plan.pageIndex, (o) => {
  const objs = E.objects(o.page);
  const g = E.groups(o.textPage);
  E.closeTextPage(o);
  fn(o, objs, plan, g);
  if (!E.p.FPDFPage_GenerateContent(o.page)) throw new Error('generate');
  return E.saveNoIncremental(o.doc);
});
function utf16z(str) {
  const units = [];
  for (const ch of str) { const cp = ch.codePointAt(0); if (cp > 0xffff) units.push(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)); else units.push(cp); }
  const ptr = E.malloc((units.length + 1) * 2);
  units.forEach((u, i) => E.dv().setUint16(ptr + 2 * i, u, true));
  E.dv().setUint16(ptr + 2 * units.length, 0, true);
  return ptr;
}
const tampers = [
  { id: 'FT-01', name: 'incremental update appended (second revision, /Prev)', fn: (b) => { const s = latin1(b); const x = /startxref\s+(\d+)\s*%%EOF\s*$/.exec(s)[1]; const root = /\/Root\s+(\d+\s+\d+\s+R)/.exec(s)[1]; const size = /\/Size\s+(\d+)/.exec(s)[1]; const add = `xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size ${size} /Root ${root} /Prev ${x} >>\nstartxref\n${s.length}\n%%EOF\n`; return enc(s + add); } },
  { id: 'FT-02', name: 'unreferenced stream carrying the old text', fn: (b, p) => { const txt = `BT /F1 12 Tf 72 72 Td <${[...p.oldBytes].map((c) => c.codePointAt(0).toString(16).padStart(2, '0')).join('')}> Tj ET`; return rewriteWithExtraObject(b, `<< /Length ${txt.length} >>\nstream\n${txt}\nendstream`); } },
  { id: 'FT-03', name: 'hidden copy of the old text (render mode 3) added to the page', fn: pdfiumTamper((o, objs, p) => { const t = E.p.FPDFPageObj_NewTextObj(o.doc, 'Helvetica', 12); const ptr = utf16z(p.oldText); E.p.FPDFText_SetText(t, ptr); E.free(ptr); E.p.FPDFTextObj_SetTextRenderMode(t, 3); E.p.FPDFPageObj_Transform(t, 1, 0, 0, 1, 72, 40); E.p.FPDFPage_InsertObject(o.page, t); }) },
  { id: 'FT-04', name: 'white rectangle overlay on the edit area', fn: pdfiumTamper((o, objs, p) => { const b = p.newBox; const r = E.p.FPDFPageObj_CreateNewRect(b.left, b.bottom, b.right - b.left, b.top - b.bottom); E.p.FPDFPageObj_SetFillColor(r, 255, 255, 255, 255); E.p.FPDFPath_SetDrawMode(r, 1, 0); E.p.FPDFPage_InsertObject(o.page, r); }) },
  { id: 'FT-05', name: 'image overlay (raster substitute)', fn: pdfiumTamper((o, objs, p) => { const img = E.p.FPDFPageObj_NewImageObj(o.doc); const bm = E.p.FPDFBitmap_Create(8, 8, 0); E.p.FPDFBitmap_FillRect(bm, 0, 0, 8, 8, 0xffffffff); E.p.FPDFImageObj_SetBitmap(0, 0, img, bm); E.p.FPDFBitmap_Destroy(bm); E.p.FPDFImageObj_SetMatrix(img, 40, 0, 0, 12, p.newBox.left, p.newBox.bottom); E.p.FPDFPage_InsertObject(o.page, img); }) },
  { id: 'FT-06', name: 'an untouched text object moved by 0.5 pt', fn: pdfiumTamper((o, objs, p) => { const k = objs.findIndex((h, i) => i !== p.objIndex && E.p.FPDFPageObj_GetType(h) === OBJ.TEXT); if (k < 0) throw new Error('no untouched text'); E.p.FPDFPageObj_Transform(objs[k], 1, 0, 0, 1, 0.5, 0); }), disc: (p) => p.analysis.objects.some((x) => x.index !== p.objIndex && x.type === OBJ.TEXT) },
  { id: 'FT-07', name: 'target text silently different (one code changed)', fn: pdfiumTamper((o, objs, p) => { const codes = p.newCodes.slice(); const i = codes.length - 1; codes[i] = p.newCodes.find((c) => c !== codes[i]) ?? codes[i] + 1; E.setCharcodes(objs[p.objIndex], codes); if (codes.length > 1) E.setPositions(objs[p.objIndex], p.xs.slice(1)); }), disc: (p) => new Set(p.newCodes).size > 1 },
  { id: 'FT-08', name: 'kerning of untouched objects dropped (stock-generator behaviour)', fn: pdfiumTamper((o, objs, p, g) => { p.analysis.objects.forEach((x) => { if (x.index === p.objIndex || x.type !== OBJ.TEXT || !x.show) return; E.setCharcodes(objs[x.index], x.show.glyphs.map((gl) => gl.code)); }); }), disc: (p) => p.analysis.objects.some((x) => x.index !== p.objIndex && x.type === OBJ.TEXT && x.show && x.show.tj && x.show.tj.some((it) => typeof it === 'number' && Math.abs(it) > 1)) },
];

const report = [];
let failures = 0;
for (const f of faults) {
  const row = { id: f.id, name: f.name, evidence: 0, rejected: 0, acceptedBad: [], nonDiscriminating: 0 };
  for (const fx of committed) {
    const good = await runFixture(E, fx, load, { pdfjs });
    if (good.status !== 'committed') { row.acceptedBad.push(`${fx.id}: baseline not committed`); continue; }
    const disc = f.disc(good.plan);
    const r = await runFixture(E, fx, load, { pdfjs, applyEngine: f.applyEngine || null, planMutator: f.planMutator || null });
    if (!disc) { row.nonDiscriminating++; continue; }
    row.evidence++;
    if (r.status === 'committed') row.acceptedBad.push(fx.id); else { row.rejected++; row.caughtBy = [...new Set([...(row.caughtBy || []), ...r.reasons.map((x) => x.code)])]; }
  }
  report.push(row);
}
for (const t of tampers) {
  const row = { id: t.id, name: t.name, evidence: 0, rejected: 0, acceptedBad: [], nonDiscriminating: 0 };
  for (const fx of committed) {
    const good = await runFixture(E, fx, load, { pdfjs });
    if (t.disc && !t.disc(good.plan)) { row.nonDiscriminating++; continue; }
    let bad;
    try { bad = await t.fn(good.out, good.plan); } catch (e) { row.acceptedBad.push(`${fx.id}: tamper failed ${e.message}`); continue; }
    row.evidence++;
    const v = await verifyEdit(E, good.before, bad, good.plan, { pdfjs });
    if (v.ok) row.acceptedBad.push(fx.id); else { row.rejected++; row.caughtBy = [...new Set([...(row.caughtBy || []), ...v.failed])]; }
  }
  report.push(row);
}
for (const r of report) {
  const ok = r.acceptedBad.length === 0 && r.evidence > 0;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.id}  ${r.name}\n      discriminating fixtures ${r.evidence}, rejected ${r.rejected}, not discriminating (not counted) ${r.nonDiscriminating}${r.caughtBy ? `, caught by ${r.caughtBy.join(',')}` : ''}${r.acceptedBad.length ? `\n      WRONGLY ACCEPTED: ${r.acceptedBad.join(', ')}` : ''}`);
}
const i = process.argv.indexOf('--json');
if (i > 0) writeFileSync(process.argv[i + 1], JSON.stringify(report, null, 1));
console.log(`\n${report.length - failures}/${report.length} fault classes caught on every discriminating fixture`);
process.exit(failures ? 1 : 0);
