// HARNESS ONLY. Local static server for the Phase 10 corpus harness browser tests.
// Separate from server.mjs (Phase 9 harness, unchanged). It serves the lab pages, npm PDF.js
// 3.11.174 and the REAL Run #10 engine (or the stock engine to prove the identity check), and
// it records EVERY request it receives (method, path, request body size, whether the body
// looks like a PDF) so tests can prove that no PDF was ever uploaded. It can also inject
// host-style scripts, relax img-src for the late-request test, and serve a service worker.
// Nothing here is deployable. Usage: see tests/README-TESTS.txt
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = (k, d) => process.env[k] || d;
const PORT = Number(env('PORT', '8793'));
const LAB = env('V2_LAB_DIR', path.join(here, '../../public_html/app.noblepdf.com/lab/true-text-edit'));
const PDFJS_DIR = env('PDFJS_DIR', path.join(here, '../node_modules/pdfjs3'));
const PDFIUM_DIR = env('PDFIUM_DIR', path.join(here, '../node_modules/@embedpdf/pdfium'));
const REAL_DIR = env('REAL_PATCHED_DIR', path.join(here, '../.engine/patched'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.txt': 'text/plain', '.png': 'image/png', '.json': 'application/json' };
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const SW = "self.addEventListener('install', (e) => self.skipWaiting());\nself.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));\nself.addEventListener('fetch', () => {});\n";
// The install page is outside the worker's scope, so it waits for the worker's own
// "activated" state (navigator.serviceWorker.ready would never resolve here).
const SW_INSTALL = '<!doctype html><meta charset="utf-8"><title>sw install (harness)</title><script>navigator.serviceWorker.register("/__p10/sw.js", { scope: "/lab/true-text-edit/" }).then((reg) => new Promise((res) => { if (reg.active) return res(); const w = reg.installing || reg.waiting; w.addEventListener("statechange", () => { if (w.state === "activated") res(); }); })).then(() => { document.title = "sw ready"; }).catch((e) => { document.title = "sw failed " + e; });</script>';
const scenario = { engine: 'real', inject: 'none', csp: 'strict', host: 'live' };
const log = [];

function send(res, status, body, type, extra = {}) {
  res.writeHead(status, { 'Content-Type': type || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': body.length, ...extra });
  res.end(body);
}
function injectHtml(buf) {
  let s = buf.toString('utf8');
  const monitor = `<script src="http://127.0.0.1:${PORT}/__p10/monitor.js"></script>`;
  if (scenario.inject === 'after') s = s.replace('</body>', `${monitor}<script>window.__inlineInjected = 1;</script>\n</body>`);
  if (scenario.inject === 'before') s = s.replace('<head>', `<head>\n${monitor}`);
  if (scenario.csp === 'img-relaxed') {
    if (!s.includes("img-src 'self';")) throw new Error('img-src directive not found for csp=img-relaxed');
    s = s.replace("img-src 'self';", `img-src 'self' http://127.0.0.1:${PORT};`);
  }
  return Buffer.from(s);
}
// LOCAL DEBUGGING ONLY (P10_DEV=1 at server start, engine=dev-stock): serves the stock engine
// and a te-engine.mjs whose Run #10 pins are swapped for the stock hashes, so page flows can be
// exercised without the Run #10 build (edits then fail: stock has no SetPositions). Never
// used by run-phase10.py; without P10_DEV=1 the option does not exist.
const DEV = process.env.P10_DEV === '1';
function devEngineModule(buf) {
  const s = buf.toString('utf8');
  const wasm = readFileSync(path.join(PDFIUM_DIR, 'dist', 'pdfium.wasm'));
  const glue = readFileSync(path.join(PDFIUM_DIR, 'dist', 'index.js'));
  const h = (b) => createHash('sha256').update(b).digest('hex');
  return Buffer.from(s.replace('c4f54bda9bc730c0aeb6579254f0431fa95886478cd19967555be6ea2a35ce11', h(wasm)).replace('2af28659a83b5691ed1193bd0819a6a1339036fb08505826d561c7541762baf2', h(glue)).replace('wasmBytes: 4648757', `wasmBytes: ${wasm.length}`).replace("'FPDFText_SetCharcodes', 'FPDFText_SetPositions',", "'FPDFText_SetCharcodes',"));
}
function engineFile(name) {
  if (DEV && scenario.engine === 'dev-stock') return readFileSync(path.join(PDFIUM_DIR, 'dist', name));
  if (scenario.engine === 'real') {
    const f = path.join(REAL_DIR, name);
    return existsSync(f) ? readFileSync(f) : null;
  }
  return readFileSync(path.join(PDFIUM_DIR, 'dist', name));
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const u = new URL(req.url, `http://${req.headers.host}`);
    const p = decodeURIComponent(u.pathname);
    if (!p.startsWith('/__p10/requests') && !p.startsWith('/__p10/scenario')) {
      log.push({ method: req.method, host: req.headers.host || '', path: p, query: u.search, bodyBytes: body.length, pdfLike: body.includes(Buffer.from('%PDF')), t: Date.now() });
    }
    try {
      if (p === '/__p10/scenario') {
        for (const k of Object.keys(scenario)) if (u.searchParams.has(k)) scenario[k] = u.searchParams.get(k);
        if (u.searchParams.has('resetlog')) log.length = 0;
        return send(res, 200, Buffer.from(JSON.stringify({ scenario, realEngine: existsSync(path.join(REAL_DIR, 'pdfium.wasm')) })), 'application/json');
      }
      if (p === '/__p10/requests') return send(res, 200, Buffer.from(JSON.stringify(log)), 'application/json');
      if (p === '/__p10/monitor.js') return send(res, 200, Buffer.from('window.__monitorRan = true;\n'), 'text/javascript');
      if (p === '/__p10/pixel.png') return send(res, 200, PIXEL, 'image/png');
      if (p === '/__p10/sw.js') return send(res, 200, Buffer.from(SW), 'text/javascript', { 'Service-Worker-Allowed': '/' });
      if (p === '/__p10/sw-install.html') return send(res, 200, Buffer.from(SW_INSTALL), TYPES['.html']);
      if (p === '/vendor/pdfjs-3.11.174/pdf.min.js' || p === '/vendor/pdfjs-3.11.174/pdf.worker.min.js') return send(res, 200, readFileSync(path.join(PDFJS_DIR, 'build', path.basename(p))), TYPES['.js']);
      if (p === '/vendor/pdfium-2.15.1-setpositions/index.js' || p === '/vendor/pdfium-2.15.1-setpositions/pdfium.wasm') {
        const b = engineFile(path.basename(p));
        return b ? send(res, 200, b, TYPES[path.extname(p)]) : send(res, 404, Buffer.from('engine missing (set REAL_PATCHED_DIR)'), 'text/plain');
      }
      // host=live: the measured app.noblepdf.com rule, 403 for every *.json URL.
      if (scenario.host === 'live' && /\.json$/i.test(p)) return send(res, 403, Buffer.from('403 Forbidden'), 'text/html; charset=iso-8859-1');
      const PREFIX = '/lab/true-text-edit/';
      if (p.startsWith(PREFIX) && !p.includes('..')) {
        const f = path.join(LAB, p.slice(PREFIX.length));
        if (existsSync(f) && statSync(f).isFile()) {
          const ext = path.extname(f);
          let b = readFileSync(f);
          if (ext === '.html') b = injectHtml(b);
          if (DEV && scenario.engine === 'dev-stock' && path.basename(f) === 'te-engine.mjs') b = devEngineModule(b);
          return send(res, 200, b, TYPES[ext]);
        }
      }
      return send(res, 404, Buffer.from('not found'), 'text/plain');
    } catch (e) {
      return send(res, 500, Buffer.from(String(e && e.stack ? e.stack : e)), 'text/plain');
    }
  });
});
server.listen(PORT, '0.0.0.0', () => console.log(`phase10 harness on http://localhost:${PORT} ${JSON.stringify(scenario)}`));
