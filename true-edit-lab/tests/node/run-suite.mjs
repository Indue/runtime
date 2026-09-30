// Node CI: runs every Phase 9 fixture through the real pipeline on the pinned engine.
// Usage: node tests/node/run-suite.mjs [--pdfjs 3|4] [--json out.json] [--only id,id]
// Exit code 1 if any fixture outcome differs from its manifest expectation.
import { readFileSync, writeFileSync } from 'node:fs';
import { loadEngine } from './lib/engine-node.mjs';
import { pdfjsProvider } from './lib/pdfjs-node.mjs';
import { runFixture, discriminationLabel } from '../../public_html/app.noblepdf.com/lab/true-text-edit/te-suite.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DIR = new URL('../../public_html/app.noblepdf.com/lab/true-text-edit/fixtures-phase9/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.txt', DIR)));
const only = arg('--only', '') ? arg('--only', '').split(',') : null;
const E = await loadEngine('patched');
const pdfjs = await pdfjsProvider(Number(arg('--pdfjs', '3')));
const load = async (name) => new Uint8Array(readFileSync(new URL(name, DIR)));
const rows = [];
let bad = 0;
for (const fx of manifest.fixtures) {
  if (only && !only.includes(fx.id)) continue;
  const r = await runFixture(E, fx, load, { pdfjs });
  if (!r.ok) bad++;
  rows.push({ id: fx.id, expected: fx.expect.status, got: r.status, ok: r.ok, disc: discriminationLabel(r), reasons: r.reasons.map((x) => x.code), mismatch: r.mismatch, failedChecks: r.checks.filter((c) => !c.pass).map((c) => `${c.id}: ${c.evidence.slice(0, 220)}`), ref: r.ref.filter((c) => !c.pass).map((c) => `${c.id}: ${c.evidence.slice(0, 220)}`), notes: r.notes });
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${fx.id.padEnd(30)} ${String(r.status).padEnd(9)} expected ${fx.expect.status.padEnd(9)} SetPositions-discriminating ${discriminationLabel(r).padEnd(14)} ${r.reasons.map((x) => x.code).join(',')}`);
  if (!r.ok) { for (const m of r.mismatch) console.log('      mismatch:', m); for (const f of rows[rows.length - 1].failedChecks) console.log('      check', f); for (const f of rows[rows.length - 1].ref) console.log('      ref', f); for (const n of r.notes) console.log('      note', n); for (const x of r.reasons) console.log('      reason', x.code, '-', String(x.detail).slice(0, 200)); }
}
console.log(`\n${rows.length - bad}/${rows.length} fixtures matched their expectation (PDF.js ${pdfjs.version}, engine Run #10)`);
if (arg('--json', '')) writeFileSync(arg('--json', ''), JSON.stringify({ pdfjs: pdfjs.version, rows }, null, 1));
process.exit(bad ? 1 : 0);
