#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/app/src-tauri"
RES_DIR="$APP_DIR/resources"

log() { echo "[hydrate-sidecars-linux] $*"; }
have_cmd() { command -v "$1" >/dev/null 2>&1; }

ensure_cmd() {
  if ! have_cmd "$1"; then
    echo "error: required command '$1' not found" >&2
    exit 1
  fi
}

copy_binary() {
  local source="$1"
  local destination="$2"
  cp "$source" "$destination"
  chmod +x "$destination"
}

main() {
  ensure_cmd curl
  ensure_cmd tar

  mkdir -p "$RES_DIR"

  local arch
  local asset
  local ff_asset
  arch="$(uname -m)"
  asset="yt-dlp_linux"
  ff_asset="ffmpeg-master-latest-linux64-gpl"
  if [[ "$arch" == "aarch64" || "$arch" == "arm64" ]]; then
    asset="yt-dlp_linux_aarch64"
    ff_asset="ffmpeg-master-latest-linuxarm64-gpl"
  fi

  log "Downloading standalone yt-dlp linux binary"
  curl -fL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}" \
    -o "$RES_DIR/yt-dlp-linux"
  chmod +x "$RES_DIR/yt-dlp-linux"

  # Static build: the distro ffmpeg links against system libav* and fails on
  # machines that don't have the exact same packages installed.
  log "Downloading static ffmpeg/ffprobe"
  local tmp
  tmp="$(mktemp -d)"
  curl -fL "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/${ff_asset}.tar.xz" \
    | tar -xJ -C "$tmp"
  copy_binary "$tmp/${ff_asset}/bin/ffmpeg" "$RES_DIR/ffmpeg-linux"
  copy_binary "$tmp/${ff_asset}/bin/ffprobe" "$RES_DIR/ffprobe-linux"
  rm -rf "$tmp"
}

main "$@"
