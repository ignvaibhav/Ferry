#!/usr/bin/env bash
# Fetch self-contained Apple Silicon sidecars. Homebrew's ffmpeg links against
# /opt/homebrew dylibs and fails on every Mac without that exact install.
# Intel Macs are not supported.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RES_DIR="$ROOT_DIR/app/src-tauri/resources"
FF_BASE="https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release"

log() { echo "[hydrate-sidecars-macos] $*"; }

mkdir -p "$RES_DIR"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

log "Downloading yt-dlp (macOS)"
curl -fL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos" -o "$RES_DIR/yt-dlp-mac"
chmod +x "$RES_DIR/yt-dlp-mac"

for tool in ffmpeg ffprobe; do
  log "Downloading static ${tool} (arm64)"
  curl -fL "${FF_BASE}/${tool}.zip" -o "$tmp/${tool}.zip"
  unzip -o -q "$tmp/${tool}.zip" -d "$tmp/${tool}"
  cp "$(find "$tmp/${tool}" -type f -name "${tool}" | head -n 1)" "$RES_DIR/${tool}-mac"
  chmod +x "$RES_DIR/${tool}-mac"
  xattr -c "$RES_DIR/${tool}-mac" 2>/dev/null || true
done

# Fail loudly if anything still needs Homebrew or doesn't run.
for tool in ffmpeg ffprobe; do
  if otool -L "$RES_DIR/${tool}-mac" | grep -qE '/(opt/homebrew|usr/local)/'; then
    echo "error: ${tool}-mac is linked to Homebrew libraries" >&2
    exit 1
  fi
  "$RES_DIR/${tool}-mac" -version | head -n 1
done
"$RES_DIR/yt-dlp-mac" --version
