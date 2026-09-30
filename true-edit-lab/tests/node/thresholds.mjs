// F10 threshold regression: measures where PDFium and PDF.js start splitting a word when
// an extra gap e (em of the font size) is inserted between two glyphs, for the text
// states the policy must handle, and checks that te-edit.mjs gapBounds() stays strictly
// inside the measured no-split interval of every engine. Also shows that the old fixed
// Run #10 lint limits are unsafe. Usage: node tests/node/thresholds.mjs --pdfjs 3|4 [--json f]
import { writeFileSync } from 'node:fs';
import { loadEngine } from './lib/engine-node.mjs';
import { pdfjsProvider } from './lib/pdfjs-node.mjs';
import { mkpdf } from './lib/mkpdf.mjs';
import { gapBounds } from '../../public_html/app.noblepdf.com/lab/true-text-edit/te-edit.mjs';
import { GAP_MAX_EM, GAP_MIN_EM, PDFJS_MAX_EM } from '../../public_html/app.noblepdf.com/lab/true-text-edit/phase8-layout.mjs';
import { BASE_ENCODINGS, STD14_WIDTHS } from '../../public_html/app.noblepdf.com/lab/true-text-edit/te-data.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const E = await loadEngine('patched');
const pj = await pdfjsProvider(Number(arg('--pdfjs', '3')));
const winWidths = (space) => { const names = BASE_ENCODINGS.WinAnsiEncoding; const w = []; for (let c = 32; c < 256; c++) w.push(c === 32 ? space : (STD14_WIDTHS.Helvetica[names[c]] ?? 0)); return `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 255 /Widths [${w.join(' ')}] >>`; };
// Each config writes the pair the way the regenerated output does (Tz folded into Tm),
// except the rows marked original:true, which keep the Tz operator (pre-edit form).
const configs = [
  { id: 'base', size: 12, tm: [1, 0, 0, 1, 72, 700] },
  { id: 'tz50-regenerated', size: 12, tm: [0.5, 0, 0, 1, 72, 700] },
  { id: 'tz100-regenerated', size: 12, tm: [1, 0, 0, 1, 72, 700] },
  { id: 'tz150-regenerated', size: 12, tm: [1.5, 0, 0, 1, 72, 700] },
  { id: 'tz50-original-operator', size: 12, tm: [1, 0, 0, 1, 72, 700], tz: 50, original: true },
  { id: 'tz150-original-operator', size: 12, tm: [1, 0, 0, 1, 72, 700], tz: 150, original: true },
  { id: 'tc+0.05em', size: 12, tm: [1, 0, 0, 1, 72, 700], tc: 0.6 },
  { id: 'tc-0.05em', size: 12, tm: [1, 0, 0, 1, 72, 700], tc: -0.6 },
  { id: 'narrow-space-160', size: 12, tm: [1, 0, 0, 1, 72, 700], space: 160 },
  { id: 'narrow-space-100', size: 12, tm: [1, 0, 0, 1, 72, 700], space: 100 },
  { id: 'rotated-30', size: 12, tm: [0.866025, 0.5, -0.5, 0.866025, 200, 400] },
  { id: 'rotated-90', size: 12, tm: [0, 1, -1, 0, 300, 300] },
  { id: 'scaled-tm-2x-9pt', size: 9, tm: [2, 0, 0, 2, 72, 600] },
  { id: 'scaled-cm-0.5', size: 12, tm: [1, 0, 0, 1, 72, 700], cm: [0.5, 0, 0, 0.5, 0, 0] },
];
function probe(cfg, e) {
  const k = -e * 1000;
  const fonts = { F1: cfg.space ? winWidths(cfg.space) : winWidths(278) };
  let s = `BT /F1 ${cfg.size} Tf ${cfg.tc || 0} Tc ${cfg.tz || 100} Tz ${cfg.tm.join(' ')} Tm [(abc) ${k.toFixed(3)} (def)] TJ ET`;
  if (cfg.cm) s = `q ${cfg.cm.join(' ')} cm ${s} Q`;
  return mkpdf(s, fonts);
}
async function splits(bytes) {
  const pdfium = E.withDoc(bytes, 0, (o) => E.pageText(o.textPage)) !== 'abcdef';
  const tc = await pj.textContent(bytes, 0);
  // PDF.js 'splits' when its text changes (space inserted) or when it breaks the word into
  // separate text items (negative gaps): either one changes what consumers see.
  const pdfjs = tc.items.map((i) => i.str + (i.hasEOL ? '\n' : '')).join('').trim() !== 'abcdef' || tc.items.filter((i) => i.str).length > 1;
  return { pdfium, pdfjs };
}
async function threshold(cfg, engine, sign) {
  let lo = 0;
  let hi = sign > 0 ? 0.6 : -1.0;
  if (!(await splits(probe(cfg, hi)))[engine]) return null;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if ((await splits(probe(cfg, mid)))[engine]) hi = mid; else lo = mid;
  }
  return +hi.toFixed(4);
}
const rows = [];
let failures = 0;
for (const cfg of configs) {
  const r = { id: cfg.id, pdfiumPos: await threshold(cfg, 'pdfium', 1), pdfiumNeg: await threshold(cfg, 'pdfium', -1), pdfjsPos: await threshold(cfg, 'pdfjs', 1), pdfjsNeg: await threshold(cfg, 'pdfjs', -1) };
  const b = gapBounds({ run: { size: cfg.size, tc: cfg.tc || 0 }, font: { spaceWidth: cfg.space || 278 } });
  r.policy = { lo: +b.lo.toFixed(4), hi: +b.hi.toFixed(4) };
  const pos = [r.pdfiumPos, r.pdfjsPos].filter((v) => v !== null);
  const neg = [r.pdfiumNeg, r.pdfjsNeg].filter((v) => v !== null);
  r.safe = cfg.original ? null : (pos.every((v) => b.hi < v) && neg.every((v) => b.lo > v) && b.hi > b.lo);
  // Old Run #10 lint accepted e when e <= 0.08, e >= -0.15 and e + Tc/size <= max(0.095, Tc/size).
  const tcEm = (cfg.tc || 0) / cfg.size;
  const legacyMax = Math.min(GAP_MAX_EM, Math.max(PDFJS_MAX_EM, tcEm) - tcEm);
  r.legacyAccepts = { lo: GAP_MIN_EM, hi: +legacyMax.toFixed(4) };
  r.legacyUnsafe = pos.some((v) => legacyMax >= v) || neg.some((v) => GAP_MIN_EM <= v);
  if (r.safe === false) failures++;
  rows.push(r);
  console.log(`${r.safe === false ? 'FAIL' : (r.safe === null ? 'INFO' : 'PASS')}  ${cfg.id.padEnd(24)} PDFium +${r.pdfiumPos} / ${r.pdfiumNeg ?? 'none>=-1'}   PDF.js ${pj.version} +${r.pdfjsPos} / ${r.pdfjsNeg}   policy [${r.policy.lo}, ${r.policy.hi}]   old lint accepted [${r.legacyAccepts.lo}, ${r.legacyAccepts.hi}] unsafe: ${r.legacyUnsafe}`);
}
const legacyShown = rows.some((r) => r.legacyUnsafe);
if (!legacyShown) { failures++; console.log('FAIL  no configuration shows the old fixed limits to be unsafe (the regression test would not discriminate)'); }
console.log(`\n${rows.filter((r) => r.safe).length} configurations verified safe, ${rows.filter((r) => r.safe === null).length} informational (pre-regeneration Tz operator form), legacy limits unsafe in ${rows.filter((r) => r.legacyUnsafe).length}`);
if (arg('--json', '')) writeFileSync(arg('--json', ''), JSON.stringify({ pdfjs: pj.version, rows }, null, 1));
process.exit(failures ? 1 : 0);
