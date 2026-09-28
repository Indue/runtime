// Deterministic Phase 8 fixtures. Every page is written from explicit "runs"
// so each Tc/Tw/Tz/Tm/TJ value is exact, and the reference PDF for an edit
// can be authored independently (spec math in double precision) with every
// other byte of page content identical.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFNumber,
  PDFDict,
  PDFHexString,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import StandardFonts from '@pdf-lib/standard-fonts';

const require = createRequire(import.meta.url);
const LIBERATION = readFileSync(
  require.resolve('pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'),
);
const lib = fontkit.create(LIBERATION);
const helvAfm = StandardFonts.Font.load('Helvetica');
const winAnsiNames = StandardFonts.Encodings.WinAnsi;

const FIRST = 32;
const LAST = 126;

function helvWidth(code) {
  const name = winAnsiNames.encodeUnicodeCodePoint(code).name;
  return helvAfm.getWidthOfGlyph(name);
}
function libWidth(code, { fractional }) {
  const w = (lib.glyphForCodePoint(code).advanceWidth * 1000) / lib.unitsPerEm;
  return fractional ? Math.round(w * 1000) / 1000 : Math.round(w);
}

// ---------------------------------------------------------------------------
// Fonts. Each returns { name, widthOf(code), encode(str) -> codes[] }.

function addSimpleFont(doc, key, { kind }) {
  const ctx = doc.context;
  const widthsFor = (code) =>
    kind === 'helv'
      ? helvWidth(code)
      : libWidth(code, { fractional: kind === 'libFrac' });
  const dict = ctx.obj({
    Type: 'Font',
    Subtype: kind === 'helv' || kind === 'helvNoWidths' ? 'Type1' : 'TrueType',
    BaseFont:
      kind === 'helv' || kind === 'helvNoWidths' ? 'Helvetica' : 'LiberationSans',
    Encoding: 'WinAnsiEncoding',
  });
  if (kind !== 'helvNoWidths') {
    const widths = [];
    for (let c = FIRST; c <= LAST; c++) widths.push(widthsFor(c));
    dict.set(PDFName.of('FirstChar'), PDFNumber.of(FIRST));
    dict.set(PDFName.of('LastChar'), PDFNumber.of(LAST));
    dict.set(PDFName.of('Widths'), ctx.obj(widths));
  }
  if (kind === 'lib' || kind === 'libFrac') {
    const file = ctx.flateStream(LIBERATION, { Length1: LIBERATION.length });
    const desc = ctx.obj({
      Type: 'FontDescriptor',
      FontName: 'LiberationSans',
      Flags: 32,
      FontBBox: [-203, -303, 1050, 910],
      ItalicAngle: 0,
      Ascent: 905,
      Descent: -212,
      CapHeight: 729,
      StemV: 80,
      FontFile2: ctx.register(file),
    });
    dict.set(PDFName.of('FontDescriptor'), ctx.register(desc));
  }
  return {
    key,
    ref: ctx.register(dict),
    widthOf: (code) =>
      kind === 'helvNoWidths' ? helvWidth(code) : widthsFor(code),
    encode: (str) => [...str].map((ch) => ch.charCodeAt(0)),
    codeHex: (code) => code.toString(16).padStart(2, '0'),
  };
}

async function addCidFont(doc, key) {
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(LIBERATION, {
    subset: true,
    features: { liga: false, kern: false },
  });
  return {
    key,
    pdfLibFont: font,
    ref: font.ref,
    widthOf: null, // filled from the saved W array (see finalizeCid)
    encode: (str) => {
      const hex = font.encodeText(str).asString();
      const codes = [];
      for (let i = 0; i < hex.length; i += 4) codes.push(parseInt(hex.slice(i, i + 4), 16));
      return codes;
    },
    codeHex: (code) => code.toString(16).padStart(4, '0'),
  };
}

// ---------------------------------------------------------------------------
// Content

