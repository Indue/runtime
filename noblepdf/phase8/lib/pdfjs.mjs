// PDF.js lane: what NoblePDF's viewer extracts and renders.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));
const standardFontDataUrl = join(pdfjsRoot, 'standard_fonts') + '/';

async function open(bytes) {
  return pdfjs.getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
}

export async function extract(bytes) {
  const doc = await open(bytes);
  try {
    const page = await doc.getPage(1);
    const tc = await page.getTextContent();
    const items = tc.items
      .filter((it) => 'str' in it)
      .map((it) => ({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
        width: it.width,
        eol: it.hasEOL,
      }));
    return { text: items.map((i) => i.str + (i.eol ? '\n' : '')).join(''), items };
  } finally {
    await doc.destroy();
  }
}

export async function render(bytes, scale) {
  const doc = await open(bytes);
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale });
    const factory = doc.canvasFactory;
    const { canvas, context } = factory.create(
      Math.round(viewport.width),
      Math.round(viewport.height),
    );
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    const img = context.getImageData(0, 0, canvas.width, canvas.height);
    return { w: canvas.width, h: canvas.height, rgba: new Uint8Array(img.data.buffer) };
  } finally {
    await doc.destroy();
  }
}
