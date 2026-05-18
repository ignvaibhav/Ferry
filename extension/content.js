/**
 * Ferry content script — Injected download interface.
 * Robust YouTube integration with modern Design System UI.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = "http://127.0.0.1:49152";
const BUTTON_ID = "ferry-injected-button";
const PANEL_ID = "ferry-inline-panel";
const WRAPPER_ID = "ferry-button-anchor";
const INJECT_DEBOUNCE_MS = 200;
const MAX_INJECTION_FRAMES = 180;
const PREFETCH_DEBOUNCE_MS = 900;

// ---------------------------------------------------------------------------
// Runtime & API Helpers
// ---------------------------------------------------------------------------

function runtimeAvailable() {
  return Boolean(globalThis.chrome?.runtime?.id);
}

async function safeSendMessage(message) {
  const runtime = globalThis.chrome?.runtime;
  if (!runtimeAvailable() || typeof runtime?.sendMessage !== "function") return null;
  try { return await runtime.sendMessage(message); } catch { return null; }
}

async function queueDownload(payload) {
  const res = await fetch(`${API_BASE}/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.error || `failed (${res.status})`);
  }
  return res.json();
}

async function fetchJobStatus(jobId) {
  const res = await fetch(`${API_BASE}/status/${encodeURIComponent(jobId)}`);
  if (!res.ok) throw new Error(`failed (${res.status})`);
  return res.json();
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let activeJobId = null;
let wsBound = false;
let prefetchKey = "";
let prefetchState = { loading: false, formats: [], error: null, selectedFormats: {} };
let injectTimer = null;
let statusPollTimer = null;
let injectionWatchdogTimer = null;
let injectionWatchdogTicks = 0;
let injectionLoopActive = false;
let prefetchTimer = null;

// ---------------------------------------------------------------------------
// YouTube Helpers
// ---------------------------------------------------------------------------

function isWatchPage() {
  try {
    const url = new URL(window.location.href);
    return url.hostname.includes("youtube.com") && url.pathname === "/watch";
  } catch { return false; }
}

function getVideoContext() {
  const videoId = new URLSearchParams(window.location.search).get("v");
  return {
    url: window.location.href,
    videoId: videoId,
    title: document.querySelector("h1.ytd-watch-metadata")?.textContent?.trim() || document.title,
    thumbnailUrl: videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : null,
  };
}

function getPlayerDurationSeconds() {
  const video = document.querySelector("video.html5-main-video");
  return video?.duration || 0;
}

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1000 ? (mb / 1024).toFixed(1) + " GB" : mb.toFixed(1) + " MB";
}

function escapeHtml(v) {
  return String(v || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// UI Feedback Logic
// ---------------------------------------------------------------------------

function setStatus(panel, text, ok = true, show = true) {
  const box = panel.querySelector("#ferry-progress-box");
  const textEl = panel.querySelector("#ferry-progress-text");
  const dlBtn = panel.querySelector('[data-ferry="download-btn"]');
  if (!box || !textEl) return;

  if (!show) {
    box.style.display = "none";
    return;
  }

  box.style.display = "flex";
  textEl.textContent = ok ? text : `Error: ${text}`;
  
  if (!ok) {
    textEl.style.color = "var(--f-accent2)";
    if (dlBtn) dlBtn.disabled = false;
  } else {
    textEl.style.color = "";
  }
}

function setProgress(panel, progress, speed, eta) {
  const box = panel.querySelector("#ferry-progress-box");
  const text = panel.querySelector("#ferry-progress-text");
  const dlBtn = panel.querySelector('[data-ferry="download-btn"]');

  if (!box || !text) return;

  const value = Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0;
  
  if (value >= 100) {
    box.style.display = "flex";
    text.textContent = "Downloaded!";
    if (dlBtn) {
      dlBtn.innerHTML = 'Download';
      dlBtn.disabled = false;
    }
  } else {
    box.style.display = "none";
    if (dlBtn) dlBtn.disabled = false;
  }
}

function resetProgressBox(panel) {
  const box = panel.querySelector("#ferry-progress-box");
  const dlBtn = panel.querySelector('[data-ferry="download-btn"]');
  if (box) {
    box.style.display = "none";
    const text = box.querySelector("#ferry-progress-text");
    if (text) text.textContent = "";
  }
  if (dlBtn) {
    updateDownloadButtonLabel(panel);
    dlBtn.disabled = false;
  }
}

function setFormatInteractionDisabled(panel, disabled) {
  const dlBtn = panel.querySelector('[data-ferry="download-btn"]');
  if (dlBtn) dlBtn.disabled = Boolean(disabled);
  panel.querySelectorAll(".ferry-quality-item").forEach(item => {
    item.classList.toggle("is-disabled", Boolean(disabled));
  });
}

// ---------------------------------------------------------------------------
// Format Handling
// ---------------------------------------------------------------------------

function buildFormatOptionLabel(format, mode) {
  const parts = [];
  const ext = (format.format || (mode === "audio" ? "mp3" : "mp4")).toUpperCase();
  const heightText = format.height ? `${format.height}p` : "";
  const sizeText = formatBytes(format.filesize);
  if (format.quality === "best") parts.push("Best", ext);
  else if (ext) parts.push(ext);
  if (heightText) parts.push(heightText);
  if (sizeText) parts.push(sizeText);
  return parts.join(" • ") || format.label || "Best available";
}

function applyPrefetchStateToPanel(panel) {
  if (prefetchState.loading) {
    setFormatInteractionDisabled(panel, true);
    setStatus(panel, "Loading qualities...", true, true);
    renderFormats(panel, [], true);
    return;
  }

  if (prefetchState.error) {
    setFormatInteractionDisabled(panel, true);
    const errorText = String(prefetchState.error || "Failed to load formats");
    const message = errorText.toLowerCase().includes("desktop")
      ? errorText
      : `Desktop app not reachable: ${errorText}`;
    setStatus(panel, message, false, true);
    return;
  }

  setFormatInteractionDisabled(panel, false);
  setStatus(panel, "", true, false); 

  const formats = prefetchState.formats || [];
  renderFormats(panel, formats, false);

  if (!formats.length) {
    setStatus(panel, "No downloadable formats found", false, true);
  }
}

function renderFormats(panel, formats, loading = false) {
  const selects = {
    video: panel.querySelector("[data-ferry=video-quality-select]"),
    audio: panel.querySelector("[data-ferry=audio-quality-select]"),
    thumbnail: panel.querySelector("[data-ferry=thumbnail-quality-select]"),
  };

  const context = getVideoContext();
  const thumbPreview = panel.querySelector("[data-ferry=thumbnail-preview]");
  if (thumbPreview && context.thumbnailUrl) {
    thumbPreview.src = context.thumbnailUrl;
  }

  for (const [mode, select] of Object.entries(selects)) {
    if (!select) continue;
    select.innerHTML = "";
    if (loading) {
      const opt = document.createElement("option");
      opt.textContent = "Loading...";
      select.appendChild(opt);
      continue;
    }

    const filtered = formats.filter(f => {
      const type = (f.media_type || "").toLowerCase();
      const fmt = (f.format || "").toLowerCase();
      if (mode === "audio") return type === "audio" || fmt === "mp3" || f.quality === "audio";
      if (mode === "thumbnail") return type === "thumbnail" || fmt === "jpg" || fmt === "png" || type.includes("thumb");
      // For video, include anything that is explicitly video OR lacks a media_type but isn't mp3/jpg
      return type === "video" || (!type && fmt !== "mp3" && fmt !== "jpg");
    });

    if (!filtered.length && mode !== "thumbnail") {
      const opt = document.createElement("option");
      opt.textContent = `No ${mode} formats`;
      select.appendChild(opt);
      continue;
    }

    const displayFormats = (mode === "thumbnail" && !filtered.length) ? [{ label: "Best JPG", quality: "best", format: "jpg" }] : filtered;

    displayFormats.forEach((format, index) => {
      const opt = document.createElement("option");
      opt.value = JSON.stringify(format);
      opt.textContent = buildFormatOptionLabel(format, mode).replace(/ • /g, " · ");
      if (index === 0) {
        if (!prefetchState.selectedFormats) prefetchState.selectedFormats = {};
        prefetchState.selectedFormats[mode] = format;
      }
      select.appendChild(opt);
    });

    select.onchange = () => {
      try {
        prefetchState.selectedFormats[mode] = JSON.parse(select.value);
        updateDownloadButtonLabel(panel);
      } catch (e) {}
    };
  }
  updateDownloadButtonLabel(panel);
}

// ---------------------------------------------------------------------------
// Clipping Logic
// ---------------------------------------------------------------------------

function setupClipSlider(panel) {
  const mode = panel.dataset.ferryMode;
  const activeMode = mode === "thumbnail" ? "video" : mode;
  
  const track = panel.querySelector(`[data-ferry=${activeMode}-clip-track]`);
  const fill = panel.querySelector(`[data-ferry=${activeMode}-clip-fill]`);
  const sThumb = panel.querySelector(`[data-ferry=${activeMode}-clip-start-thumb]`);
  const eThumb = panel.querySelector(`[data-ferry=${activeMode}-clip-end-thumb]`);
  const sCapture = panel.querySelector(`[data-ferry=${activeMode}-clip-start-capture]`);
  const eCapture = panel.querySelector(`[data-ferry=${activeMode}-clip-end-capture]`);
  
  if (!track || !sThumb || !eThumb) return;
  const duration = getPlayerDurationSeconds();
  if (!duration) return;

  let start = parseFloat(panel.dataset.clipStart || 0);
  let end = parseFloat(panel.dataset.clipEnd || duration);
  
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  
  const render = () => {
    const sPct = (start / duration) * 100, ePct = (end / duration) * 100;
    sThumb.style.left = `${sPct}%`; eThumb.style.left = `${ePct}%`; 
    fill.style.left = `${sPct}%`; fill.style.width = `${ePct - sPct}%`;
    
    panel.dataset.clipStart = String(start); 
    panel.dataset.clipEnd = String(end);
    
    const fmt = (s) => new Date(s * 1000).toISOString().substr(11, 8);
    const sBox = panel.querySelector(`[data-ferry=${activeMode}-clip-start-box]`);
    const eBox = panel.querySelector(`[data-ferry=${activeMode}-clip-end-box]`);
    if (sBox) sBox.textContent = fmt(start);
    if (eBox) eBox.textContent = fmt(end);
  };

  const getSecs = (x) => { 
    const r = track.getBoundingClientRect(); 
    return clamp(Math.round(((x - r.left) / r.width) * duration), 0, duration); 
  };

  const drag = (w) => (e) => {
    e.preventDefault();
    const move = (me) => { 
      const s = getSecs(me.clientX); 
      if (w === "s") start = clamp(s, 0, end - 1); 
      else end = clamp(s, start + 1, duration); 
      render(); 
    };
    const up = () => { 
      window.removeEventListener("pointermove", move); 
      window.removeEventListener("pointerup", up); 
    };
    window.addEventListener("pointermove", move); 
    window.addEventListener("pointerup", up);
  };

  sThumb.onpointerdown = drag("s"); 
  eThumb.onpointerdown = drag("e");

  if (sCapture) {
    sCapture.onclick = () => {
      const cur = Math.floor(document.querySelector("video.html5-main-video")?.currentTime || 0);
      start = clamp(cur, 0, end - 1);
      render();
    };
  }
  if (eCapture) {
    eCapture.onclick = () => {
      const cur = Math.ceil(document.querySelector("video.html5-main-video")?.currentTime || duration);
      end = clamp(cur, start + 1, duration);
      render();
    };
  }

  render();
}

// ---------------------------------------------------------------------------
// Panel Component
// ---------------------------------------------------------------------------

function getExtensionAssetUrl(path) {
  const runtime = globalThis.chrome?.runtime;
  if (!runtime || typeof runtime.getURL !== "function") return path;
  try { return runtime.getURL(path); } catch { return path; }
}

function createPanel() {
  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.style.display = "none";
  panel.dataset.ferryMode = "video";

  const iconUrl = getExtensionAssetUrl("icons/icon128.png");

  panel.innerHTML = `
    <div class="ferry-branded-header">
      <div class="ferry-brand-left">
        <span class="ferry-brand-mark" aria-hidden="true">
          <img src="${iconUrl}" alt="" style="width: 100%; height: 100%; object-fit: contain;">
        </span>
        <span class="ferry-brand-text">Ferry</span>
      </div>
      <button type="button" data-ferry="close" class="ferry-close-btn" aria-label="Close" title="Close">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    </div>
    
    <div class="ferry-mode-tabs" role="tablist">
      <button type="button" class="ferry-mode-tab is-active" data-ferry-mode="video" role="tab">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
        Video
      </button>
      <button type="button" class="ferry-mode-tab" data-ferry-mode="audio" role="tab">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
        Audio
      </button>
      <button type="button" class="ferry-mode-tab" data-ferry-mode="thumbnail" role="tab">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        Thumbnail
      </button>
    </div>

    <section class="ferry-mode-section" data-ferry-section="video">
      <div class="ferry-section-label">Quality</div>
      <select class="ferry-quality-select" data-ferry="video-quality-select"></select>
      
      <details class="ferry-clip-details" style="margin-top: 8px;">
        <summary class="ferry-section-label" style="cursor: pointer; display: flex; align-items: center; gap: 4px; list-style: none;">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>
          <p>Configure Clip<p>
        </summary>
        <div class="ferry-clip-grid" style="margin-top: 8px;">
          <div class="ferry-clip-card">
            <label class="ferry-section-label">From</label>
            <div class="ferry-clip-input-row">
              <div class="ferry-clip-input" data-ferry="video-clip-start-box">00:00:00</div>
              <button type="button" class="ferry-capture-btn" data-ferry="video-clip-start-capture">Set Current</button>
            </div>
          </div>
          <div class="ferry-clip-card">
            <label class="ferry-section-label">To</label>
            <div class="ferry-clip-input-row">
              <div class="ferry-clip-input" data-ferry="video-clip-end-box">00:00:00</div>
              <button type="button" class="ferry-capture-btn" data-ferry="video-clip-end-capture">Set Current</button>
            </div>
          </div>
        </div>
        <div style="margin-top: 12px; padding: 0 4px;">
          <div data-ferry="video-clip-track" style="height: 4px; background: var(--f-surface3); border-radius: 2px; position: relative;">
            <div data-ferry="video-clip-fill" style="position: absolute; height: 100%; background: var(--f-accent); border-radius: 2px;"></div>
            <button type="button" data-ferry="video-clip-start-thumb" style="position: absolute; width: 12px; height: 12px; border-radius: 50%; background: #fff; border: none; top: 50%; transform: translate(-50%, -50%); cursor: pointer;"></button>
            <button type="button" data-ferry="video-clip-end-thumb" style="position: absolute; width: 12px; height: 12px; border-radius: 50%; background: #fff; border: none; top: 50%; transform: translate(-50%, -50%); cursor: pointer;"></button>
          </div>
        </div>
      </details>
    </section>

    <section class="ferry-mode-section" data-ferry-section="audio" hidden>
      <div class="ferry-section-label">Bitrate</div>
      <select class="ferry-quality-select" data-ferry="audio-quality-select"></select>
      
      <details class="ferry-clip-details" style="margin-top: 8px;">
        <summary class="ferry-section-label" style="cursor: pointer; display: flex; align-items: center; gap: 4px; list-style: none;">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>
          Configure Clip
        </summary>
        <div class="ferry-clip-grid" style="margin-top: 8px;">
          <div class="ferry-clip-card">
            <label class="ferry-section-label">From</label>
            <div class="ferry-clip-input-row">
              <div class="ferry-clip-input" data-ferry="audio-clip-start-box">00:00:00</div>
              <button type="button" class="ferry-capture-btn" data-ferry="audio-clip-start-capture">Set Current</button>
            </div>
          </div>
          <div class="ferry-clip-card">
            <label class="ferry-section-label">To</label>
            <div class="ferry-clip-input-row">
              <div class="ferry-clip-input" data-ferry="audio-clip-end-box">00:00:00</div>
              <button type="button" class="ferry-capture-btn" data-ferry="audio-clip-end-capture">Set Current</button>
            </div>
          </div>
        </div>
        <div style="margin-top: 12px; padding: 0 4px;">
          <div data-ferry="audio-clip-track" style="height: 4px; background: var(--f-surface3); border-radius: 2px; position: relative;">
            <div data-ferry="audio-clip-fill" style="position: absolute; height: 100%; background: var(--f-accent); border-radius: 2px;"></div>
            <button type="button" data-ferry="audio-clip-start-thumb" style="position: absolute; width: 12px; height: 12px; border-radius: 50%; background: #fff; border: none; top: 50%; transform: translate(-50%, -50%); cursor: pointer;"></button>
            <button type="button" data-ferry="audio-clip-end-thumb" style="position: absolute; width: 12px; height: 12px; border-radius: 50%; background: #fff; border: none; top: 50%; transform: translate(-50%, -50%); cursor: pointer;"></button>
          </div>
        </div>
      </details>
    </section>

    <section class="ferry-mode-section" data-ferry-section="thumbnail" hidden>
      <div class="ferry-section-label">Thumbnail Preview</div>
      <div class="ferry-thumbnail-preview-container" style="background: var(--f-surface2); border-radius: 8px; overflow: hidden; aspect-ratio: 16/9; margin-bottom: 8px; border: 0.5px solid var(--f-border2);">
        <img data-ferry="thumbnail-preview" src="" alt="" style="width: 100%; height: 100%; object-fit: cover;" />
      </div>
      <div class="ferry-section-label">Formats</div>
      <select class="ferry-quality-select" data-ferry="thumbnail-quality-select"></select>
    </section>

    <div class="ferry-progress-box" id="ferry-progress-box" style="display: none;">
      <div class="ferry-progress-status">
        <span id="ferry-progress-text"></span>
      </div>
    </div>

    <button type="button" class="ferry-dl-btn" data-ferry="download-btn">Download</button>
  `;

  panel.querySelector('[data-ferry="close"]').onclick = () => {
    panel.style.display = "none";
    setButtonActiveState(false);
    resetProgressBox(panel);
  };

  panel.querySelectorAll("[data-ferry-mode]").forEach((tab) => {
    tab.onclick = () => setPanelMode(panel, tab.dataset.ferryMode);
  });

  const dlBtn = panel.querySelector('[data-ferry="download-btn"]');
  dlBtn.onclick = () => handleDownloadClick(panel);

  window.addEventListener("keydown", (e) => {
    if (panel.style.display === "none") return;
    if (e.key === "Escape") panel.querySelector('[data-ferry="close"]').click();
    else if (e.key === "Enter") dlBtn.click();
    else if (["1", "2", "3", "4"].includes(e.key)) {
      const idx = parseInt(e.key) - 1;
      const list = panel.querySelector(`[data-ferry="${panel.dataset.ferryMode}-quality-select"]`);
      if (list && list.options[idx]) {
        list.selectedIndex = idx;
        list.dispatchEvent(new Event("change"));
      }
    }
  });

  return panel;
}

function setPanelMode(panel, mode) {
  const nextMode = ["video", "audio", "thumbnail"].includes(mode) ? mode : "video";
  panel.dataset.ferryMode = nextMode;
  panel.querySelectorAll(".ferry-mode-tab").forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.ferryMode === nextMode);
  });
  panel.querySelectorAll("[data-ferry-section]").forEach((section) => {
    section.hidden = section.dataset.ferrySection !== nextMode;
  });
  
  if (nextMode === "video" || nextMode === "audio") {
    setupClipSlider(panel);
  }
  
  updateDownloadButtonLabel(panel);
}

function updateDownloadButtonLabel(panel) {
  const mode = panel.dataset.ferryMode;
  const dlBtn = panel.querySelector('[data-ferry="download-btn"]');
  if (!dlBtn) return;

  const format = prefetchState.selectedFormats?.[mode];
  
  if (format?.filesize) {
    dlBtn.textContent = `Download · ${formatBytes(format.filesize)}`;
  } else if (mode === "thumbnail") {
    dlBtn.textContent = "Download Thumbnail";
  } else {
    dlBtn.textContent = `Download ${mode.charAt(0).toUpperCase() + mode.slice(1)}`;
  }
}

async function handleDownloadClick(panel) {
  const mode = panel.dataset.ferryMode;
  const format = prefetchState.selectedFormats?.[mode];
  const context = getVideoContext();

  const payload = {
    url: context.url,
    title: context.title,
    media_type: mode,
    format: format?.format || (mode === "audio" ? "mp3" : mode === "thumbnail" ? "jpg" : "mp4"),
    quality: format?.quality || "best",
    format_id: format?.format_id || null,
    height: format?.height || null,
  };

  if (mode !== "thumbnail") {
    const duration = getPlayerDurationSeconds();
    payload.clip = {
      start: String(panel.dataset.clipStart || 0),
      end: String(panel.dataset.clipEnd || duration || 0),
    };
  }

  try {
    const result = await queueDownload(payload);
    activeJobId = result.job_id;
    setProgress(panel, 0, null, null);
    startStatusPolling(panel, activeJobId);
    
    await safeSendMessage({
      type: "TRACK_JOB",
      jobId: activeJobId,
      title: payload.title || "Video",
      meta: { 
        mediaType: mode, 
        qualityLabel: mode === "thumbnail" ? (format?.quality || "Best") : (format?.height ? `${format.height}p` : "Best"), 
        formatLabel: payload.format.toUpperCase() 
      }
    });
  } catch (error) {
    setStatus(panel, error.message, false, true);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function startStatusPolling(panel, jobId) {
  if (statusPollTimer) clearInterval(statusPollTimer);
  statusPollTimer = setInterval(async () => {
    try {
      const s = await fetchJobStatus(jobId);
      if (s.status === "in_progress") setProgress(panel, s.progress);
      else if (s.status === "done") { setProgress(panel, 100); stopStatusPolling(); }
      else if (s.status === "error") { setStatus(panel, s.message || "Failed", false, true); stopStatusPolling(); }
    } catch { stopStatusPolling(); }
  }, 2000);
}

function stopStatusPolling() {
  if (statusPollTimer) clearInterval(statusPollTimer);
  statusPollTimer = null;
}

function ensureWsListener() {
  if (wsBound) return;
  chrome.runtime.onMessage.addListener((m) => {
    const p = document.getElementById(PANEL_ID);
    if (m.type === "PREFETCH_UPDATED" && m.payload.key === prefetchKey) {
      const snapshot = m.payload;
      prefetchState.loading = snapshot.state === "loading";
      prefetchState.formats = Array.isArray(snapshot.formats) ? snapshot.formats : [];
      prefetchState.error = snapshot.state === "error" ? (snapshot.error || "Failed to load formats") : null;
      if (p && p.style.display !== "none") applyPrefetchStateToPanel(p);
    } else if (m.type === "WS_EVENT" && p && m.payload.job_id === activeJobId) {
      if (m.payload.event === "progress") setProgress(p, m.payload.percent, m.payload.speed, m.payload.eta);
      else if (m.payload.event === "done") setProgress(p, 100);
      else if (m.payload.event === "error") setStatus(p, m.payload.message, false, true);
    }
  });
  wsBound = true;
}

// ---------------------------------------------------------------------------
// Injection Logic
// ---------------------------------------------------------------------------

function ensureDropdownHostStyles(actionBar) {
  const nodes = [actionBar, actionBar?.parentElement, actionBar?.closest("#menu"), actionBar?.closest("#actions"), actionBar?.closest("#actions-inner"), actionBar?.closest("ytd-watch-metadata")].filter(Boolean);
  for (const node of nodes) { if (node instanceof HTMLElement) node.style.overflow = "visible"; }
}

function setButtonActiveState(active) {
  const button = document.getElementById(BUTTON_ID);
  if (!button) return;
  button.classList.toggle("is-active", Boolean(active));
  button.setAttribute("aria-pressed", active ? "true" : "false");
}

function findActionBar() {
  const selectors = ["#top-level-buttons-computed", "#menu #top-level-buttons-computed", "ytd-watch-metadata #top-level-buttons-computed", "#actions #top-level-buttons-computed", "ytd-menu-renderer #top-level-buttons-computed", "#actions-inner #top-level-buttons-computed"];
  for (const s of selectors) { const n = document.querySelector(s); if (n?.isConnected && isWatchPage()) return n; }
  return null;
}

function createButton() {
  const button = document.createElement("button");
  button.id = BUTTON_ID; button.className = "ferry-injected-button";
  button.innerHTML = `
    <span class="ferry-button-icon" aria-hidden="true">
      <span class="ferry-icon-fill">
        <span class="ferry-icon-liquid"></span>
      </span>
      <svg class="ferry-icon-svg" viewBox="0 0 462.05 462.05" role="img" aria-hidden="true">
        <g class="ferry-icon-shape">
          <path d="M178.828,345.125c-12.279,0-22.269,9.99-22.269,22.269s9.99,22.269,22.269,22.269c12.279,0,22.269-9.99,22.269-22.269 S191.107,345.125,178.828,345.125z M178.828,374.662c-4.008,0-7.269-3.261-7.269-7.269s3.261-7.269,7.269-7.269 c4.008,0,7.269,3.261,7.269,7.269S182.836,374.662,178.828,374.662z"></path>
          <path d="M230.518,345.125c-12.279,0-22.269,9.99-22.269,22.269s9.99,22.269,22.269,22.269s22.269-9.99,22.269-22.269 S242.797,345.125,230.518,345.125z M230.518,374.662c-4.008,0-7.269-3.261-7.269-7.269s3.261-7.269,7.269-7.269 s7.269,3.261,7.269,7.269S234.526,374.662,230.518,374.662z"></path>
          <path d="M282.209,345.125c-12.279,0-22.269,9.99-22.269,22.269s9.99,22.269,22.269,22.269s22.269-9.99,22.269-22.269 S294.487,345.125,282.209,345.125z M282.209,374.662c-4.008,0-7.269-3.261-7.269-7.269s3.261-7.269,7.269-7.269 s7.269,3.261,7.269,7.269S286.216,374.662,282.209,374.662z"></path>
          <path d="M447.388,280.945c-0.938-4.035-4.969-6.547-9.003-5.607l-126.25,29.342c-3.397,0.79-5.802,3.817-5.802,7.305 c0,6.084-4.95,11.035-11.035,11.035h-57.28V207.922c6.545,7.088,15.653,11.112,25.414,11.111c10.713,0,20.65-4.834,27.263-13.263 l5.661-7.216l5.666,7.221c6.613,8.428,16.549,13.262,27.262,13.262c10.712,0,20.649-4.834,27.261-13.262l9.315-11.872h10.432 c4.142,0,7.5-3.358,7.5-7.5s-3.358-7.5-7.5-7.5H238.018v-36.984c6.545,7.088,15.653,11.111,25.414,11.111 c10.713,0,20.65-4.834,27.263-13.263l9.309-11.866h11.683c4.142,0,7.5-3.358,7.5-7.5s-3.358-7.5-7.5-7.5h-73.669V82.917h15.971 c3.671,0,6.802-2.657,7.4-6.279l5.192-31.474c0.358-2.173-0.256-4.394-1.681-6.073c-1.425-1.679-3.516-2.647-5.719-2.647h-21.164 V7.5c0-4.142-3.358-7.5-7.5-7.5s-7.5,3.358-7.5,7.5v28.943h-21.164c-2.203,0-4.293,0.968-5.719,2.647 c-1.425,1.679-2.04,3.9-1.681,6.073l5.192,31.474c0.598,3.622,3.729,6.279,7.4,6.279h15.971V112.9h-73.669 c-4.142,0-7.5,3.358-7.5,7.5s3.358,7.5,7.5,7.5h11.664l9.307,11.865c6.613,8.429,16.55,13.264,27.264,13.264 c9.771,0,18.888-4.032,25.434-11.134v37.008H84.745c-4.142,0-7.5,3.358-7.5,7.5s3.358,7.5,7.5,7.5h10.431l9.302,11.859 c6.613,8.431,16.551,13.266,27.265,13.266c10.715,0,20.653-4.835,27.266-13.266l5.653-7.208l5.658,7.213 c6.613,8.429,16.55,13.264,27.264,13.264c9.771,0,18.888-4.032,25.434-11.134V323.02h-25.712c-7.502,0-13.606-6.104-13.606-13.606 v-48.379c0-4.142-3.358-7.5-7.5-7.5H21.969c-4.142,0-7.5,3.358-7.5,7.5s3.358,7.5,7.5,7.5h10.434v15.734H21.969 c-4.142,0-7.5,3.358-7.5,7.5s3.358,7.5,7.5,7.5h10.434v31.251c0,4.142,3.358,7.5,7.5,7.5h26.752 c0.971,13.161,3.403,26.705,8.029,39.79h-8.054c-4.142,0-7.5,3.358-7.5,7.5v53.443c0,4.142,3.358,7.5,7.5,7.5h37.408 c2.934,0,5.599-1.711,6.819-4.378l4.323-9.445c24.844,17.914,61.427,29.624,114.616,29.624c90.31,0,164.135-72.01,167.293-161.72 l44.69-10.386C445.816,289.01,448.326,284.979,447.388,280.945z M210.694,51.443h39.649l-2.718,16.474h-34.214L210.694,51.443z M263.432,204.033c-6.076,0-11.711-2.742-15.462-7.522l-2.046-2.608h35.015l-2.046,2.608 C275.143,201.291,269.507,204.033,263.432,204.033z M344.743,196.515c-3.75,4.78-9.385,7.521-15.46,7.521 c-6.076,0-11.711-2.741-15.461-7.521l-2.05-2.612h35.021L344.743,196.515z M278.893,130.507c-3.75,4.78-9.385,7.522-15.461,7.522 c-6.076,0-11.712-2.741-15.462-7.521l-2.046-2.608h35.014L278.893,130.507z M197.584,138.028c-6.076,0-11.711-2.742-15.462-7.522 l-2.044-2.606h35.013l-2.044,2.606C209.296,135.287,203.66,138.028,197.584,138.028z M131.743,204.028 c-6.076,0-11.712-2.742-15.462-7.523l-2.041-2.602h35.007l-2.041,2.602C143.456,201.286,137.82,204.028,131.743,204.028z M197.584,204.032c-6.076,0-11.711-2.742-15.462-7.522l-2.045-2.607h35.014l-2.045,2.606 C209.296,201.29,203.66,204.032,197.584,204.032z M47.403,268.535H168.7v15.734H47.403V268.535z M99.224,431.253H74.132V392.81 h6.985c5.444,10.632,12.669,20.698,22.111,29.697L99.224,431.253z M229.798,447.054c-92.566,0-142.345-36.676-148.096-109.035 h71.783c4.142,0,7.5-3.358,7.5-7.5s-3.358-7.5-7.5-7.5H47.403v-23.751H168.7v10.145c0,15.773,12.833,28.606,28.606,28.606h97.992 c12.247,0,22.545-8.499,25.307-19.909l61.311-14.25C377.003,383.653,310.652,447.054,229.798,447.054z"></path>
        </g>
      </svg>
    </span>
    <span class="ferry-button-text">Ferry</span>
  `;
  button.onclick = async () => {
    const actionBar = findActionBar();
    const wrapper = document.getElementById(WRAPPER_ID);
    let panel = document.getElementById(PANEL_ID);
    if (!panel) { panel = createPanel(); wrapper.appendChild(panel); }
    const opening = panel.style.display === "none";
    panel.style.display = opening ? "flex" : "none";
    setButtonActiveState(opening);
    if (opening) {
      setPanelMode(panel, panel.dataset.ferryMode || "video");
      prefetchKey = window.location.href;
      prefetchState.loading = true;
      renderFormats(panel, [], true);
      const res = await safeSendMessage({ type: "PREFETCH_FORMATS", url: window.location.href, awaitResult: true });
      if (res?.snapshot) {
        const snapshot = res.snapshot;
        prefetchState.loading = snapshot.state === "loading";
        prefetchState.formats = Array.isArray(snapshot.formats) ? snapshot.formats : [];
        prefetchState.error = snapshot.state === "error" ? (snapshot.error || "Failed to load formats") : null;
        applyPrefetchStateToPanel(panel);
      }
    }
  };
  return button;
}

function inject() {
  if (!isWatchPage()) return;
  const bar = findActionBar();
  if (!bar || document.getElementById(BUTTON_ID)) return;
  ensureDropdownHostStyles(bar);
  const wrap = document.createElement("div"); wrap.id = WRAPPER_ID; wrap.className = "ferry-button-anchor";
  bar.prepend(wrap); wrap.appendChild(createButton());
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

ensureWsListener();
const observer = new MutationObserver(() => { if (isWatchPage()) inject(); });
observer.observe(document.documentElement, { childList: true, subtree: true });
inject();

// SPA navigation handling
window.addEventListener("yt-navigate-finish", inject);
window.addEventListener("yt-page-data-updated", inject);
