/**
 * Ferry background service worker.
 *
 * Manages WebSocket connection to the desktop companion, broadcasts download
 * events to content/popup contexts, and creates desktop notifications.
 */

import { API_BASE, WS_URL, ACTIVITY_KEY, MAX_ACTIVITY_ITEMS } from "./constants.js";
import { loadFormats } from "./api.js";
import { runtimeAvailable } from "./runtime.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

var socket = null;
var reconnectTimer = null;
var reconnectDelay = 2000;
var activeJobs = new Set();
var shouldKeepSocket = false;
var notificationTargets = new Map();
var formatPrefetchCache = new Map();
var formatPrefetchInflight = new Map();

var MAX_RECONNECT_DELAY = 30000;
var NOTIFICATION_TARGET_TTL = 300000;
var FORMAT_PREFETCH_TTL = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

function broadcastToExtension(message) {
  if (!runtimeAvailable()) return;
  var runtime = globalThis.chrome && globalThis.chrome.runtime;
  if (!runtime || typeof runtime.sendMessage !== "function") return;

  try {
    runtime.sendMessage(message).catch(function() {
      // ignore - usually means popup is closed
    });
  } catch (err) {
    // ignore
  }
}

function broadcastActivityUpdated(jobId, state) {
  broadcastToExtension({
    type: "ACTIVITY_UPDATED",
    payload: {
      job_id: jobId,
      state: state || null
    }
  });
}

function broadcastPrefetchUpdated(snapshot) {
  broadcastToExtension({
    type: "PREFETCH_UPDATED",
    payload: snapshot || null
  });
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

function notify(title, message, options) {
  if (!runtimeAvailable()) return;
  if (!globalThis.chrome || !globalThis.chrome.notifications || !globalThis.chrome.notifications.create) return;

  var opts = options || {};
  var notificationId = opts.notificationId || ("ferry-" + Date.now() + "-" + Math.random().toString(16).slice(2));

  if (opts.path) {
    notificationTargets.set(notificationId, {
      path: opts.path,
      createdAt: Date.now()
    });
  }

  try {
    var iconUrl = globalThis.chrome.runtime.getURL ? globalThis.chrome.runtime.getURL("icons/extentionIcon.png") : "icons/extentionIcon.png";
    globalThis.chrome.notifications.create(notificationId, {
      type: "basic",
      iconUrl: iconUrl,
      title: title,
      message: message
    }, function() {
      var err = globalThis.chrome.runtime.lastError;
      if (err) console.warn("notification failed:", err);
    });
  } catch (err) {}
}

function cleanupNotificationTargets() {
  var cutoff = Date.now() - NOTIFICATION_TARGET_TTL;
  notificationTargets.forEach(function(data, id) {
    if (data.createdAt < cutoff) notificationTargets.delete(id);
  });
}

function revealPath(path) {
  if (!path) return;
  fetch(API_BASE + "/reveal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: path })
  }).catch(function() {});
}

// ---------------------------------------------------------------------------
// Activity log with sequential queue to avoid race conditions
// ---------------------------------------------------------------------------

var activityUpdateQueue = Promise.resolve();
var lastProgressUpdate = {};

function readActivity() {
  var storage = globalThis.chrome && globalThis.chrome.storage && globalThis.chrome.storage.local;
  if (!storage || !storage.get) return Promise.resolve([]);
  return storage.get(ACTIVITY_KEY).then(function(data) {
    return Array.isArray(data && data[ACTIVITY_KEY]) ? data[ACTIVITY_KEY] : [];
  }).catch(function() { return []; });
}

function writeActivity(items) {
  var storage = globalThis.chrome && globalThis.chrome.storage && globalThis.chrome.storage.local;
  if (!storage || !storage.set) return Promise.resolve();
  var obj = {};
  obj[ACTIVITY_KEY] = items.slice(0, MAX_ACTIVITY_ITEMS);
  return storage.set(obj).catch(function() {});
}

function fetchJobStatus(jobId) {
  if (!jobId) return Promise.resolve(null);
  return fetch(API_BASE + "/status/" + encodeURIComponent(jobId), {
    method: "GET",
    cache: "no-store"
  }).then(function(res) {
    if (!res.ok) return null;
    return res.json();
  }).catch(function() {
    return null;
  });
}

function sortActivityByUpdatedAt(items) {
  return (items || []).slice().sort(function(a, b) {
    var aTime = new Date((a && (a.updatedAt || a.createdAt)) || 0).getTime();
    var bTime = new Date((b && (b.updatedAt || b.createdAt)) || 0).getTime();
    return bTime - aTime;
  });
}

