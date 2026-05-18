#!/usr/bin/env bash
# hydrate-sidecars-cross.sh
#
# Run this on macOS to download the Windows and Linux sidecar binaries
# (yt-dlp + ffmpeg + ffprobe) into app/src-tauri/resources/.
#
# This does NOT touch the macOS binaries — it only fills in the
# Windows and Linux placeholders so CI releases build correctly.
#
# Usage:
#   ./scripts/hydrate-sidecars-cross.sh
#
# Requirements: curl

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RES_DIR="$ROOT_DIR/app/src-tauri/resources"
TMP_DIR="$(mktemp -d)"

log()  { echo "  [hydrate-cross] $*"; }
ok()   { echo "  ✓ $*"; }
fail() { echo "  ✗ $*" >&2; exit 1; }

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

require_cmd() {
  if ! command -v "$1" > /dev/null 2>&1; then
    fail "Required command '$1' not found. Install it and re-run."
  fi
}

require_cmd curl
require_cmd unzip

mkdir -p "$RES_DIR"

echo ""
echo "Ferry cross-platform sidecar hydration"
echo "======================================="
echo "Destination: $RES_DIR"
echo ""

# ──────────────────────────────────────────────────────────────────────────────
# 1. yt-dlp (single-file binaries from yt-dlp GitHub Releases)
# ──────────────────────────────────────────────────────────────────────────────
YT_DLP_VERSION="latest/download"
YT_DLP_BASE="https://github.com/yt-dlp/yt-dlp/releases/${YT_DLP_VERSION}"

log "Downloading yt-dlp for Linux (x86_64)..."
curl -fsSL "$YT_DLP_BASE/yt-dlp_linux" -o "$RES_DIR/yt-dlp-linux"
chmod +x "$RES_DIR/yt-dlp-linux"
ok "yt-dlp-linux done"

log "Downloading yt-dlp for Windows (x86_64)..."
curl -fsSL "$YT_DLP_BASE/yt-dlp.exe" -o "$RES_DIR/yt-dlp-win.exe"
ok "yt-dlp-win.exe done"

# ──────────────────────────────────────────────────────────────────────────────
# 2. ffmpeg + ffprobe for Linux (static builds from johnvansickle.com)
# ──────────────────────────────────────────────────────────────────────────────
FFMPEG_LINUX_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"

log "Downloading ffmpeg static build for Linux (this may take a minute)..."
curl -fsSL "$FFMPEG_LINUX_URL" -o "$TMP_DIR/ffmpeg-linux.tar.xz"

log "Extracting ffmpeg and ffprobe for Linux..."
tar -xJf "$TMP_DIR/ffmpeg-linux.tar.xz" -C "$TMP_DIR"

FFMPEG_EXTRACTED_DIR=$(find "$TMP_DIR" -maxdepth 1 -type d -name "ffmpeg-*-static" | head -n 1)
if [[ -z "$FFMPEG_EXTRACTED_DIR" ]]; then
  fail "Could not find extracted ffmpeg directory in $TMP_DIR"
fi

cp "$FFMPEG_EXTRACTED_DIR/ffmpeg"  "$RES_DIR/ffmpeg-linux"
cp "$FFMPEG_EXTRACTED_DIR/ffprobe" "$RES_DIR/ffprobe-linux"
chmod +x "$RES_DIR/ffmpeg-linux" "$RES_DIR/ffprobe-linux"
ok "ffmpeg-linux and ffprobe-linux done"

# ──────────────────────────────────────────────────────────────────────────────
# 3. ffmpeg + ffprobe for Windows (from gyan.dev builds)
# ──────────────────────────────────────────────────────────────────────────────
FFMPEG_WIN_URL="https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"

log "Downloading ffmpeg for Windows (this may take a minute)..."
curl -fsSL "$FFMPEG_WIN_URL" -o "$TMP_DIR/ffmpeg-win.zip"

log "Extracting ffmpeg and ffprobe for Windows..."
unzip -q "$TMP_DIR/ffmpeg-win.zip" -d "$TMP_DIR/ffmpeg-win"

FFMPEG_WIN_BIN=$(find "$TMP_DIR/ffmpeg-win" -type d -name "bin" | head -n 1)
if [[ -z "$FFMPEG_WIN_BIN" ]]; then
  fail "Could not find bin/ directory inside Windows ffmpeg zip"
fi

cp "$FFMPEG_WIN_BIN/ffmpeg.exe"  "$RES_DIR/ffmpeg-win.exe"
cp "$FFMPEG_WIN_BIN/ffprobe.exe" "$RES_DIR/ffprobe-win.exe"
ok "ffmpeg-win.exe and ffprobe-win.exe done"

# ──────────────────────────────────────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────────────────────────────────────
echo ""
echo "All cross-platform sidecars are ready:"
ls -lh "$RES_DIR" | grep -v "^total" | awk '{print "  " $NF "\t" $5}'
echo ""
echo "macOS binaries are unchanged. Commit resources/ when done."
