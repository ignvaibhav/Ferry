/**
 * Ferry content script — Injects a download button and panel on YouTube watch pages.
 *
 * This is the primary user-facing interface. The popup is a fallback path.
 * Styles are loaded from content.css via manifest.json.
 *
 * NOTE: Content scripts cannot use ES module imports in MV3.
 * API and runtime helpers are inlined here. Shared modules (api.js, runtime.js,
 * constants.js) are used by background.js and popup.js which run as modules.
 */

// ---------------------------------------------------------------------------
// Constants (inlined — content scripts can't import modules)
// ---------------------------------------------------------------------------

const API_BASE = "http://127.0.0.1:49152";
const BUTTON_ID = "ferry-injected-button";
const PANEL_ID = "ferry-inline-panel";
const WRAPPER_ID = "ferry-button-anchor";
const INJECT_DEBOUNCE_MS = 200;
const MAX_INJECTION_FRAMES = 180;
const PREFETCH_DEBOUNCE_MS = 900;

// ---------------------------------------------------------------------------
// Runtime helpers (inlined)
// ---------------------------------------------------------------------------

function runtimeAvailable() {
  return Boolean(globalThis.chrome?.runtime?.id);
}

function getExtensionAssetUrl(path) {
  const runtime = globalThis.chrome?.runtime;
  if (!runtime || typeof runtime.getURL !== "function") return path;
  try {
    return runtime.getURL(path);
  } catch {
    return path;
  }
}

