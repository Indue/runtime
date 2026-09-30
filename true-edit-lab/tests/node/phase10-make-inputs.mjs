// Writes the synthetic Phase 10 test inputs (tests/node/lib/phase10-inputs.mjs) into a folder,
// for the browser harness. Usage: node tests/node/phase10-make-inputs.mjs OUT_DIR
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { INPUTS } from './lib/phase10-inputs.mjs';
import { clipFixture, clipBlock, wordLike } from './lib/phase10b-clip-inputs.mjs';
const out = process.argv[2];
if (!out) { console.error('usage: node tests/node/phase10-make-inputs.mjs OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });
// Phase 10B clip variants of the pinned Phase 9 fixtures (tests/node/lib/phase10b-clip-inputs.mjs).
const fx = (id) => new Uint8Array(readFileSync(new URL(`../../public_html/app.noblepdf.com/lab/true-text-edit/fixtures-phase9/${id}-before.pdf`, import.meta.url)));
const INPUTS10B = {
  'p10b-page-clip.pdf': () => clipFixture(fx('invoice-number-longer'), '0 0 612 792 re W n'),
  'p10b-cut.pdf': () => clipBlock(fx('ttf-winansi-nonascii'), '<4D65>', '72 690 60 30 re W n'),
  'p10b-tight.pdf': () => clipBlock(fx('invoice-number-longer'), '<49> 30 <6E766F696365>', '60 660 170 30 re W n'),
  'p10b-word.pdf': () => wordLike(),
};
const all = { ...INPUTS, ...INPUTS10B };
for (const [name, make] of Object.entries(all)) writeFileSync(path.join(out, name), make());
console.log(`wrote ${Object.keys(all).length} inputs to ${out}`);
