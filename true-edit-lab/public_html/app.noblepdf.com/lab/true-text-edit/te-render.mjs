// NoblePDF True Edit (Phase 9 lab): PDF.js access with an enforced safe configuration,
// and high-resolution render comparison. Browser only. ASCII only.
// Security posture (PDF.js 3.11.174 is the production pin):
//  - CVE-2024-4367 (<= 4.1.392) needs isEvalSupported true: every getDocument call here
//    forces isEvalSupported false, and the page CSP has no 'unsafe-eval' (te-env.mjs
//    proves eval is blocked at runtime).
//  - CVE-2026-16633 (>= 5.6.83 < 6.2.108) needs enableScripting and no script CSP; this
//    version is outside the range, scripting is never enabled and the CSP blocks it.
//  - Library and worker are same-origin, version-pinned and SHA-256 checked; the
//    library tag carries SRI. There is no CDN fallback anywhere.
export const TE_RENDER_VERSION = 'te-render-1';
export const PDFJS_PIN = Object.freeze({
  version: '3.11.174',
  lib: '/vendor/pdfjs-3.11.174/pdf.min.js',
  worker: '/vendor/pdfjs-3.11.174/pdf.worker.min.js',
  libSha256: '5b5799e6f8c680663207ac5b42ee14eed2a406fa7af48f50c154f0c0b1566946',
  workerSha256: 'feabdf309770ed24bba31a5467836cdc8cf639c705af27d52b585b041bb8527b',
  libSri: 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e',
});
export const SAFE_OPTIONS = Object.freeze({ isEvalSupported: false, enableXfa: false, verbosity: 0, disableAutoFetch: true, disableStream: true });

export function pdfjsLib() {
  const lib = globalThis.pdfjsLib;
  if (!lib) throw new Error('PDF.js did not load');
  if (lib.version !== PDFJS_PIN.version) throw new Error(`PDF.js ${lib.version} loaded; ${PDFJS_PIN.version} is pinned`);
  const worker = new URL(PDFJS_PIN.worker, location.href).href;
  lib.GlobalWorkerOptions.workerSrc = worker;
  return lib;
}
export function openPdf(lib, bytes) {
  return lib.getDocument({ data: new Uint8Array(bytes).slice(), ...SAFE_OPTIONS });
}
// Same interface as tests/node/lib/pdfjs-node.mjs.
export function browserPdfjs(lib) {
  return {
    version: lib.version,
    async textContent(bytes, pageIndex = 0) {
      const task = openPdf(lib, bytes);
      try {
        const doc = await task.promise;
        const page = await doc.getPage(pageIndex + 1);
        const tc = await page.getTextContent();
        return { items: tc.items.filter((x) => typeof x.str === 'string').map((x) => ({ str: x.str, hasEOL: !!x.hasEOL, transform: x.transform.slice(), width: x.width })) };
      } finally { await task.destroy(); }
    },
  };
}

export async function renderToCanvas(lib, bytes, pageIndex, scale, canvas) {
  const task = openPdf(lib, bytes);
  try {
    const doc = await task.promise;
    const page = await doc.getPage(pageIndex + 1);
    // scale: a number, or { fitWidth: px, max } to fit the page into a container width.
    const k = typeof scale === 'number' ? scale : Math.max(0.25, Math.min(scale.max || 2, scale.fitWidth / page.getViewport({ scale: 1 }).width));
    const vp = page.getViewport({ scale: k });
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d', { willReadFrequently: true }), viewport: vp, intent: 'display' }).promise;
    return { viewport: vp, width: canvas.width, height: canvas.height, view: page.view.slice(), rotate: page.rotate };
  } finally { await task.destroy(); }
}

async function renderBand(page, vp, top, height) {
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width);
  c.height = height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, 0, -top], intent: 'print' }).promise;
  const img = ctx.getImageData(0, 0, c.width, c.height);
  c.width = 0;
  c.height = 0;
  return img;
}

// Compares two documents page by page at `scale` (4 = 288 dpi), band by band.
// `exclude` is a PDF-space rectangle {left,bottom,right,top} left out of the comparison
// (the edited text); `region` limits the comparison to a PDF-space rectangle.
export async function compareRenders(lib, aBytes, bBytes, { pageIndex = 0, scale = 4, tolerance = 8, exclude = null, region = null, bandPx = 768 } = {}) {
  const ta = openPdf(lib, aBytes);
  const tb = openPdf(lib, bBytes);
  try {
    const [da, db] = await Promise.all([ta.promise, tb.promise]);
    const [pa, pb] = await Promise.all([da.getPage(pageIndex + 1), db.getPage(pageIndex + 1)]);
    const va = pa.getViewport({ scale });
    const vb = pb.getViewport({ scale });
    if (Math.round(va.width) !== Math.round(vb.width) || Math.round(va.height) !== Math.round(vb.height)) return { ok: false, detail: 'page sizes differ' };
    const rectPx = (r) => { const q = va.convertToViewportRectangle([r.left, r.bottom, r.right, r.top]); return { x0: Math.min(q[0], q[2]), x1: Math.max(q[0], q[2]), y0: Math.min(q[1], q[3]), y1: Math.max(q[1], q[3]) }; };
    const ex = exclude ? rectPx(exclude) : null;
    const rg = region ? rectPx(region) : { x0: 0, x1: va.width, y0: 0, y1: va.height };
    let over = 0;
    let max = 0;
    let compared = 0;
    const y0 = Math.max(0, Math.floor(rg.y0));
    const y1 = Math.min(Math.ceil(va.height), Math.ceil(rg.y1));
    for (let top = y0; top < y1; top += bandPx) {
      const h = Math.min(bandPx, y1 - top);
      const [ia, ib] = await Promise.all([renderBand(pa, va, top, h), renderBand(pb, vb, top, h)]);
      const w = ia.width;
      for (let y = 0; y < h; y++) {
        const py = top + y;
        for (let x = Math.max(0, Math.floor(rg.x0)); x < Math.min(w, Math.ceil(rg.x1)); x++) {
          if (ex && x >= ex.x0 && x <= ex.x1 && py >= ex.y0 && py <= ex.y1) continue;
          const i = (y * w + x) * 4;
          const d = Math.max(Math.abs(ia.data[i] - ib.data[i]), Math.abs(ia.data[i + 1] - ib.data[i + 1]), Math.abs(ia.data[i + 2] - ib.data[i + 2]));
          compared++;
          if (d > max) max = d;
          if (d > tolerance) over++;
        }
      }
    }
    return { ok: over === 0 && compared > 0, over, max, compared, scale, detail: `${over} of ${compared} pixels differ by more than ${tolerance}/255 at ${Math.round(72 * scale)} dpi (max ${max})` };
  } finally { await Promise.all([ta.destroy(), tb.destroy()]); }
}

export function grow(r, d) { return { left: r.left - d, bottom: r.bottom - d, right: r.right + d, top: r.top + d }; }
export function union(a, b) { return { left: Math.min(a.left, b.left), bottom: Math.min(a.bottom, b.bottom), right: Math.max(a.right, b.right), top: Math.max(a.top, b.top) }; }
