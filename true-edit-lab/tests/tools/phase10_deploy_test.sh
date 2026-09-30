#!/bin/sh
# Regression test for deploy/phase10-lab-deploy.sh and deploy/phase10-lab-rollback.sh against a
# throwaway app root (never the real server). Proves:
#   - the dry run changes nothing;
#   - --apply writes only under lab/true-text-edit/ (every other file byte-identical);
#   - rollback --apply restores the whole tree byte- and mode-identical;
#   - a corrupted package file, a drifted required server file (for example a te-env.mjs older
#     than the a3f9038 network-audit fix), a required list entry without a SHA-256 (ANY), a
#     missing Phase 9 lab and a backup folder inside public_html each stop the deploy before
#     anything is written;
#   - a deploy list or backup list naming a path that escapes lab/true-text-edit/ (.. segment),
#     or naming a file Phase 10 does not own (phase8.css), is refused before anything is
#     written or removed;
#   - phase8.css is not a Phase 10 dependency: the scratch server holds an 826-byte live-style
#     phase8.css that is NOT the a3f9038 build, and the dry run, --apply and rollback all
#     succeed; the dry run also succeeds with no phase8.css at all; phase8.css keeps its bytes,
#     mode, mtime and inode through deploy and rollback, and never appears in the backup;
#   - the files --apply changes are exactly the Phase 10-owned deploy files it had to write.
# The vendor engine pins are replaced in the scratch copy only by the hash of a placeholder
# file (the real engine bytes are not needed to test file handling); no pin is ANY.
# POSIX sh. Usage: sh tests/tools/phase10_deploy_test.sh
set -eu
PKG=$(cd "$(dirname "$0")/../.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
FAILS=0
sha_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
ok() { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; FAILS=$((FAILS + 1)); }
expect_stop() { # label, expected message fragment, command...
  label=$1; want=$2; shift 2
  if "$@" > "$T/out.log" 2>&1; then bad "$label: command succeeded"; return; fi
  if grep -qF "$want" "$T/out.log"; then ok "$label"; else bad "$label: unexpected output: $(tail -1 "$T/out.log")"; fi
}
fstat() { stat -c '%a %Y %i' "$1" 2>/dev/null || stat -f '%Lp %m %i' "$1"; }
snap() { (cd "$T/home" && find . -print | LC_ALL=C sort | while read -r f; do
  if [ -f "$f" ]; then echo "$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f") $(cksum < "$f") $f"; else echo "dir $f"; fi
done); }

# Scratch package: deploy/ and public_html/ only, vendor pins set to the placeholder's hash.
mkdir -p "$T/pkg"
cp -R "$PKG/deploy" "$T/pkg/deploy"
cp -R "$PKG/public_html" "$T/pkg/public_html"
echo "engine placeholder" > "$T/placeholder"
PH=$(sha_of "$T/placeholder")
sed "s#^[0-9a-f]\{64\} \(vendor/\)#$PH \1#" "$PKG/deploy/phase10-required-unchanged.txt" > "$T/pkg/deploy/phase10-required-unchanged.txt"
grep -q "ANY" "$T/pkg/deploy/phase10-required-unchanged.txt" "$T/pkg/deploy/phase10-deploy-files.txt" && bad "a Phase 10 list contains ANY" || ok "no Phase 10 list entry is ANY"
grep -q "phase8\.css" "$T/pkg/deploy/phase10-required-unchanged.txt" "$T/pkg/deploy/phase10-deploy-files.txt" && bad "a Phase 10 list names phase8.css" || ok "neither Phase 10 list names phase8.css"
SRC="$T/pkg/public_html/app.noblepdf.com"

