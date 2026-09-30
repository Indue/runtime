// Writes the synthetic Phase 10 test inputs (tests/node/lib/phase10-inputs.mjs) into a folder,
// for the browser harness. Usage: node tests/node/phase10-make-inputs.mjs OUT_DIR
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { INPUTS } from './lib/phase10-inputs.mjs';
const out = process.argv[2];
if (!out) { console.error('usage: node tests/node/phase10-make-inputs.mjs OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });
for (const [name, make] of Object.entries(INPUTS)) writeFileSync(path.join(out, name), make());
console.log(`wrote ${Object.keys(INPUTS).length} inputs to ${out}`);
