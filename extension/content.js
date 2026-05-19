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
let lastInjectedVideoId = "";
let lastKnownWatchUrl = window.location.href;
let historyHooksInstalled = false;

// ---------------------------------------------------------------------------
// YouTube Helpers
// ---------------------------------------------------------------------------

function isWatchPage() {
  try {
    const url = new URL(window.location.href);
    return url.hostname.includes("youtube.com") && (url.pathname === "/watch" || url.pathname.startsWith("/shorts/"));
  } catch { return false; }
}

function isShortsPage() {
  try {
    const url = new URL(window.location.href);
    return url.hostname.includes("youtube.com") && url.pathname.startsWith("/shorts/");
  } catch { return false; }
}

function getVideoContext() {
  const url = new URL(window.location.href);
  let videoId = new URLSearchParams(url.search).get("v");
  if (!videoId && url.pathname.startsWith("/shorts/")) {
    videoId = url.pathname.split("/shorts/")[1].split("/")[0].split("?")[0];
  }
  let pageThumbnail = null;
  if (videoId) {
    pageThumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  } else {
    pageThumbnail =
      document.querySelector('meta[property="og:image"]')?.getAttribute("content") ||
      document.querySelector('link[itemprop="thumbnailUrl"]')?.getAttribute("href") ||
      document.querySelector('meta[name="twitter:image"]')?.getAttribute("content");
  }
  return {
    url: window.location.href,
    videoId: videoId,
    title: document.querySelector("h1.ytd-watch-metadata")?.textContent?.trim() || document.querySelector("ytd-reel-video-renderer[is-active] h2.title")?.textContent?.trim() || document.title,
    thumbnailUrl: pageThumbnail,
  };
}

function getWatchPageKey() {
  if (!isWatchPage()) return "";
  const context = getVideoContext();
  return context.videoId || context.url;
}