# Scratch server: production-like files outside the lab, the required lab files, an older
# copy of one deployed file (REPLACE, mode 600), one already-current file (SAME).
A="$T/home/public_html/app.noblepdf.com"
mkdir -p "$A/editor" "$A/lab/true-text-edit/fixtures-phase9"
for f in $(sed -n "s#^$PH \(vendor/.*\)#\1#p" "$T/pkg/deploy/phase10-required-unchanged.txt"); do mkdir -p "$(dirname "$A/$f")"; cp "$T/placeholder" "$A/$f"; done
echo "production index" > "$A/index.html"
echo "production editor" > "$A/editor/index.html"
while read -r want rel; do
  case "$rel" in lab/*) cp "$SRC/$rel" "$A/$rel" ;; esac
done < "$T/pkg/deploy/phase10-required-unchanged.txt"
# The Phase 9 lab as deployed (its pages; its modules come from the required list above).
for f in phase8-v2.html phase8-v2.js phase9-suite.html phase9-suite.js phase9-editor.html phase9-editor.js; do cp "$SRC/lab/true-text-edit/$f" "$A/lab/true-text-edit/$f"; done
cp "$SRC/lab/true-text-edit/fixtures-phase9/manifest.txt" "$A/lab/true-text-edit/fixtures-phase9/manifest.txt"
# The live phase8.css is not the a3f9038 build (observed: about 826 bytes). Emulate that with
# an 826-byte stylesheet and an old mtime, so any write, even of identical bytes, would show.
P8="$A/lab/true-text-edit/phase8.css"
i=0
: > "$T/p8"
while [ "$(wc -c < "$T/p8")" -lt 826 ]; do echo ".live-rule-$i{margin:0;color:#334155}" >> "$T/p8"; i=$((i + 1)); done
head -c 826 "$T/p8" > "$P8"
touch -t 202501010000 "$P8"
P8SHA=$(sha_of "$P8"); P8STAT=$(fstat "$P8")
[ "$(wc -c < "$P8" | tr -d ' ')" = 826 ] && [ "$P8SHA" != "$(sha_of "$SRC/lab/true-text-edit/phase8.css")" ] && ok "scratch server holds an 826-byte phase8.css that is not the a3f9038 build" || bad "could not set up the live-style phase8.css"
p8_same() { [ "$(sha_of "$P8")" = "$P8SHA" ] && [ "$(fstat "$P8")" = "$P8STAT" ]; }
echo "older corpus page" > "$A/lab/true-text-edit/phase10-corpus.js"
chmod 600 "$A/lab/true-text-edit/phase10-corpus.js"
cp "$SRC/lab/true-text-edit/te-corpus.mjs" "$A/lab/true-text-edit/te-corpus.mjs"
export HOME="$T/home" NOBLEPDF_BACKUPS="$T/backups"
DEPLOY="$T/pkg/deploy/phase10-lab-deploy.sh"
ROLLBACK="$T/pkg/deploy/phase10-lab-rollback.sh"
snap > "$T/s0"

# Refusals before any write.
cp "$SRC/lab/true-text-edit/te-corpus-env.mjs" "$T/keep"
echo "tampered" >> "$SRC/lab/true-text-edit/te-corpus-env.mjs"
expect_stop "corrupted package file stops the deploy" "package file corrupted" sh "$DEPLOY" --apply
cp "$T/keep" "$SRC/lab/true-text-edit/te-corpus-env.mjs"
cp "$A/lab/true-text-edit/te-env.mjs" "$T/keep"
sed "s/te-env-2/te-env-1/" "$T/keep" > "$A/lab/true-text-edit/te-env.mjs"
expect_stop "a server te-env.mjs older than the a3f9038 network-audit fix stops the deploy" "differs from its pinned build" sh "$DEPLOY" --apply
cp "$T/keep" "$A/lab/true-text-edit/te-env.mjs"
cp "$A/lab/true-text-edit/phase8-verify.mjs" "$T/keep"
echo "drift" >> "$A/lab/true-text-edit/phase8-verify.mjs"
expect_stop "drifted required server file stops the deploy" "differs from its pinned build" sh "$DEPLOY" --apply
cp "$T/keep" "$A/lab/true-text-edit/phase8-verify.mjs"
cp "$T/pkg/deploy/phase10-required-unchanged.txt" "$T/keep"
sed 's#^[0-9a-f]\{64\} \(lab/true-text-edit/te-env\.mjs\)#ANY \1#' "$T/keep" > "$T/pkg/deploy/phase10-required-unchanged.txt"
expect_stop "a required list entry pinned as ANY stops the deploy" "ANY is not accepted" sh "$DEPLOY" --apply
cp "$T/keep" "$T/pkg/deploy/phase10-required-unchanged.txt"
cp "$T/pkg/deploy/phase10-deploy-files.txt" "$T/keep"
cp "$SRC/lab/true-text-edit/phase8.css" "$T/p8pkg"
echo "$(sha_of "$T/p8pkg") lab/true-text-edit/phase8.css" >> "$T/pkg/deploy/phase10-deploy-files.txt"
expect_stop "a deploy list naming phase8.css is refused (not a Phase 10-owned file)" "does not own: lab/true-text-edit/phase8.css" sh "$DEPLOY" --apply
cp "$T/keep" "$T/pkg/deploy/phase10-deploy-files.txt"
echo "$(sha_of "$SRC/lab/true-text-edit/te-env.mjs") lab/true-text-edit/te-env.mjs" >> "$T/pkg/deploy/phase10-deploy-files.txt"
expect_stop "a deploy list naming a Phase 9 module is refused" "does not own: lab/true-text-edit/te-env.mjs" sh "$DEPLOY" --apply
cp "$T/keep" "$T/pkg/deploy/phase10-deploy-files.txt"
mv "$A/lab/true-text-edit/phase9-suite.html" "$T/keep"
expect_stop "a server without the Phase 9 lab stops the deploy" "Phase 9 lab not deployed" sh "$DEPLOY" --apply
mv "$T/keep" "$A/lab/true-text-edit/phase9-suite.html"
expect_stop "backup folder inside public_html is refused" "must be outside public_html" env NOBLEPDF_BACKUPS="$T/home/public_html/bk" sh "$DEPLOY" --apply
cp "$T/pkg/deploy/phase10-deploy-files.txt" "$T/keep"
echo "escape" > "$SRC/escape.txt"
esc=$(sha_of "$SRC/escape.txt")
echo "$esc lab/true-text-edit/../../escape.txt" >> "$T/pkg/deploy/phase10-deploy-files.txt"
expect_stop "deploy list path with a .. segment is refused" "segments" sh "$DEPLOY" --apply
cp "$T/keep" "$T/pkg/deploy/phase10-deploy-files.txt"
rm -f "$SRC/escape.txt"
[ ! -e "$T/backups" ] && ok "no backup folder was created by any refused deploy" || bad "a refused deploy created a backup folder"
snap > "$T/s1"
cmp -s "$T/s0" "$T/s1" && ok "refused deploys left the server tree unchanged" || bad "refused deploys changed the server tree"

p8_same && ok "refused deploys left phase8.css untouched (bytes, mode, mtime, inode)" || bad "a refused deploy touched phase8.css"

# Dry run: succeeds although the live phase8.css is not the a3f9038 build, and does not read it.
sh "$DEPLOY" > "$T/out.log" 2>&1 && grep -q "DRY RUN complete" "$T/out.log" && ok "dry run completes with the different live phase8.css in place" || bad "dry run failed: $(tail -1 "$T/out.log")"
grep -q "phase8\.css" "$T/out.log" && bad "the dry run mentions phase8.css" || ok "the dry run neither checks nor plans phase8.css"
grep -q "   NEW lab/true-text-edit/phase10-base.css" "$T/out.log" && ok "the dry run plans phase10-base.css as a new Phase 10 file" || bad "phase10-base.css is not planned as NEW"
mv "$P8" "$T/p8aside"
sh "$DEPLOY" > "$T/out.log" 2>&1 && grep -q "DRY RUN complete" "$T/out.log" && ok "dry run completes with no phase8.css on the server at all (not a Phase 10 dependency)" || bad "dry run needs phase8.css: $(tail -1 "$T/out.log")"
mv "$T/p8aside" "$P8"
snap > "$T/s1"
cmp -s "$T/s0" "$T/s1" && ok "dry run changed nothing" || bad "dry run changed the server tree"
p8_same && ok "phase8.css untouched by the dry runs (bytes, mode, mtime, inode)" || bad "the dry runs touched phase8.css"

# Apply: only lab/true-text-edit/ may differ; every deployed file matches its pin.
sh "$DEPLOY" --apply > "$T/out.log" 2>&1 && ok "deploy --apply succeeded with the different live phase8.css in place" || bad "deploy --apply failed: $(tail -1 "$T/out.log")"
snap > "$T/s2"
if diff "$T/s0" "$T/s2" | sed -n 's/^[<>] //p' | grep -v ' \./public_html/app\.noblepdf\.com/lab/true-text-edit/' | grep -q .; then bad "deploy changed something outside lab/true-text-edit/"; else ok "deploy changed nothing outside lab/true-text-edit/"; fi
while read -r want rel; do
  [ "$(sha_of "$A/$rel")" = "$want" ] || { bad "deployed file does not match its pin: $rel"; }
done < "$T/pkg/deploy/phase10-deploy-files.txt"
# Exactly the Phase 10-owned files that were missing or older changed; nothing else did.
diff "$T/s0" "$T/s2" | sed -n 's/^[<>] //p' | awk '{print $NF}' | sed 's#^\./public_html/app\.noblepdf\.com/##' | LC_ALL=C sort -u > "$T/changed"
sed -n 's/^[0-9a-f]\{64\} //p' "$T/pkg/deploy/phase10-deploy-files.txt" | grep -vxF lab/true-text-edit/te-corpus.mjs | LC_ALL=C sort > "$T/expected"
cmp -s "$T/changed" "$T/expected" && ok "deploy changed exactly the $(wc -l < "$T/expected" | tr -d ' ') Phase 10-owned files it had to write (te-corpus.mjs was already current)" || { bad "deploy changed other files:"; diff "$T/expected" "$T/changed" | head -10; }
# Phase 9 files on the server are untouched by the Phase 10 deploy.
while read -r want rel; do case "$rel" in lab/*) [ "$(sha_of "$A/$rel")" = "$want" ] || bad "Phase 9 file changed by the Phase 10 deploy: $rel" ;; esac; done < "$T/pkg/deploy/phase10-required-unchanged.txt"
p8_same && ok "phase8.css untouched by the deploy (bytes, mode, mtime, inode)" || bad "the deploy wrote or replaced phase8.css"
BK=$(ls -d "$T/backups"/*)
if grep -q "phase8\.css" "$BK/replaced.txt" "$BK/created.txt" "$BK/backup.sha256" "$BK/deploy-files.txt" || [ -n "$(find "$BK" -name 'phase8.css' -print)" ]; then bad "phase8.css appears in the backup"; else ok "phase8.css is not backed up (absent from every backup list and from the backup files)"; fi
(cd "$BK/files" && find . -type f | sed 's#^\./##' | LC_ALL=C sort) > "$T/bkfiles"
LC_ALL=C sort "$BK/replaced.txt" | cmp -s - "$T/bkfiles" && grep -qxF lab/true-text-edit/phase10-corpus.js "$T/bkfiles" && [ "$(wc -l < "$T/bkfiles" | tr -d ' ')" = 1 ] && ok "the backup holds only the replaced Phase 10 file (phase10-corpus.js)" || bad "the backup holds unexpected files: $(tr '\n' ' ' < "$T/bkfiles")"

# Tampered backup lists are refused before anything is restored or removed.
cp "$BK/created.txt" "$T/keep"
echo "lab/true-text-edit/../../index.html" >> "$BK/created.txt"
expect_stop "rollback refuses a created.txt path with a .. segment" "segments" sh "$ROLLBACK" "$BK" --apply
cp "$T/keep" "$BK/created.txt"
cp "$BK/replaced.txt" "$T/keep"
echo "editor/index.html" >> "$BK/replaced.txt"
expect_stop "rollback refuses a replaced.txt path outside the lab" "outside lab/true-text-edit" sh "$ROLLBACK" "$BK" --apply
cp "$T/keep" "$BK/replaced.txt"
echo "lab/true-text-edit/phase10-old.css" >> "$BK/replaced.txt"
expect_stop "rollback refuses a replaced file without a hash-checked backup copy" "no hash-checked backup copy" sh "$ROLLBACK" "$BK" --apply
cp "$T/keep" "$BK/replaced.txt"
echo "lab/true-text-edit/phase8.css" >> "$BK/replaced.txt"
mkdir -p "$BK/files/lab/true-text-edit" && cp "$T/p8pkg" "$BK/files/lab/true-text-edit/phase8.css"
cp "$BK/backup.sha256" "$T/keep2"
echo "$(sha_of "$T/p8pkg") lab/true-text-edit/phase8.css" >> "$BK/backup.sha256"
expect_stop "rollback refuses to restore (overwrite) phase8.css even with a hash-checked copy" "does not own: lab/true-text-edit/phase8.css" sh "$ROLLBACK" "$BK" --apply
cp "$T/keep" "$BK/replaced.txt"; cp "$T/keep2" "$BK/backup.sha256"; rm -f "$BK/files/lab/true-text-edit/phase8.css"
cp "$BK/created.txt" "$T/keep"
echo "lab/true-text-edit/phase8.css" >> "$BK/created.txt"
expect_stop "rollback refuses to remove phase8.css" "does not own: lab/true-text-edit/phase8.css" sh "$ROLLBACK" "$BK" --apply
cp "$T/keep" "$BK/created.txt"
echo "lab/true-text-edit/phase9-editor.js" >> "$BK/created.txt"
expect_stop "rollback refuses to remove a Phase 9 file" "does not own: lab/true-text-edit/phase9-editor.js" sh "$ROLLBACK" "$BK" --apply
cp "$T/keep" "$BK/created.txt"
snap > "$T/s3"
cmp -s "$T/s2" "$T/s3" && ok "refused rollbacks left the deployed tree unchanged" || bad "a refused rollback changed the server tree"

# Rollback restores the original tree exactly (bytes and modes; created folder removed).
sh "$ROLLBACK" "$BK" --apply > "$T/out.log" 2>&1 && ok "rollback --apply succeeded" || bad "rollback --apply failed: $(tail -1 "$T/out.log")"
snap > "$T/s4"
if cmp -s "$T/s0" "$T/s4"; then ok "rollback restored the server tree byte- and mode-identical"; else bad "rollback did not restore the tree:"; diff "$T/s0" "$T/s4" | head -10; fi
p8_same && ok "phase8.css untouched by the refused and the real rollbacks (bytes, mode, mtime, inode)" || bad "a rollback touched phase8.css"

[ "$FAILS" = 0 ] && { echo "phase 10 deploy/rollback tests: all passed"; exit 0; }
echo "phase 10 deploy/rollback tests: $FAILS failure(s)"
exit 1
