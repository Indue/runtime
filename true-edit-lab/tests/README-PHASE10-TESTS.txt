NoblePDF True Edit Phase 10 corpus-harness tests. Not deployable. ASCII only.
The frozen Phase 9 sequence (tests/run-all.sh, README-TESTS.txt) is unchanged and still runs,
in CI in .github/workflows/true-edit-phase9-lab.yml on every push.

Setup: as for Phase 9 (npm install in tests/, sh tests/tools/fetch-engine.sh, Playwright 1.56.0).

Run
  sh tests/run-phase10.sh                 writes tests/results/phase10-*.log
  sh tests/run-phase10.sh --no-browser    Node and tooling steps only

What each step proves
  phase10-phase9-frozen      every file of the Phase 9 package (MANIFEST.sha256, a3f9038) is
                             byte-identical: pages, modules, fixtures, deploy scripts, tests,
                             workflow, docs (tests/results skipped: generated). With git, the
                             diff from a3f9038 may only ADD files, anywhere in the repository.
  phase10-lists              deploy/phase10-deploy-files.txt and phase10-required-unchanged.txt
                             match the tree; required pins are the frozen Phase 9 pins (so
                             te-env.mjs must be the a3f9038 network-audit build).
  phase10-refs-host-compat   every file the page loads (HTML and the full static import graph)
                             is a Phase 10 deploy file or a pinned required file, uses an
                             extension the live host serves, and equals the ledger allowlist in
                             te-corpus-env.mjs; te-env.mjs is imported as ?v=2.
  phase10-node-tests         node --test tests/node/phase10-corpus.test.mjs on the REAL Run #10
                             engine and PDF.js 3.11.174:
                              - all 47 fixtures through the corpus analysis and corpus edit path
                                reproduce every Phase 9 expectation (22 committed and equal to
                                the independent references R01..R06, 24 blocked with every
                                expected reason, 1 rejected with V12); the classification of
                                each target agrees with the gates the edit met;
                              - SetPositions-disabled control through the corpus path: rejected (V05);
                              - supported fixture SUPPORTED with evidence; signed, Form XObject,
                                Type3, vertical, text rise, clip, optional content, rotation,
                                shared content, no-unicode-map stay BLOCKED with every code;
                              - missing glyph: object supported, the edit blocked before mutation;
                              - verifier rejection never replaces working bytes, download stays
                                disabled; a verified commit enables a single-revision download;
                              - stale revision, spent selection, stale object text, results from
                                other bytes and a new load (stale generation) cannot commit;
                              - three documents (two with identical bytes) cannot leak state;
                              - malformed, non-PDF, user-password and oversized files fail closed;
                                owner-password encrypted fixture analysed and blocked;
                              - multi-page: rotated page blocked, page-2 edit commits, D01 proves
                                the other pages unchanged and fails when one does change;
                              - incremental-update and xref-stream inputs are detected and edit
                                into one clean revision (V01);
                              - export: no file names, text, reason details or PDF bytes by
                                default; redacted and plain samples only on request;
                              - diffText equals the Phase 9 editor's diff (source extracted from
                                phase9-editor.js, >1000 pairs); generator family detection.
  phase10-deploy-rollback    deploy/phase10-lab-deploy.sh and rollback against a throwaway app
                             root: refusals (corrupted package, te-env.mjs older than a3f9038,
                             drifted required file, Phase 9 lab missing, backup inside
                             public_html, .. paths), dry run changes nothing, writes stay in
                             lab/true-text-edit/, Phase 9 files untouched, rollback restores the
                             tree byte- and mode-identical.
  phase10-browser            tests/harness/run-phase10.py: Chromium drives phase10-corpus.html
                             served by tests/harness/server-phase10.mjs (REAL Run #10 engine).
                             Playwright records every browser request and the server records
                             every request it receives; any body, non-GET, PDF bytes or request
                             through another origin fails every scenario (C16-C18 make such
                             requests on purpose and check the audit instead).
                               C01 preflight (identity, API, PDF.js pin, exact CSP, ledger, no SW)
                               C02 local file path, no upload, file name never sent
                               C03 blocked fixtures together; missing-glyph edit blocked
                               C04 verifier rejection: exact message, V12, bytes identical
                               C05 verified commit: every stage and check, download = verified bytes
                               C06 stale selection/revision refused
                               C07 new PDF invalidates old selections
                               C08 malformed / non-PDF / password fail closed
                               C09 three PDFs, no state leak
                               C10 multi-page: D01 + D02 over the other pages
                               C11 host-style scripts after the CSP: blocked, reported, still local
                               C12 script before the CSP: fail closed
                               C13 service worker controlling the page: fail closed
                               C14 engine not Run #10: fail closed
                               C15 export: no text/names/bytes by default; redacted on request
                               C16 ledger completeness: after 300 requests a late unpinned request fails
                               C17 POST/PUT/XHR/beacon/WebSocket refused in the page; audit fails
                               C18 relaxed CSP fails at load; the allowed cross-origin load is named
                               C19 every Phase 10 and required lab file served with its pin by the
                                   emulated live host (403 for *.json)
  phase10-ascii-check        every text file in the package is ASCII.

Local development without the Run #10 engine (not evidence)
  P10_ENGINE=stock node --test tests/node/phase10-corpus.test.mjs   edit tests are skipped
  P10_DEV=1 python3 tests/harness/run-phase10.py C01 C02 ...        stock engine with swapped
      pins; edits fail closed; the run always exits 3 and writes *-DEV results.
