<div align="center">

# Ferry

**yt-dlp, without the terminal.**

Ferry is a browser extension that injects a native-feeling download UI on top of any yt-dlp supported page. Island is the local macOS engine that runs the actual download — no cloud, no accounts, no commands.

[![Version](https://img.shields.io/badge/version-1.0.3-B5F23D?labelColor=111111)](https://github.com/ignvaibhav/Ferry/releases/tag/v1.0.3)
[![macOS](https://img.shields.io/badge/macOS-supported-B5F23D?labelColor=111111&logo=apple&logoColor=white)](https://github.com/ignvaibhav/Ferry/releases/tag/v1.0.3)
[![License](https://img.shields.io/badge/license-MIT-B5F23D?labelColor=111111)](./LICENSE)
[![Chromium](https://img.shields.io/badge/Chromium-MV3-B5F23D?labelColor=111111&logo=googlechrome&logoColor=white)](./extension)
[![Tauri](https://img.shields.io/badge/Tauri-2-B5F23D?labelColor=111111&logo=tauri&logoColor=white)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-backend-B5F23D?labelColor=111111&logo=rust&logoColor=white)](./app/src-tauri)
[![Local First](https://img.shields.io/badge/local--first-no%20cloud-B5F23D?labelColor=111111)](https://github.com/ignvaibhav/Ferry)

[**Download for macOS →**](https://github.com/ignvaibhav/Ferry/releases/tag/v1.0.3) &nbsp;·&nbsp; [Website](https://ignvaibhav.github.io/Ferry) &nbsp;·&nbsp; [Bug Report](https://github.com/ignvaibhav/Ferry/issues/new?template=bug_report.md) &nbsp;·&nbsp; [Feature Request](https://github.com/ignvaibhav/Ferry/issues/new?template=feature_request.md)

</div>

---

## The Problem

`yt-dlp` is the most capable video downloader ever built. Most people will never use it because it lives in a terminal. Sketchy download sites exist to fill that gap — badly. Ferry fixes this by wrapping yt-dlp in a browser-native UI that feels like it belongs there.

---

## Overview

Ferry is a two-part system:

- **Ferry** — browser extension. Detects supported pages, injects a download button into the page UI, presents format and quality options, and streams live progress back to you.
- **Island** — macOS desktop app. Runs silently in your menu bar, exposes a local API on `127.0.0.1:49152`, and executes `yt-dlp` + `ffmpeg` locally to handle every download.

Everything stays on your machine. No data leaves your device. No servers are involved.

---

## Features

| | |
|---|---|
| 🎬 **Video** | 360p through 4K — only qualities actually available for the video |
| 🎵 **Audio** | Top 3 highest-quality audio streams |
| 🖼 **Thumbnail** | Top 2 largest available sizes |
| ✂️ **Clip range** | Set start and end time in the browser before downloading |
| 📡 **Live progress** | Real-time speed, percentage, and ETA via WebSocket |
| 🗂 **Activity history** | Recent jobs with status, reveal, and cancel actions |
| 🔒 **Fully local** | Island runs on localhost — zero cloud dependency |
| ⚙️ **No config** | Works immediately after a one-time setup |

---

## How It Works

```
Browser (Ferry extension)
        │
        │  POST /download
        │  WebSocket ← live progress
        ▼
Island  (127.0.0.1:49152)
        │
        ├── yt-dlp   (bundled)
        ├── ffmpeg   (bundled)
        └── ffprobe  (bundled)
                │
                ▼
        ~/Downloads
```

1. Open any supported page — Ferry detects it and injects its UI
2. Choose video, audio, or thumbnail — pick quality and optional clip range
3. Ferry sends the job to Island over localhost HTTP
4. Island runs yt-dlp, streams progress back via WebSocket
5. File saves to your Downloads folder — click "Reveal in Finder" when done

---

## Getting Started

### Requirements

- macOS — Intel or Apple Silicon
- Chrome, Brave, Edge, or Arc

---

### Option A — Release build *(recommended)*

**1. Download and launch Island**

Download `Island-macOS-app.zip` from [Releases](https://github.com/ignvaibhav/Ferry/releases/tag/v1.0.3), unzip it, and open Island. It runs in your menu bar with no visible window.

> **Gatekeeper note:** Builds aren't notarized yet. If macOS blocks Island on first open, right-click → Open. Or run:
> ```bash
> xattr -cr /path/to/Island.app
> ```

**2. Load the Ferry extension**

Go to `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the `extension/` folder from this repo.

**3. Open any supported page**

The Ferry button appears in the action bar. Click it, pick your format, and download.

---

### Option B — Run from source

```bash
git clone https://github.com/ignvaibhav/Ferry.git
cd Ferry

# Install Homebrew, Rust, Node, ffmpeg, yt-dlp, and Tauri CLI
./scripts/bootstrap-macos.sh

# Start Island
cd app/src-tauri
cargo run
```

Expected output:
```
INFO island_desktop::server: Island API listening on http://127.0.0.1:49152
```

Then load the extension as described in Option A (step 2 onwards).

---

## Repository Structure

```
Ferry/
├── extension/                    # Ferry — Chromium MV3 browser extension
│   ├── manifest.json
│   ├── icons/
│   ├── _shared/                  # api.js · constants.js · runtime.js
│   ├── background/               # service worker — WebSocket, activity, notifications
│   ├── content/                  # injected page UI (content.js + content.css)
│   ├── popup/                    # toolbar popup — jobs, progress, actions
│   ├── settings/                 # extension settings page
│   └── assets/
├── app/
│   ├── src/                      # Tauri webview pages
│   └── src-tauri/
│       ├── resources/            # bundled yt-dlp · ffmpeg · ffprobe sidecars
│       └── src/
│           ├── main.rs           # app entry, tray, settings window
│           ├── server.rs         # Axum HTTP + WebSocket server
│           ├── queue.rs          # sequential download queue
│           ├── downloader.rs     # yt-dlp subprocess + progress parsing
│           ├── formats.rs        # format discovery and ranking
│           ├── models.rs         # shared types
│           ├── config.rs         # thread-safe config
│           └── error.rs          # error types → HTTP responses
├── website/                      # Landing page
├── docs/                         # Technical docs
├── scripts/                      # bootstrap · build · dev-check · smoke test
└── .github/workflows/            # CI — build and release matrix
```

---

## Local API

Island exposes a private HTTP + WebSocket API on `127.0.0.1:49152`. It is not accessible outside your machine.

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Check if Island is running |
| `/formats` | POST | Fetch available format presets for a URL |
| `/download` | POST | Queue a download job |
| `/status/{job_id}` | GET | Poll job state |
| `/reveal` | POST | Reveal a completed file in Finder |
| `/jobs/{job_id}/cancel` | POST | Cancel a queued or active job |
| `/jobs/{job_id}/skip` | POST | Skip a queued job |
| `/action/open-settings` | POST | Open Island settings window |
| `/action/open-downloads` | POST | Open the downloads folder |
| `/ws` | GET | WebSocket stream for live progress events |

---

## Development

**Run all checks**
```bash
./scripts/dev-check.sh
# cargo check · cargo clippy -D warnings · cargo fmt --check · node --check
```

**Smoke test the API** *(Island must be running)*
```bash
node scripts/smoke-api.mjs          # health + formats check
node scripts/smoke-api.mjs --queue  # queue a test download
```

**Full build**
```bash
./scripts/build-all.sh
```

---

## Current Status

Ferry is in early release. The core download flow is stable on macOS.

| | Status |
|---|---|
| macOS (Intel + Apple Silicon) | ✅ Supported |
| Chrome · Brave · Edge · Arc | ✅ Supported |
| Windows | 🔜 Planned |
| Linux | 🔜 Planned |
| Firefox | 🔜 Planned |
| Code signing + notarization | 🔜 In progress |
| Chrome Web Store listing | 🔜 In progress |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Ferry button missing | Reload the extension in `chrome://extensions`, refresh the page |
| Popup shows Island offline | Check that Island is running — look for the menu bar icon |
| Downloads not starting | Check Island terminal logs |
| Old UI after an update | Reload the extension and refresh all open tabs |
| Port 49152 in use | Stop the process holding that port |
| Fewer quality options than expected | Ferry shows a curated list — only heights available for that specific video appear |

---

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a PR. For bugs and feature requests, use the [issue tracker](https://github.com/ignvaibhav/Ferry/issues). For security issues, see [SECURITY.md](./SECURITY.md).

---

## License

MIT — see [LICENSE](./LICENSE)

---

<div align="center">
  <sub>Built on <a href="https://github.com/yt-dlp/yt-dlp">yt-dlp</a> · <a href="https://tauri.app">Tauri 2</a> · <a href="https://ffmpeg.org">ffmpeg</a></sub>
</div>