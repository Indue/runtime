#!/bin/sh
# Regression test for deploy/phase9-lab-deploy.sh and deploy/phase9-lab-rollback.sh against a
# throwaway app root (never the real server). Proves:
#   - the dry run changes nothing;
#   - --apply writes only under lab/true-text-edit/ (every other file byte-identical);
#   - rollback --apply restores the whole tree byte- and mode-identical;
#   - a corrupted package file, a drifted required server file and a backup folder inside
#     public_html each stop the deploy before anything is written;
#   - a deploy list or backup list naming a path that escapes lab/true-text-edit/ (.. segment)
#     is refused before anything is written or removed.
# The vendor engine pins are relaxed to ANY in the scratch copy only (the real engine bytes
# are not needed to test file handling). POSIX sh. Usage: sh tests/tools/deploy_test.sh
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
snap() { (cd "$T/home" && find . -print | LC_ALL=C sort | while read -r f; do
  if [ -f "$f" ]; then echo "$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f") $(cksum < "$f") $f"; else echo "dir $f"; fi
done); }

# Scratch package: deploy/ and public_html/ only, vendor pins relaxed.
mkdir -p "$T/pkg"
cp -R "$PKG/deploy" "$T/pkg/deploy"
cp -R "$PKG/public_html" "$T/pkg/public_html"
sed 's#^[0-9a-f]\{64\} \(vendor/\)#ANY \1#' "$PKG/deploy/required-unchanged.txt" > "$T/pkg/deploy/required-unchanged.txt"
SRC="$T/pkg/public_html/app.noblepdf.com"

