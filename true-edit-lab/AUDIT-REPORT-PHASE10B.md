# NoblePDF True Edit - Phase 10B clipping investigation: audit report

Lab only. Branch `noblepdf-phase10b-clipping-investigation`, from the Phase 10 baseline
`d7b121d5d5806c0fbe0a94ee28deda9bae31f23a`. Nothing is deployed or merged; PR #4 and the
deployed Phase 10 lab are untouched. No Phase 9 file is changed (`check_phase9_frozen.py`:
the diff from a3f9038 still only adds files). Run #10 is unchanged; no new engine was built.

## Symptom

Three unrelated real PDFs in the live Phase 10 lab: ordinary visible text blocked by
`target-clipped` (one single-page PDF: 47 text objects, 0 supported, 47 blocked); some
objects also had `engine-interpreter-count-mismatch`.

## Root cause

Phase 9 blocks a text object when EITHER clip signal is set (`te-pipeline.mjs`, `targetGates`):

- `o.clipPaths > 0`: `FPDFClipPath_CountPaths(FPDFPageObj_GetClipPath(obj))` (`te-engine.mjs`).
- `s.clip`: a boolean in the independent interpreter (`te-pdf.mjs`): any `W`/`W*` followed by a
  path-ending operator sets it until the enclosing `Q`. No geometry is kept.

PDF semantics and PDFium facts (this repository's PDFium source, confirmed on the engine):

1. Every page object copies the clip active when it is created
   (`CPDF_StreamContentParser::SetGraphicStates`). A clip path is recorded in page space
   (the CTM is applied, `AddPathObject`) and successive clips intersect.
2. Pages get no implicit clip; only Form XObjects get their `/BBox` as a clip
   (`CPDF_ContentParser`).
3. After parsing, `CPDF_ContentParser::CheckClip` REMOVES an object's clip when it is a single
   rectangle that contains the object's bounds (for text, the union of glyph outline boxes,
   `CPDF_TextObject::CalcPositionDataInternal`). `FPDFClipPath_CountPaths` then returns -1.
   A retained clip means: more than one path, a non-rectangle, or a rectangle that does not
   contain the glyph bounds. `AppendPathWithAutoMerge` drops an older rectangle that contains
   the new clip path.
4. `GenerateContent` re-emits each object inside `q ... Q` with its own (simplified) clip.
5. A text clip (render modes 4-7) is stored as text, not as a path: `CountPaths` returns 0.

Real generators wrap page content in a page-size or content-area rectangle clip:

| Generator (observed here) | Page-level clip |
|---|---|
| Chromium 141 / Skia PDF m141 (printed in this container) | `.24 0 0 -.24 0 842.88 cm q 212.5 234.375 2058.35 3045.9 re W* n` (content area, flipped CTM) |
| LibreOffice 24.2 Writer (converted in this container) | `/Artifact BMC q 0 0.028 595.275 841.861 re W* n EMC`, closed by the final `Q` |
| Microsoft Word (known pattern, modelled in `wordLike()`) | `q 0.000008871 0 595.32 841.92 re W* n BT ... ET Q` per text block |

So every text object on such a page is under a clip. PDFium removes it (single containing
rectangle), but the Phase 9 boolean stays true: **every object is blocked by
`target-clipped` ("clipping path active in the content stream") although PDFium itself treats
the clip as irrelevant.** The two signals are not the same clip test and often disagree.

