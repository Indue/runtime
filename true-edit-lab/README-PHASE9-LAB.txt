NoblePDF True Edit - Phase 8 V2.1.1 hardening + Phase 9 lab (release noblepdf-trueedit-phase9-lab-v3)
=====================================================================================================

LAB ONLY. FIXTURES ONLY. NOT PRODUCTION-READY.
Nothing here changes the production editor or any vendor folder. The deploy script writes
only under lab/true-text-edit/ and only reads (hash-checks) everything else. The Phase 9
editor opens hash-pinned lab fixtures; it has no upload path.

Contents
--------
  public_html/app.noblepdf.com/lab/true-text-edit/
      phase8-v2.html, phase8-v2.js      V2.1.1 (changed): stock engine pinned, SRI on pdf.min.js,
                                        cache key ?v=2, page version phase8-v2.1.1
      phase9-suite.html/.js             Phase 9 fixture suite page (new)
      phase9-editor.html/.js            Phase 9 interactive editor (new)
      phase9.css, te-*.mjs              Phase 9 modules (new)
      fixtures-phase9/                  47 fixtures + manifest.txt (new)
      phase8-verify.mjs, phase8-csp-guard.js, phase8-layout.mjs, phase8.css, fixtures-phase8/
                                        ALREADY LIVE: shipped for tests only, NOT deployed; the
                                        deploy script verifies the live copies by SHA-256
  deploy/phase9-lab-deploy.sh           dry run by default, --apply to deploy
  deploy/phase9-lab-rollback.sh         dry run by default, --apply to roll back
  deploy/deploy-files.txt               the 80 files deployed, with SHA-256, in deploy order
  deploy/required-unchanged.txt         live files that must already match their pins
  tests/                                Node tests, fixture generator, browser harness, results
  .github/workflows/true-edit-phase9-lab.yml   CI workflow (see tests/README-TESTS.txt)
  AUDIT-REPORT-PHASE9.md                findings, acceptance matrix, known limitations
  MANIFEST.sha256                       SHA-256 of every file in this package

A. Optional: run the tests yourself first
-----------------------------------------
  See tests/README-TESTS.txt. Short version (Linux or macOS with Node 22 and Python 3.12):
    cd tests && npm install && cd ..
    sh tests/tools/fetch-engine.sh
    python3 -m pip install playwright==1.56.0 && python3 -m playwright install chromium
    sh tests/run-all.sh
  Expected last line: ALL STEPS PASSED
  For GitHub: copy this package into your repository as true-edit-lab/ (or edit PKG in the
  workflow) and copy .github/workflows/true-edit-phase9-lab.yml to the repository root
  .github/workflows/. Run it from the Actions tab (workflow_dispatch).

B. Deploy (GoDaddy SSH shell, POSIX sh)
---------------------------------------
  1. Upload noblepdf-trueedit-phase9-lab-v3.zip to your home folder (cPanel File Manager),
     NOT into public_html.
  2. In the SSH terminal:
       cd ~
       mkdir -p noblepdf-releases
       mv noblepdf-trueedit-phase9-lab-v3.zip noblepdf-releases/
       cd noblepdf-releases
       unzip -o noblepdf-trueedit-phase9-lab-v3.zip
       cd noblepdf-trueedit-phase9-lab-v3
       sha256sum -c MANIFEST.sha256 | grep -v ': OK$'      (should print nothing)
       sh deploy/phase9-lab-deploy.sh
     Read the dry-run plan. Expected: 80 package files verified, 12 required server files
     verified or present, plan "new 78, replace 2, unchanged 0" (phase8-v2.js and
     phase8-v2.html are the two replacements). If anything says STOP, do not continue:
     paste the output back.
  3. Deploy:
       sh deploy/phase9-lab-deploy.sh --apply
     It backs up the two replaced files to ~/noblepdf-backups/phase9-lab-v3-YYYYMMDD-HHMM/,
     writes modules and fixtures first and the three HTML pages last (each via a temporary
     name and rename), then re-hashes every deployed file. Expected ending:
       DEPLOYED phase9-lab-v3. Backup: /home/.../noblepdf-backups/phase9-lab-v3-...
     Keep that backup path for rollback.
  4. Optional check: running the dry run again must show "new 0, replace 0, unchanged 80".
  No manual edits on the server are needed or wanted.

