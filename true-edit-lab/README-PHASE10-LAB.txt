NoblePDF True Edit - Phase 10 real-PDF corpus harness (release noblepdf-trueedit-phase10-corpus-lab-v1)
======================================================================================================

LAB ONLY. ENGINEERING / RESEARCH TOOL. NOT THE PUBLIC EDITOR. NOT PRODUCTION-READY.
Baseline: Phase 9 frozen at a3f9038 (includes the te-env.mjs network-audit fix). Phase 10 only
ADDS files; no Phase 9 file, production file or vendor file is changed.

What it is
----------
  public_html/app.noblepdf.com/lab/true-text-edit/phase10-corpus.html lets an engineer choose
  real PDFs from the local computer. Each file is read with the browser File API
  (File.arrayBuffer) and analysed in the browser with the same Run #10 PDFium engine, PDF.js
  3.11.174, independent parser and Phase 9 gates as the fixture suite. Nothing is uploaded.

  For every PDF it reports: file facts (size, SHA-256, PDF version, pages, encryption,
  permissions, signatures and signature fields, revisions/incremental updates, xref style,
  object streams, AcroForm/XFA, optional content, tagging, generator), per-page facts (size,
  rotation, object census, annotations by type, images, paths, Form XObjects, marked content,
  optional content, text drawn inside Form XObjects), a font inventory (name, subset, subtype
  incl. Type0/CID, TrueType, Type1, Type3, embedded, encoding, ToUnicode, vertical, validated
  class or block code) and text state (size, Tc, Tw, Tz, rise, render mode, operator, TJ
  adjustments, rotation/skew, clipping, marked content).

  Every direct text object is classified with the exact Phase 9 code:
    SUPPORTED  documentGates() and targetGates() pass AND a planning probe (planEdit() replacing
               the object's own text with itself: re-encoding, font program, PDFium metrics,
               PDF.js extraction, gap policy, collision) passes. The inspector lists why.
    BLOCKED    at least one Phase 9 gate code; every code is shown, none is hidden.
    UNKNOWN    the probe could not run (error) or was skipped (quick mode). Needs investigation.
  Text inside Form XObjects is not a direct object and is counted as blocked
  (text-in-form-xobject). "Percentage editable" is a diagnostic and never relaxes a gate.

  A SUPPORTED object can be edit-tested: analyse -> classify -> encode + plan -> clone/candidate
  -> mutate -> GenerateContent -> non-incremental save -> destroy/reopen -> verification.
  Required checks: Phase 9 V01..V13 (unchanged), plus D01 (document invariants and every other
  page unchanged in PDFium), X01 (outside the edit the page renders identically at 288 dpi) and
  D02 (every other page renders identically at 144 dpi). Only if every check passes does the
  verified result replace the working copy; otherwise: "Rejected by verification. The working
  document was NOT replaced." The original bytes are never written. "Download verified PDF" is
  enabled only while the working copy is the output of a verified commit.

  "Export corpus report" writes a JSON report for aggregating many PDFs. By default it holds no
  PDF bytes, no file names, no document text and no reason details (details can quote text).
  Options: include file names; text samples redacted to their shape ("Aaaa 99") or plain
  (max 24 characters, plus reason details); Producer/Creator strings (on by default).

Privacy and integrity (processing stays disabled unless all pass)
------------------------------------------------------------------
  - Exact Phase 10 CSP (connect-src 'self', form-action 'none', no eval, no inline script,
    no frames, no media, no manifest), delivered once, before every script.
  - phase8-csp-guard.js (records CSP violations) and phase10-net-guard.js (network ledger and
    upload guard) are the first two scripts. The guard records every fetch/XHR/beacon call and
    every resource load from page start, and refuses any request with a body or a method other
    than GET/HEAD, every sendBeacon, WebSocket and EventSource.
  - The Phase 9 audit (te-env.mjs?v=2, unchanged) runs inside the Phase 10 audit: unexpected
    scripts must be matched by a CSP violation (the GoDaddy tccl.min.js injection stays
    blocked and is reported as a warning), complete Resource Timing, eval blocked, PDF.js
    library and worker pinned by SHA-256 and SRI.
  - A service worker controlling the page FAILS (Phase 9 only warned). Analytics globals FAIL.
  - Every request since page start must be a GET/HEAD to a pinned same-origin file; the page
    reports the requests made while processing the chosen PDFs (expected: pinned files only,
    zero request bodies). The audit reruns before every file and edit and after every batch.

