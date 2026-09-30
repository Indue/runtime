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
  phase10-lists              deploy/phase10-deploy-files.txt (8 Phase 10-owned files) and
                             phase10-required-unchanged.txt (15 files, none ANY, no phase8.css)
                             match the tree; required pins are the frozen Phase 9 pins (so
                             te-env.mjs must be the a3f9038 network-audit build); no deploy file
                             is a Phase 9 file; phase10-base.css is the byte copy of the a3f9038
                             phase8.css (constant and frozen Phase 9 manifest).
  phase10-refs-host-compat   every file the page loads (HTML and the full static import graph)
                             is a Phase 10 deploy file or a pinned required file (none as ANY),
                             uses an extension the live host serves (.png only for the pinned
                             favicon), and is loaded with exactly one query that equals the exact
                             URL policy in te-corpus-env.mjs (LAB_QUERIES); the engine policy
                             ?te=patched-<12 hex> matches te-engine.mjs and the page's 6-byte
                             nonce; exactly one icon is declared; te-env.mjs is imported as ?v=2;
                             the stylesheets are exactly phase10-base.css?v=1, phase9.css?v=1,
                             phase10.css?v=1; phase8.css appears in no page file, module, policy
                             or Phase 10 list; every deploy file is a Phase 10-owned name.
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
                              - multi-page with text on other pages: rotated page blocked; the
                                page-2 edit is REJECTED by Phase 9 V11 only (page-scoped reference
                                set; not relaxed); D01 passes on built variants that differ in the
                                edited page only and fails when another page differs;
                              - multi-page whose other pages hold no text: the page-2 edit commits
                                and D01 proves both other pages unchanged;
                              - incremental-update and xref-stream inputs are detected and edit
                                into one clean revision (V01);
                              - export: no file names, text, reason details, raw Producer/Creator
                                or PDF bytes by default (generator family only); redacted and plain
                                samples and raw generator strings only on request;
                              - exact URL policy: every pinned URL in its exact form passes; about
                                30 variants fail (secret/%PDF/fixture-text queries, extra or
                                reordered keys, other versions, fragments, bad engine nonces,
                                PDF.js queries, /favicon.ico, other paths, other origins);
                                phase10-base.css?v=1 passes; phase8.css (any query) fails;
                              - diffText equals the Phase 9 editor's diff (source extracted from
                                phase9-editor.js, >1000 pairs); generator family detection.
  phase10-deploy-rollback    deploy/phase10-lab-deploy.sh and rollback against a throwaway app
                             root whose phase8.css is an 826-byte live-style file, NOT the a3f9038
                             build: refusals (corrupted package, te-env.mjs older than a3f9038,
                             drifted required file, a required entry pinned as ANY, a deploy list
                             naming phase8.css or a Phase 9 module, Phase 9 lab missing, backup
                             inside public_html, .. paths; rollback lists naming phase8.css or a
                             Phase 9 file); dry run, --apply and rollback succeed with the
                             different phase8.css, and the dry run also without any phase8.css;
                             phase8.css keeps bytes, mode, mtime and inode and is never backed
                             up; --apply changes exactly the Phase 10-owned files it must write;
                             writes stay in lab/true-text-edit/, Phase 9 files untouched,
                             rollback restores the tree byte- and mode-identical.
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
                               C10 multi-page: V11 rejection with text on other pages (explained
                                   on the page); commit with D01 + D02 when they hold graphics only
                               C11 host-style scripts after the CSP: blocked, reported, still local
                               C12 script before the CSP: fail closed
                               C13 service worker controlling the page: fail closed
                               C14 engine not Run #10: fail closed
                               C15 export: no text/names/bytes/raw Producer-Creator by default;
                                   redacted samples and raw generator strings only on request
                               C16 ledger completeness: 300 requests of one pinned URL in its exact
                                   form pass; a late unpinned request then fails
                               C17 POST/PUT/XHR/beacon/WebSocket refused in the page; audit fails
                               C18 relaxed CSP fails at load; the allowed cross-origin load is named
                               C19 every Phase 10 and required lab file (19, none ANY, no
                                   phase8.css) served with its pin by the emulated live host
                                   (403 for *.json)
                               C20 favicon: the declared pinned icon is allowed; /favicon.ico and
                                   unpinned icons fail the audit and disable processing
                               C21 query privacy: ?secret=JaneCitizen, %PDF and fixture-text values,
                                   extra keys, other versions, bad engine nonces, PDF.js queries and
                                   a query seen only via Resource Timing all fail closed
                               C22 self-contained styles: the emulated live host serves an
                                   826-byte phase8.css that is not the a3f9038 build (as the real
                                   host does, in every scenario); the page applies exactly
                                   phase10-base.css, phase9.css, phase10.css, renders the frozen
                                   styles, never requests phase8.css; phase10-base.css is served
                                   byte-identical to the a3f9038 phase8.css; a phase8.css?v=2
                                   request fails the audit and disables processing
  phase10-ascii-check        every text file in the package is ASCII.

Local development without the Run #10 engine (not evidence)
  P10_ENGINE=stock node --test tests/node/phase10-corpus.test.mjs   edit tests are skipped
  P10_DEV=1 python3 tests/harness/run-phase10.py C01 C02 ...        stock engine with swapped
      pins; edits fail closed; the run always exits 3 and writes *-DEV results.
