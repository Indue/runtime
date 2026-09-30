// NoblePDF True Edit (Phase 9 lab): text model, replacement layout and semantic-gap policy.
// One indexing model: every array here is indexed by glyph, and every glyph carries
// exactly one Unicode code point and one PDF character code. JavaScript strings are
// converted with Array.from / for-of (code points), never with UTF-16 unit indexing.
// The layout keeps the Run #10 diff-anchored semantics (prefix fixed, new glyphs at
// natural advance, suffix shifted, optional width fitting over real spaces).
export const TE_EDIT_VERSION = 'te-edit-1';

// ------------------------------------------------------------------ text model
export function toCodePoints(str) {
  const cps = [];
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    cps.push(cp);
  }
  return cps;
}
export function fromCodePoints(cps) { return cps.map((c) => String.fromCodePoint(c)).join(''); }

const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]|[\u{10800}-\u{10FFF}]|[\u{1E800}-\u{1EFFF}]/u;
// Validates a replacement string. Returns { ok, cps, reason }.
export function validateReplacement(str) {
  if (typeof str !== 'string' || str.length === 0) return { ok: false, reason: { code: 'empty-replacement', detail: 'an empty replacement (deletion) is not supported' } };
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(str)) return { ok: false, reason: { code: 'invalid-unicode', detail: 'unpaired surrogate' } };
  const cps = toCodePoints(str);
  for (const cp of cps) {
    const ch = String.fromCodePoint(cp);
    if (cp === 0x0a || cp === 0x0d || cp === 0x2028 || cp === 0x2029) return { ok: false, cps, reason: { code: 'line-break-unsupported', detail: 'replacement text must stay on one line' } };
    if (/\p{Cc}/u.test(ch)) return { ok: false, cps, reason: { code: 'control-character', detail: `U+${cp.toString(16).toUpperCase()}` } };
    if (/\p{M}/u.test(ch)) return { ok: false, cps, reason: { code: 'combining-mark-unsupported', detail: `U+${cp.toString(16).toUpperCase()} needs glyph positioning that True Edit does not do` } };
    if (/\p{Cf}/u.test(ch)) return { ok: false, cps, reason: { code: 'format-character-unsupported', detail: `U+${cp.toString(16).toUpperCase()}` } };
    if (RTL.test(ch)) return { ok: false, cps, reason: { code: 'rtl-unsupported', detail: 'right-to-left scripts are not supported' } };
  }
  return { ok: true, cps };
}

// Maps code points to glyphs of a font model (see te-pdf.mjs). Never assumes code == Unicode.
export function glyphsForCodePoints(cps, font) {
  const glyphs = [];
  const errors = [];
  cps.forEach((cp, i) => {
    const r = font.codeForCp(cp);
    if (!r) { errors.push({ i, cp, code: 'glyph-not-in-font', detail: `U+${cp.toString(16).toUpperCase()} has no character code in this font` }); return; }
    if (r.ambiguous) { errors.push({ i, cp, code: 'ambiguous-encoding', detail: `U+${cp.toString(16).toUpperCase()} maps to several codes with different widths` }); return; }
    glyphs.push({ cp, code: r.code, width1000: font.width(r.code), declared: r.declared !== false });
  });
  return { glyphs, errors };
}

// ------------------------------------------------------------------ layout
// run: { size, tc, tw, singleByte } in unscaled text-space units (PDFium's object
// matrix already contains Tz). Word spacing applies to single-byte code 32 only,
// exactly as in ISO 32000 and PDFium, regardless of which glyph code 32 draws.
export function advance(g, run) {
  return (g.width1000 * run.size) / 1000 + (run.tc || 0) + (run.singleByte && g.code === 32 ? (run.tw || 0) : 0);
}
const same = (a, b) => a.code === b.code && a.cp === b.cp;

export function layoutAnchored({ oldGlyphs, oldXs, newGlyphs, run, fit = false }) {
  const oldN = oldGlyphs.length;
  const newN = newGlyphs.length;
  if (oldN === 0 || oldXs.length !== oldN) throw new Error('layout: original run is empty or positions do not match');
  if (newN === 0) throw new Error('layout: empty result is not supported');
  let p = 0;
  while (p < oldN && p < newN && same(oldGlyphs[p], newGlyphs[p])) p++;
  let s = 0;
  while (s < oldN - p && s < newN - p && same(oldGlyphs[oldN - 1 - s], newGlyphs[newN - 1 - s])) s++;
  const xs = new Array(newN);
  for (let i = 0; i < p; i++) xs[i] = oldXs[i];
  let x = p > 0 ? xs[p - 1] + advance(newGlyphs[p - 1], run) : oldXs[0];
  for (let i = p; i < newN - s; i++) { xs[i] = x; x += advance(newGlyphs[i], run); }
  if (s > 0) {
    const shift = x - oldXs[oldN - s];
    for (let j = 0; j < s; j++) xs[newN - s + j] = oldXs[oldN - s + j] + shift;
  }
  let fitInfo = null;
  if (fit) {
    const oldEnd = oldXs[oldN - 1] + advance(oldGlyphs[oldN - 1], run);
    const newEnd = xs[newN - 1] + advance(newGlyphs[newN - 1], run);
    const slack = oldEnd - newEnd;
    const spaces = [];
    for (let i = 1; i < newN - 1; i++) if (newGlyphs[i].cp === 0x20) spaces.push(i);
    if (spaces.length && Math.abs(slack) > 1e-6) {
      const per = slack / spaces.length;
      const spaceAdv = advance(newGlyphs[spaces[0]], run);
      if (per >= -0.75 * spaceAdv) {
        let acc = 0;
        const set = new Set(spaces);
        for (let i = 0; i < newN; i++) { xs[i] += acc; if (set.has(i)) acc += per; }
        fitInfo = { slack, perSpace: per, spaces: spaces.length, applied: true };
      } else fitInfo = { slack, perSpace: per, spaces: spaces.length, applied: false, skipped: 'would collapse spaces' };
    } else fitInfo = { slack, spaces: spaces.length, applied: false, skipped: spaces.length ? 'no slack' : 'no real spaces' };
  }
  return { xs, prefix: p, suffix: s, changedFrom: p, changedTo: newN - s, fit: fitInfo };
}