Package contents (Phase 10 additions only)
------------------------------------------
  public_html/app.noblepdf.com/lab/true-text-edit/
      phase10-corpus.html, phase10-corpus.js, phase10.css      the page
      phase10-net-guard.js                                     early network ledger/upload guard
      te-corpus.mjs                                            document analysis, classification,
                                                               verified edit runner, session, export
      te-corpus-env.mjs                                        strict privacy/integrity audit
  deploy/phase10-lab-deploy.sh, phase10-lab-rollback.sh       dry run by default, --apply
  deploy/phase10-deploy-files.txt                             the 6 files deployed (SHA-256)
  deploy/phase10-required-unchanged.txt                       16 live files that must match their
                                                              a3f9038 / Run #10 / PDF.js pins
  tests/run-phase10.sh, tests/README-PHASE10-TESTS.txt        the Phase 10 test sequence
  .github/workflows/true-edit-phase10-corpus.yml (repository root) CI; builds the package zip

A. Deploy (GoDaddy SSH shell, POSIX sh)
---------------------------------------
  Prerequisite: the Phase 9 lab at a3f9038 is live (it is: Run #10 identity, 47/47).
  1. Download the artifact "noblepdf-trueedit-phase10-corpus-lab-v1" from the green
     true-edit-phase10-corpus workflow run of this branch (it contains the zip), or build it:
     python3 tests/tools/build_phase10_package.py OUT_DIR
     Upload noblepdf-trueedit-phase10-corpus-lab-v1.zip to your home folder (NOT public_html).
  2. In the SSH terminal:
       cd ~ && mkdir -p noblepdf-releases && mv noblepdf-trueedit-phase10-corpus-lab-v1.zip noblepdf-releases/
       cd noblepdf-releases && unzip -o noblepdf-trueedit-phase10-corpus-lab-v1.zip
       cd noblepdf-trueedit-phase10-corpus-lab-v1
       sha256sum -c MANIFEST.sha256 | grep -v ': OK$'        (should print nothing)
       sh deploy/phase10-lab-deploy.sh
     Expected dry run: 6 package files verified; 16 required server files verified or present
     (te-env.mjs must be the a3f9038 build; if the server still has an older one the script
     STOPs and changes nothing); plan "new 6, replace 0, unchanged 0". Any STOP: paste it back.
  3. sh deploy/phase10-lab-deploy.sh --apply
     Expected ending: "DEPLOYED phase10-corpus-lab-v1. Backup: ..." Keep the backup path.
  4. Optional: the dry run again shows "new 0, replace 0, unchanged 6".
  Rollback: sh deploy/phase10-lab-rollback.sh BACKUP_DIR (dry run), then add --apply. It
  removes the 6 Phase 10 files; Phase 9 files are never touched by either script.

B. Live test (desktop Chrome, fresh tab, hard refresh Ctrl+Shift+R)
-------------------------------------------------------------------
  https://app.noblepdf.com/lab/true-text-edit/phase10-corpus.html
  1. The privacy line reads PASS (WARN lines for the blocked host monitoring script are
     expected). Click "Run preflight": Engine identity RUN #10 MATCH, API surface COMPLETE,
     PDF.js 3.11.174 PINNED, Privacy PASS, Service worker none, Ready YES.
  2. Sanity check with a known file: choose the Phase 9 fixture
     fixtures-phase9/invoice-number-longer-before.pdf (save it from the lab first). Expected:
     9 text objects, 9 supported. Click "Invoice Number: 12345", change it to
     "Invoice Number: INV-2026-0012345", "Run verified edit test": Committed, all checks PASS
     (V01..V13, D01, X01, D02). Download verified PDF and open it in Chrome/Acrobat/Preview.
  3. Choose real PDFs (several at once is fine). Read the load line: "Requests while
     processing N local PDF(s): ... 0 with a request body, 0 non-GET (all same-origin pinned
     files)". Section 7 must still read PASS.
  4. Per document: read section 4 (document report, fonts, pages); in section 5 click text to
     inspect it; try edits on SUPPORTED objects; note verifier rejections.
  5. Export corpus report (JSON) and send it back (defaults contain no text or file names).
