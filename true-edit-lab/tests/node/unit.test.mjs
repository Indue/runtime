// Unit tests for the Phase 9 modules (no engine needed). Each test states what the old
// implementation did wrong where applicable, and fails if that behaviour comes back.
// Usage: node --test tests/node/unit.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { toCodePoints, validateReplacement, glyphsForCodePoints, advance, layoutAnchored, naturalXs, monotonic, gapPolicy, gapBounds } from '../../public_html/app.noblepdf.com/lab/true-text-edit/te-edit.mjs';
import { parseToUnicode, PdfDoc, interpretPage, loadFontModel, showXs } from '../../public_html/app.noblepdf.com/lab/true-text-edit/te-pdf.mjs';
import { parseTrueType } from '../../public_html/app.noblepdf.com/lab/true-text-edit/te-ttf.mjs';
import { layoutReplacement } from '../../public_html/app.noblepdf.com/lab/true-text-edit/phase8-layout.mjs';
import { mkpdf } from './lib/mkpdf.mjs';

const FIX = new URL('../../public_html/app.noblepdf.com/lab/true-text-edit/fixtures-phase9/', import.meta.url);
const W = { 32: 278, 65: 667, 66: 667, 97: 556, 98: 556, 99: 500 };
const G = (cp, code, w) => ({ cp, code, width1000: w ?? (W[code] ?? 500) });

test('F9: code points, not UTF-16 units', () => {
  assert.deepEqual(toCodePoints('a\u{10300}b'), [0x61, 0x10300, 0x62]);
  assert.equal(toCodePoints('\u{1F600}').length, 1);
  assert.equal('\u{1F600}'.length, 2, 'JavaScript length counts UTF-16 units');
});

test('replacement validation (empty, unpaired surrogates, combining, RTL, controls, line breaks, format chars)', () => {
  const code = (s) => (validateReplacement(s).ok ? 'ok' : validateReplacement(s).reason.code);
  assert.equal(code(''), 'empty-replacement');
  assert.equal(code('a\uD800'), 'invalid-unicode');
  assert.equal(code('\uDC00a'), 'invalid-unicode');
  assert.equal(code('e\u0301'), 'combining-mark-unsupported');
  assert.equal(code('\u05E9\u05DC'), 'rtl-unsupported');
  assert.equal(code('a\u0007'), 'control-character');
  assert.equal(code('a\nb'), 'line-break-unsupported');
  assert.equal(code('a\u200Db'), 'format-character-unsupported');
  assert.equal(code('X'), 'ok');
  assert.equal(code('\u{10300}\u{10301}'), 'ok');
});

test('F7: glyph mapping uses the font model, never code == Unicode', () => {
  const font = { codeForCp: (cp) => ({ 0x20ac: { code: 0x80, declared: true }, 0x57: { code: 69, declared: true } })[cp] || null, width: (c) => ({ 0x80: 556, 69: 944 })[c] };
  const r = glyphsForCodePoints([0x20ac, 0x57, 0x41], font);
  assert.deepEqual(r.glyphs.map((g) => g.code), [0x80, 69]);
  assert.equal(r.errors[0].code, 'glyph-not-in-font');
});

test('Tw applies to single-byte code 32 only (not to a space glyph at another code, not to 2-byte fonts)', () => {
  const run = { size: 10, tc: 0, tw: 3, singleByte: true };
  assert.equal(advance(G(0x20, 32, 278), run), 2.78 + 3);
  assert.equal(advance(G(0x20, 3, 278), run), 2.78);
  assert.equal(advance(G(0x20, 32, 278), { ...run, singleByte: false }), 2.78);
});

test('F9 regression: the Run #10 layout (UTF-16 indexing) misplaces word spacing after an astral glyph; the new layout does not', () => {
  // "x\u{10300} ab" -> replace "ab" with "a b": the real space of the new text is glyph 4.
  const oldText = 'x\u{10300} ab';
  const newText = 'x\u{10300} a b';
  const codeOf = (cp) => (cp === 0x20 ? 32 : ({ 0x78: 1, 0x10300: 2, 0x61: 3, 0x62: 4 })[cp]);
  const glyphs = (t) => toCodePoints(t).map((cp) => G(cp, codeOf(cp), 500));
  const run = { size: 10, tc: 0, tw: 4, singleByte: true };
  const oldG = glyphs(oldText);
  const oldXs = naturalXs(oldG, run);
  const newG = glyphs(newText);
  const now = layoutAnchored({ oldGlyphs: oldG, oldXs, newGlyphs: newG, run }).xs;
  const expected = naturalXs(newG, run);
  assert.deepEqual(now.map((x) => +x.toFixed(6)), expected.map((x) => +x.toFixed(6)));
  const legacy = layoutReplacement({ oldCodes: oldG.map((g) => g.code), oldXs, newCodes: newG.map((g) => g.code), newText, run: { size: 10, tc: 0, tw: 4, fontIsSimple: true }, widthOf: () => 500 }).xs;
  assert.ok(Math.abs(legacy[5] - expected[5]) > 3.9, `legacy glyph 5 at ${legacy[5]}, expected ${expected[5]}: the old code must be shown to be wrong`);
});

