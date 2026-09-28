# NoblePDF True Edit — Phase 8 regression suite

Runs the True Edit V1 mutation path against the patched
`@embedpdf/pdfium` 2.15.1 (`FPDFText_SetPositions`) and gates production
readiness. CI runs it in the `phase8-suite` job against the engine built in
the same workflow run.

```sh
npm ci
node run.mjs --engine <dist dir containing index.js + pdfium.wasm> [--out out]
```

## Replacement layout (why "preserve every glyph origin" is wrong)

`FPDFText_SetPositions` places glyphs exactly where it is told (run 9: 0 pt
drift and a 0-pixel match against independently authored reference PDFs
on every fixture). Whether the result reads as contiguous text depends only
on the requested positions. These word-break thresholds were measured on the
shipped engines with a uniform per-letter gap sweep:

| Extra gap between letters | PDFium 2.15.1 (inside one text object) | PDF.js 4.10.38 |
|---|---|---|
| Word break when | TJ gap ≥ half the font's space width (0.139 em for Helvetica/Liberation) | TJ gap + Tc > 0.102 em |
| Tc (char spacing) | ignored for word breaks | counted as gap (Tc > 0.102 em splits every letter) |
| Tw (word spacing) | applies only to real space glyphs (single-byte 32) | same |

PDFium reads word breaks from the TJ separator values
(`CPDF_TextPage::ProcessTextObjectItems`: `spacing = -fontsize * k / 1000`,
compared to `CalculateSpaceThreshold`). PDF.js reads them from glyph positions
(`compareWithLastPosition`, `TRACKING_SPACE_FACTOR = 0.102`).

Putting new glyph *i* at old glyph *i*'s origin leaves a hole whenever the new
glyph is narrower. For example, `T` at `W`'s origin leaves 0.213 em, and both
engines read that as a word break ("T OKYOLAKE"). Tc cannot absorb it: PDFium
ignores Tc, PDF.js counts it as gap, and this revision has no public setter.

`lib/layout.mjs` is the reference model for NoblePDF:

- `layoutReplacement`: diff-anchored layout.
  - The common prefix keeps its exact original origins.
  - Changed glyphs advance naturally (width + Tc + Tw).
  - The common suffix keeps its internal spacing, shifted as one block.
  - The optional `fit` keeps the run width by adding slack at real spaces
    only.
- `semanticGapLint`: rejects any intra-word gap outside [-0.15, +0.08] em
  (TJ alone, for PDFium) or above 0.095 em (TJ + Tc, for PDF.js). NoblePDF
  should refuse to commit an edit that fails it.

## Fixtures

| Fixture | Covers |
|---|---|
| A | Untouched Tc/Tw/Tz/skew page, regenerated |
| B | Pure TJ |
| C | Scaled Tm + Tz + Tc/Tw |
| D | Rotated TJ |
| E | Embedded TrueType |
| F | Standard Helvetica |
| G | Real spaces + Tw |
| H | CID Identity-H subset |
| I | Same length (prefix anchored) |
| J1, J2 | Different length (natural; width kept at spaces) |
| P | Guard: the lint must reject per-glyph origin preservation |
| K1, K2 | Fractional widths: must be blocked |
| R | API rejection with no mutation |

`P8_DEV_REFERENCE=1` (stock engine only, never in CI) substitutes the
reference PDF for the engine output, so layouts and every non-engine check
can be validated locally.
