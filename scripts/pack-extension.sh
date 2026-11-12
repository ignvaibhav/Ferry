#!/usr/bin/env bash
# pack-extension.sh — Packages the Ferry browser extension into a distributable zip.
# Usage: ./scripts/pack-extension.sh [output-dir]
#
# Output: dist/ferry-extension.zip
# The same zip works for Chromium browsers and Firefox (one cross-browser manifest).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="${ROOT_DIR}/extension"
OUT_DIR="${1:-${ROOT_DIR}/dist}"
# Ensure OUT_DIR is absolute so the cd command later doesn't break it
if [[ "$OUT_DIR" != /* ]]; then
  OUT_DIR="$PWD/$OUT_DIR"
fi
OUT_ZIP="${OUT_DIR}/ferry-extension.zip"

if [[ ! -d "${EXT_DIR}" ]]; then
  echo "error: extension/ directory not found at ${EXT_DIR}" >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"
rm -f "${OUT_ZIP}"

echo "Packaging Ferry extension..."
echo "  Source : ${EXT_DIR}"
echo "  Output : ${OUT_ZIP}"

# Build the zip from inside extension/ so paths inside are relative (no parent folder prefix)
(
  cd "${EXT_DIR}"
  zip -r "${OUT_ZIP}" . \
    -x "*.DS_Store" \
    -x "*/.DS_Store" \
    -x "__MACOSX/*" \
    -x "*.map" \
    -x ".git/*"
)

SIZE=$(du -sh "${OUT_ZIP}" | cut -f1)
echo "Done — ferry-extension.zip (${SIZE})"
echo ""
echo "Install instructions:"
echo "  Chromium (Chrome/Edge/Brave/Opera/Vivaldi/Arc):"
echo "    unzip, open chrome://extensions, enable Developer Mode, 'Load unpacked'"
echo "  Firefox 128+:"
echo "    sign the zip on addons.mozilla.org (free, can be unlisted) and install the .xpi;"
echo "    for testing: about:debugging > This Firefox > Load Temporary Add-on > manifest.json"
