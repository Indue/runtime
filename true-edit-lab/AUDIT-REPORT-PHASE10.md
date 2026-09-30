# NoblePDF True Edit - Phase 10 real-PDF corpus harness: audit report

Lab only. Engineering and research tool, not the public editor. Nothing is deployed by this
branch; deployment is manual (README-PHASE10-LAB.txt).

## Baseline

- Frozen Phase 9 baseline: `a3f9038c11b0b82eba94ed965818e8698ca1e491` (network-audit fix:
  PerformanceObserver-complete Resource Timing, H02). Phase 10 only adds files.
- `tests/tools/check_phase9_frozen.py` proves every Phase 9 package file is byte-identical to
  the a3f9038 manifest and, with git, that the diff from a3f9038 contains additions only.
- The unchanged Phase 9 CI (`true-edit-phase9-lab.yml`, `tests/run-all.sh`) runs on every
  push of this branch: 47/47, 22 committed, 25 failed closed, SetPositions-disabled control
  rejected, S01..S08, E01..E08, H01, H02.

## What Phase 10 adds

| File | Role |
|---|---|
| `phase10-corpus.html` | page; exact CSP; guard scripts first; pinned PDF.js with SRI |
| `phase10-net-guard.js` | classic script, second in `<head>`: records every fetch/XHR/beacon and resource load from page start; refuses bodies, non-GET, beacon, WebSocket, EventSource |
| `te-corpus-env.mjs` | strict audit: Phase 9 `environmentAudit` (te-env.mjs?v=2, unchanged) + exact CSP, script order, ledger allowlist, service worker = FAIL, analytics globals |
| `te-corpus.mjs` | whole-document analysis, classification, verified edit runner, session state, export |
| `phase10-corpus.js`, `phase10.css` | UI |
| `phase10-base.css` | base styles: byte copy of the frozen a3f9038 `phase8.css` (`d36798cc...`), owned by Phase 10 |
| `phase10-favicon.png` | pinned page icon |

Reused unchanged: `te-pipeline.mjs` (analyze, documentGates, targetGates, planEdit,
applyEdit, verifyEdit), `te-engine.mjs` (Run #10 identity), `te-render.mjs` (PDF.js pin,
render comparison), `te-pdf.mjs`, `te-edit.mjs`, `te-ttf.mjs`, `te-data.mjs`, `te-env.mjs`,
`phase8-verify.mjs`, `phase8-csp-guard.js`. `phase8.css` is not used (see below).

## Classification rule

- **BLOCKED**: `documentGates()` or `targetGates()` returns codes, or the planning probe does.
  The probe is `planEdit()` with the object's own text as the replacement, over the full
  object. It exercises re-encoding, the embedded font program, PDFium metrics, PDF.js
  extraction, the gap policy and collision checks. All codes are listed.
- **SUPPORTED**: every gate and the probe pass. The inspector lists the evidence.
- **UNKNOWN**: the probe raised an error or was skipped (quick mode).
- Text drawn inside Form XObjects is not a direct object and counts as blocked (`text-in-form-xobject`).

## Edit test (exact Phase 9 sequence, stricter commit)

analyse -> classify (gates) -> encode + plan -> clone/candidate + mutate + GenerateContent ->
non-incremental save -> destroy/reopen -> V01..V13 (unchanged) + D01 (document invariants,
every other page unchanged in PDFium) + X01 (288 dpi outside the edit) + D02 (every other page
at 144 dpi). The working copy is replaced only by `CorpusSession.commit()` of a result whose
every check passed, computed from exactly the current working bytes for the current selection
token, document and revision. Loading new files bumps the generation and invalidates all
selections. The original bytes are never written. Download re-hashes the verified bytes.

## Privacy model

- PDFs are read with `File.arrayBuffer()`; bytes go only to the in-page wasm engine and to the
  PDF.js worker via postMessage (in-browser, not network).
- CSP `connect-src 'self'`, `form-action 'none'`, no eval, no inline script, `frame-src`,
  `media-src` and `manifest-src 'none'`.
- The network guard refuses any request that carries a body, in addition to the CSP.
- The ledger allowlist equals the exact set of files the page loads (checked in CI); it no
  longer contains `phase8.css`.
- Each processing batch reports its own requests. Expected: pinned URLs (path and exact query) only, 0 bodies.
- Tests prove it from outside the page: Playwright sees every browser request and the harness
  server logs every request it receives. No scenario may send a body, a non-GET request, PDF
  bytes or a request through another origin.

## Pre-deployment hardening (after 275ed73)

- **Favicon.** Live desktop Chrome requested `/favicon.ico` for the Phase 9 pages, which
  declare no icon. The Phase 10 page now declares one pinned icon, `phase10-favicon.png?v=1`
  (16x16, 122 bytes, deployed and hash-checked like every Phase 10 file). The browser therefore
  asks for that URL, which the policy allows. `/favicon.ico`, other icon versions and other
  icon files fail the audit (C20).
- **Exact URL/query policy.** Before, the policy checked origin and path and ignored the query,
  so `phase10.css?data=...` passed although the query reaches the server. Now every allowed
  resource has exactly one allowed query:
  - lab files: the exact `?v=N` the page uses for it;
  - engine: `?te=patched-<12 lowercase hex>`, the `loadVerifiedEngine` form;
  - PDF.js: no query.
  Anything else fails closed, in the fetch/XHR ledger and in Resource Timing alike: extra or
  unknown keys, other values, fragments, `%PDF` or document text in a query, other paths.
  `check_phase10_refs.py` proves the policy map equals the queries the page and its module
  graph really use. C16 now repeats one pinned URL in its exact form. C21 and a Node unit test
  cover the refusals.