Measured (stock 2.15.1 engine locally for the probes; the same PDFium code as Run #10, and
every assertion is repeated on Run #10 in CI):

| Input | Before (Phase 9 gates) | After (Phase 10B) |
|---|---|---|
| Chromium print, 229 per-glyph text objects | 229 `target-clipped` (201 by the stream boolean only) | 201 contained, 3 cut by an `overflow:hidden` box, 25 under a rounded (curved) clip; 94 SUPPORTED (0 before); remaining blocker `metrics-disagree` |
| LibreOffice print, 16 text objects | 16 `target-clipped` | 16 contained; remaining blockers `marked-content-ambiguous` (LibreOffice style-name tags such as "Text body") and 1 ligature |
| Phase 9 `blocked-clip` fixture | `target-clipped` (stream boolean only; PDFium drops the clip) | contained: `[60 690 360 720]` holds the original and the replacement |

The live symptom (47/47 blocked by `target-clipped`) is fully explained by this mechanism
when the three PDFs install a page-level clip, which all three generator families above do.
What still needs a redacted report to confirm: the generator of the three PDFs, the clip kind
of each blocked object, and which non-clip gate blocks next. The corpus export now carries
exactly that by default, without text or file names.

## `engine-interpreter-count-mismatch` (separate; not changed)

Raised when the interpreter's glyph count differs from PDFium's character count for the
object. Reproduced with LibreOffice: "cut off" draws the `ff` ligature as ONE glyph whose
ToUnicode maps to TWO code points; PDFium's text page emits two characters. The gate is
correct (an edit cannot map characters to glyphs one-to-one) and stays. Phase 10B adds a
diagnostic `countMismatch` per object: glyph and character counts, multi-code-point and
unmapped glyphs, and the cause (`multi-codepoint-glyph` when the expanded code points equal
PDFium's characters, else `unmapped-glyph` or `unexplained`).

## Phase 9 gap found

Text drawn after a text clipping render mode (`Tr` 4-7) is clipped to glyph outlines, but
neither Phase 9 signal sees it (PDFium counts no path; the boolean records `W`/`W*` only).
Phase 10B blocks it (`target-clipped` + `clip-geometry-unsupported`). Phase 9 itself is not
changed.

## Phase 10B rule (corpus path only; `te-corpus-clip.mjs`)

For each direct text object, two independent clip regions are computed:

- **Content stream** (own tokenizer, aligned op-for-op with `te-pdf.mjs` show records, checked
  for every object): `re m l c v y h`, `W W*`, `n` and painting operators, `q Q`, `cm`,
  successive clips intersect, text clip modes. A path region is a known rectangle only for ONE
  subpath without curves whose four vertices form an axis-aligned rectangle after the CTM
  (fill rule irrelevant for a simple rectangle); a single point or zero area is empty;
  everything else (curves, several subpaths, rotated/skewed, `W n` without a path, malformed)
  is non-rectangular.
- **PDFium**: `FPDFClipPath_CountPaths/CountPathSegments/GetPathSegment`,
  `FPDFPathSegment_GetPoint/GetType` (exported by Run #10), same region rules, intersected.

Agreement: both none; or both the same rectangle (0.01 pt); or PDFium none (dropped by
CheckClip) and the stream rectangle contains PDFium's bounds. Anything else disagrees.

Text bounds: independent glyph ink boxes (TrueType `glyf` boxes of the embedded program for
embedded TrueType and CIDFontType2; the AFM FontBBox plus 0.1 em on every side for
non-embedded standard-14 fonts) at the interpreter's glyph origins, and PDFium's bounds.

| Case | Result |
|---|---|
| no clip | unchanged Phase 9 behaviour |
| agreed rectangle containing the original run (independent AND PDFium bounds, 0.01 pt float tolerance) and, when planned, the candidate run (independent bounds at the planned positions, both with the independent matrix and PDFium's matrix) | `target-clipped` cleared; the plan proceeds; K01 after mutation |
| rectangle cuts the original | BLOCKED `target-clipped` + `clip-cuts-text` |
| candidate would reach outside the clip | edit BLOCKED before mutation: `clip-candidate-outside` (fit layouts are checked at their fitted positions) |
| non-rectangular / curved / several subpaths / rotated / text clip | BLOCKED `clip-geometry-unsupported` |
| empty (point, disjoint clips) | BLOCKED `clip-empty` |
| PDFium and stream disagree | BLOCKED `clip-engine-interpreter-disagree` |
| clip facts unavailable, interpreter out of step, glyph bounds unknown | BLOCKED `clip-geometry-unknown` |

The Phase 9 plan is computed in full by `planEdit()`; `planEditClipAware()` re-issues it as ok
only when its ONLY reasons are `target-clipped` and the verdict above is contained. V01..V13
are unchanged and always run; D01 always runs; X01 and D02 run in the page. **K01** (new,
additive, only when a clip was cleared): the reopened output's target lies inside the original
clip rectangle (PDFium bounds and independent glyph bounds) and the output either keeps that
clip for the target or has none (PDFium dropped a containing rectangle when regenerating).

## Fixtures and tests

- `tests/node/lib/phase10b-clip-inputs.mjs`: clipped variants of pinned Phase 9 fixtures
  (content rewritten, fonts kept: standard-14, embedded TrueType) and synthetic generator
  models (Word, LibreOffice, Skia), a clipped Form XObject, a text clip, an `ff` ligature.
- `tests/node/phase10b-clip.test.mjs` (Run #10): API availability; root cause; signal
  disagreement; region primitives; cases 1-14 of the brief (no clip; page and crop clips
  commit with V01..V13, D01, K01; cutting clip; crossing candidate blocked before mutation;
  fit inside; non-rectangular; nested q/Q; cm transforms; successive W/W*; Form XObject;
  Phase 9 blocked-clip; verifier rejection keeps canonical bytes; redacted export); text clip;
  generator models; K01 negative; count-mismatch cause.
- `tests/node/phase10-corpus.test.mjs`: the 47-fixture parity test documents exactly one
  intentional delta (blocked-clip commits with every V check, D01 and K01; the Phase 9
  manifest and pipeline still block it): 23 committed, 23 blocked, 1 rejected.
- Browser: C23 (clip in the UI: commit with K01/X01/D02; cutting clip; crossing candidate) and
  C24 (a PDF printed by Chromium during the test run).

## Remaining blockers seen in real generator output (not changed here)

- Chromium (Type0/Identity-H subsets): `metrics-disagree` (PDFium width lookup by Unicode for
  subset CID fonts) and one glyph per text object.
- LibreOffice: `marked-content-ambiguous` for its style-name tags.
- Ligatures: `engine-interpreter-count-mismatch`.
- A glyph whose ink crosses the content-area edge by a fraction of a point (negative side
  bearing at the left margin) stays `clip-cuts-text`: the tolerance is float noise only.
