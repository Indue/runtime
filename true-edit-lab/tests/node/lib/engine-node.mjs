import { fileURLToPath } from 'node:url';
// Loads a PDFium engine for Node CI from a directory holding index.js + pdfium.wasm,
// verifying SHA-256 pins before executing anything.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { instantiateEngine, RUN10, STOCK_PINNED } from '../../../public_html/app.noblepdf.com/lab/true-text-edit/te-engine.mjs';
const sha = (b) => createHash('sha256').update(b).digest('hex');
export function engineDir(kind) {
  // Defaults are package-relative: tests/.engine/patched (tests/tools/fetch-engine.sh) and
  // tests/node_modules/@embedpdf/pdfium/dist (npm install in tests/).
  if (kind === 'patched') return process.env.PATCHED_ENGINE_DIR || fileURLToPath(new URL('../../.engine/patched/', import.meta.url));
  return process.env.STOCK_ENGINE_DIR || fileURLToPath(new URL('../../node_modules/@embedpdf/pdfium/dist/', import.meta.url));
}
export async function loadEngine(kind = 'patched') {
  const dir = engineDir(kind);
  const js = `${dir}/index.js`;
  const wasmPath = `${dir}/pdfium.wasm`;
  if (!existsSync(js) || !existsSync(wasmPath)) throw new Error(`engine files missing in ${dir}`);
  const wasm = new Uint8Array(readFileSync(wasmPath));
  const jsBytes = readFileSync(js);
  const pins = kind === 'patched' ? RUN10 : STOCK_PINNED;
  const got = { wasm: sha(wasm), js: sha(jsBytes) };
  if (got.wasm !== pins.wasmSha256 || got.js !== pins.indexJsSha256) throw new Error(`${kind} engine hash mismatch: wasm ${got.wasm} js ${got.js}`);
  const mod = await import(pathToFileURL(js).href);
  const r = await instantiateEngine(kind, mod.init, wasm);
  if (r.hookCalls !== 1 || !r.fromVerifiedBytes) throw new Error('engine not instantiated from verified bytes');
  return r.engine;
}
