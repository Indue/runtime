// HARNESS ONLY. Local static server for the Phase 8 V1/V2 browser test matrix.
// Serves the lab pages, npm PDF.js 3.11.174, the stock npm @embedpdf/pdfium 2.15.1
// engine and a FAKE patched engine (fake-patched-engine.template.js), and can
// inject cross-origin/inline scripts to imitate host-injected monitoring markup.
// Nothing here is deployable. Usage: see tests/README-TESTS.txt
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = (k, d) => process.env[k] || d;
const PORT = Number(env('PORT', '8765'));
const V2_LAB = env('V2_LAB_DIR', path.join(here, '../../public_html/app.noblepdf.com/lab/true-text-edit'));
const V1_LAB = env('V1_LAB_DIR', '');
const PDFJS_DIR = env('PDFJS_DIR', path.join(here, '../node_modules/pdfjs3'));
const PDFIUM_DIR = env('PDFIUM_DIR', path.join(here, '../node_modules/@embedpdf/pdfium'));
const RUN10_WASM = 'c4f54bda9bc730c0aeb6579254f0431fa95886478cd19967555be6ea2a35ce11';
const RUN10_INDEX = '2af28659a83b5691ed1193bd0819a6a1339036fb08505826d561c7541762baf2';
const RUN10_WASM_BYTES = 4648757;

if (V1_LAB && !existsSync(path.join(V1_LAB, 'phase8.html'))) {
  console.error('V1_LAB_DIR is set but does not contain phase8.html.');
  process.exit(2);
}
const sha = (b) => createHash('sha256').update(b).digest('hex');
const stockGlue = readFileSync(path.join(PDFIUM_DIR, 'dist/index.js')); // the file served live (V2.1.1 STOCK_PINNED)
const stockGlueUnpinned = readFileSync(path.join(PDFIUM_DIR, 'dist/index.browser.js'));
const REAL_DIR = env('REAL_PATCHED_DIR', existsSync(path.join(here, '../.engine/patched/pdfium.wasm')) ? path.join(here, '../.engine/patched') : '');
const realIndex = REAL_DIR ? readFileSync(path.join(REAL_DIR, 'index.js')) : null;
const realWasm = REAL_DIR ? readFileSync(path.join(REAL_DIR, 'pdfium.wasm')) : null;
const stockWasm = readFileSync(path.join(PDFIUM_DIR, 'dist/pdfium.wasm'));
const template = readFileSync(path.join(here, 'fake-patched-engine.template.js'), 'utf8');

// Fake wasm: stock bytes plus one custom section, padded so the size equals the Run #10
// size exactly. It proves a size check alone cannot identify the engine.
function leb(n) { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; }
function fakeWasm() {
  const name = Buffer.from('noblepdf-harness-fake-not-pdfium');
  const total = RUN10_WASM_BYTES - stockWasm.length;
  for (let payload = total - 2; payload > 0; payload--) {
    const sizeLeb = leb(payload);
    const filler = payload - 1 - name.length;
    if (1 + sizeLeb.length + payload === total && filler >= 0) {
      return Buffer.concat([stockWasm, Buffer.from([0x00, ...sizeLeb, name.length]), name, Buffer.alloc(filler, 0x2e)]);
    }
  }
  throw new Error('cannot size fake wasm');
}
const FAKE_WASM = fakeWasm();