test('layout: prefix fixed, new glyphs natural, suffix shifted with its kerning; one-glyph and x0 != 0 handled', () => {
  const run = { size: 10, tc: 0, tw: 0, singleByte: true };
  const oldG = [G(0x41, 65), G(0x61, 97), G(0x62, 98), G(0x63, 99)];
  const oldXs = [0, 6.5, 12.4, 18.2]; // kerned
  const newG = [G(0x41, 65), G(0x42, 66), G(0x42, 66), G(0x62, 98), G(0x63, 99)];
  const r = layoutAnchored({ oldGlyphs: oldG, oldXs, newGlyphs: newG, run });
  assert.equal(r.prefix, 1);
  assert.equal(r.suffix, 2);
  assert.equal(r.xs[0], 0);
  assert.ok(Math.abs(r.xs[1] - 6.67) < 1e-9 && Math.abs(r.xs[2] - 13.34) < 1e-9);
  assert.ok(Math.abs(r.xs[3] - 20.01) < 1e-9, 'suffix starts at the natural position');
  assert.ok(Math.abs(r.xs[4] - r.xs[3] - (18.2 - 12.4)) < 1e-9, 'suffix keeps its kerning');
  const one = layoutAnchored({ oldGlyphs: [G(0x41, 65)], oldXs: [0], newGlyphs: [G(0x42, 66)], run });
  assert.deepEqual(one.xs, [0]);
  const off = layoutAnchored({ oldGlyphs: [G(0x41, 65), G(0x61, 97)], oldXs: [2, 8.5], newGlyphs: [G(0x42, 66), G(0x61, 97)], run });
  assert.equal(off.xs[0], 2, 'x0 is taken from the original run, not assumed to be 0');
  assert.throws(() => layoutAnchored({ oldGlyphs: oldG, oldXs, newGlyphs: [], run }), /empty/);
  assert.equal(monotonic([0, 1, 0.5]), false);
});

test('F10: gap policy uses font space width, Tc and size; fails closed', () => {
  const b = gapBounds({ run: { size: 12, tc: 0 }, font: { spaceWidth: 278 } });
  assert.ok(Math.abs(b.hi - (0.102 - 0.02)) < 1e-9 && Math.abs(b.lo - (-0.2 + 0.02)) < 1e-9);
  const narrow = gapBounds({ run: { size: 12, tc: 0 }, font: { spaceWidth: 100 } });
  assert.ok(Math.abs(narrow.hi - 0.03) < 1e-9, 'a narrow space lowers the PDFium bound');
  const tracked = gapBounds({ run: { size: 12, tc: 1.5 }, font: { spaceWidth: 278 } });
  assert.equal(tracked.trackedTextSplits, true);
  const run = { size: 10, tc: 0, tw: 0, singleByte: true };
  const glyphs = [G(0x61, 97), G(0x62, 98), G(0x63, 99)];
  const layout = { prefix: 0, changedTo: 3 };
  const xs = [0, 5.56 + 0.9, 5.56 + 0.9 + 5.56]; // 0.09 em extra gap inside a word
  assert.equal(gapPolicy({ xs, glyphs, run, font: { spaceWidth: 278 }, layout, oldGlyphs: glyphs, oldXs: xs.map(() => 0) }).ok, false);
  assert.equal(gapPolicy({ xs: naturalXs(glyphs, run), glyphs, run, font: { spaceWidth: null }, layout, oldGlyphs: glyphs, oldXs: [0, 0, 0] }).ok, true, 'natural gaps need no threshold');
  assert.equal(gapPolicy({ xs, glyphs, run, font: { spaceWidth: null }, layout, oldGlyphs: glyphs, oldXs: [0, 0, 0] }).violations[0].code, 'no-space-width');
  assert.equal(gapPolicy({ xs, glyphs, run, font: { spaceWidth: 278 }, layout: { prefix: 3, changedTo: 3 }, oldGlyphs: glyphs, oldXs: xs }).ok, true, 'gaps copied from the original are exempt');
});

