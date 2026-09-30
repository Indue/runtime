#!/bin/sh
# NoblePDF True Edit lab rollback for deploy/phase10-lab-deploy.sh (Phase 10 corpus harness).
# Usage:  sh deploy/phase10-lab-rollback.sh BACKUP_DIR           dry run (default)
#         sh deploy/phase10-lab-rollback.sh BACKUP_DIR --apply   restore
# Restores every file the deploy replaced (from BACKUP_DIR/files, hash-checked) and
# removes every file the deploy created. HTML first, then everything else, so no page
# ever references a module that is already gone. Only Phase 10-owned names are restored or
# removed; a backup list naming any other file (phase8.css, a Phase 9 file) is refused.
# POSIX sh only.
set -eu
[ $# -ge 1 ] || { sed -n '2,7p' "$0"; exit 2; }
BK=$1; shift
APPLY=0
for arg in "$@"; do case "$arg" in --apply) APPLY=1 ;; *) echo "unknown option: $arg" >&2; exit 2 ;; esac; done
[ -f "$BK/release.txt" ] || { echo "STOP: not a deploy backup folder: $BK" >&2; exit 1; }
APP_ROOT=${NOBLEPDF_APP_ROOT:-$(sed -n 's/^app_root=//p' "$BK/release.txt")}
sha_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else openssl dgst -sha256 "$1" | sed 's/^.*= //'; fi
}
echo "NoblePDF True Edit lab rollback - $( [ "$APPLY" = 1 ] && echo APPLY || echo 'DRY RUN (nothing will be changed)' )"
echo "Backup:   $BK"
echo "App root: $APP_ROOT"
[ -d "$APP_ROOT" ] || { echo "STOP: app root not found" >&2; exit 1; }
# Every path the rollback writes or removes must be a plain path under lab/true-text-edit/,
# whatever the backup folder says (it is not trusted blindly).
for list in replaced.txt created.txt created-dirs.txt; do
  [ -f "$BK/$list" ] || { echo "STOP: $BK/$list missing" >&2; exit 1; }
  while read -r rel; do
    [ -n "$rel" ] || continue
    case "$rel" in lab/true-text-edit/*) ;; *) echo "STOP: $list names a path outside lab/true-text-edit: $rel" >&2; exit 1 ;; esac
    case "/$rel/" in */../*|*/./*|*//*) echo "STOP: $list names a path with empty, . or .. segments: $rel" >&2; exit 1 ;; esac
    [ "$list" = created-dirs.txt ] && continue
    case "$rel" in
      lab/true-text-edit/phase10.css|lab/true-text-edit/phase10-*|lab/true-text-edit/te-corpus.mjs|lab/true-text-edit/te-corpus-env.mjs) ;;
      *) echo "STOP: $list names a file Phase 10 does not own: $rel" >&2; exit 1 ;;
    esac
    case "${rel#lab/true-text-edit/}" in */*) echo "STOP: $list names a file Phase 10 does not own: $rel" >&2; exit 1 ;; esac
  done < "$BK/$list"
done
while read -r want rel; do
  [ -n "$rel" ] || continue
  grep -qxF "$rel" "$BK/replaced.txt" || { echo "STOP: backup.sha256 lists a file the deploy did not replace: $rel" >&2; exit 1; }
  [ -f "$BK/files/$rel" ] && [ "$(sha_of "$BK/files/$rel")" = "$want" ] || { echo "STOP: backup copy missing or damaged: $rel" >&2; exit 1; }
done < "$BK/backup.sha256"
while read -r rel; do
  [ -n "$rel" ] || continue
  cut -d' ' -f2- "$BK/backup.sha256" | grep -qxF "$rel" || { echo "STOP: replaced file has no hash-checked backup copy: $rel" >&2; exit 1; }
done < "$BK/replaced.txt"
echo "Backup copies verified ($(wc -l < "$BK/backup.sha256" | tr -d ' ') file(s))."
for pass in html other; do
  while read -r rel; do
    [ -n "$rel" ] || continue
    case "$rel" in *.html) [ "$pass" = html ] || continue ;; *) [ "$pass" = other ] || continue ;; esac
    echo "   restore $rel"
    if [ "$APPLY" = 1 ]; then cp -p "$BK/files/$rel" "$APP_ROOT/$rel.tmp-rollback"; mv -f "$APP_ROOT/$rel.tmp-rollback" "$APP_ROOT/$rel"; fi
  done < "$BK/replaced.txt"
  while read -r rel; do
    [ -n "$rel" ] || continue
    case "$rel" in *.html) [ "$pass" = html ] || continue ;; *) [ "$pass" = other ] || continue ;; esac
    echo "   remove  $rel"
    if [ "$APPLY" = 1 ] && [ -f "$APP_ROOT/$rel" ]; then rm -f "$APP_ROOT/$rel"; fi
  done < "$BK/created.txt"
done
while read -r d; do
  [ -n "$d" ] || continue
  echo "   remove folder $d (only if empty)"
  if [ "$APPLY" = 1 ] && [ -d "$APP_ROOT/$d" ]; then rmdir "$APP_ROOT/$d" 2>/dev/null || echo "   (kept $d: not empty)"; fi
done < "$BK/created-dirs.txt"
if [ "$APPLY" != 1 ]; then echo "DRY RUN complete. Nothing was changed. Re-run with --apply to roll back."; exit 0; fi
bad=0
while read -r want rel; do
  [ -n "$rel" ] || continue
  [ "$(sha_of "$APP_ROOT/$rel")" = "$want" ] || { echo "   MISMATCH after restore: $rel"; bad=1; }
done < "$BK/backup.sha256"
while read -r rel; do
  [ -n "$rel" ] || continue
  [ ! -e "$APP_ROOT/$rel" ] || { echo "   still present: $rel"; bad=1; }
done < "$BK/created.txt"
[ "$bad" = 0 ] || { echo "ROLLBACK INCOMPLETE - check the lines above" >&2; exit 1; }
echo "ROLLED BACK. The lab folder is back to its state before the deploy."
