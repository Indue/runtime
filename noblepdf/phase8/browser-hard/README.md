# NoblePDF True Edit — browser hard gate

This suite exercises the **actual NoblePDF browser True Edit bridge** against the patched
`@embedpdf/pdfium` 2.15.1 build produced by the same GitHub workflow run.

It is intentionally stricter than a smoke test. The gate now contains **28 deterministic cases**.

Supported edits cover same-length, longer, shorter, real spaces, rotation, verified non-zero
character spacing, horizontal scaling, verified existing `TJ` segmentation, repeated identical
text at distinct positions, and multiple edits on one page.

Fail-closed cases cover overlapping duplicate text objects, custom formatting, auto-fit, vertical
text metadata, single-glyph objects, supplementary Unicode, non-zero `Tw` with spaces, real
fractional source `/Widths` affecting both old and newly typed glyphs, missing trusted new-glyph
metrics, missing or incorrect `Tc`, missing `TJ` adjustment metadata, unmappable BMP Unicode,
missing source objects, degenerate matrices, empty replacements, and a multi-edit transaction
where a later edit becomes ambiguous.

The browser bridge's source-font contract is deliberately conservative:

- PDF.js `sourceGlyphPlan` widths are authoritative for glyphs already present in the source run.
- `sourceFontMetrics` may extend that trusted width set for replacement characters that were
  observed with the same PDF font resource elsewhere by the caller.
- every required width must be finite, positive and integral; fractional source metrics block
  True Edit and fall back to NoblePDF's existing flatten path;
- caller `charSpacing` / `wordSpacing` is checked against the original PDF glyph geometry and the
  recorded `TJ` adjustments before any mutation;
- after `FPDFText_SetText`, a fresh PDFium text page must round-trip to exactly the requested
  Unicode text before positions are changed or content is generated.

Successful outputs must reopen in PDFium, retain the same object census, contain no raster image
objects, keep the edited run anchored, keep untouched text objects unchanged, and expose the
replacement through PDFium search/copy semantics. CI additionally runs `qpdf --check` and an
independent Poppler `pdftotext` extraction.

The existing `noblepdf/phase8` suite remains authoritative for the engine-level PDFium + PDF.js
reference fixtures. This browser hard gate adds integration/locator/fallback coverage around the
production bridge. Both gates must pass.

## Run

```bash
NOBLEPDF_REQUIRE_EXTERNAL=1 node noblepdf/phase8/browser-hard/run-hard.mjs \
  --engine engine \
  --out noblepdf/phase8/browser-hard/out
```

The engine directory must contain the matching `index.js` and `pdfium.wasm` built from the same
workflow run.

## Reports

The runner writes:

- `report.json`
- `report.md`
- one output PDF for every supported/pass fixture

A non-zero exit code means the hard gate failed.