# Scratch server: production-like files outside the lab, the required lab files, an older
# copy of one deployed file (REPLACE, mode 600), one already-current file (SAME).
A="$T/home/public_html/app.noblepdf.com"
mkdir -p "$A/editor" "$A/lab/true-text-edit/fixtures-phase8"
for f in $(sed -n 's#^ANY \(vendor/.*\)#\1#p' "$T/pkg/deploy/required-unchanged.txt"); do mkdir -p "$(dirname "$A/$f")"; echo "engine placeholder" > "$A/$f"; done
echo "production index" > "$A/index.html"
echo "production editor" > "$A/editor/index.html"
while read -r want rel; do
  case "$rel" in lab/*) cp "$SRC/$rel" "$A/$rel" ;; esac
done < "$T/pkg/deploy/required-unchanged.txt"
echo "<html>older phase8 v2</html>" > "$A/lab/true-text-edit/phase8-v2.html"
echo "older editor" > "$A/lab/true-text-edit/phase9-editor.js"
chmod 600 "$A/lab/true-text-edit/phase9-editor.js"
cp "$SRC/lab/true-text-edit/te-data.mjs" "$A/lab/true-text-edit/te-data.mjs"
export HOME="$T/home" NOBLEPDF_BACKUPS="$T/backups"
DEPLOY="$T/pkg/deploy/phase9-lab-deploy.sh"
ROLLBACK="$T/pkg/deploy/phase9-lab-rollback.sh"
snap > "$T/s0"

# Refusals before any write.
cp "$SRC/lab/true-text-edit/te-edit.mjs" "$T/keep"
echo "tampered" >> "$SRC/lab/true-text-edit/te-edit.mjs"
expect_stop "corrupted package file stops the deploy" "package file corrupted" sh "$DEPLOY" --apply
cp "$T/keep" "$SRC/lab/true-text-edit/te-edit.mjs"
cp "$A/lab/true-text-edit/phase8-verify.mjs" "$T/keep"
echo "drift" >> "$A/lab/true-text-edit/phase8-verify.mjs"
expect_stop "drifted required server file stops the deploy" "differs from its pinned build" sh "$DEPLOY" --apply
cp "$T/keep" "$A/lab/true-text-edit/phase8-verify.mjs"
expect_stop "backup folder inside public_html is refused" "must be outside public_html" env NOBLEPDF_BACKUPS="$T/home/public_html/bk" sh "$DEPLOY" --apply
cp "$T/pkg/deploy/deploy-files.txt" "$T/keep"
echo "escape" > "$SRC/escape.txt"
esc=$(sha_of "$SRC/escape.txt")
echo "$esc lab/true-text-edit/../../escape.txt" >> "$T/pkg/deploy/deploy-files.txt"
expect_stop "deploy list path with a .. segment is refused" "segments" sh "$DEPLOY" --apply
cp "$T/keep" "$T/pkg/deploy/deploy-files.txt"
rm -f "$SRC/escape.txt"
[ ! -e "$T/backups" ] && ok "no backup folder was created by any refused deploy" || bad "a refused deploy created a backup folder"
snap > "$T/s1"
cmp -s "$T/s0" "$T/s1" && ok "refused deploys left the server tree unchanged" || bad "refused deploys changed the server tree"

# Dry run.
sh "$DEPLOY" > "$T/out.log" 2>&1 && grep -q "DRY RUN complete" "$T/out.log" && ok "dry run completes" || bad "dry run failed: $(tail -1 "$T/out.log")"
snap > "$T/s1"
cmp -s "$T/s0" "$T/s1" && ok "dry run changed nothing" || bad "dry run changed the server tree"

# Apply: only lab/true-text-edit/ may differ; every deployed file matches its pin.
sh "$DEPLOY" --apply > "$T/out.log" 2>&1 && ok "deploy --apply succeeded" || bad "deploy --apply failed: $(tail -1 "$T/out.log")"
snap > "$T/s2"
if diff "$T/s0" "$T/s2" | sed -n 's/^[<>] //p' | grep -v ' \./public_html/app\.noblepdf\.com/lab/true-text-edit/' | grep -q .; then bad "deploy changed something outside lab/true-text-edit/"; else ok "deploy changed nothing outside lab/true-text-edit/"; fi
while read -r want rel; do
  [ "$(sha_of "$A/$rel")" = "$want" ] || { bad "deployed file does not match its pin: $rel"; }
done < "$T/pkg/deploy/deploy-files.txt"
BK=$(ls -d "$T/backups"/*)

# Tampered backup lists are refused before anything is restored or removed.
cp "$BK/created.txt" "$T/keep"
echo "lab/true-text-edit/../../index.html" >> "$BK/created.txt"
expect_stop "rollback refuses a created.txt path with a .. segment" "segments" sh "$ROLLBACK" "$BK" --apply
cp "$T/keep" "$BK/created.txt"
cp "$BK/replaced.txt" "$T/keep"
echo "editor/index.html" >> "$BK/replaced.txt"
expect_stop "rollback refuses a replaced.txt path outside the lab" "outside lab/true-text-edit" sh "$ROLLBACK" "$BK" --apply
cp "$T/keep" "$BK/replaced.txt"
echo "lab/true-text-edit/te-edit.mjs" >> "$BK/replaced.txt"
expect_stop "rollback refuses a replaced file without a hash-checked backup copy" "no hash-checked backup copy" sh "$ROLLBACK" "$BK" --apply
cp "$T/keep" "$BK/replaced.txt"
snap > "$T/s3"
cmp -s "$T/s2" "$T/s3" && ok "refused rollbacks left the deployed tree unchanged" || bad "a refused rollback changed the server tree"

# Rollback restores the original tree exactly (bytes and modes; created folder removed).
sh "$ROLLBACK" "$BK" --apply > "$T/out.log" 2>&1 && ok "rollback --apply succeeded" || bad "rollback --apply failed: $(tail -1 "$T/out.log")"
snap > "$T/s4"
if cmp -s "$T/s0" "$T/s4"; then ok "rollback restored the server tree byte- and mode-identical"; else bad "rollback did not restore the tree:"; diff "$T/s0" "$T/s4" | head -10; fi

[ "$FAILS" = 0 ] && { echo "deploy/rollback tests: all passed"; exit 0; }
echo "deploy/rollback tests: $FAILS failure(s)"
exit 1