// Natural positions that FPDFText_SetCharcodes alone produces (PDFium resets char
// positions to natural advances). Used to decide whether an edit exercises SetPositions.
export function naturalXs(glyphs, run, x0 = 0) {
  const xs = [x0];
  for (let i = 0; i + 1 < glyphs.length; i++) xs.push(xs[i] + advance(glyphs[i], run));
  return xs;
}

export function monotonic(xs) {
  for (let i = 1; i < xs.length; i++) if (!(xs[i] >= xs[i - 1] - 1e-9) || !Number.isFinite(xs[i])) return false;
  return Number.isFinite(xs[0]);
}

// ------------------------------------------------------------------ semantic-gap policy (F10)
// Thresholds, in em of the font size, measured on PDFium 2.15.1 (Run #10 build) and
// PDF.js 3.11.174 / 4.10.38 by tests/node/thresholds.test.mjs:
//   PDF.js splits when (e + Tc/size) > 0.102 or < -0.2 (text transform scale invariant;
//     after regeneration Tz is written into Tm, which PDF.js treats the same way).
//   PDFium inserts a space when e > spaceWidth/2 + max(0, -Tc/size); never on negative gaps.
// e is the extra gap beyond the natural advance (width + Tc + Tw) in unscaled em.
export const PDFJS_SPLIT_POS_EM = 0.102;
export const PDFJS_SPLIT_NEG_EM = -0.2;
export const GAP_MARGIN_EM = 0.02;
export const SPACE_ADJ_MIN_EM = -0.25;
export const SPACE_ADJ_MAX_EM = 0.3;

export function gapBounds({ run, font }) {
  const tcEm = (run.tc || 0) / run.size;
  const pdfjsPos = PDFJS_SPLIT_POS_EM - tcEm;
  const pdfjsNeg = PDFJS_SPLIT_NEG_EM - tcEm;
  const pdfiumPos = font && Number.isFinite(font.spaceWidth) && font.spaceWidth > 0 ? font.spaceWidth / 2000 + Math.max(0, -tcEm) : null;
  const hi = Math.min(pdfjsPos, pdfiumPos === null ? Infinity : pdfiumPos) - GAP_MARGIN_EM;
  const lo = pdfjsNeg + GAP_MARGIN_EM;
  return { tcEm, pdfjsPos, pdfjsNeg, pdfiumPos, lo, hi, trackedTextSplits: pdfjsPos <= GAP_MARGIN_EM };
}

// Checks every gap the edit creates or changes. Gaps copied unchanged from the original
// run (inside an untouched prefix or suffix) are exempt: the original extraction was
// verified consistent before planning. Fails closed when a bound cannot be computed.
export function gapPolicy({ xs, glyphs, run, font, layout, oldGlyphs, oldXs }) {
  const b = gapBounds({ run, font });
  const violations = [];
  const pairs = [];
  if (b.trackedTextSplits) violations.push({ code: 'tracked-text', detail: `Tc ${run.tc} at ${run.size} pt makes PDF.js split every glyph` });
  for (let i = 0; i + 1 < xs.length; i++) {
    const e = (xs[i + 1] - xs[i] - advance(glyphs[i], run)) / run.size;
    const inPrefix = i + 1 < layout.prefix;
    const inSuffix = i >= layout.changedTo;
    let original = null;
    if (inPrefix) original = (oldXs[i + 1] - oldXs[i] - advance(oldGlyphs[i], run)) / run.size;
    if (inSuffix) {
      const oi = oldGlyphs.length - (xs.length - i);
      original = (oldXs[oi + 1] - oldXs[oi] - advance(oldGlyphs[oi], run)) / run.size;
    }
    const preserved = original !== null && Math.abs(original - e) < 1e-6;
    const spaceAdj = glyphs[i].cp === 0x20 || glyphs[i + 1].cp === 0x20;
    const rec = { i, e: +e.toFixed(5), preserved, spaceAdj };
    pairs.push(rec);
    if (preserved || Math.abs(e) < 1e-6) continue;
    if (spaceAdj) {
      if (e < SPACE_ADJ_MIN_EM || e > SPACE_ADJ_MAX_EM) violations.push({ code: 'space-gap-out-of-range', detail: `pair ${i} e=${e.toFixed(4)} em` });
      continue;
    }
    if (b.pdfiumPos === null) { violations.push({ code: 'no-space-width', detail: 'font has no space glyph width; PDFium split threshold unknown' }); continue; }
    if (e > b.hi || e < b.lo) violations.push({ code: 'semantic-gap', detail: `pair ${i} e=${e.toFixed(4)} em outside [${b.lo.toFixed(3)}, ${b.hi.toFixed(3)}]` });
  }
  return { ok: violations.length === 0, violations, bounds: b, pairs };
}
