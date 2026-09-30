# NoblePDF True Edit: Phase 8 V2.1.1 hardening and Phase 9 lab - audit report

Release: `noblepdf-trueedit-phase9-lab-v3` (lab only, fixtures only). Date: 2026-09-30.

## 1. Status

- NOT production-ready. Nothing in this package touches the production editor. The Phase 9
  editor opens only hash-pinned lab fixtures; there is no upload path.
- Local evidence (this machine, real Run #10 engine, hash-verified copy): every step of
  `tests/run-all.sh` passed (unit, SetPositions API, fixture suite on PDF.js 3.11.174 /
  4.10.38 / 6.3.289, fault injection, threshold regression, manifest, V2.1.1 browser matrix,
  Phase 9 browser suite and editor in Chromium, ASCII check).
- Still required before any production decision: (1) the GitHub workflow run in your
  repository, (2) the live real-browser runs on app.noblepdf.com described in
  README-PHASE9-LAB.txt, (3) a separate production-integration plan with a real-document
  corpus study. Local runs are not a substitute for the live runs.

Environment of the recorded runs: Node 22.22.2, Python 3.12.3, Playwright 1.56.0,
HeadlessChrome 141.0.7390.37, @embedpdf/pdfium 2.15.1 (stock), Run #10 patched engine.

## 2. Baseline and pins

| Item | SHA-256 / value |
|---|---|
| Patched engine pdfium.wasm (Run #10, 4,648,757 B) | c4f54bda9bc730c0aeb6579254f0431fa95886478cd19967555be6ea2a35ce11 |
| Patched engine index.js | 2af28659a83b5691ed1193bd0819a6a1339036fb08505826d561c7541762baf2 |
| Stock engine pdfium.wasm (npm 2.15.1) | 5e4cd023c3dad4a895b3571ca573d3fc51bac6de48360d95283134385b954eaa |
| Stock engine index.js (npm dist/index.js, as served live) | 0e31ce6c207b371384392242c560b5e88d90221843dfbbaebf3f5cff1e22f2e0 |
| PDF.js 3.11.174 pdf.min.js | 5b5799e6f8c680663207ac5b42ee14eed2a406fa7af48f50c154f0c0b1566946 |
| PDF.js 3.11.174 pdf.min.js SRI | sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e |
| PDF.js 3.11.174 pdf.worker.min.js | feabdf309770ed24bba31a5467836cdc8cf639c705af27d52b585b041bb8527b |
| Phase 9 fixture manifest (pinned in both pages) | @@MANIFEST_SHA@@ |

Phase 8 V2 live PASS on the real engine is the immutable baseline; V2.1.1 changes only
the stock pin, PAGE_VERSION, the PDF.js SRI attribute and the module cache key.

## 3. Requirement coverage

| # | Requirement | Where | Evidence |
|---|---|---|---|
| 1 | V2.1.1 hardening | phase8-v2.js (STOCK_PINNED, PAGE_VERSION phase8-v2.1.1), phase8-v2.html (SRI, ?v=2) | V2 matrix H10..H24 all OK; H23 = PHASE 8 V2 PASS with the real engine; H24 = unpinned stock refused (P09) |
| 2 | F7 character-code widths | te-pdf.mjs font model (codes, not Unicode), te-edit.mjs glyphsForCodePoints | 7 code != Unicode fixtures; FI-03 (legacy code == Unicode) rejected on all 7; R03 reference codes equal lab codes |
| 3 | F9 one indexing model | te-edit.mjs toCodePoints (no charCodeAt), te-engine.mjs glyph groups merge PDFium surrogate units | unit F9 regression fails the old layout; FI-04 rejected on ttf-astral-tw; cid-astral and ttf-astral-tw commit in Node and Chromium |
| 4 | F10 gap rules | te-edit.mjs gapBounds/gapPolicy (space width, Tc, size; Tz/Tm/CTM/rotation invariant) | thresholds on 14 text states, 3 PDF.js versions; old limits shown unsafe |
| 5 | F15 SetPositions edge cases | te-pipeline.mjs applyEdit (one glyph skips the call), te-edit.mjs monotonic | setpositions-api 8/8 on the real API; FI-02 legacy count-0 path fails |
| 6 | Live layout fixtures with independent references | tests/fixtures/gen_fixtures.py (Python, independent), fixtures-phase9/ | 22 supported fixtures, R00..R06 and X02/X03 against references |
| 7 | Untouched-object verification | V06, V08, V10, X01 | FT-06 (0.5 pt move) and FT-08 (dropped kerning) rejected; rejected-untouched-grouping |
| 8 | PDF.js security | te-render.mjs SAFE_OPTIONS, te-env.mjs checks, CSP | section 7 |
| 9 | Privacy model | te-env.mjs, phase8-csp-guard.js, CSP meta | S02..S06, E06 |
| 10 | Phase 9 interactive editor | phase9-editor.html/.js | E01..E06 |
| 11 | Fail-closed gates | te-pipeline.mjs documentGates/targetGates, te-pdf.mjs, te-edit.mjs | 25 blocked/rejected fixtures, section 5.2 |
| 12 | Per-edit verification | te-pipeline.mjs verifyEdit V01..V13, editor X01 | section 6 |
| 13 | CI expansion and fault injection | tests/, .github/workflows/true-edit-phase9-lab.yml | section 5.3 |
| 14 | Deliverables | this package | README-PHASE9-LAB.txt, deploy/, tests/, MANIFEST.sha256 |
| 15 | Acceptance matrix, no production claim | this report | section 5 |

## 4. Findings from the real Run #10 engine

1. PDFium's text page indexes a supplementary-plane character as two UTF-16 units (high and
   low surrogate, same text object, same origin). The engine wrapper merges them into one
   glyph entry; all layout and verification works on glyphs, search ranges on units.
2. FPDFFont_GetGlyphWidth / FPDFFont_GetGlyphPath take a Unicode value; PDFium cannot
   reverse-map supplementary-plane characters (returns the default width 1000). For those
   characters the PDFium width cross-check is skipped; positions are proven after mutation
   (V05, V08) and glyph presence by the independent TrueType reader (te-ttf.mjs).
3. PDFium FPDFText_Find* cannot find supplementary-plane text even in unmodified PDFs. V07
   runs a control search on the original; when the control also finds nothing, search is
   reported as not applicable and presence/absence rest on the exact-text checks.
4. FPDFText_SetPositions: count must equal glyphs - 1; count 0 is rejected with or without a
   pointer (so one-glyph results must skip the call); NaN and Infinity are rejected;
   decreasing and negative positions are ACCEPTED, so the lab enforces monotonic positions.
5. The object matrix includes Tz and the leading TJ offset; glyph 0 is always at x = 0 in
   object space. Rise is folded into the position; the generator writes Tz into Tm.
6. Regeneration moves untouched objects by 0.00 pt and renders them identically, but PDF.js
   (3.11.174, 4.10.38, 6.3.289) can group an untouched Tz 150 object with 0.08 em kerning
   differently after regeneration ("Stret ched" -> "Stretched"). V12 catches it; fixture
   rejected-untouched-grouping proves the edit is refused.
7. Standard-14 Helvetica without /Widths: PDFium Euro width 667 vs AFM/PDF.js 556; blocked as
   metrics-disagree.
8. Word-split thresholds (section 5.4): PDFium splits at e > spaceWidth/2 + max(0, -Tc/size)
   em and never on negative gaps down to -1 em; PDF.js splits at +0.102 / -0.2 em shifted by
   Tc, identical in 3.11.174, 4.10.38 and 6.3.289, invariant to Tm scale, rotation and cm; the
   Tz operator form differs (Tz 150: +0.068 em) but edited objects are always regenerated
   with Tz in Tm.

## 5. Acceptance matrix

### 5.1 Supported edits (must commit and match the independent reference)

Node columns: the full pipeline (V01..V13) plus reference checks R00..R06. Chromium column:
the Phase 9 suite page (S01), which adds X01 (outside the edit, output vs original, 288 dpi),
X02 (around the edit, output vs reference, 288 dpi) and X03 (full page vs reference, 144 dpi).

@@SUPPORTED@@

20 of 22 supported fixtures distinguish a working SetPositions from a no-op. one-glyph-object
(tests the skipped call) and p8-waveskern (full replacement; covered by the Phase 8 V2 page's
legacy control) cannot, and are not counted as SetPositions evidence.

### 5.2 Blocked and rejected cases (must fail closed for the stated reason)

@@BLOCKED@@

### 5.3 Regression and fault injection

@@FAULTS@@

Also: unit tests 11/11, SetPositions API tests 8/8 (real engine), manifest verification.

### 5.4 F10 threshold regression (measured, em of the font size)

@@THRESHOLDS@@

### 5.5 Browser (Chromium, real engine, local harness)

@@BROWSER@@

V2.1.1 matrix (tests/results/v2-harness-matrix.log): H10..H24 all OK (V1 scenarios H01..H06
need the V1 page, which is not part of this package).

### 5.6 Live (app.noblepdf.com) - PENDING, to be run by Robert

| Page | Expected |
|---|---|
| /lab/true-text-edit/phase8-v2.html | Ready YES, P09 "pinned identity matches", PHASE 8 V2 PASS (this fixture only) |
| /lab/true-text-edit/phase9-suite.html | Ready YES, Matched 47/47, control PASS, PHASE 9 SUITE PASS (fixtures only); WARN lines for the host monitoring scripts are expected |
| /lab/true-text-edit/phase9-editor.html | edit, download, undo, reset, blocked and rejected cases as in README-PHASE9-LAB.txt |

## 6. Per-edit verification (all must pass before a commit)

- V01 single non-incremental revision: one %%EOF, one startxref, no /Prev, valid classic xref.
- V02 reopens; page count, object census and annotation census unchanged.
- V03 exact PDFium page text equals the expected text.
- V04 exactly one text object changed, at the target index, to the expected text.
- V05 target glyph origins equal the planned layout within 0.01 pt (PDFium, reopened).
- V06 untouched objects: identical text, glyph origins and bounds within 0.01 pt.
- V07 search: replacement found in the target (match case, whole words), old text gone
  from the target and page counts consistent; control-based N/A for supplementary-plane text.
- V08 independent content interpreter agrees with PDFium on every origin; target codes and
  positions equal the plan; untouched text-showing operations unchanged.
- V09 no image, form or shading added or removed (no overlay, no XObject substitute).
- V10 the multiset of shown text equals the original with only the target replaced
  (all referenced content, forms included).
- V11 no text in unreferenced streams; old text bytes only where verified content shows
  them; invisible text unchanged.
- V12 exact PDF.js page text equals the expected text.
- V13 PDF.js places the new text at the target position.
- X01 (editor and browser suite) outside the edited box the page renders identically at
  288 dpi; X02/X03 (suite) the output renders identically to the independent reference.
- R00..R06 (suite) reference hash, PDFium text, all glyph origins, character codes (Python
  encoder vs lab), PDF.js text, expected text, discrimination agreement with the generator.

## 7. PDF.js security decision

- CVE-2024-4367 (pdfjs-dist <= 4.1.392, fixed 4.2.67; Mozilla bug 1893645) requires
  isEvalSupported true. Every lab getDocument call forces isEvalSupported false
  (te-render.mjs SAFE_OPTIONS), and the page CSP has no unsafe-eval; te-env.mjs proves at
  runtime that eval throws.
- CVE-2026-16633 / GHSA-hq66-cqwq-w95j (pdfjs-dist >= 5.6.83 < 6.2.108, fixed 6.2.108)
  requires enableScripting and no script CSP. 3.11.174 is outside the affected range, the
  lab never enables scripting and the CSP blocks inline and foreign script.
- Delivery: same-origin library and worker only, exact version check, SHA-256 of both files
  checked at runtime, SRI attribute on the script tag, no CDN anywhere.
- Decision: the lab keeps 3.11.174 with the enforced configuration. 6.3.289 (current release
  line) was validated for text grouping only (thresholds identical, Node suite 47/47). A
  production upgrade is a separate decision and must rerun this whole suite in browsers.

## 8. Privacy model

- No user uploads: the pages fetch only constant, pinned fixture URLs; there is no file input.
- Engines: bytes fetched same-origin, SHA-256 verified before any engine code runs, wasm
  instantiated only from the verified bytes (a glue that fetches its own wasm is refused).
- CSP meta: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; no unsafe-eval, no
  unsafe-inline; connect-src 'self'. The early recorder (phase8-csp-guard.js) logs every
  violation.
- Foreign scripts: every script element not on the expected list must be matched by a
  recorded CSP violation (inline scripts by count, external scripts by URL), otherwise the
  audit assumes it executed and FAILS. Scripts placed before the CSP meta always FAIL.
- Resource Timing: any cross-origin entry without a matching violation FAILS.
- The GoDaddy monitoring markup (inline _trfq plus img1.wsimg.com tccl.min.js after the CSP
  meta) is blocked and reported as WARN; it FAILS if it executes.
- A controlling service worker is reported (WARN); all engine, PDF.js and fixture bytes are
  hash-verified regardless.

## 9. Known limitations

1. Fonts: only three validated classes: non-embedded standard-14 Type1 (base encoding plus
   /Differences, metrics must agree), embedded simple TrueType (FontFile2), and Type0
   Identity-H with CIDFontType2 (FontFile2, CIDToGIDMap Identity or stream). Type3, embedded
   Type1/CFF, CIDFontType0, non-embedded TrueType, vertical writing, other CMaps and fonts
   without a usable Unicode map or widths are blocked.
2. New glyphs must already exist in the embedded subset; fonts are never extended.
3. Tagged PDFs: only plain structure tags with MCID around the target; ActualText, Alt, E,
   optional content and ambiguous nesting are blocked.
4. Blocked states: page /Rotate != 0, text rise (Ts), render modes other than 0, clipped
   text, text in Form XObjects, shared content streams, signed, encrypted,
   permission-restricted and XFA documents, collisions with neighbouring objects.
5. Single-line edits inside one text object; no reflow, no line breaks, no new objects.
   Width-preserving fit only distributes slack over real spaces within the gap policy.
6. Input: combining marks, RTL, format characters (ZWJ etc.), controls and line breaks are
   refused; complex shaping is unsupported.
7. PDFium cannot search supplementary-plane text and cannot measure it through its Unicode
   API (findings 2 and 3); the lab compensates but live search in viewers built on PDFium
   will still not find such text.
8. GenerateContent rewrites the whole page content stream. Untouched objects are verified
   (0.01 pt, rendering, PDF.js grouping), and pages where PDF.js grouping of untouched
   objects would change are refused rather than edited.
9. Saving is non-incremental: earlier revisions are flattened (one reason signed documents
   are blocked).
10. The independent reader does not decrypt; encrypted documents are blocked.
11. The editor lab UI handles page 1 of single-page fixtures; the pipeline takes a page index
    but multi-page editing has not been exercised.
12. Coverage is fixture-based. Real-world PDFs (producer quirks, damaged files, unusual
    fonts) have not been measured; a corpus study is required before production.
13. Render checks compare two PDF.js renders in the same browser; cross-renderer visual
    checks (PDFium render, Acrobat, Preview) are manual.
14. PDF.js stays at 3.11.174 (enforced safe configuration); see section 7.

## 10. Before any production integration

1. GitHub workflow green in your repository (same sequence as tests/run-all.sh).
2. Live runs of the three lab pages in Chrome (and ideally Safari, Firefox, one mobile
   browser) with the reports pasted back.
3. A real-document corpus study (gate hit rates, false blocks, verification failures).
4. A separate design and review for production integration (upload path, memory limits,
   multi-page UI, PDF.js upgrade decision), with its own deploy and rollback plan.
