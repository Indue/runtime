#!/bin/sh
# NoblePDF True Edit lab deploy: Phase 8 V2.1.1 hardening + Phase 9 lab (fixtures only).
# Lab-only: writes under lab/true-text-edit/ and nowhere else. Production editor files
# and vendor folders are only READ (hash checks), never written.
#
# Usage (from anywhere):   sh deploy/phase9-lab-deploy.sh            dry run (default)
#                          sh deploy/phase9-lab-deploy.sh --apply    backup, deploy, verify
# Environment:  NOBLEPDF_APP_ROOT  (default: $HOME/public_html/app.noblepdf.com)
#               NOBLEPDF_BACKUPS   (default: $HOME/noblepdf-backups)
# Order: fixtures and modules first, HTML last; every file is written to a temporary
# name and renamed into place. Backups go outside public_html. POSIX sh only.
set -eu
RELEASE=phase9-lab-v3
APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
PKG=$(cd "$(dirname "$0")/.." && pwd)
SRC="$PKG/public_html/app.noblepdf.com"
APP_ROOT=${NOBLEPDF_APP_ROOT:-$HOME/public_html/app.noblepdf.com}
BACKUPS=${NOBLEPDF_BACKUPS:-$HOME/noblepdf-backups}
LIST="$PKG/deploy/deploy-files.txt"
REQ="$PKG/deploy/required-unchanged.txt"

sha_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else openssl dgst -sha256 "$1" | sed 's/^.*= //'; fi
}
die() { echo "STOP: $*" >&2; exit 1; }

echo "NoblePDF True Edit lab deploy ($RELEASE) - $( [ "$APPLY" = 1 ] && echo APPLY || echo 'DRY RUN (nothing will be changed)' )"
echo "Package:  $PKG"
echo "App root: $APP_ROOT"
[ -d "$APP_ROOT" ] || die "app root not found: $APP_ROOT (set NOBLEPDF_APP_ROOT)"
[ -f "$APP_ROOT/lab/true-text-edit/phase8-v2.html" ] || die "lab folder not found under the app root (expected lab/true-text-edit/phase8-v2.html)"
case "$BACKUPS/" in *"/public_html/"*) die "backup folder must be outside public_html: $BACKUPS" ;; esac
[ -f "$LIST" ] && [ -f "$REQ" ] || die "deploy lists missing in $PKG/deploy"

