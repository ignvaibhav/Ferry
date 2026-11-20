#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/app/src-tauri"
RES_DIR="$APP_DIR/resources"

log() { echo "[bootstrap-macos] $*"; }
have_cmd() { command -v "$1" >/dev/null 2>&1; }

ensure_xcode_clt() {
  if xcode-select -p >/dev/null 2>&1; then
    return
  fi
  log "Installing Xcode Command Line Tools (UI prompt may appear)"
  xcode-select --install || true
  until xcode-select -p >/dev/null 2>&1; do
    sleep 5
  done
}

ensure_homebrew() {
  if have_cmd brew; then
    return
  fi
  log "Installing Homebrew"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
}

ensure_rust() {
  if have_cmd cargo && have_cmd rustc; then
    return
  fi
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
}

source_cargo() {
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
}

install_tools() {
  brew update
  brew install node ffmpeg yt-dlp
}

install_tauri_cli() {
  if cargo tauri --version >/dev/null 2>&1; then
    return
  fi
  cargo install tauri-cli --version '^2'
}

install_latest_ytdlp_sidecar() {
  # yt-dlp + static (non-Homebrew) ffmpeg/ffprobe
  "$ROOT_DIR/scripts/hydrate-sidecars-macos.sh"
}

main() {
  ensure_xcode_clt
  ensure_homebrew
  ensure_rust
  source_cargo
  install_tools
  install_tauri_cli
  install_latest_ytdlp_sidecar
  (cd "$APP_DIR" && cargo check)
  log "Done. Load extension from: $ROOT_DIR/extension"
  log "Run desktop app: cd $APP_DIR && cargo run"
}

main "$@"
