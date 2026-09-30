import { fileURLToPath } from 'node:url';
// Node PDF.js text provider for CI (same interface as the browser provider in te-render.mjs).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const DEPS = process.env.TE_DEPS || fileURLToPath(new URL('../../node_modules/', import.meta.url));
export async function pdfjsProvider(major = 3) {
  // 3 = production pin (3.11.174), 4 = 4.10.38, 6 = current release line (upgrade candidate)
  const DEPS6 = process.env.TE_DEPS6 || DEPS;
  const lib = major === 3 ? require(`${DEPS}/pdfjs3/legacy/build/pdf.js`) : (major === 6 ? await import(`${DEPS6}/pdfjs-dist/legacy/build/pdf.mjs`) : await import(`${DEPS}/pdfjs4/legacy/build/pdf.mjs`));
  return {
    version: lib.version,
    lib,
    async textContent(bytes, pageIndex = 0) {
      const task = lib.getDocument({ data: new Uint8Array(bytes).slice(), verbosity: 0, isEvalSupported: false, useSystemFonts: false, disableFontFace: true });
      const doc = await task.promise;
      try {
        const page = await doc.getPage(pageIndex + 1);
        const tc = await page.getTextContent();
        return { items: tc.items.filter((x) => typeof x.str === 'string').map((x) => ({ str: x.str, hasEOL: !!x.hasEOL, transform: x.transform.slice(), width: x.width })) };
      } finally { await task.destroy(); }
    },
  };
}
