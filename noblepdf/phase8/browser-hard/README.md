# NoblePDF True Edit — browser hard gate

This suite exercises the **actual NoblePDF browser True Edit bridge** against the patched
`@embedpdf/pdfium` 2.15.1 build produced by the same GitHub workflow run.

It is intentionally stricter than a smoke test. The gate contains 22 deterministic cases:

- supported edits: same-length, longer, shorter, real spaces, rotation, character spacing,
  horizontal scaling, existing `TJ` segmentation, repeated identical text at distinct positions,
  and multiple edits on one page;
- fail-closed cases: overlapping duplicate text objects, custom formatting, auto-fit, vertical
  text metadata, single-glyph objects, supplementary Unicode, non-zero `Tw` with spaces,
  fractional source metrics, missing source objects, degenerate matrices, empty replacements,
  and a multi-edit transaction where a later edit becomes ambiguous;
- successful outputs must reopen in PDFium, retain the same object census, contain no raster
  image objects, keep the edited run anchored, keep untouched text objects unchanged, and expose
  the replacement through PDFium search/copy semantics;
- CI additionally runs `qpdf --check` and independent Poppler `pdftotext` extraction.

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
