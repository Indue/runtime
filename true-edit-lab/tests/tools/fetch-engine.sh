#!/bin/sh
# Fetches the Run #10 patched PDFium engine (read-only) into tests/.engine/patched and
# verifies both files by SHA-256. Refuses to keep anything that does not match.
# Usage: sh tests/tools/fetch-engine.sh [BASE_URL]
# Default BASE_URL: https://app.noblepdf.com/vendor/pdfium-2.15.1-setpositions/
# Alternatively copy index.js and pdfium.wasm from the Run #10 build artifact into
# tests/.engine/patched/ yourself, or point PATCHED_ENGINE_DIR at them.
set -eu
BASE=${1:-https://app.noblepdf.com/vendor/pdfium-2.15.1-setpositions/}
WASM_SHA=c4f54bda9bc730c0aeb6579254f0431fa95886478cd19967555be6ea2a35ce11
JS_SHA=2af28659a83b5691ed1193bd0819a6a1339036fb08505826d561c7541762baf2
HERE=$(cd "$(dirname "$0")/.." && pwd)
DEST="$HERE/.engine/patched"
mkdir -p "$DEST"
sha_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else openssl dgst -sha256 "$1" | sed 's/^.*= //'; fi
}
get() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$2" "$1"; else wget -q -O "$2" "$1"; fi
}
for pair in "index.js $JS_SHA" "pdfium.wasm $WASM_SHA"; do
  name=${pair%% *}
  want=${pair#* }
  if [ -f "$DEST/$name" ] && [ "$(sha_of "$DEST/$name")" = "$want" ]; then echo "ok (cached) $name"; continue; fi
  get "$BASE$name" "$DEST/$name.part"
  got=$(sha_of "$DEST/$name.part")
  if [ "$got" != "$want" ]; then rm -f "$DEST/$name.part"; echo "FAIL $name sha256 $got (expected $want)" >&2; exit 1; fi
  mv "$DEST/$name.part" "$DEST/$name"
  echo "ok $name $got"
done