- **Raw Producer/Creator strings are opt-in.** The export includes the generator family by
  default. The raw strings (which can name a person, file or organisation) are included only
  when the checkbox or `includeGeneratorStrings: true` asks for them.
- **phase8.css pinned** (superseded, see the next section). The required list pinned it to the
  a3f9038 hash, so a different live copy stopped the dry run before any write.

## phase8.css is no longer a Phase 10 dependency (after the live dry-run STOP)

The live deploy dry run stopped on `lab/true-text-edit/phase8.css`: the live file (about 826
bytes) is substantially different from the frozen a3f9038 build (4964 bytes, `d36798cc...`).
The Phase 9 lists accept any `phase8.css` (ANY), so Phase 9 never recorded this. The live file
is left exactly as it is. Phase 10 is now self-contained for its styles:

- `phase10-base.css` is a new Phase 10-owned file, a byte copy of the a3f9038 `phase8.css`
  (`build_phase10_package.py` checks its SHA-256 against the constant and against the frozen
  Phase 9 manifest). The page loads `phase10-base.css?v=1`, `phase9.css?v=1`, `phase10.css?v=1`,
  so it renders exactly as before.
- `phase8.css` is gone from `phase10-required-unchanged.txt` (15 files, none ANY), from the page
  and its module graph, and from the exact URL policy: a `phase8.css` request now fails the
  audit (`check_phase10_refs.py`, Node URL-policy test, browser C22).
- The deploy script refuses any deploy entry that is not a Phase 10-owned name (`phase10.css`,
  `phase10-*`, `te-corpus*.mjs`) or that is also a required file, and refuses a required entry
  without a SHA-256 (ANY). The rollback script refuses a backup list naming any other file.
  `phase10_deploy_test.sh` proves, with an 826-byte live-style `phase8.css` on the scratch
  server: the dry run, `--apply` and rollback succeed; the dry run also succeeds with no
  `phase8.css` at all; `phase8.css` keeps its bytes, mode, mtime and inode throughout and never
  appears in the backup; `--apply` changes exactly the Phase 10-owned files it has to write.
- The browser harness host now serves an 826-byte different `phase8.css`, like the live host,
  for every scenario. C22 checks the page never requests it and renders the frozen styles.

## Finding: Phase 9 V11 rejects every edit in a multi-page document with text on other pages

V11 ("no text in unreferenced streams") builds its set of referenced streams from the
edited page only (`a1.independent.counters.streamRefs`). In a multi-page document, the text
content streams of the other pages therefore count as "orphan text streams", and V11 fails
closed on every edit. Everything else passes, including D01, X01 and D02. Evidence:

- `tests/node/phase10-corpus.test.mjs`, test 12: only V11 fails; its evidence lists the other
  pages' content streams.
- Browser C10: "Rejected by verification. The working document was NOT replaced.", V11 FAIL.

A multi-page document whose other pages contain no text commits normally (test 13, C10).
Phase 10 does not change V11. Relaxing a verifier to make real PDFs pass is out of scope.
The page explains this rejection when it happens. Most real-world PDFs have text on several
pages, so this finding decides whether multi-page corpus edits can ever commit. A reviewed
Phase 9 verifier change would be needed. Proposal: compute the reference set over every
page of the document (plus their forms), keep the edited-page checks exactly as they are,
and re-run the 47 fixtures.

## Known limitations

1. Classification covers direct page-level text objects with the three Phase 9 validated font
   classes (standard-14 Type1, embedded simple TrueType, Type0 Identity-H CIDFontType2). Real
   PDFs with Type1C/CFF, OpenType, non-Identity CMaps, Type3, vertical or Form XObject text
   are reported BLOCKED by design.
2. Page rotation, text rise, clipping, render modes other than 0, ActualText and optional
   content remain blocked (Phase 9 gates).
3. The independent reader supports only FlateDecode content streams without predictors;
   anything else blocks the page (`independent-reader-unavailable` / `pdf-filter-unsupported`).
4. PDF.js runs without cMap or standard-font URLs (no network), so documents that need
   predefined CMaps may extract inconsistently and are then blocked.
5. Each page is analysed by Phase 9 `analyze()`, which re-parses the document, plus a
   planning probe per gate-passing object. Large documents (hundreds of pages, dense
   spreadsheets) are slow. Quick mode and a page limit exist; files over 100 MB are refused
   unread.
6. Verification V11 decodes every stream of the output. Real PDFs with unusual stream types
   may be rejected by verification. That is recorded, never relaxed.
7. The PDF.js worker is a separate same-origin script (pinned by SHA-256). The page CSP does
   not govern its network access; it is given data, never URLs, and pdf.js 3.11.174 fetches
   nothing in that configuration.
8. Service worker *registrations* that do not control the page are reported as warnings.
   Control by a service worker fails the audit.
9. Multi-page documents with text on other pages: every edit is rejected by V11 (see the finding above).
10. "Percentage editable" is a diagnostic. It depends on the probe and on the gates, and it
   says nothing about visual quality beyond the verifier checks.
