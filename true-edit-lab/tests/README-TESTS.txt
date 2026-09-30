NoblePDF True Edit lab tests (Phase 8 V2.1.1 + Phase 9). Not deployable. ASCII only.

Setup (once, from the package root)
  cd tests && npm install && cd ..        pdfjs-dist 3.11.174 (alias pdfjs3), 4.10.38 (pdfjs4),
                                          6.3.289 (pdfjs-dist), @embedpdf/pdfium 2.15.1 (stock)
  sh tests/tools/fetch-engine.sh          Run #10 patched engine -> tests/.engine/patched (hash-pinned)
  python3 -m pip install playwright==1.56.0 && python3 -m playwright install chromium

Run everything
  sh tests/run-all.sh                     writes tests/results/*.log and *.json
  sh tests/run-all.sh --no-browser        Node only

What each step proves
  unit-tests               F7 code mapping, F9 code-point indexing (with a regression that the old
                           UTF-16 layout fails), F10 gap policy, ToUnicode/font model, interpreter
                           arithmetic, TrueType glyph reader.
  setpositions-api-tests   F15 on the REAL engine: count 0 rejected, NaN/Inf rejected, decreasing
                           positions accepted by the engine (so the lab refuses them), positions
                           honoured exactly, leading TJ and Tz folded into the object matrix.
  node-suite-pdfjs3/4/6    all 47 fixtures through analyze -> gates -> plan -> mutate -> save ->
                           reopen -> V01..V13, committed results compared with the independent
                           references (R00..R06). Expectations must match exactly.
  faults                   12 fault classes; a class counts only on fixtures where it changes the
                           result, and every such fixture must be rejected.
  thresholds-pdfjs3/4/6    measured PDFium and PDF.js word-split thresholds for 14 text states;
                           the gap policy must sit inside every measured interval; shows that the
                           old fixed limits were unsafe.
  fixture-manifest         fixture hashes and the manifest pin in the pages.
  host-compat              every deployed file uses an extension the live host serves (the host
                           answers 403 to every *.json URL); the manifest URL pinned in the
                           suite and editor pages is deployed with that pin.
  deploy-rollback          deploy and rollback scripts against a throwaway app root: writes stay
                           under lab/true-text-edit/, .. paths and tampered backup lists are
                           refused, rollback restores the tree byte- and mode-identical.
  v2-harness-matrix        V2.1.1 page in Chromium (fake engines, injection, real engine H23,
                           unpinned stock H24). V1 scenarios run only when V1_LAB_DIR is set.
  phase9-browser           Phase 9 suite page (S01..S08) and editor (E01..E08) in Chromium with
                           the real engine, including host-style script injection, a tampered
                           manifest (S07, E07) and a tampered fixture PDF (S08, E08). S01 also
                           requires 22 committed, 25 failed closed and the SetPositions-disabled
                           control rejected. H01 fetches, from the page, the exact manifest URL
                           of both pages and all deploy-files.txt entries through the harness
                           server, which imitates the live host (403 for every *.json URL).
                           H02 makes more than 250 requests (the default Resource Timing
                           buffer), then loads a cross-origin image that the harness-relaxed
                           img-src allows: the network audit must still see it and fail.
  ascii-check              every text file in the package is ASCII (no em dash).

Fixtures
  tests/fixtures/gen_fixtures.py regenerates fixtures-phase9/ independently of the lab code
  (Python: reportlab 4.4.10 AFM data, pypdf 5.9.0 glyph list, fontTools 4.62.1 subsetting of
  DejaVuSans, pikepdf 10.5.1 encryption):
    python3 tests/fixtures/gen_fixtures.py public_html/app.noblepdf.com/lab/true-text-edit/fixtures-phase9 \
            public_html/app.noblepdf.com/lab/true-text-edit/fixtures-phase8
    python3 tests/tools/pin_manifest.py     (the encrypted fixture changes on every run)
  then rerun the whole sequence and redeploy. Byte-identical regeneration across machines is
  not expected (zlib and fontTools versions); the committed files and manifest are the pins.

Paths can be overridden with PATCHED_ENGINE_DIR, STOCK_ENGINE_DIR, TE_DEPS, TE_DEPS6,
PDFJS_DIR, PDFIUM_DIR, REAL_PATCHED_DIR, V1_LAB_DIR, PORT.