C. Live tests (desktop Chrome first; use a fresh tab and a hard refresh, Ctrl+Shift+R)
-------------------------------------------------------------------------------------
  C1. https://app.noblepdf.com/lab/true-text-edit/phase8-v2.html
      - Title and eyebrow say V2.1.1.
      - Click "Run V2 preflight". Expected: Engine identity RUN #10 MATCH, Ready YES, and
        row P09 evidence contains "pinned identity matches".
      - Click "Run V2 live proof". Expected decision: PHASE 8 V2 PASS (this fixture only).
      - Click "Copy report" and paste it back.
  C2. https://app.noblepdf.com/lab/true-text-edit/phase9-suite.html
      - The privacy line should read PASS. WARN lines in section 3 for the host monitoring
        markup (img1.wsimg.com ... tccl.min.js and an inline script) are EXPECTED: they are
        blocked by the CSP. Any FAIL line means the suite will not run: paste section 3 back.
      - Click "Run preflight". Expected: Engine identity RUN #10 MATCH, API surface COMPLETE,
        Fixtures 47 pinned, Ready YES.
      - Click "Run fixture suite" (about 1 to 3 minutes). Expected: Matched 47/47,
        Committed (verified) 22, Failed closed as expected 25, and
        Suite decision "PHASE 9 SUITE PASS (fixtures only)". The last table row,
        "invoice-number-longer (SetPositions disabled)", must be PASS with observed
        "rejected": it proves SetPositions really moves glyphs in your browser.
      - Click "Copy report" and paste it back.
  C3. https://app.noblepdf.com/lab/true-text-edit/phase9-editor.html
      - Click "Start lab (verify engine)". Expected: "Run #10 engine verified ..., PDF.js 3.11.174."
      - Choose "editable: invoice-number-longer". Click on the line "Invoice Number: 12345".
        It is outlined in blue and appears in the Text object box.
      - Change it to: Invoice Number: INV-2026-0012345   then click "Apply edit".
        Expected: "Committed: ... (14 checks passed; layout needed SetPositions)." and 14 PASS
        rows (V01..V13 and X01). The page re-renders with the new number.
      - Click "Download verified PDF". Open the file in Chrome's viewer (and Acrobat or
        Preview if you have them): the text reads INV-2026-0012345, search finds it, and the
        rest of the page looks unchanged.
      - Click "Undo" (the original returns), then "Use suggested edit" and "Apply edit" again,
        then "Reset" (the original returns, undo is cleared).
      - Choose "blocked: blocked-signed": the hint says the page cannot be edited
        (signed-document) and Apply stays disabled.
      - Choose "rejected: rejected-untouched-grouping", click its text, "Use suggested edit",
        "Apply edit". Expected: "Rejected by verification. The working document was NOT
        replaced." with V12 FAIL.
      - Optional: try the other editable fixtures with "Use suggested edit".
      - Paste back what you saw (or screenshots), plus browser name and version.
  C4. If you can, repeat C2 in Safari or Firefox and on one phone browser; report results.

D. Rollback
-----------
  From the extracted package folder:
    sh deploy/phase9-lab-rollback.sh ~/noblepdf-backups/phase9-lab-v3-YYYYMMDD-HHMM
    sh deploy/phase9-lab-rollback.sh ~/noblepdf-backups/phase9-lab-v3-YYYYMMDD-HHMM --apply
  It verifies the backup copies, restores phase8-v2.html first and then phase8-v2.js,
  removes the files the deploy created (HTML first), removes fixtures-phase9/ if empty, and
  re-checks hashes. Expected ending: "ROLLED BACK. The lab folder is back to its state
  before the deploy."

E. What this does not change
----------------------------
  - Production editor pages and scripts: untouched.
  - vendor/pdfium-2.15.1/, vendor/pdfium-2.15.1-setpositions/, vendor/pdfjs-3.11.174/: read
    and hash-checked only.
  - No analytics, no third-party requests, noindex on every page.
