#!/usr/bin/env bash
# pack-extension.sh — Packages the Ferry browser extension into a distributable zip.
# Usage: ./scripts/pack-extension.sh [output-dir]
#
# Output: dist/ferry-extension.zip
# The zip contains all extension files ready to be loaded unpacked in Chrome/Brave/Edge.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="${ROOT_DIR}/extension"
OUT_DIR="${1:-${ROOT_DIR}/dist}"
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
echo "  1. Download and unzip ferry-extension.zip"
echo "  2. Open Chrome/Brave/Edge and go to chrome://extensions"
echo "  3. Enable Developer Mode (top-right toggle)"
echo "  4. Click 'Load unpacked' and select the unzipped folder"