async function reconcileActivityState(items) {
  if (!Array.isArray(items) || !items.length) return [];

  var changed = false;
  var reconciled = await Promise.all(items.map(async function(item) {
    if (!item || !item.jobId) return item;
    if (item.state === "done" || item.state === "error") return item;

    var status = await fetchJobStatus(item.jobId);
    if (!status || !status.status) return item;

    var next = Object.assign({}, item);
    var nextState = item.state;

    if (status.status === "queued") {
      nextState = "queued";
      next.progress = 0;
    } else if (status.status === "in_progress") {
      nextState = "progress";
      next.progress = typeof status.progress === "number" ? status.progress : (next.progress || 0);
    } else if (status.status === "done") {
      nextState = "done";
      next.progress = 100;
      next.path = status.output_path || next.path || null;
      activeJobs.delete(item.jobId);
    } else if (status.status === "error") {
      nextState = "error";
      next.errorMessage = status.message || next.errorMessage || "Download failed";
      activeJobs.delete(item.jobId);
    }

    if (
      nextState !== item.state ||
      next.progress !== item.progress ||
      next.path !== item.path ||
      next.errorMessage !== item.errorMessage
    ) {
      changed = true;
      next.state = nextState;
      next.updatedAt = new Date().toISOString();
    }

    return next;
  }));

  reconciled = sortActivityByUpdatedAt(reconciled);

  if (changed) {
    await writeActivity(reconciled);
    setBadge(activeJobs.size > 0 ? String(activeJobs.size) : "");
  }

  return reconciled;
}