echo
echo "1. Package integrity"
n=0
while read -r want rel; do
  [ -n "$rel" ] || continue
  case "$rel" in lab/true-text-edit/*) ;; *) die "refusing to deploy outside lab/true-text-edit: $rel" ;; esac
  # The prefix alone is not enough: lab/true-text-edit/../../x resolves outside the lab.
  case "/$rel/" in */../*|*/./*|*//*) die "refusing path with empty, . or .. segments: $rel" ;; esac
  [ -f "$SRC/$rel" ] || die "package file missing: $rel"
  [ "$(sha_of "$SRC/$rel")" = "$want" ] || die "package file corrupted: $rel"
  n=$((n + 1))
done < "$LIST"
echo "   $n files match deploy-files.txt"

echo
echo "2. Required server files (read only)"
while read -r want rel; do
  [ -n "$rel" ] || continue
  [ -f "$APP_ROOT/$rel" ] || die "required server file missing: $rel"
  got=$(sha_of "$APP_ROOT/$rel")
  if [ "$want" = "ANY" ]; then echo "   present   $rel"; continue; fi
  [ "$got" = "$want" ] || die "server file differs from its pinned build: $rel ($got). Nothing was changed."
  echo "   verified  $rel"
done < "$REQ"

echo
echo "3. Plan"
new=0; same=0; repl=0
while read -r want rel; do
  [ -n "$rel" ] || continue
  if [ ! -f "$APP_ROOT/$rel" ]; then state=NEW; new=$((new + 1))
  elif [ "$(sha_of "$APP_ROOT/$rel")" = "$want" ]; then state=SAME; same=$((same + 1))
  else state=REPLACE; repl=$((repl + 1)); fi
  echo "   $state $rel"
done < "$LIST"
echo "   new $new, replace $repl, unchanged $same"
if [ "$APPLY" != 1 ]; then
  echo
  echo "DRY RUN complete. Nothing was changed. Re-run with --apply to deploy."
  exit 0
fi

echo
echo "4. Backup"
BK="$BACKUPS/$RELEASE-$(date +%Y%m%d-%H%M)"
[ ! -e "$BK" ] || die "backup folder already exists: $BK (wait a minute and retry)"
mkdir -p "$BK/files"
: > "$BK/created.txt"; : > "$BK/replaced.txt"; : > "$BK/backup.sha256"; : > "$BK/created-dirs.txt"
{ echo "release=$RELEASE"; echo "app_root=$APP_ROOT"; echo "time=$(date '+%Y-%m-%d %H:%M:%S %z')"; echo "package=$PKG"; } > "$BK/release.txt"
cp "$LIST" "$BK/deploy-files.txt"
for d in lab/true-text-edit/fixtures-phase9; do [ -d "$APP_ROOT/$d" ] || echo "$d" >> "$BK/created-dirs.txt"; done
while read -r want rel; do
  [ -n "$rel" ] || continue
  if [ ! -f "$APP_ROOT/$rel" ]; then echo "$rel" >> "$BK/created.txt"
  elif [ "$(sha_of "$APP_ROOT/$rel")" != "$want" ]; then
    mkdir -p "$BK/files/$(dirname "$rel")"
    cp -p "$APP_ROOT/$rel" "$BK/files/$rel"
    echo "$rel" >> "$BK/replaced.txt"
    echo "$(sha_of "$BK/files/$rel") $rel" >> "$BK/backup.sha256"
  fi
done < "$LIST"
echo "   $BK ($(wc -l < "$BK/replaced.txt" | tr -d ' ') file(s) backed up, $(wc -l < "$BK/created.txt" | tr -d ' ') new)"

echo
echo "5. Deploy (non-HTML first, HTML last)"
put() {
  mkdir -p "$(dirname "$APP_ROOT/$1")"
  cp "$SRC/$1" "$APP_ROOT/$1.tmp-$RELEASE"
  chmod 644 "$APP_ROOT/$1.tmp-$RELEASE"
  mv -f "$APP_ROOT/$1.tmp-$RELEASE" "$APP_ROOT/$1"
  echo "   wrote $1"
}
for pass in other html; do
  while read -r want rel; do
    [ -n "$rel" ] || continue
    case "$rel" in *.html) [ "$pass" = html ] || continue ;; *) [ "$pass" = other ] || continue ;; esac
    if [ -f "$APP_ROOT/$rel" ] && [ "$(sha_of "$APP_ROOT/$rel")" = "$want" ]; then continue; fi
    put "$rel"
  done < "$LIST"
done
[ -d "$APP_ROOT/lab/true-text-edit/fixtures-phase9" ] && chmod 755 "$APP_ROOT/lab/true-text-edit/fixtures-phase9"

echo
echo "6. Verify"
bad=0
while read -r want rel; do
  [ -n "$rel" ] || continue
  if [ "$(sha_of "$APP_ROOT/$rel")" != "$want" ]; then echo "   MISMATCH $rel"; bad=1; fi
done < "$LIST"
if [ "$bad" != 0 ]; then
  echo "VERIFY FAILED. Roll back with: sh $PKG/deploy/phase9-lab-rollback.sh $BK --apply" >&2
  exit 1
fi
echo "   all deployed files match deploy-files.txt"
echo
echo "DEPLOYED $RELEASE. Backup: $BK"
echo "Rollback: sh $PKG/deploy/phase9-lab-rollback.sh $BK        (dry run, then add --apply)"
echo "Live tests (see README-PHASE9-LAB.txt):"
echo "  https://app.noblepdf.com/lab/true-text-edit/phase8-v2.html"
echo "  https://app.noblepdf.com/lab/true-text-edit/phase9-suite.html"
echo "  https://app.noblepdf.com/lab/true-text-edit/phase9-editor.html"