function isElementVisible(node) {
  if (!(node instanceof Element)) return false;
  const style = window.getComputedStyle(node);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getVisibleElements(selectors, root = document) {
  return selectors
    .flatMap((selector) => Array.from(root.querySelectorAll(selector)))
    .filter((node) => node?.isConnected && isElementVisible(node));
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
  console.log("[Ferry Content] setProgress called:", progress, speed, eta);
  const box = panel.querySelector("#ferry-progress-box");
  const text = panel.querySelector("#ferry-progress-text");
  const dlBtn = panel.querySelector('[data-ferry="download-btn"]');

  if (!box || !text) return;

  const value = Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0;
  
  if (value >= 100) {
    box.style.display = "flex";
    text.textContent = "Downloaded!";
    text.style.color = "";
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
  panel.querySelectorAll(".ferry-quality-trigger, .ferry-quality-option").forEach((item) => {
    item.disabled = Boolean(disabled);
    item.classList.toggle("is-disabled", Boolean(disabled));
  });
}

// ---------------------------------------------------------------------------
// Format Handling
// ---------------------------------------------------------------------------

function buildFormatOptionLabel(format, mode) {
  return getFormatPresentation(format, mode).title;
}

function getAudioBitrateText(format) {
  const source = [format?.quality, format?.label, format?.note].find((value) => typeof value === "string") || "";
  const match = source.match(/(\d+)\s*kbps/i);
  return match ? `${match[1]} kbps` : "";
}

function getThumbnailDimensionText(format) {
  if (format?.width && format?.height) {
    return `${format.width} × ${format.height}`;
  }
  if (typeof format?.quality === "string" && /\d+x\d+/i.test(format.quality)) {
    return format.quality.replace(/x/i, " × ");
  }
  return "";
}

function getFormatPresentation(format, mode) {
  const ext = (format?.format || (mode === "audio" ? "mp3" : mode === "thumbnail" ? "jpg" : "mp4")).toUpperCase();
  const sizeText = formatBytes(format?.filesize);

  if (mode === "audio") {
    const bitrate = getAudioBitrateText(format) || "Audio";
    return {
      title: [ext, bitrate, sizeText].filter(Boolean).join(" · "),
      meta: "",
    };
  }

  if (mode === "thumbnail") {
    const dimensions = getThumbnailDimensionText(format) || format?.label || "Best thumbnail";
    return {
      title: [ext, dimensions, sizeText].filter(Boolean).join(" · "),
      meta: "",
    };
  }

  const quality = format?.height ? `${format.height}p` : (format?.label || "Best available");
  return {
    title: [ext, quality, sizeText].filter(Boolean).join(" · "),
    meta: "",
  };
}

function getFormatOptionKey(format) {
  if (!format) return "";
  return [
    format.media_type || "",
    format.format_id || "",
    format.format || "",
    format.quality || "",
    format.height || "",
    format.width || "",
    format.filesize || "",
  ].join("|");
}

function getModeFormats(formats, mode) {
  const filtered = formats.filter((f) => {
    const type = (f.media_type || "").toLowerCase();
    const fmt = (f.format || "").toLowerCase();
    if (mode === "audio") return type === "audio" || fmt === "mp3" || f.quality === "audio";
    if (mode === "thumbnail") return type === "thumbnail" || fmt === "jpg" || fmt === "png" || type.includes("thumb");
    return type === "video" || (!type && fmt !== "mp3" && fmt !== "jpg");
  });

  if (mode === "thumbnail" && !filtered.length) {
    return [{ label: "Best JPG", quality: "best", format: "jpg" }];
  }

  return filtered;
}

function areSameFormatOption(left, right) {
  if (!left || !right) return false;
  return (
    (left.format_id && right.format_id && left.format_id === right.format_id) ||
    (left.media_type === right.media_type &&
      left.format === right.format &&
      left.quality === right.quality &&
      left.height === right.height &&
      left.width === right.width)
  );
}

function closeQualityMenus(panel, exceptMode = null) {
  panel.querySelectorAll("[data-ferry-quality-dropdown]").forEach((dropdown) => {
    const mode = dropdown.dataset.ferryQualityDropdown;
    const menu = dropdown.querySelector(".ferry-quality-menu");
    const trigger = dropdown.querySelector(".ferry-quality-trigger");
    const keepOpen = Boolean(exceptMode && mode === exceptMode);
    if (!keepOpen && menu) menu.hidden = true;
    if (trigger) trigger.setAttribute("aria-expanded", keepOpen && menu ? String(!menu.hidden) : "false");
  });
}

function setSelectedQuality(panel, mode, format) {
  if (!prefetchState.selectedFormats) prefetchState.selectedFormats = {};
  prefetchState.selectedFormats[mode] = format;

  const dropdown = panel.querySelector(`[data-ferry-quality-dropdown="${mode}"]`);
  if (!dropdown) return;

  const triggerTitle = dropdown.querySelector("[data-ferry-quality-trigger-title]");
  const triggerMeta = dropdown.querySelector("[data-ferry-quality-trigger-meta]");
  const presentation = getFormatPresentation(format, mode);

  if (triggerTitle) triggerTitle.textContent = presentation.title;
  if (triggerMeta) triggerMeta.textContent = presentation.meta;

  const selectedKey = getFormatOptionKey(format);
  dropdown.querySelectorAll(".ferry-quality-option").forEach((option) => {
    option.classList.toggle("is-selected", option.dataset.ferryOptionKey === selectedKey);
  });

  updateDownloadButtonLabel(panel);
}

function renderQualityDropdown(panel, mode, formats, loading = false) {
  const dropdown = panel.querySelector(`[data-ferry-quality-dropdown="${mode}"]`);
  if (!dropdown) return;

  const trigger = dropdown.querySelector(".ferry-quality-trigger");
  const triggerTitle = dropdown.querySelector("[data-ferry-quality-trigger-title]");
  const triggerMeta = dropdown.querySelector("[data-ferry-quality-trigger-meta]");
  const menu = dropdown.querySelector(".ferry-quality-menu");

  if (!trigger || !triggerTitle || !triggerMeta || !menu) return;

  menu.innerHTML = "";
  menu.hidden = true;
  trigger.setAttribute("aria-expanded", "false");

  if (loading) {
    trigger.disabled = true;
    triggerTitle.textContent = "Loading…";
    triggerMeta.textContent = "";
    return;
  }

  const displayFormats = getModeFormats(formats, mode);
  if (!displayFormats.length) {
    trigger.disabled = true;
    triggerTitle.textContent = mode === "thumbnail" ? "No thumbnails" : `No ${mode} formats`;
    triggerMeta.textContent = "";
    return;
  }

  trigger.disabled = false;
  trigger.onclick = (event) => {
    event.stopPropagation();
    const willOpen = menu.hidden;
    closeQualityMenus(panel, willOpen ? mode : null);
    menu.hidden = !willOpen;
    trigger.setAttribute("aria-expanded", willOpen ? "true" : "false");
  };
  const previousFormat = prefetchState.selectedFormats?.[mode];
  const selectedFormat = displayFormats.find((format) => areSameFormatOption(format, previousFormat)) || displayFormats[0];

  displayFormats.forEach((format) => {
    const presentation = getFormatPresentation(format, mode);
    const option = document.createElement("button");
    option.type = "button";
    option.className = "ferry-quality-option";
    option.dataset.ferryOptionKey = getFormatOptionKey(format);
    option.innerHTML = `
      <span class="ferry-quality-option-copy">
        <span class="ferry-quality-option-title">${escapeHtml(presentation.title)}</span>
      </span>
      <span class="ferry-quality-option-check" aria-hidden="true">●</span>
    `;
    option.addEventListener("click", () => {
      setSelectedQuality(panel, mode, format);
      closeQualityMenus(panel);
    });
    menu.appendChild(option);
  });

  setSelectedQuality(panel, mode, selectedFormat);
}

function applyPrefetchStateToPanel(panel) {
  if (prefetchState.loading) {
    setFormatInteractionDisabled(panel, true);
    setStatus(panel, "", true, false);
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
  const context = getVideoContext();
  const thumbPreview = panel.querySelector("[data-ferry=thumbnail-preview]");
  if (thumbPreview && context.thumbnailUrl) {
    thumbPreview.src = context.thumbnailUrl;
  }

  ["video", "audio", "thumbnail"].forEach((mode) => {
    renderQualityDropdown(panel, mode, formats, loading);
  });
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

  const iconUrl = getExtensionAssetUrl("icons/extentionIcon.png");

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
      <div class="ferry-quality-dropdown" data-ferry-quality-dropdown="video">
        <button type="button" class="ferry-quality-trigger" aria-expanded="false">
          <span class="ferry-quality-trigger-copy">
            <span class="ferry-quality-trigger-title" data-ferry-quality-trigger-title>Select quality</span>
            <span class="ferry-quality-trigger-meta" data-ferry-quality-trigger-meta></span>
          </span>
          <span class="ferry-quality-trigger-chevron" aria-hidden="true">⌄</span>
        </button>
        <div class="ferry-quality-menu" hidden></div>
      </div>
      
      <details class="ferry-clip-details" style="margin-top: 8px;">
        <summary class="ferry-clip-toggle">
          <span class="ferry-clip-toggle-main">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>
            <span class="ferry-clip-toggle-label">Configure Clip</span>
          </span>
          <span class="ferry-clip-toggle-chevron" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          </span>
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
        <div class="ferry-clip-track-shell">
          <div class="ferry-clip-track" data-ferry="video-clip-track">
            <div class="ferry-clip-fill" data-ferry="video-clip-fill"></div>
            <button type="button" class="ferry-clip-thumb" data-ferry="video-clip-start-thumb"></button>
            <button type="button" class="ferry-clip-thumb" data-ferry="video-clip-end-thumb"></button>
          </div>
        </div>
      </details>
    </section>

    <section class="ferry-mode-section" data-ferry-section="audio" hidden>
      <div class="ferry-section-label">Bitrate</div>
      <div class="ferry-quality-dropdown" data-ferry-quality-dropdown="audio">
        <button type="button" class="ferry-quality-trigger" aria-expanded="false">
          <span class="ferry-quality-trigger-copy">
            <span class="ferry-quality-trigger-title" data-ferry-quality-trigger-title>Select bitrate</span>
            <span class="ferry-quality-trigger-meta" data-ferry-quality-trigger-meta></span>
          </span>
          <span class="ferry-quality-trigger-chevron" aria-hidden="true">⌄</span>
        </button>
        <div class="ferry-quality-menu" hidden></div>
      </div>
      
      <details class="ferry-clip-details" style="margin-top: 8px;">
        <summary class="ferry-clip-toggle">
          <span class="ferry-clip-toggle-main">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>
            <span class="ferry-clip-toggle-label">Configure Clip</span>
          </span>
          <span class="ferry-clip-toggle-chevron" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          </span>
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
        <div class="ferry-clip-track-shell">
          <div class="ferry-clip-track" data-ferry="audio-clip-track">
            <div class="ferry-clip-fill" data-ferry="audio-clip-fill"></div>
            <button type="button" class="ferry-clip-thumb" data-ferry="audio-clip-start-thumb"></button>
            <button type="button" class="ferry-clip-thumb" data-ferry="audio-clip-end-thumb"></button>
          </div>
        </div>
      </details>
    </section>

    <section class="ferry-mode-section" data-ferry-section="thumbnail" hidden>
      <div class="ferry-section-label">Thumbnail Preview</div>
      <div class="ferry-thumbnail-preview-container" style="background: var(--f-surface2); border-radius: 8px; overflow: hidden; aspect-ratio: 16/9; margin-bottom: 8px; border: 0.5px solid var(--f-border2);">
        <img data-ferry="thumbnail-preview" src="" alt="" style="width: 100%; height: 100%; object-fit: cover;" />
      </div>
      <div class="ferry-section-label">Quality</div>
      <div class="ferry-quality-dropdown" data-ferry-quality-dropdown="thumbnail">
        <button type="button" class="ferry-quality-trigger" aria-expanded="false">
          <span class="ferry-quality-trigger-copy">
            <span class="ferry-quality-trigger-title" data-ferry-quality-trigger-title>Select thumbnail</span>
            <span class="ferry-quality-trigger-meta" data-ferry-quality-trigger-meta></span>
          </span>
          <span class="ferry-quality-trigger-chevron" aria-hidden="true">⌄</span>
        </button>
        <div class="ferry-quality-menu" hidden></div>
      </div>
    </section>

    <div class="ferry-progress-box" id="ferry-progress-box" style="display: none;">
      <div class="ferry-progress-status">
        <span id="ferry-progress-text"></span>
      </div>
    </div>

    <button type="button" class="ferry-dl-btn" data-ferry="download-btn">Download</button>
  `;

  panel.querySelector('[data-ferry="close"]').onclick = () => {
    closeQualityMenus(panel);
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
    if (e.key === "Escape") {
      closeQualityMenus(panel);
      panel.querySelector('[data-ferry="close"]').click();
    }
    else if (e.key === "Enter") dlBtn.click();
    else if (["1", "2", "3", "4"].includes(e.key)) {
      const idx = parseInt(e.key) - 1;
      const menu = panel.querySelector(`[data-ferry-quality-dropdown="${panel.dataset.ferryMode}"] .ferry-quality-menu`);
      const options = menu ? Array.from(menu.querySelectorAll(".ferry-quality-option")) : [];
      if (options[idx]) {
        options[idx].click();
      }
    }
  });

  document.addEventListener("click", (event) => {
    if (!panel.contains(event.target)) {
      closeQualityMenus(panel);
    }
  });

  return panel;
}

function setPanelMode(panel, mode) {
  const nextMode = ["video", "audio", "thumbnail"].includes(mode) ? mode : "video";
  closeQualityMenus(panel);
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
    const presentation = getFormatPresentation(format || {}, mode);
    
    await safeSendMessage({
      type: "TRACK_JOB",
      jobId: activeJobId,
      title: payload.title || "Video",
      meta: {
        mediaType: mode,
        qualityLabel: presentation.title || "Best",
        formatLabel: payload.format.toUpperCase(),
        sourceThumbnailUrl: context.thumbnailUrl || "",
        sourceUrl: context.url || payload.url || "",
        sourceVideoId: context.videoId || "",
        sourceKind: isShortsPage() ? "short" : "long",
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
  if (!globalThis.chrome?.runtime?.onMessage) return;
  try {
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
  } catch (e) {
    console.warn("[Ferry Content] Failed to bind message listener:", e);
  }
}

// ---------------------------------------------------------------------------
// Injection Logic
// ---------------------------------------------------------------------------

function ensureDropdownHostStyles(actionBar) {
  const nodes = [
    actionBar,
    actionBar?.parentElement,
    actionBar?.closest("#menu"),
    actionBar?.closest("#actions"),
    actionBar?.closest("#actions-inner"),
    actionBar?.closest("ytd-watch-metadata"),
    actionBar?.closest("ytd-reel-video-renderer"),
    actionBar?.closest("ytd-shorts"),
  ].filter(Boolean);
  for (const node of nodes) { if (node instanceof HTMLElement) node.style.overflow = "visible"; }
}

function setButtonActiveState(active) {
  const button = document.getElementById(BUTTON_ID);
  if (!button) return;
  button.classList.toggle("is-active", Boolean(active));
  button.setAttribute("aria-pressed", active ? "true" : "false");
}

function findActiveShortsRenderer() {
  const selectors = [
    "ytd-reel-video-renderer[is-active]",
    "ytd-reel-video-renderer[active]",
    "ytd-reel-video-renderer",
  ];
  const visibleRenderers = getVisibleElements(selectors);
  if (!visibleRenderers.length) return null;

  const viewportCenter = window.innerHeight / 2;
  return visibleRenderers
    .map((node) => {
      const rect = node.getBoundingClientRect();
      const center = rect.top + rect.height / 2;
      return { node, distance: Math.abs(center - viewportCenter) };
    })
    .sort((left, right) => left.distance - right.distance)[0]?.node || null;
}

function findShortsActionBar() {
  const renderer = findActiveShortsRenderer();
  if (!renderer) return null;

  const selectors = [
    ".ytReelPlayerOverlayViewModelActionsContainer",
    ".reel-player-overlay-actions",
    "ytd-reel-player-overlay-renderer #actions",
    "ytd-reel-player-overlay-renderer [id='actions']",
  ];
  const container = getVisibleElements(selectors, renderer)[0];
  if (!container) return null;

  const directChildren = Array.from(container.children).filter((child) => {
    if (!isElementVisible(child) || child.id === WRAPPER_ID) return false;
    const rect = child.getBoundingClientRect();
    return rect.width >= 40 && rect.height >= 120;
  });

  const verticalChild = directChildren
    .map((child) => {
      const rect = child.getBoundingClientRect();
      const style = window.getComputedStyle(child);
      const score =
        (style.display.includes("flex") ? 40 : 0) +
        (style.flexDirection.includes("column") ? 80 : 0) +
        (rect.height > rect.width * 2 ? 60 : 0) +
        rect.left / 1000;
      return { child, score };
    })
    .sort((left, right) => right.score - left.score)[0]?.child;

  return verticalChild || container;
}

function getFlexOrder(node) {
  const value = Number.parseInt(window.getComputedStyle(node).order || "0", 10);
  return Number.isFinite(value) ? value : 0;
}

function getActionRailChildText(node) {
  return [
    node.getAttribute("aria-label"),
    node.getAttribute("title"),
    node.textContent,
    ...Array.from(node.querySelectorAll("[aria-label], [title]")).map((child) => `${child.getAttribute("aria-label") || ""} ${child.getAttribute("title") || ""}`),
  ].join(" ").toLowerCase();
}

function findShortsLikeRailChild(actionBar) {
  if (!actionBar) return null;
  return Array.from(actionBar.children).find((child) => {
    if (child.id === WRAPPER_ID || !isElementVisible(child)) return false;
    const text = getActionRailChildText(child);
    return text.includes("like") && !text.includes("dislike");
  }) || null;
}

function placeShortsButtonInRail(wrapper, actionBar) {
  if (!wrapper || !actionBar) return false;
  const flexDirection = window.getComputedStyle(actionBar).flexDirection || "column";
  const isReverse = flexDirection.includes("reverse");
  const likeChild = findShortsLikeRailChild(actionBar);

  wrapper.style.left = "";
  wrapper.style.top = "";
  wrapper.style.order = likeChild
    ? String(getFlexOrder(likeChild) + (isReverse ? 1 : -1))
    : "";
  return true;
}

function findActionBar() {
  if (isShortsPage()) {
    return findShortsActionBar();
  }

  // Regular Watch Page selectors
  const selectors = [
    "#top-level-buttons-computed",
    "#menu #top-level-buttons-computed",
    "ytd-watch-metadata #top-level-buttons-computed",
    "#actions #top-level-buttons-computed",
    "ytd-menu-renderer #top-level-buttons-computed",
    "#actions-inner #top-level-buttons-computed",
    "ytd-watch-metadata #actions-inner",
    "#actions-inner",
    "ytd-watch-metadata #menu",
    "#menu",
    "ytd-watch-metadata #actions",
    "#actions",
  ];
  for (const s of selectors) {
    const nodes = Array.from(document.querySelectorAll(s));
    const visibleNode = nodes.find((node) => node?.isConnected && isElementVisible(node));
    if (visibleNode && isWatchPage()) return visibleNode;
    const fallbackNode = nodes.find((node) => node?.isConnected);
    if (fallbackNode && isWatchPage()) return fallbackNode;
  }
  return null;
}

function teardownInjectedUi() {
  const panel = document.getElementById(PANEL_ID);
  if (panel) panel.remove();

  const wrapper = document.getElementById(WRAPPER_ID);
  if (wrapper) wrapper.remove();

  const button = document.getElementById(BUTTON_ID);
  if (button) button.remove();

  setButtonActiveState(false);
  stopStatusPolling();
  activeJobId = null;
  lastInjectedVideoId = "";
}

function hasInjectedButton() {
  return Boolean(document.getElementById(BUTTON_ID));
}

function shouldReattachButton(bar) {
  const wrapper = document.getElementById(WRAPPER_ID);
  const button = document.getElementById(BUTTON_ID);
  if (!wrapper || !button) return true;
  if (!wrapper.isConnected || !button.isConnected) return true;
  if (isShortsPage()) {
    if (wrapper.parentElement !== bar) return true;
    placeShortsButtonInRail(wrapper, bar);
    return !isElementVisible(button);
  }
  if (wrapper.parentElement !== bar) return true;
  if (!isElementVisible(bar) || !isElementVisible(wrapper) || !isElementVisible(button)) return true;
  return false;
}

function shouldInjectButton() {
  if (!isWatchPage()) return false;
  const bar = findActionBar();
  if (!bar) return false;
  if (!hasInjectedButton()) return true;
  return shouldReattachButton(bar);
}

function createButton() {
  const isShorts = isShortsPage();
  const button = document.createElement("button");
  button.id = BUTTON_ID; button.className = "ferry-injected-button" + (isShorts ? " is-shorts" : "");
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
    ${!isShorts ? '<span class="ferry-button-text">Ferry</span>' : ''}
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
      safeSendMessage({ type: "ENSURE_WS" }).catch(() => {});
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
  if (!isWatchPage()) return false;
  const bar = findActionBar();
  if (!bar) return false;
  const isShorts = isShortsPage();

  const context = getVideoContext();
  const currentVideoId = context.videoId || window.location.href;
  if (lastInjectedVideoId && lastInjectedVideoId !== currentVideoId) {
    teardownInjectedUi();
  }

  if (hasInjectedButton() && shouldReattachButton(bar)) {
    teardownInjectedUi();
  }

  const existingWrapper = document.getElementById(WRAPPER_ID);
  if (isShorts && document.getElementById(BUTTON_ID) && existingWrapper) {
    placeShortsButtonInRail(existingWrapper, bar);
    return true;
  }
  if (document.getElementById(BUTTON_ID) && existingWrapper?.parentElement === bar) return true;
  ensureDropdownHostStyles(bar);
  const wrap = document.createElement("div");
  wrap.id = WRAPPER_ID;
  wrap.className = "ferry-button-anchor" + (isShorts ? " is-shorts" : "");

  if (isShorts) {
    bar.prepend(wrap);
    placeShortsButtonInRail(wrap, bar);
  } else {
    bar.prepend(wrap);
  }

  wrap.appendChild(createButton());
  lastInjectedVideoId = currentVideoId;
  return true;
}

function stopInjectionLoop() {
  if (injectTimer) {
    clearTimeout(injectTimer);
    injectTimer = null;
  }
  if (injectionWatchdogTimer) {
    clearTimeout(injectionWatchdogTimer);
    injectionWatchdogTimer = null;
  }
  injectionLoopActive = false;
  injectionWatchdogTicks = 0;
}

function runInjectionLoop() {
  if (!isWatchPage()) {
    stopInjectionLoop();
    teardownInjectedUi();
    return;
  }

  if (inject()) {
    stopInjectionLoop();
    return;
  }

  injectionWatchdogTicks += 1;
  if (injectionWatchdogTicks >= MAX_INJECTION_FRAMES) {
    stopInjectionLoop();
    return;
  }

  injectionWatchdogTimer = setTimeout(runInjectionLoop, 100);
}

function scheduleInject() {
  if (injectTimer) clearTimeout(injectTimer);
  injectTimer = setTimeout(() => {
    injectTimer = null;
    const hasHealthyButton = !shouldInjectButton() && lastInjectedVideoId === getWatchPageKey();
    if (hasHealthyButton) return;
    if (injectionLoopActive) return;
    injectionLoopActive = true;
    injectionWatchdogTicks = 0;
    runInjectionLoop();
  }, INJECT_DEBOUNCE_MS);
}

function handlePageStateChange() {
  const currentUrl = window.location.href;
  const currentWatchKey = getWatchPageKey();
  const navigated = currentUrl !== lastKnownWatchUrl;
  if (navigated) {
    lastKnownWatchUrl = currentUrl;
  }

  if (!isWatchPage()) {
    if (hasInjectedButton() || document.getElementById(PANEL_ID)) {
      stopInjectionLoop();
      teardownInjectedUi();
    }
    return;
  }

  if (navigated && lastInjectedVideoId && lastInjectedVideoId !== currentWatchKey) {
    stopInjectionLoop();
    teardownInjectedUi();
  }

  scheduleInject();
}

function installHistoryHooks() {
  if (historyHooksInstalled) return;
  historyHooksInstalled = true;

  const wrapHistoryMethod = (methodName) => {
    const original = window.history?.[methodName];
    if (typeof original !== "function") return;
    window.history[methodName] = function wrappedHistoryMethod(...args) {
      const result = original.apply(this, args);
      setTimeout(handlePageStateChange, 0);
      return result;
    };
  };

  wrapHistoryMethod("pushState");
  wrapHistoryMethod("replaceState");
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

ensureWsListener();
installHistoryHooks();
const observer = new MutationObserver(() => {
  handlePageStateChange();
});
observer.observe(document.documentElement, { childList: true, subtree: true });
handlePageStateChange();

// SPA navigation handling
window.addEventListener("yt-navigate-start", () => {
  stopInjectionLoop();
  teardownInjectedUi();
});
window.addEventListener("yt-navigate-finish", handlePageStateChange);
window.addEventListener("yt-page-data-updated", handlePageStateChange);
window.addEventListener("popstate", handlePageStateChange);
window.addEventListener("pageshow", handlePageStateChange);
window.addEventListener("load", handlePageStateChange);
document.addEventListener("readystatechange", handlePageStateChange);

setInterval(handlePageStateChange, 1000);