function num(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function runToContent(run, fonts) {
  const f = fonts[run.font];
  const parts = ['q', 'BT', `/${run.font} ${num(run.size)} Tf`];
  if (run.tz !== undefined) parts.push(`${num(run.tz)} Tz`);
  if (run.tc !== undefined) parts.push(`${num(run.tc)} Tc`);
  if (run.tw !== undefined) parts.push(`${num(run.tw)} Tw`);
  if (run.tr !== undefined) parts.push(`${run.tr} Tr`);
  parts.push(`${run.tm.map(num).join(' ')} Tm`);
  const items = run.show.map((it) =>
    typeof it === 'number'
      ? num(it)
      : `<${(Array.isArray(it) ? it : f.encode(it)).map(f.codeHex).join('')}>`,
  );
  if (items.length === 1 && typeof run.show[0] !== 'number') {
    parts.push(`${items[0]} Tj`);
  } else {
    parts.push(`[${items.join(' ')}] TJ`);
  }
  parts.push('ET', 'Q');
  return parts.join(' ');
}

// Spec TJ for glyph codes placed at object-space positions (double math).
export function specShow(codes, positions, run, widthOf) {
  const show = [[codes[0]]];
  let cur = 0;
  for (let i = 0; i + 1 < codes.length; i++) {
    cur += (widthOf(codes[i]) * run.size) / 1000 + (run.tc ?? 0);
    if (codes[i] === 32 && run.fontIsSimple) cur += run.tw ?? 0;
    const k = ((cur - positions[i]) * 1000) / run.size;
    if (Math.abs(k) > 1e-9) show.push(k);
    if (typeof show[show.length - 1] === 'number') show.push([codes[i + 1]]);
    else show[show.length - 1].push(codes[i + 1]);
    cur = positions[i];
  }
  return show;
}

export async function buildPdf(spec, { replaceTarget } = {}) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([612, 792]);
  const fonts = {};
  for (const [key, kind] of Object.entries(spec.fonts)) {
    fonts[key] = kind === 'cid' ? await addCidFont(doc, key) : addSimpleFont(doc, key, { kind });
    fonts[key].kind = kind;
    page.node.setFontDictionary(PDFName.of(key), fonts[key].ref);
  }
  // Pre-encode every string used by the fixture (content, glyph pool and the
  // replacement) so a subset font contains all needed glyphs, and CID codes
  // are stable between the fixture and its reference.
  for (const s of spec.allStrings ?? []) {
    for (const f of Object.values(fonts)) if (f.pdfLibFont) f.encode(s);
  }
  const runs = spec.runs.map((r) =>
    replaceTarget && r.id === spec.edit?.target ? replaceTarget(r, fonts) : r,
  );
  const content = runs.map((r) => runToContent(r, fonts)).join('\n');
  const stream = doc.context.flateStream(content);
  page.node.set(PDFName.of('Contents'), doc.context.register(stream));
  let bytes = await doc.save({ useObjectStreams: false });
  if (spec.roundCidWidths) bytes = await roundCidWidths(bytes);
  return { bytes, fonts };
}

// Replace fractional W entries with integers (clean CID fixture).
async function roundCidWidths(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const w = obj.lookup(PDFName.of('W'));
    if (!(w instanceof PDFArray)) continue;
    for (let i = 0; i < w.size(); i++) {
      const inner = w.lookup(i);
      if (inner instanceof PDFArray) {
        for (let j = 0; j < inner.size(); j++) {
          inner.set(j, PDFNumber.of(Math.round(inner.lookup(j).asNumber())));
        }
      }
    }
  }
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

// cid -> width from the saved document's W array.
export async function cidWidths(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const map = new Map();
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const w = obj.lookup(PDFName.of('W'));
    if (!(w instanceof PDFArray)) continue;
    for (let i = 0; i < w.size(); ) {
      const first = w.lookup(i).asNumber();
      const next = w.lookup(i + 1);
      if (next instanceof PDFArray) {
        for (let j = 0; j < next.size(); j++) map.set(first + j, next.lookup(j).asNumber());
        i += 2;
      } else {
        const last = next.asNumber();
        const val = w.lookup(i + 2).asNumber();
        for (let c = first; c <= last; c++) map.set(c, val);
        i += 3;
      }
    }
  }
  return map;
}

export function hasFractionalWidths(widthOf, codes) {
  return codes.some((c) => !Number.isInteger(widthOf(c)));
}

export { PDFHexString };