test('ToUnicode parser: bfchar, bfrange (offset and array forms), surrogate pairs', () => {
  const t = parseToUnicode('1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0003> <0041> <0010> <D800DF00> endbfchar 2 beginbfrange <0020> <0022> <0061> <0030> <0031> [<0078> <D800DF01>] endbfrange');
  assert.deepEqual(t.map.get(3), [0x41]);
  assert.deepEqual(t.map.get(0x10), [0x10300]);
  assert.deepEqual(t.map.get(0x22), [0x63]);
  assert.deepEqual(t.map.get(0x31), [0x10301]);
});

test('font model: /Differences, WinAnsi Euro, lowest declared code, widths from /Widths', async () => {
  const doc = await PdfDoc.load(new Uint8Array(readFileSync(new URL('std-differences-before.pdf', FIX))));
  const page = doc.pages()[0];
  const ref = doc.resolve(page.resources.Font).F6;
  const f = await loadFontModel(doc, ref);
  assert.equal(f.fontClass, 'std14-type1');
  assert.equal(f.codeForCp(0x48).code, 65, 'H is drawn by code 65 through /Differences');
  assert.equal(f.codeForCp(0x57).code, 69);
  assert.equal(f.width(69), 944);
  assert.equal(f.codeForCp(0x41), null, 'A is no longer encoded');
  const euro = await PdfDoc.load(new Uint8Array(readFileSync(new URL('euro-winansi-before.pdf', FIX))));
  const fe = await loadFontModel(euro, euro.resolve(euro.pages()[0].resources.Font).F1);
  assert.equal(fe.codeForCp(0x20ac).code, 0x80);
  assert.equal(fe.codeForCp(0x20).code, 0x20, 'space: 0x20 wins over 0xA0');
});

test('independent interpreter reproduces spec positions (Tc, Tw, Tz, TJ, Ts, cm)', async () => {
  const pdf = mkpdf('q 2 0 0 2 10 20 cm BT /F1 10 Tf 1 Tc 2 Tw 150 Tz 3 Ts 1 0 0 1 5 6 Tm [(A b) -100 (c)] TJ ET Q');
  const doc = await PdfDoc.load(pdf);
  const it = await interpretPage(doc, 0);
  const s = it.shows[0];
  assert.deepEqual(s.glyphs.map((g) => g.code), [65, 32, 98, 99]);
  const adv = (w, code) => ((w / 1000) * 10 + 1 + (code === 32 ? 2 : 0));
  const x = [0, adv(667, 65), adv(667, 65) + adv(278, 32), adv(667, 65) + adv(278, 32) + adv(556, 98) + 1];
  assert.deepEqual(showXs(s).map((v) => +v.toFixed(6)), x.map((v) => +v.toFixed(6)));
  const o = s.glyphs[2].origin;
  assert.ok(Math.abs(o.x - (10 + 2 * (5 + 1.5 * x[2]))) < 1e-9 && Math.abs(o.y - (20 + 2 * (6 + 3))) < 1e-9, JSON.stringify(o));
});

test('TrueType reader: glyph presence in an embedded subset', async () => {
  const doc = await PdfDoc.load(new Uint8Array(readFileSync(new URL('blocked-glyph-missing-before.pdf', FIX))));
  const f = await loadFontModel(doc, doc.resolve(doc.pages()[0].resources.Font).F4);
  const prog = await f.program();
  assert.ok(prog.hasOutline(f.gidForCode(0x43, 0x43)), 'C is in the subset');
  assert.equal(f.gidForCode(0x5a, 0x5a), 0, 'Z is not in the subset');
  const cid = await PdfDoc.load(new Uint8Array(readFileSync(new URL('cid-greek-before.pdf', FIX))));
  const fc = await loadFontModel(cid, cid.resolve(cid.pages()[0].resources.Font).F7);
  const pc = await fc.program();
  const theta = fc.codeForCp(0x398);
  assert.ok(theta && pc.hasOutline(fc.gidForCode(theta.code, 0x398)));
  assert.throws(() => parseTrueType(new Uint8Array([0x74, 0x74, 0x63, 0x66, 0, 0, 0, 0])), /collections/);
});
