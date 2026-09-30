// NoblePDF True Edit V1 replacement layout model from Phase 8 Run #10.
// Keeps semantic text gaps inside safe PDFium/PDF.js thresholds.
export const GAP_MAX_EM = 0.08;
export const PDFJS_MAX_EM = 0.095;
export const GAP_MIN_EM = -0.15;

export function advance(code, isSpaceChar, run, widthOf) {
  return (
    (widthOf(code) * run.size) / 1000 +
    (run.tc ?? 0) +
    (isSpaceChar && run.fontIsSimple && code === 32 ? run.tw ?? 0 : 0)
  );
}

export function layoutReplacement({ oldCodes, oldXs, newCodes, newText, run, widthOf, fit = false }) {
  const oldN = oldCodes.length;
  const newN = newCodes.length;
  let p = 0;
  while (p < oldN && p < newN && oldCodes[p] === newCodes[p]) p++;
  let s = 0;
  while (s < oldN - p && s < newN - p && oldCodes[oldN - 1 - s] === newCodes[newN - 1 - s]) s++;

  const isSpace = (i) => newText[i] === ' ';
  const xs = new Array(newN);
  for (let i = 0; i < p; i++) xs[i] = oldXs[i];
  let x = p > 0 ? xs[p - 1] + advance(newCodes[p - 1], isSpace(p - 1), run, widthOf) : oldXs[0];
  for (let i = p; i < newN - s; i++) {
    xs[i] = x;
    x += advance(newCodes[i], isSpace(i), run, widthOf);
  }
  if (s > 0) {
    const shift = x - oldXs[oldN - s];
    for (let j = 0; j < s; j++) xs[newN - s + j] = oldXs[oldN - s + j] + shift;
  }

  let fitInfo = null;
  if (fit) {
    const oldEnd = oldXs[oldN - 1] + advance(oldCodes[oldN - 1], false, run, widthOf);
    const newEnd = xs[newN - 1] + advance(newCodes[newN - 1], isSpace(newN - 1), run, widthOf);
    const slack = oldEnd - newEnd;
    const spaces = [...newText].map((c, i) => (c === ' ' && i > 0 && i < newN - 1 ? i : -1)).filter((i) => i >= 0);
    if (spaces.length && Math.abs(slack) > 1e-6) {
      const per = slack / spaces.length;
      const spaceAdv = advance(newCodes[spaces[0]], true, run, widthOf);
      if (per >= -0.75 * spaceAdv) {
        let acc = 0;
        for (let i = 0; i < newN; i++) {
          xs[i] += acc;
          if (spaces.includes(i)) acc += per;
        }
        fitInfo = { slack, perSpace: per, spaces: spaces.length };
      } else {
        fitInfo = { slack, perSpace: per, spaces: spaces.length, skipped: 'would collapse spaces' };
      }
    } else {
      fitInfo = { slack, spaces: spaces.length, skipped: spaces.length ? 'no slack' : 'no real spaces' };
    }
  }
  return { xs, prefix: p, suffix: s, fit: fitInfo };
}

export function semanticGapLint({ xs, newCodes, newText, run, widthOf }) {
  const tcEm = (run.tc ?? 0) / run.size;
  let worst = null;
  const bad = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    if (newText[i] === ' ' || newText[i + 1] === ' ') continue;
    const extra = xs[i + 1] - xs[i] - advance(newCodes[i], false, run, widthOf);
    const em = extra / run.size;
    const pdfiumBad = em > GAP_MAX_EM || em < GAP_MIN_EM;
    const pdfjsBad = em + tcEm > Math.max(PDFJS_MAX_EM, tcEm);
    if (!worst || Math.abs(em) > Math.abs(worst.em)) worst = { i, em: +em.toFixed(4) };
    if (pdfiumBad || pdfjsBad) bad.push({ i, pair: newText.slice(i, i + 2), em: +em.toFixed(4) });
  }
  return { ok: bad.length === 0, bad, worst };
}