function queueActivityUpdate(jobId, updates) {
  activityUpdateQueue = activityUpdateQueue.then(function() {
    return readActivity().then(function(items) {
      var index = -1;
      for (var i = 0; i < items.length; i++) {
        if (items[i].jobId === jobId) {
          index = i;
          break;
        }
      }
      var now = new Date().toISOString();
      if (index !== -1) {
        var updatedItem = Object.assign({}, items[index], updates, { updatedAt: now });
        items.splice(index, 1);
        items.unshift(updatedItem);
      } else {
        items.unshift(Object.assign({
          jobId: jobId,
          title: "Video",
          state: "queued",
          progress: 0,
          thumbnailUrl: "",
          sourceUrl: "",
          mediaType: "video",
          qualityLabel: "",
          formatLabel: "",
          createdAt: now
        }, updates, { updatedAt: now }));
      }
      return writeActivity(items);
    });
  });
  return activityUpdateQueue;
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

function setBadge(text) {
  var action = globalThis.chrome && globalThis.chrome.action;
  if (!action || !action.setBadgeText) return;
  action.setBadgeText({ text: text });
  if (action.setBadgeBackgroundColor) {
    action.setBadgeBackgroundColor({ color: "#111111" });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function filenameFromPath(path) {
  if (!path || typeof path !== "string") return null;
  var normalized = path.replace(/\\/g, "/");
  var segments = normalized.split("/");
  return segments[segments.length - 1] || null;
}

function extractVideoIdFromUrl(rawUrl) {
  try {
    var parsed = new URL(rawUrl || "");
    if (parsed.pathname === "/watch") {
      return parsed.searchParams.get("v") || "";
    }
    var shortsMatch = parsed.pathname.match(/^\/shorts\/([^/?]+)/);
    return shortsMatch && shortsMatch[1] ? shortsMatch[1] : "";
  } catch (err) {
    return "";
  }
}

function getFormatPrefetchKey(rawUrl) {
  return extractVideoIdFromUrl(rawUrl) || rawUrl || "";
}

function createPrefetchSnapshot(entry) {
  return {
    key: entry && entry.key ? entry.key : "",
    url: entry && entry.url ? entry.url : "",
    state: entry && entry.state ? entry.state : "idle",
    formats: entry && Array.isArray(entry.formats) ? entry.formats : [],
    error: entry && entry.error ? entry.error : null,
    updatedAt: entry && entry.updatedAt ? entry.updatedAt : 0,
  };
}

function isFreshPrefetch(entry) {
  return Boolean(
    entry &&
    entry.state === "ready" &&
    entry.updatedAt &&
    Date.now() - entry.updatedAt < FORMAT_PREFETCH_TTL
  );
}

function normalizePrefetchError(error) {
  var message = error && error.message ? error.message : String(error || "formats failed");
  if (
    message.includes("Failed to fetch") ||
    message.includes("NetworkError") ||
    message.includes("fetch")
  ) {
    return "Island desktop not reachable";
  }
  return message;
}

function getCachedPrefetch(url) {
  var key = getFormatPrefetchKey(url);
  if (!key) return createPrefetchSnapshot(null);
  return createPrefetchSnapshot(formatPrefetchCache.get(key));
}

function ensureFormatsPrefetch(url, options) {
  var opts = options || {};
  var key = getFormatPrefetchKey(url);
  if (!key || !url) {
    return Promise.resolve({
      key: key,
      url: url || "",
      state: "error",
      formats: [],
      error: "Missing video URL",
      updatedAt: Date.now(),
    });
  }

  var current = formatPrefetchCache.get(key);
  if (!opts.force && isFreshPrefetch(current)) {
    return Promise.resolve(createPrefetchSnapshot(current));
  }

  if (!opts.force && formatPrefetchInflight.has(key)) {
    return opts.awaitResult
      ? formatPrefetchInflight.get(key)
      : Promise.resolve(createPrefetchSnapshot(formatPrefetchCache.get(key)));
  }

  var loadingEntry = {
    key: key,
    url: url,
    state: "loading",
    formats: current && Array.isArray(current.formats) ? current.formats : [],
    error: null,
    updatedAt: current && current.updatedAt ? current.updatedAt : 0,
  };
  formatPrefetchCache.set(key, loadingEntry);
  broadcastPrefetchUpdated(createPrefetchSnapshot(loadingEntry));

  var request = loadFormats(url)
    .then(function(formats) {
      var readyEntry = {
        key: key,
        url: url,
        state: "ready",
        formats: Array.isArray(formats) ? formats : [],
        error: null,
        updatedAt: Date.now(),
      };
      formatPrefetchCache.set(key, readyEntry);
      var snapshot = createPrefetchSnapshot(readyEntry);
      broadcastPrefetchUpdated(snapshot);
      return snapshot;
    })
    .catch(function(error) {
      var failedEntry = {
        key: key,
        url: url,
        state: "error",
        formats: [],
        error: normalizePrefetchError(error),
        updatedAt: Date.now(),
      };
      formatPrefetchCache.set(key, failedEntry);
      var snapshot = createPrefetchSnapshot(failedEntry);
      broadcastPrefetchUpdated(snapshot);
      return snapshot;
    })
    .finally(function() {
      formatPrefetchInflight.delete(key);
    });

  formatPrefetchInflight.set(key, request);

  return opts.awaitResult
    ? request
    : Promise.resolve(createPrefetchSnapshot(loadingEntry));
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (shouldKeepSocket && runtimeAvailable()) {
    reconnectTimer = setTimeout(function() {
      connectSocket();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }
}

function apiReachable() {
  return fetch(API_BASE + "/health", { method: "GET", cache: "no-store" })
    .then(function(res) { return res.ok; })
    .catch(function() { return false; });
}

function handleSocketMessage(event) {
  var payload = null;
  try {
    payload = JSON.parse(event.data);
  } catch (err) { return; }

  if (!payload || !payload.job_id) return;
  var jobId = payload.job_id;

  // Broadcast to extension immediately for snappy UI
  broadcastToExtension({ type: "WS_EVENT", payload: payload });

  if (payload.event === "done") {
    var name = filenameFromPath(payload.path);
    notify("Ferry", name ? ("Done ✓ " + name) : "Done ✓ Saved to Downloads", {
      notificationId: "ferry-done-" + jobId,
      path: payload.path || null
    });
    queueActivityUpdate(jobId, {
      state: "done",
      path: payload.path || null,
      progress: 100
    }).then(function() {
      broadcastActivityUpdated(jobId, "done");
    });
    activeJobs.delete(jobId);
    setBadge(activeJobs.size > 0 ? String(activeJobs.size) : "");
    cleanupNotificationTargets();
  } else if (payload.event === "error") {
    notify("Ferry", payload.message || "Download failed", {
      notificationId: "ferry-error-" + jobId
    });
    queueActivityUpdate(jobId, {
      state: "error",
      errorMessage: payload.message || "Download failed"
    }).then(function() {
      broadcastActivityUpdated(jobId, "error");
    });
    activeJobs.delete(jobId);
    setBadge(activeJobs.size > 0 ? String(activeJobs.size) : "");
    cleanupNotificationTargets();
  } else if (payload.event === "progress") {
    var percent = (payload.percent !== undefined && payload.percent !== null) ? payload.percent : 0;
    
    // Always persist the first seen progress event for a job so the popup can
    // create an activity card even if the initial queued message was missed.
    var hasSeenProgress = Object.prototype.hasOwnProperty.call(lastProgressUpdate, jobId);
    var lastPercent = hasSeenProgress ? lastProgressUpdate[jobId] : 0;
    if (!hasSeenProgress || Math.abs(percent - lastPercent) >= 5 || percent === 0 || percent === 100) {
      lastProgressUpdate[jobId] = percent;
      queueActivityUpdate(jobId, {
        state: "progress",
        progress: percent,
        speed: payload.speed || "",
        eta: payload.eta || ""
      });
    }

    if (activeJobs.has(jobId)) {
      setBadge(String(activeJobs.size));
    }
  }
}

function connectSocket() {
  if (!runtimeAvailable()) return;
  if (!shouldKeepSocket) return;
  
  if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;

  apiReachable().then(function(reachable) {
    if (!reachable) {
      scheduleReconnect();
      return;
    }

    socket = new WebSocket(WS_URL);
    socket.onopen = function() {
      reconnectDelay = 2000;
    };
    socket.onmessage = handleSocketMessage;
    socket.onclose = function() {
      scheduleReconnect();
    };
    socket.onerror = function() {
      try { if (socket) socket.close(); } catch (err) {}
    };
  });
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

if (globalThis.chrome && globalThis.chrome.runtime && globalThis.chrome.runtime.onMessage) {
  globalThis.chrome.runtime.onMessage.addListener(function(message, _sender, sendResponse) {
    if (!message) return false;

    if (message.type === "TRACK_JOB") {
      if (message.jobId) {
        activeJobs.add(message.jobId);
        queueActivityUpdate(message.jobId, {
          title: message.meta && message.meta.sourceTitle ? message.meta.sourceTitle : (message.title || "Video"),
          state: "queued",
          mediaType: message.meta && message.meta.mediaType ? message.meta.mediaType : "video",
          qualityLabel: message.meta && message.meta.qualityLabel ? message.meta.qualityLabel : "",
          formatLabel: message.meta && message.meta.formatLabel ? message.meta.formatLabel : "",
          thumbnailUrl: message.meta && message.meta.sourceThumbnailUrl ? message.meta.sourceThumbnailUrl : "",
          sourceUrl: message.meta && message.meta.sourceUrl ? message.meta.sourceUrl : "",
          videoId: message.meta && message.meta.sourceVideoId ? message.meta.sourceVideoId : ""
        }).then(function() {
          shouldKeepSocket = true;
          setBadge(String(activeJobs.size));
          connectSocket();
          broadcastActivityUpdated(message.jobId, "queued");
        });
      }
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "ENSURE_WS") {
      shouldKeepSocket = true;
      connectSocket();
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "STOP_WS") {
      shouldKeepSocket = false;
      activeJobs.clear();
      lastProgressUpdate = {};
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { if (socket) socket.close(); } catch (err) { /* ignore */ }
      socket = null;
      reconnectDelay = 2000;
      setBadge("");
      activityUpdateQueue = activityUpdateQueue.then(function() {
        return writeActivity([]);
      }).then(function() {
        sendResponse({ ok: true });
      });
      return true;
    }

    if (message.type === "GET_ACTIVITY") {
      // Ensure we wait for any pending writes to disk before reading
      activityUpdateQueue.then(function() {
        return readActivity().then(function(items) {
          return reconcileActivityState(items);
        });
      }).then(function(items) {
        sendResponse({ ok: true, items: items });
      });
      return true;
    }

    if (message.type === "PREFETCH_FORMATS") {
      ensureFormatsPrefetch(message.url, {
        force: Boolean(message.force),
        awaitResult: Boolean(message.awaitResult),
      }).then(function(snapshot) {
        sendResponse({ ok: true, snapshot: snapshot });
      }).catch(function(error) {
        sendResponse({
          ok: false,
          error: normalizePrefetchError(error),
          snapshot: getCachedPrefetch(message.url),
        });
      });
      return true;
    }

    return false;
  });
}

// ---------------------------------------------------------------------------
// Notification click handler
// ---------------------------------------------------------------------------

if (globalThis.chrome && globalThis.chrome.notifications && globalThis.chrome.notifications.onClicked) {
  globalThis.chrome.notifications.onClicked.addListener(function(notificationId) {
    var entry = notificationTargets.get(notificationId);
    if (entry && entry.path) {
      void revealPath(entry.path);
    }
    notificationTargets.delete(notificationId);
    try {
      globalThis.chrome.notifications.clear(notificationId);
    } catch (err) {}
  });
}