const scenario = { engine: 'emulated', subst: '0', inject: 'none', pdfjs: 'ok', stock: 'pinned' };
const fakeIndex = () => Buffer.from(template.replaceAll('__VARIANT__', scenario.engine));
const info = () => ({
  scenario, fakeWasmSha256: sha(FAKE_WASM), fakeWasmBytes: FAKE_WASM.length, fakeIndexSha256: sha(fakeIndex()),
  stockWasmSha256: sha(stockWasm), stockGlueSha256: sha(stockGlue),
});

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.txt': 'text/plain' };
function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': body.length });
  res.end(body);
}
function injectHtml(buf) {
  let s = buf.toString('utf8');
  const monitor = `<script src="http://127.0.0.1:${PORT}/__harness/monitor.js"></script>`;
  if (scenario.inject === 'after') s = s.replace('</body>', `${monitor}<script>window.__inlineInjected = 1;</script>\n</body>`);
  if (scenario.inject === 'before') s = s.replace('<head>', `<head>\n${monitor}`);
  if (scenario.inject === 'inline') s = s.replace('</body>', '<script>window.__inlineInjected = 1;</script>\n</body>');
  return Buffer.from(s);
}
function pdfjsFile(name) {
  const buf = readFileSync(path.join(PDFJS_DIR, 'build', name));
  return scenario.pdfjs === 'badversion' ? Buffer.from(buf.toString('latin1').replaceAll('3.11.174', '3.11.999'), 'latin1') : buf;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = decodeURIComponent(u.pathname);
  try {
    if (p === '/__harness/scenario') {
      for (const k of Object.keys(scenario)) if (u.searchParams.has(k)) scenario[k] = u.searchParams.get(k);
      return send(res, 200, Buffer.from(JSON.stringify(info())), 'application/json');
    }
    if (p === '/__harness/info') return send(res, 200, Buffer.from(JSON.stringify(info())), 'application/json');
    if (p === '/__harness/monitor.js') return send(res, 200, Buffer.from('window.__monitorRan = true;\n'), 'text/javascript');
    if (p === '/__harness/stockglue/index.js') return send(res, 200, stockGlue, TYPES['.js']);
    if (p === '/__harness/stockglue/pdfium.wasm') return send(res, 200, stockWasm, TYPES['.wasm']);
    if (p === '/vendor/pdfium-2.15.1/index.js') return send(res, 200, scenario.stock === 'unpinned' ? stockGlueUnpinned : stockGlue, TYPES['.js']);
    if (p === '/vendor/pdfium-2.15.1/pdfium.wasm') return send(res, 200, stockWasm, TYPES['.wasm']);
    if (p === '/vendor/pdfium-2.15.1-setpositions/index.js') { if (scenario.engine === 'real') { if (!realIndex) return send(res, 404, 'REAL_PATCHED_DIR not set', 'text/plain'); return send(res, 200, realIndex, TYPES['.js']); } return send(res, 200, fakeIndex(), TYPES['.js']); }
    if (p === '/vendor/pdfium-2.15.1-setpositions/pdfium.wasm') { if (scenario.engine === 'real') { if (!realWasm) return send(res, 404, 'REAL_PATCHED_DIR not set', 'text/plain'); return send(res, 200, realWasm, TYPES['.wasm']); } return send(res, 200, FAKE_WASM, TYPES['.wasm']); }
    if (p === '/vendor/pdfjs-3.11.174/pdf.min.js') return send(res, 200, pdfjsFile('pdf.min.js'), TYPES['.js']);
    if (p === '/vendor/pdfjs-3.11.174/pdf.worker.min.js') return send(res, 200, pdfjsFile('pdf.worker.min.js'), TYPES['.js']);
    const LAB = '/lab/true-text-edit/';
    if (p.startsWith(LAB) && !p.includes('..')) {
      const rel = p.slice(LAB.length);
      for (const dir of [V2_LAB, V1_LAB].filter(Boolean)) {
        const f = path.join(dir, rel);
        if (existsSync(f) && statSync(f).isFile()) {
          let body = readFileSync(f);
          const ext = path.extname(f);
          if (ext === '.html') body = injectHtml(body);
          if (rel === 'phase8-v2.js' && scenario.subst === '1') {
            // Harness-only substitution of the two pinned Run #10 hashes by the fake engine's hashes.
            const s = body.toString('utf8');
            if (!s.includes(RUN10_WASM) || !s.includes(RUN10_INDEX)) throw new Error('pinned hashes not found for substitution');
            body = Buffer.from(s.replace(RUN10_WASM, sha(FAKE_WASM)).replace(RUN10_INDEX, sha(fakeIndex())));
          }
          return send(res, 200, body, TYPES[ext]);
        }
      }
    }
    return send(res, 404, Buffer.from('not found'), 'text/plain');
  } catch (e) {
    return send(res, 500, Buffer.from(String(e && e.stack ? e.stack : e)), 'text/plain');
  }
});
server.listen(PORT, '0.0.0.0', () => console.log(`phase8 harness on http://localhost:${PORT} ${JSON.stringify(info())}`));