async function safeSendMessage(message) {
  const runtime = globalThis.chrome?.runtime;
  if (!runtimeAvailable() || typeof runtime?.sendMessage !== "function") return null;
  try {
    return await runtime.sendMessage(message);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// API helpers (inlined)
// ---------------------------------------------------------------------------

async function queueDownload(payload) {
  const res = await fetch(`${API_BASE}/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.error || `download failed (${res.status})`);
  }
  return res.json();
}

async function fetchJobStatus(jobId) {
  const res = await fetch(`${API_BASE}/status/${encodeURIComponent(jobId)}`);
  if (!res.ok) throw new Error(`status failed (${res.status})`);
  return res.json();
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let activeJobId = null;
let wsBound = false;
let prefetchKey = "";
let prefetchState = { loading: false, formats: [], error: null };
let injectTimer = null;
let statusPollTimer = null;
let injectionWatchdogTimer = null;
let injectionWatchdogTicks = 0;
let buttonAnimationTimer = null;
let injectionLoopActive = false;
let prefetchTimer = null;

// ---------------------------------------------------------------------------
// YouTube page detection
// ---------------------------------------------------------------------------

function isWatchPage() {
  try {
    const url = new URL(window.location.href);
    return url.hostname.includes("youtube.com") && url.pathname === "/watch";
  } catch {
    return false;
  }
}

function getVideoContext() {
  const url = window.location.href;
  const titleEl =
    document.querySelector("h1.ytd-watch-metadata yt-formatted-string") ||
    document.querySelector("h1.title");
  const title = titleEl?.textContent?.trim() || document.title.replace(" - YouTube", "");
  const videoId = extractYouTubeVideoId(url);
  return {
    url,
    title,
    videoId,
    thumbnailUrl: getThumbnailUrlForVideoId(videoId),
  };
}

function getVideoIdFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl || window.location.href);
    if (parsed.pathname !== "/watch") return "";
    return parsed.searchParams.get("v") || "";
  } catch {
    return "";
  }
}

function getPrefetchKey(rawUrl) {
  const id = getVideoIdFromUrl(rawUrl);
  return id || rawUrl || "";
}

function snapshotToPrefetchState(snapshot) {
  return {
    loading: snapshot?.state === "loading",
    formats: Array.isArray(snapshot?.formats) ? snapshot.formats : [],
    error: snapshot?.state === "error" ? snapshot.error || "Failed to load formats" : null,
  };
}

function setPrefetchStateFromSnapshot(snapshot) {
  prefetchKey = snapshot?.key || "";
  prefetchState = snapshotToPrefetchState(snapshot);
}

// ---------------------------------------------------------------------------
// Progress / status display
// ---------------------------------------------------------------------------

function setStatus(panel, text, ok = true, show = true) {
  const box = panel.querySelector("[data-ferry=progress-box]");
  const textEl = panel.querySelector("[data-ferry=progress-text]");
  if (!box || !textEl) return;
  
  if (!show) {
    box.style.display = "none";
    return;
  }
  
  box.style.display = "block";
  textEl.textContent = ok ? text : `Error: ${text}`;
  if (!ok) {
    textEl.style.color = "#ff8989";
  } else {
    textEl.style.color = "";
  }
}

function setProgress(panel, progress, speed, eta) {
  const box = panel.querySelector("[data-ferry=progress-box]");
  const text = panel.querySelector("[data-ferry=progress-text]");
  if (!box || !text) return;

  box.style.display = "block";
  const value = Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0;
  const parts = value > 0 ? [`Queue… ${value}%`] : ["Queue…"];
  if (speed) parts.push(speed);
  if (eta) parts.push(`ETA ${eta}`);
  text.textContent = parts.join(" • ");
}

function resetProgressBox(panel) {
  const box = panel.querySelector("[data-ferry=progress-box]");
  const text = panel.querySelector("[data-ferry=progress-text]");
  if (!box || !text) return;
  box.style.display = "none";
  text.textContent = "Queue…";
}

function setFormatInteractionDisabled(panel, disabled) {
  panel.querySelectorAll("[data-ferry=download-video-btn], [data-ferry=download-audio-btn], [data-ferry=download-thumbnail-btn]")
    .forEach((button) => {
      button.disabled = Boolean(disabled);
    });
}

// ---------------------------------------------------------------------------
// Status polling (fallback when WS misses events)
// ---------------------------------------------------------------------------

function stopStatusPolling() {
  if (statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
}

function startStatusPolling(panel, jobId) {
  stopStatusPolling();
  if (!jobId) return;
  const downloadBtn = panel.querySelector("[data-ferry=download-btn]");

  statusPollTimer = setInterval(async () => {
    try {
      const status = await fetchJobStatus(jobId);
      if (status?.status === "in_progress") {
        setProgress(panel, status.progress ?? 0, null, null);
        return;
      }
      if (status?.status === "done") {
        setProgress(panel, 100, null, null);
        const fileName = status.output_path ? status.output_path.split(/[\\/]/).pop() : null;
        setStatus(panel, fileName ? `Done ✓ ${fileName}` : "Done ✓ Saved to Downloads", true, true);
        if (downloadBtn) downloadBtn.disabled = false;
        stopStatusPolling();
        return;
      }
      if (status?.status === "error") {
        setStatus(panel, status.message || "Download failed", false, true);
        if (downloadBtn) downloadBtn.disabled = false;
        stopStatusPolling();
      }
    } catch {
      if (downloadBtn) downloadBtn.disabled = false;
      stopStatusPolling();
    }
  }, 2000);
}

// ---------------------------------------------------------------------------
// Prefetch video data
// ---------------------------------------------------------------------------

function applyPrefetchStateToPanel(panel) {
  syncThumbnailPreview(panel);

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
  setStatus(panel, "", true, false); // Hide status if ok

  const formats = prefetchState.formats || [];
  renderFormats(panel, formats, false);

  if (!formats.length) {
    setStatus(panel, "No downloadable formats found for this video", false, true);
  }
}

async function requestFormatsPrefetch(url, awaitResult = false) {
  if (!url) return null;
  const response = await safeSendMessage({
    type: "PREFETCH_FORMATS",
    url,
    awaitResult,
  });
  if (!response?.snapshot) return null;
  return response.snapshot;
}

async function refreshPrefetchState(url, awaitResult = false) {
  const snapshot = await requestFormatsPrefetch(url, awaitResult);
  if (!snapshot) return null;
  const currentKey = getPrefetchKey(window.location.href);
  if (snapshot.key && snapshot.key === currentKey) {
    setPrefetchStateFromSnapshot(snapshot);
  }
  return snapshot;
}

function scheduleVideoPrefetch(url = window.location.href) {
  const key = getPrefetchKey(url);
  if (!key) return;

  if (prefetchTimer) {
    clearTimeout(prefetchTimer);
    prefetchTimer = null;
  }

  prefetchTimer = setTimeout(() => {
    prefetchTimer = null;
    void refreshPrefetchState(url, true);
  }, PREFETCH_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// Clip slider
// ---------------------------------------------------------------------------

function secondsToTimestamp(rawSeconds) {
  const total = Math.max(0, Math.floor(rawSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getPlayerDurationSeconds() {
  const playerVideo = document.querySelector("video");
  const duration = Number(playerVideo?.duration || 0);
  return Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : 0;
}

function clipPayload(panel) {
  const mode = panel.dataset.ferryMode || "video";
  const clipKey = mode === "audio" ? "audio" : "video";
  if (panel.dataset[`${clipKey}ClipTouched`] !== "1") return null;
  const startSeconds = Number(panel.dataset[`${clipKey}ClipStartSeconds`] || 0);
  const endSeconds = Number(panel.dataset[`${clipKey}ClipEndSeconds`] || 0);
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
    return null;
  }
  return { start: secondsToTimestamp(startSeconds), end: secondsToTimestamp(endSeconds) };
}

function syncClipSliders(panel) {
  setupClipSlider(panel, "video");
  setupClipSlider(panel, "audio");
}

function bindClipDurationSync(panel) {
  const video = document.querySelector("video");
  if (!video) return;

  const previousVideo = panel._ferryClipVideoEl;
  const previousHandler = panel._ferryClipDurationHandler;
  if (previousVideo && previousHandler && previousVideo !== video) {
    previousVideo.removeEventListener("loadedmetadata", previousHandler);
    previousVideo.removeEventListener("durationchange", previousHandler);
    previousVideo.removeEventListener("loadeddata", previousHandler);
  }

  if (previousVideo === video && previousHandler) return;

  const handler = () => syncClipSliders(panel);
  video.addEventListener("loadedmetadata", handler);
  video.addEventListener("durationchange", handler);
  video.addEventListener("loadeddata", handler);
  panel._ferryClipVideoEl = video;
  panel._ferryClipDurationHandler = handler;
}

function extractYouTubeVideoId(url = window.location.href) {
  try {
    const parsed = new URL(url);
    const directId = parsed.searchParams.get("v");
    if (directId) return directId;
    const shortMatch = parsed.pathname.match(/^\/shorts\/([^/?]+)/);
    if (shortMatch?.[1]) return shortMatch[1];
    return null;
  } catch {
    return null;
  }
}

function getThumbnailUrlForVideoId(videoId) {
  if (!videoId) return "";
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

function syncThumbnailPreview(panel, url = window.location.href) {
  const thumbPreview = panel?.querySelector("[data-ferry=thumbnail-preview]");
  if (!thumbPreview) return;

  const videoId = extractYouTubeVideoId(url);
  if (!videoId) {
    thumbPreview.removeAttribute("src");
    return;
  }

  const maxRes = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
  const hq = getThumbnailUrlForVideoId(videoId);

  if (thumbPreview.dataset.ferryVideoId === videoId && thumbPreview.src) return;

  thumbPreview.dataset.ferryVideoId = videoId;
  thumbPreview.onerror = () => {
    if (thumbPreview.src !== hq) {
      thumbPreview.src = hq;
      return;
    }
    thumbPreview.onerror = null;
  };
  thumbPreview.src = maxRes;
}

function setupClipSlider(panel, mode) {
  const box = panel.querySelector(`[data-ferry=${mode}-clip-slider-box]`);
  const track = panel.querySelector(`[data-ferry=${mode}-clip-track]`);
  const fill = panel.querySelector(`[data-ferry=${mode}-clip-fill]`);
  const startThumb = panel.querySelector(`[data-ferry=${mode}-clip-start-thumb]`);
  const endThumb = panel.querySelector(`[data-ferry=${mode}-clip-end-thumb]`);
  const readout = panel.querySelector(`[data-ferry=${mode}-clip-readout]`);
  if (!box || !track || !fill || !startThumb || !endThumb || !readout) return;
  const clipKey = mode === "audio" ? "audio" : "video";
  panel.dataset[`${clipKey}ClipTouched`] = "0";

  const duration = getPlayerDurationSeconds();
  if (!duration) {
    panel.dataset[`${clipKey}ClipStartSeconds`] = "0";
    panel.dataset[`${clipKey}ClipEndSeconds`] = "0";
    box.style.display = "none";
    return;
  }

  box.style.display = "grid";
  let start = 0;
  let end = duration;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const pct = (value) => (value / duration) * 100;

  const render = () => {
    const startPct = pct(start);
    const endPct = pct(end);
    startThumb.style.left = `${startPct}%`;
    endThumb.style.left = `${endPct}%`;
    fill.style.left = `${startPct}%`;
    fill.style.width = `${Math.max(0.5, endPct - startPct)}%`;
    panel.dataset[`${clipKey}ClipStartSeconds`] = String(start);
    panel.dataset[`${clipKey}ClipEndSeconds`] = String(end);
    
    const startStr = secondsToTimestamp(start);
    const endStr = secondsToTimestamp(end);
    
    const startText = panel.querySelector(`[data-ferry=${mode}-clip-start-text]`);
    if (startText) startText.textContent = startStr;
    const endText = panel.querySelector(`[data-ferry=${mode}-clip-end-text]`);
    if (endText) endText.textContent = endStr;
    
    const startBox = panel.querySelector(`[data-ferry=${mode}-clip-start-box]`);
    if (startBox) startBox.textContent = startStr;
    const endBox = panel.querySelector(`[data-ferry=${mode}-clip-end-box]`);
    if (endBox) endBox.textContent = endStr;
  };

  const secondsFromClientX = (clientX) => {
    const rect = track.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    return Math.round(ratio * duration);
  };

  const beginDrag = (which) => (downEvent) => {
    downEvent.preventDefault();
    panel.dataset[`${clipKey}ClipTouched`] = "1";
    const onMove = (moveEvent) => {
      const cursorSeconds = secondsFromClientX(moveEvent.clientX);
      if (which === "start") {
        start = clamp(cursorSeconds, 0, end - 1);
      } else {
        end = clamp(cursorSeconds, start + 1, duration);
      }
      render();
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  startThumb.onpointerdown = beginDrag("start");
  endThumb.onpointerdown = beginDrag("end");

  track.onclick = (event) => {
    panel.dataset[`${clipKey}ClipTouched`] = "1";
    const cursorSeconds = secondsFromClientX(event.clientX);
    const distToStart = Math.abs(cursorSeconds - start);
    const distToEnd = Math.abs(cursorSeconds - end);
    if (distToStart <= distToEnd) {
      start = clamp(cursorSeconds, 0, end - 1);
    } else {
      end = clamp(cursorSeconds, start + 1, duration);
    }
    render();
  };

  render();
}

// ---------------------------------------------------------------------------
// Format selector
// ---------------------------------------------------------------------------

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1000 ? (mb / 1024).toFixed(1) + " GB" : mb.toFixed(1) + " MB";
}

function getQualityBadge(height, mode) {
  if (mode !== "video" || !height) return "";
  if (height >= 2160) return "4K";
  if (height >= 1440) return "2K";
  if (height >= 1080) return "Full HD";
  if (height >= 720) return "HD";
  if (height >= 480) return "SD";
  if (height >= 360) return "Low";
  return "Very Low";
}

function formatHeightLabel(height) {
  if (!height) return "";
  return `${height}p`;
}

function formatDimensions(width, height) {
  if (width && height) return `${width}×${height}`;
  if (height) return `${height}p`;
  return "";
}

function buildFormatOptionLabel(format, mediaType) {
  if (mediaType === "video") {
    const parts = [];
    const ext = (format.format || "mp4").toUpperCase();
    const heightText = formatHeightLabel(format.height);
    const qualityBadge = getQualityBadge(format.height, mediaType);
    const sizeText = formatBytes(format.filesize);
    if (format.quality === "best") {
      parts.push("Best", ext);
    } else if (ext) {
      parts.push(ext);
    }
    if (heightText) parts.push(heightText);
    if (qualityBadge) parts.push(qualityBadge);
    if (sizeText) parts.push(sizeText);
    return parts.join(" • ") || format.label || "Best available";
  }
  if (mediaType === "audio") {
    const parts = [];
    if (format.quality === "best") {
      parts.push("Best", "MP3");
    } else {
      parts.push("MP3");
    }
    if (format.label && format.label !== "Best") parts.push(format.label);
    const sizeText = formatBytes(format.filesize);
    if (sizeText) parts.push(sizeText);
    return parts.join(" • ") || "Best audio";
  }
  if (mediaType === "thumbnail") {
    const parts = [];
    if (format.quality === "best") {
      parts.push("Best", "JPG");
    } else {
      parts.push("JPG");
    }
    const dimensionText = formatDimensions(format.width, format.height);
    if (dimensionText) {
      parts.push(dimensionText);
    } else if (format.label && format.label !== "Best") {
      parts.push(format.label);
    }
    return parts.join(" • ") || "Best thumbnail";
  }
  return format.label || "Best available";
}

function buildFallbackPreset(mode) {
  return {
    media_type: mode,
    format: mode === "audio" ? "mp3" : mode === "thumbnail" ? "jpg" : "mp4",
    quality: mode === "audio" ? "audio" : mode === "thumbnail" ? "thumbnail" : "best",
    format_id: null,
    height: null,
  };
}

function buildFallbackLabel(mode) {
  if (mode === "video") return "Best • MP4";
  if (mode === "audio") return "Best • MP3";
  if (mode === "thumbnail") return "Best • JPG";
  return "Best available";
}

function buildTrackedJobMeta(preset) {
  const mediaType = preset?.media_type || "video";
  if (mediaType === "audio") {
    return {
      mediaType: "audio",
      qualityLabel:
        preset?.quality === "best"
          ? "Best audio"
          : preset?.quality
            ? String(preset.quality).replace("kbps", " kbps")
            : "Audio",
      formatLabel: "MP3",
    };
  }
  if (mediaType === "thumbnail") {
    return {
      mediaType: "thumbnail",
      qualityLabel:
        preset?.quality && preset.quality !== "best"
          ? String(preset.quality).replace("x", "×")
          : "Best thumbnail",
      formatLabel: "JPG",
    };
  }
  return {
    mediaType: "video",
    qualityLabel: preset?.height ? `${preset.height}p` : preset?.quality || "Best",
    formatLabel: (preset?.format || "mp4").toUpperCase(),
  };
}

function buildTrackedSourceMeta(context) {
  return {
    sourceUrl: context?.url || "",
    sourceTitle: context?.title || "",
    sourceThumbnailUrl: context?.thumbnailUrl || "",
    sourceVideoId: context?.videoId || "",
  };
}

function parseSelectedPreset(panel, overrideMode = null) {
  const mode = overrideMode || panel.dataset.ferryMode || "video";
  const list = panel.querySelector(`[data-ferry=${mode}-preset]`);
  const fallbackFormat = mode === "audio" ? "mp3" : mode === "thumbnail" ? "jpg" : "mp4";
  const fallbackQuality = mode === "thumbnail" ? "thumbnail" : mode === "audio" ? "audio" : "best";
  
  let rawValue = null;
  if (list?.tagName === "SELECT") {
    rawValue = list.value;
  } else {
    const selectedItem = list?.querySelector(".is-selected");
    rawValue = selectedItem?.dataset?.value;
  }

  if (!rawValue) {
    return { media_type: mode, format: fallbackFormat, quality: fallbackQuality, format_id: null, height: null };
  }
  try {
    return JSON.parse(rawValue);
  } catch {
    return { media_type: mode, format: fallbackFormat, quality: fallbackQuality, format_id: null, height: null };
  }
}

function renderFormats(panel, formats, loading = false) {
  const listMap = {
    video: panel.querySelector("[data-ferry=video-preset]"),
    audio: panel.querySelector("[data-ferry=audio-preset]"),
    thumbnail: panel.querySelector("[data-ferry=thumbnail-preset]"),
  };
  
  for (const list of Object.values(listMap)) {
    if (list) {
      list.innerHTML = "";
      if (loading) {
        if (list.tagName === "SELECT") {
          const option = document.createElement("option");
          option.textContent = "Loading options…";
          list.appendChild(option);
          list.disabled = true;
        } else {
          const item = document.createElement("div");
          item.className = "ferry-list-item is-disabled";
          item.innerHTML = `<span class="ferry-list-label">Loading options…</span>`;
          list.appendChild(item);
        }
      } else if (list.tagName === "SELECT") {
        list.disabled = false;
      }
    }
  }

  if (loading) return;

  for (const format of formats) {
    if (!format?.label) continue;
    const mediaType =
      format.media_type ||
      (format.format === "mp3" || format.quality === "audio"
        ? "audio"
        : format.format === "jpg" || format.format === "thumbnail"
          ? "thumbnail"
          : "video");
    const list = listMap[mediaType];
    if (!list) continue;
    
    const presetData = {
      media_type: mediaType,
      format: format.format || "mp4",
      quality: format.quality || "best",
      format_id: format.format_id || null,
      width: format.width || null,
      height: format.height || null,
    };
    
    if (list.tagName === "SELECT") {
      const option = document.createElement("option");
      option.textContent = buildFormatOptionLabel(format, mediaType);
      option.value = JSON.stringify(presetData);
      list.appendChild(option);
    } else {
      const item = document.createElement("div");
      item.className = "ferry-list-item";
      
      const badgeText = getQualityBadge(format.height, mediaType);
      const badgeHtml = badgeText ? `<span class="ferry-list-badge">${badgeText}</span>` : "";
      const extText = (format.format || "").toUpperCase();
      const sizeText = formatBytes(format.filesize);
      const sizeHtml = sizeText ? `<span class="ferry-list-size">${sizeText}</span>` : "";

      item.innerHTML = `
        <span class="ferry-list-ext">${extText}</span>
        <span class="ferry-list-label">${format.label}</span>
        ${badgeHtml}
        <div style="flex: 1"></div>
        ${sizeHtml}
        <div class="ferry-list-actions">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        </div>
      `;

      item.dataset.value = JSON.stringify(presetData);
      
      item.addEventListener("click", () => {
        // Trigger download immediately
        panel.dispatchEvent(new CustomEvent("ferry-download-trigger", { detail: presetData }));
        
        // Update visual selection
        list.querySelectorAll(".ferry-list-item").forEach(el => el.classList.remove("is-selected"));
        item.classList.add("is-selected");
      });

      list.appendChild(item);
    }
  }

  for (const [mode, list] of Object.entries(listMap)) {
    if (!list) continue;
    
    if (list.tagName === "SELECT") {
      if (list.options.length > 0) {
        list.selectedIndex = 0;
      } else {
        const option = document.createElement("option");
        option.textContent = buildFallbackLabel(mode);
        option.value = JSON.stringify(buildFallbackPreset(mode));
        list.appendChild(option);
      }
    } else {
      const items = list.querySelectorAll(".ferry-list-item");
      if (items.length > 0) {
        items[0].classList.add("is-selected");
      } else {
        const item = document.createElement("div");
        item.className = "ferry-list-item is-selected";
        const fallbackLabel = mode === "thumbnail" ? "Best thumbnail" : mode === "audio" ? "Best audio" : "Best available";
        const extText = mode === "audio" ? "MP3" : mode === "thumbnail" ? "JPG" : "MP4";
        
        item.innerHTML = `
          <span class="ferry-list-ext">${extText}</span>
          <span class="ferry-list-label">${fallbackLabel}</span>
        `;
        item.dataset.value = JSON.stringify({
          media_type: mode,
          format: mode === "audio" ? "mp3" : mode === "thumbnail" ? "jpg" : "mp4",
          quality: mode === "audio" ? "audio" : mode === "thumbnail" ? "thumbnail" : "best",
          format_id: null,
          height: null,
        });
        list.appendChild(item);
      }
    }
  }
}

function setPanelMode(panel, mode) {
  const nextMode = ["video", "audio", "thumbnail"].includes(mode) ? mode : "video";
  panel.dataset.ferryMode = nextMode;
  panel.querySelectorAll("[data-ferry-mode]").forEach((button) => {
    const active = button.dataset.ferryMode === nextMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  panel.querySelectorAll("[data-ferry-section]").forEach((section) => {
    section.hidden = section.dataset.ferrySection !== nextMode;
  });
  const videoClipDetails = panel.querySelector("[data-ferry=video-clip-details]");
  if (videoClipDetails) {
    videoClipDetails.hidden = nextMode !== "video";
  }
  const audioClipDetails = panel.querySelector("[data-ferry=clip-details]");
  if (audioClipDetails) {
    audioClipDetails.hidden = nextMode !== "audio";
  }
  const downloadBtn = panel.querySelector("[data-ferry=download-btn]");
  if (downloadBtn) {
    downloadBtn.textContent = nextMode === "thumbnail" ? "Download thumbnail" : "Download";
  }
  if (nextMode === "video" || nextMode === "audio") {
    bindClipDurationSync(panel);
    setupClipSlider(panel, nextMode);
  }
}

// ---------------------------------------------------------------------------
// WebSocket listener
// ---------------------------------------------------------------------------

function ensureWsListener() {
  if (wsBound) return;
  const onMessage = globalThis.chrome?.runtime?.onMessage;
  if (!runtimeAvailable() || !onMessage?.addListener) return;

  try {
    onMessage.addListener((message) => {
      const panel = document.getElementById(PANEL_ID);
      if (message?.type === "PREFETCH_UPDATED") {
        const payload = message.payload;
        const currentKey = getPrefetchKey(window.location.href);
        if (!payload || payload.key !== currentKey) return;
        setPrefetchStateFromSnapshot(payload);
        if (panel && panel.style.display !== "none") {
          applyPrefetchStateToPanel(panel);
        }
        return;
      }

      if (message?.type !== "WS_EVENT") return;
      const payload = message.payload;
      if (!payload || payload.job_id !== activeJobId || !panel) return;

      if (payload.event === "progress") {
        setProgress(panel, payload.percent ?? 0, payload.speed, payload.eta);
        return;
      }

      const downloadBtn = panel.querySelector("[data-ferry=download-btn]");
      if (payload.event === "done") {
        setProgress(panel, 100, null, null);
        const fileName = payload.path ? payload.path.split(/[\\/]/).pop() : null;
        setStatus(panel, fileName ? `Done ✓ ${fileName}` : "Done ✓ Saved to Downloads", true, true);
        if (downloadBtn) downloadBtn.disabled = false;
        stopStatusPolling();
        return;
      }

      if (payload.event === "error") {
        setStatus(panel, payload.message || "Download failed", false, true);
        if (downloadBtn) downloadBtn.disabled = false;
        stopStatusPolling();
      }
    });
    wsBound = true;
  } catch {
    wsBound = false;
  }
}

// ---------------------------------------------------------------------------
// Panel creation (uses CSS classes from content.css)
// ---------------------------------------------------------------------------

function createPanel() {
  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.style.display = "none";
  panel.dataset.ferryMode = "video";
  const ferryLogoUrl = getExtensionAssetUrl("icons/extentionIcon.png");

  panel.innerHTML = `
    <div class="ferry-branded-header">
      <div class="ferry-brand-left">
        <span class="ferry-brand-mark" aria-hidden="true">
          <img src="${ferryLogoUrl}" alt="" class="ferry-brand-mark-image" />
        </span>
        <span class="ferry-brand-text">Ferry</span>
      </div>
      <button type="button" data-ferry="close" class="ferry-close-btn" aria-label="Close" title="Close">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    </div>
    <div class="ferry-mode-tabs" role="tablist" aria-label="Download type">
      <button type="button" class="ferry-mode-tab is-active" data-ferry-mode="video" role="tab" aria-selected="true" title="Video">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>
      </button>
      <button type="button" class="ferry-mode-tab" data-ferry-mode="audio" role="tab" aria-selected="false" title="Audio">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
      </button>
      <button type="button" class="ferry-mode-tab" data-ferry-mode="thumbnail" role="tab" aria-selected="false" title="Thumbnail">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>
      </button>
    </div>

    <section class="ferry-mode-section" data-ferry-section="video">
      <div class="ferry-audio-controls ferry-video-controls">
        <label class="ferry-audio-bitrate-label">Choose video quality</label>
        <select data-ferry="video-preset" class="ferry-audio-select ferry-video-select"></select>
      </div>

      <details class="ferry-clip-details" data-ferry="video-clip-details" open>
        <summary class="ferry-clip-summary" hidden>Clip</summary>
        <div data-ferry="video-clip-slider-box" class="ferry-clip-slider-box">
          <div class="ferry-clip-header">
            <label class="ferry-audio-bitrate-label ferry-clip-label">Time</label>
            <div data-ferry="video-clip-readout" class="ferry-clip-readout" hidden>
              <span data-ferry="video-clip-start-text">00:00</span>
              <span data-ferry="video-clip-end-text">00:00</span>
            </div>
          </div>
          <div data-ferry="video-clip-track" class="ferry-clip-track">
            <div class="ferry-clip-track-bg"></div>
            <div data-ferry="video-clip-fill" class="ferry-clip-fill"></div>
            <button type="button" data-ferry="video-clip-start-thumb" class="ferry-clip-thumb"></button>
            <button type="button" data-ferry="video-clip-end-thumb" class="ferry-clip-thumb"></button>
          </div>

          <div class="ferry-clip-times">
            <div class="ferry-clip-time-card">
              <label class="ferry-audio-bitrate-label">From</label>
              <div class="ferry-clip-time-box" data-ferry="video-clip-start-box">00:00:00</div>
            </div>
            <div class="ferry-clip-time-card">
              <label class="ferry-audio-bitrate-label">To</label>
              <div class="ferry-clip-time-box" data-ferry="video-clip-end-box">00:00:00</div>
            </div>
          </div>

          <button data-ferry="download-video-btn" class="ferry-download-btn ferry-video-download-btn">Download video</button>
        </div>
      </details>
    </section>

    <section class="ferry-mode-section" data-ferry-section="audio" hidden>
      <div class="ferry-audio-controls">
        <label class="ferry-audio-bitrate-label">Choose MP3 bitrate</label>
        <select data-ferry="audio-preset" class="ferry-audio-select"></select>
      </div>

      <details class="ferry-clip-details" data-ferry="clip-details" open>
        <summary class="ferry-clip-summary" hidden>Clip</summary>
        <div data-ferry="audio-clip-slider-box" class="ferry-clip-slider-box">
          <div class="ferry-clip-header">
            <label class="ferry-audio-bitrate-label ferry-clip-label">Time</label>
            <div data-ferry="audio-clip-readout" class="ferry-clip-readout" hidden>
              <span data-ferry="audio-clip-start-text">00:00</span>
              <span data-ferry="audio-clip-end-text">00:00</span>
            </div>
          </div>
          <div data-ferry="audio-clip-track" class="ferry-clip-track">
            <div class="ferry-clip-track-bg"></div>
            <div data-ferry="audio-clip-fill" class="ferry-clip-fill"></div>
            <button type="button" data-ferry="audio-clip-start-thumb" class="ferry-clip-thumb"></button>
            <button type="button" data-ferry="audio-clip-end-thumb" class="ferry-clip-thumb"></button>
          </div>

          <div class="ferry-clip-times">
            <div class="ferry-clip-time-card">
              <label class="ferry-audio-bitrate-label">From</label>
              <div class="ferry-clip-time-box" data-ferry="audio-clip-start-box">00:00:00</div>
            </div>
            <div class="ferry-clip-time-card">
              <label class="ferry-audio-bitrate-label">To</label>
              <div class="ferry-clip-time-box" data-ferry="audio-clip-end-box">00:00:00</div>
            </div>
          </div>

          <button data-ferry="download-audio-btn" class="ferry-download-btn ferry-audio-download-btn">Download audio</button>
        </div>
      </details>
    </section>

    <section class="ferry-mode-section" data-ferry-section="thumbnail" hidden>
      <div class="ferry-thumbnail-preview-container">
        <img data-ferry="thumbnail-preview" class="ferry-thumbnail-preview" src="" alt="Thumbnail preview" />
      </div>
      <div class="ferry-thumbnail-controls">
        <label class="ferry-audio-bitrate-label">Select quality</label>
        <select data-ferry="thumbnail-preset" class="ferry-audio-select ferry-thumbnail-select"></select>
        <button data-ferry="download-thumbnail-btn" class="ferry-download-btn ferry-thumbnail-download-btn">Download thumbnail</button>
      </div>
    </section>

    <div data-ferry="progress-box" class="ferry-progress-box">
      <div data-ferry="progress-text" class="ferry-progress-text">Queue…</div>
    </div>
  `;

  panel.querySelector("[data-ferry=close]")?.addEventListener("click", () => {
    panel.style.display = "none";
    resetProgressBox(panel);
    stopStatusPolling();
    setButtonActiveState(false);
  });

  panel.querySelectorAll("[data-ferry-mode]").forEach((button) => {
    button.addEventListener("click", () => setPanelMode(panel, button.dataset.ferryMode));
  });

  // Handle download triggers from the rich list items
  panel.addEventListener("ferry-download-trigger", async (e) => {
    const preset = e.detail;
    const context = getVideoContext();

    const payload = {
      url: context.url,
      title: context.title || null,
      media_type: preset.media_type || panel.dataset.ferryMode || "video",
      format: preset.format,
      quality: preset.quality,
      format_id: preset.format_id || null,
      height: preset.height || null,
    };

    const clip = payload.media_type === "thumbnail" ? null : clipPayload(panel);
    if (clip) payload.clip = clip;

    setStatus(panel, "Queue…", true, true);

    try {
      const result = await queueDownload(payload);
      activeJobId = result.job_id;
      setProgress(panel, 0, null, null);
      setStatus(panel, "Queue… Download started", true, true);
      await safeSendMessage({
        type: "TRACK_JOB",
        jobId: activeJobId,
        title: payload.title || "Video",
        meta: Object.assign({}, buildTrackedJobMeta(preset), buildTrackedSourceMeta(context)),
      });
      startStatusPolling(panel, activeJobId);
    } catch (error) {
      setStatus(panel, error?.message || "Failed to queue download", false, true);
    }
  });

  // Attach listeners to explicit buttons
  panel.querySelector("[data-ferry=download-video-btn]")?.addEventListener("click", () => {
    const preset = parseSelectedPreset(panel, "video");
    panel.dispatchEvent(new CustomEvent("ferry-download-trigger", { detail: preset }));
  });

  panel.querySelector("[data-ferry=download-audio-btn]")?.addEventListener("click", () => {
    const preset = parseSelectedPreset(panel, "audio");
    panel.dispatchEvent(new CustomEvent("ferry-download-trigger", { detail: preset }));
  });

  panel.querySelector("[data-ferry=download-thumbnail-btn]")?.addEventListener("click", () => {
    const preset = parseSelectedPreset(panel, "thumbnail");
    panel.dispatchEvent(new CustomEvent("ferry-download-trigger", { detail: preset }));
  });

  return panel;
}

// ---------------------------------------------------------------------------
// Dropdown host styling
// ---------------------------------------------------------------------------

function ensureDropdownHostStyles(actionBar) {
  const nodes = [
    actionBar,
    actionBar?.parentElement,
    actionBar?.closest("#menu"),
    actionBar?.closest("#actions"),
    actionBar?.closest("#actions-inner"),
    actionBar?.closest("ytd-watch-metadata"),
  ].filter(Boolean);

  for (const node of nodes) {
    if (node instanceof HTMLElement) {
      node.style.overflow = "visible";
    }
  }
}

function setButtonActiveState(active) {
  const button = document.getElementById(BUTTON_ID);
  if (!button) return;
  if (buttonAnimationTimer) {
    clearTimeout(buttonAnimationTimer);
    buttonAnimationTimer = null;
  }
  button.classList.remove("is-closing");
  if (active) {
    button.classList.remove("is-flipped");
  }
  if (!active && button.classList.contains("is-active")) {
    button.classList.add("is-flipped");
    button.classList.add("is-closing");
    buttonAnimationTimer = setTimeout(() => {
      button.classList.remove("is-closing");
      buttonAnimationTimer = null;
    }, 1050);
  }
  button.classList.toggle("is-active", Boolean(active));
  button.setAttribute("aria-pressed", active ? "true" : "false");
}

// ---------------------------------------------------------------------------
// Panel initialization
// ---------------------------------------------------------------------------

async function initializePanel(panel) {
  const context = getVideoContext();
  const titleEl = panel.querySelector("[data-ferry=title]");
  if (titleEl) titleEl.textContent = context.title || context.url;
  syncThumbnailPreview(panel, context.url);
  bindClipDurationSync(panel);
  syncClipSliders(panel);
  resetProgressBox(panel);
  if (prefetchKey !== getPrefetchKey(context.url)) {
    prefetchState = { loading: true, formats: [], error: null };
  }
  applyPrefetchStateToPanel(panel);
  await refreshPrefetchState(context.url, true);
  applyPrefetchStateToPanel(panel);
}

// ---------------------------------------------------------------------------
// Button creation
// ---------------------------------------------------------------------------

function createButton() {
  const button = document.createElement("button");
  button.id = BUTTON_ID;
  button.type = "button";
  button.className = "ferry-injected-button";
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
  button.setAttribute("aria-label", "Download with Ferry");
  button.setAttribute("aria-pressed", "false");
  // Styles applied via content.css #ferry-injected-button

  button.addEventListener("click", async () => {
    const actionBar =
      button.closest("#top-level-buttons-computed") ||
      document.querySelector("#top-level-buttons-computed") ||
      document.querySelector("#menu #top-level-buttons-computed");
    if (!actionBar) return;

    const wrapper = button.closest(`#${WRAPPER_ID}`);
    const panel = ensurePanel(wrapper, actionBar);
    if (!panel) return;

    const opening = panel.style.display === "none";
    panel.style.display = opening ? "block" : "none";
    setButtonActiveState(opening);

    if (opening) {
      await initializePanel(panel);
    }
  });

  return button;
}

// ---------------------------------------------------------------------------
// DOM injection
// ---------------------------------------------------------------------------

function ensurePanel(wrapper, actionBar) {
  if (!wrapper) return null;
  ensureDropdownHostStyles(actionBar);
  let panel = document.getElementById(PANEL_ID);
  if (!panel || !panel.isConnected) {
    panel = createPanel();
    wrapper.appendChild(panel);
  } else if (panel.parentElement !== wrapper) {
    wrapper.appendChild(panel);
  }
  return panel;
}

function ensureButtonWrapper(actionBar) {
  if (!actionBar) return null;
  ensureDropdownHostStyles(actionBar);
  let wrapper = document.getElementById(WRAPPER_ID);
  if (!wrapper || !wrapper.isConnected) {
    wrapper = document.createElement("div");
    wrapper.id = WRAPPER_ID;
    wrapper.className = "ferry-button-anchor";
  }

  if (!actionBar.contains(wrapper)) {
    const beforeNode = findLikeButtonContainer(actionBar);
    if (beforeNode) {
      actionBar.insertBefore(wrapper, beforeNode);
    } else {
      actionBar.prepend(wrapper);
    }
  }

  return wrapper;
}

function findLikeButtonContainer(actionBar) {
  if (!actionBar) return null;
  const selectors = [
    ":scope > ytd-segmented-like-dislike-button-renderer",
    ":scope > segmented-like-dislike-button-view-model",
    ":scope > ytd-menu-renderer",
  ];
  for (const selector of selectors) {
    const target = actionBar.querySelector(selector);
    if (target) return target;
  }
  return actionBar.firstElementChild;
}

function findActionBar() {
  const selectors = [
    "#top-level-buttons-computed",
    "#menu #top-level-buttons-computed",
    "ytd-watch-metadata #top-level-buttons-computed",
    "#actions #top-level-buttons-computed",
    "ytd-menu-renderer #top-level-buttons-computed",
    "#actions-inner #top-level-buttons-computed",
    "ytd-watch-flexy #actions-inner ytd-menu-renderer #top-level-buttons-computed",
  ];

  for (const selector of selectors) {
    const node = document.querySelector(selector);
    if (isActionBarReady(node)) return node;
  }
  return null;
}

function isActionBarReady(actionBar) {
  if (!actionBar?.isConnected) return false;
  if (!isWatchPage()) return false;
  const rect = actionBar.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  return Boolean(findLikeButtonContainer(actionBar));
}

function isButtonInCurrentActionBar(actionBar) {
  const button = document.getElementById(BUTTON_ID);
  return Boolean(button?.isConnected && actionBar?.contains(button));
}

function cleanupInjectedElements() {
  document.getElementById(WRAPPER_ID)?.remove();
  document.getElementById(BUTTON_ID)?.remove();
  document.getElementById(PANEL_ID)?.remove();
  prefetchKey = "";
  prefetchState = { loading: false, formats: [], error: null };
  if (prefetchTimer) {
    clearTimeout(prefetchTimer);
    prefetchTimer = null;
  }
  stopStatusPolling();
}

function stopInjectionWatchdog() {
  if (injectionWatchdogTimer) {
    clearInterval(injectionWatchdogTimer);
    injectionWatchdogTimer = null;
  }
  injectionWatchdogTicks = 0;
}

function startInjectionWatchdog() {
  stopInjectionWatchdog();
  injectionWatchdogTimer = setInterval(() => {
    if (!isWatchPage()) {
      stopInjectionWatchdog();
      return;
    }
    const injected = injectButtonAndPanel();
    injectionWatchdogTicks += 1;
    if ((injected && injectionWatchdogTicks >= 8) || injectionWatchdogTicks >= 150) {
      stopInjectionWatchdog();
    }
  }, 250);
}

function injectButtonAndPanel() {
  if (!isWatchPage()) {
    cleanupInjectedElements();
    return false;
  }

  const actionBar = findActionBar();
  if (!actionBar) {
    scheduleInject();
    return false;
  }

  const existingButton = document.getElementById(BUTTON_ID);
  if (existingButton && !isButtonInCurrentActionBar(actionBar)) {
    cleanupInjectedElements();
  }

  if (!document.getElementById(BUTTON_ID)) {
    const wrapper = ensureButtonWrapper(actionBar);
    if (!wrapper) return false;
    const button = createButton();
    wrapper.appendChild(button);
  }

  return isButtonInCurrentActionBar(actionBar);
}

/** Debounced injection to prevent excessive calls from MutationObserver. */
function scheduleInject() {
  if (injectTimer) clearTimeout(injectTimer);
  injectTimer = setTimeout(() => {
    injectButtonAndPanel();
  }, INJECT_DEBOUNCE_MS);
}

/** Immediate injection loop using rAF for SPA navigation. */
function startImmediateInjectionLoop() {
  if (injectionLoopActive) return;
  injectionLoopActive = true;
  let frames = 0;
  const tick = () => {
    const injected = injectButtonAndPanel();
    frames += 1;
    if ((injected && frames >= 12) || frames >= MAX_INJECTION_FRAMES) {
      injectionLoopActive = false;
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

ensureWsListener();

// Debounced MutationObserver for DOM changes
const observer = new MutationObserver(scheduleInject);
observer.observe(document.documentElement, { childList: true, subtree: true });

// Initial injection
injectButtonAndPanel();
if (isWatchPage()) {
  scheduleVideoPrefetch(window.location.href);
}

// YouTube SPA navigation events
window.addEventListener("yt-navigate-start", () => {
  cleanupInjectedElements();
  stopInjectionWatchdog();
});

window.addEventListener("yt-navigate-finish", () => {
  injectButtonAndPanel();
  scheduleVideoPrefetch(window.location.href);
  startImmediateInjectionLoop();
  startInjectionWatchdog();
});

window.addEventListener("yt-page-data-updated", () => {
  injectButtonAndPanel();
  scheduleVideoPrefetch(window.location.href);
  startImmediateInjectionLoop();
  startInjectionWatchdog();
});

startImmediateInjectionLoop();
