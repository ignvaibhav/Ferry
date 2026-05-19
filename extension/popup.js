/**
 * Ferry popup — focused transfer control surface.
 */

import { checkHealth, revealPath, openPath, cancelJob, openSettings } from "./api.js";
import { runtimeAvailable, safeSendMessage } from "./runtime.js";

var statusDot = document.getElementById("status-dot");
var statusPill = document.getElementById("status-pill");
var statusPillText = document.getElementById("status-pill-text");
var openSettingsBtn = document.getElementById("open-settings");
var launchAppBtn = document.getElementById("launch-app");
var jobListEl = document.getElementById("job-list");
var clearBtn = document.getElementById("clear-activity");
var summaryActiveEl = document.getElementById("summary-active");
var summaryDoneEl = document.getElementById("summary-done");
var summaryErrorEl = document.getElementById("summary-error");
var signalCards = Array.from(document.querySelectorAll("[data-signal]"));
var refreshTimer = null;
var THEME_STORAGE_KEY = "ferryPopupThemeMode";
var systemThemeQuery = globalThis.matchMedia ? globalThis.matchMedia("(prefers-color-scheme: dark)") : null;

var state = {
  focus: "all",
  pinnedJobId: null,
  items: [],
  health: null,
  themeMode: "system",
  liveProgress: {},
};

function getStorage() {
  return globalThis.chrome && globalThis.chrome.storage && globalThis.chrome.storage.local;
}

function openExtensionSettingsPage() {
  var runtime = globalThis.chrome && globalThis.chrome.runtime;
  var tabs = globalThis.chrome && globalThis.chrome.tabs;
  if (runtime && typeof runtime.openOptionsPage === "function") {
    return runtime.openOptionsPage().catch(function() {
      if (runtime && typeof runtime.getURL === "function" && tabs && typeof tabs.create === "function") {
        return tabs.create({ url: runtime.getURL("settings.html") }).catch(function() {});
      }
    });
  }
  if (runtime && typeof runtime.getURL === "function" && tabs && typeof tabs.create === "function") {
    return tabs.create({ url: runtime.getURL("settings.html") }).catch(function() {});
  }
  return Promise.resolve();
}

function getResolvedTheme(themeMode) {
  if (themeMode === "light") return "light";
  if (themeMode === "dark") return "dark";
  return systemThemeQuery && systemThemeQuery.matches ? "dark" : "light";
}

function applyThemeMode(themeMode) {
  var nextMode = themeMode === "light" || themeMode === "dark" ? themeMode : "system";
  var resolvedTheme = getResolvedTheme(nextMode);
  state.themeMode = nextMode;
  if (document.body) {
    document.body.setAttribute("data-theme-mode", nextMode);
    document.body.setAttribute("data-theme", resolvedTheme);
  }
}

function loadThemeMode() {
  var storage = getStorage();
  if (!storage || !storage.get) {
    applyThemeMode("system");
    return Promise.resolve();
  }
  return storage.get(THEME_STORAGE_KEY).then(function(data) {
    applyThemeMode(data && data[THEME_STORAGE_KEY] ? data[THEME_STORAGE_KEY] : "system");
  }).catch(function() {
    applyThemeMode("system");
  });
}

function handleSystemThemeChange() {
  if (state.themeMode === "system") {
    applyThemeMode("system");
  }
}

function handleStorageChange(changes, areaName) {
  if (areaName !== "local" || !changes || !changes[THEME_STORAGE_KEY]) return;
  var nextValue = changes[THEME_STORAGE_KEY].newValue;
  applyThemeMode(nextValue || "system");
}

function applyHealthState(health) {
  state.health = health || null;
  var offlineBanner = document.getElementById("offline-banner");
  if (state.health) {
    if (statusDot) statusDot.className = "pill-dot";
    if (statusPillText) statusPillText.textContent = "Online";
    if (statusPill) {
      statusPill.title = "Ferry desktop online";
      statusPill.className = "pill pill-live";
    }
    if (offlineBanner) offlineBanner.hidden = true;
  } else {
    if (statusDot) statusDot.className = "pill-dot";
    if (statusPillText) statusPillText.textContent = "Offline";
    if (statusPill) {
      statusPill.title = "Ferry desktop not reachable";
      statusPill.className = "pill pill-error";
    }
    if (offlineBanner) offlineBanner.hidden = false;
  }
}

function refreshHealthState() {
  return checkHealth().then(function(health) {
    applyHealthState(health);
    return health;
  }).catch(function() {
    applyHealthState(null);
    return null;
  });
}

function formatTime(iso) {
  if (!iso) return "";
  var date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getStatusText(item) {
  if (item.state === "done") return "Saved";
  if (item.state === "error") return "Error";
  if (item.state === "queued") return "Queued";
  if (item.state === "progress") {
    var pct = typeof item.progress === "number" ? item.progress : 0;
    return pct + "%";
  }
  return "Unknown";
}

function getMediaBadge(item) {
  if (item.mediaType === "audio") return "Audio";
  if (item.mediaType === "thumbnail") return "Thumb";
  return "Video";
}

function getSourceKindBadge(item) {
  if (item.sourceKind === "short") return "Short";
  if (item.sourceKind === "long") return "Long";
  try {
    var parsed = new URL(item.sourceUrl || "");
    return parsed.pathname.indexOf("/shorts/") === 0 ? "Short" : "Long";
  } catch (error) {
    return "Long";
  }
}

function getJobMetaLine(item) {
  return item.qualityLabel || item.formatLabel || "";
}

function getJobQuality(item) {
  var meta = item.qualityLabel || item.formatLabel || "";
  var parts = meta.split("·");
  if (parts.length >= 2) {
    return parts[1].trim();
  }
  return "";
}

function getThumbnailMarkup(item) {
  if (item.thumbnailUrl) {
    return '<img class="transfer-thumb-img" src="' + escapeHtml(item.thumbnailUrl) + '" alt="" loading="lazy" referrerpolicy="no-referrer" />';
  }
  return '<span style="font-size: 18px;">🎬</span>';
}

function getItemsForFocus(items, focus, pinnedJobId) {
  if (focus === "pinned") {
    return items.filter(function(item) {
      return item.jobId === pinnedJobId;
    });
  }
  if (focus === "active") {
    return items.filter(function(item) {
      return item.state === "queued" || item.state === "progress";
    });
  }
  if (focus === "done") {
    return items.filter(function(item) {
      return item.state === "done";
    });
  }
  if (focus === "attention") {
    return items.filter(function(item) {
      return item.state === "error" || item.state === "queued";
    });
  }
  return items;
}

function updateHero(items) {
  var activeCount = items.filter(function(item) { return item.state === "queued" || item.state === "progress"; }).length;
  var doneCount = items.filter(function(item) { return item.state === "done"; }).length;
  var issueCount = items.filter(function(item) { return item.state === "error"; }).length;
  
  if (summaryActiveEl) summaryActiveEl.textContent = String(activeCount);
  if (summaryDoneEl) summaryDoneEl.textContent = String(doneCount);
  if (summaryErrorEl) summaryErrorEl.textContent = String(issueCount);
}

function renderEmptyState(message, copy) {
  if (!jobListEl) return;
  jobListEl.innerHTML =
    '<div class="empty-state">' +
      '<div class="empty-state-title">' + escapeHtml(message) + '</div>' +
      '<div class="empty-state-copy">' + escapeHtml(copy) + '</div>' +
    '</div>';
}

function createJobCard(item) {
  var card = document.createElement("div");
  card.className = "transfer-card";
  card.id = "job-" + item.jobId;
  card.dataset.jobId = item.jobId;

  var statusText = getStatusText(item);
  var metaLine = getJobMetaLine(item);
  var qualityText = getJobQuality(item);
  var actionMarkup = getJobActionMarkup(item);
  var mediaBadge = getMediaBadge(item);
  var sourceKindBadge = getSourceKindBadge(item);
  
  var qualityBadge = qualityText ? '<span class="transfer-badge transfer-badge-quality" style="margin-left: 6px;">' + escapeHtml(qualityText) + '</span>' : '';
  var sourceBadge = '<span class="transfer-badge transfer-badge-source" style="margin-left: 6px;">' + escapeHtml(sourceKindBadge) + '</span>';
  
  // Progress/status badge: single source of truth
  var progressBadge = '';
  if (item.state === "done") {
    progressBadge = '<span class="transfer-badge transfer-badge-done" style="margin-left: 6px;">Done</span>';
  } else if (item.state === "error") {
    progressBadge = '<span class="transfer-badge transfer-badge-error" style="margin-left: 6px;">Error</span>';
  } else if (item.state === "progress") {
    var pct = typeof item.progress === "number" ? item.progress : 0;
    if (typeof state.liveProgress[item.jobId] === "number" && state.liveProgress[item.jobId] > pct) {
      pct = state.liveProgress[item.jobId];
    }
    progressBadge = '<span class="transfer-badge transfer-badge-active" style="margin-left: 6px;"><span class="ferry-spinner"></span><span class="transfer-pct">' + pct + '%</span></span>';
  } else {
    progressBadge = '<span class="transfer-badge transfer-badge-queued" style="margin-left: 6px;">Queued</span>';
  }
  
  var badges = '<span class="transfer-badge transfer-badge-media">' + escapeHtml(mediaBadge) + '</span>' + sourceBadge + qualityBadge + progressBadge;
  var actionsHtml = actionMarkup ? '<div class="transfer-actions">' + actionMarkup + '</div>' : '';

  var html = 
    '<div class="transfer-thumb">' + getThumbnailMarkup(item) + '</div>' +
    '<div class="transfer-info">' +
      '<div class="transfer-badge-row">' +
        badges +
      '</div>' +
      '<div class="transfer-title" title="' + escapeHtml(item.title) + '">' + escapeHtml(item.title) + '</div>' +
      '<div class="transfer-meta">' + escapeHtml(metaLine) + '</div>' +
    '</div>' +
    actionsHtml;

  card.innerHTML = html;
  return card;
}

function getJobActionMarkup(item) {
  if (item.state === "done" && item.path) {
    return '<button class="transfer-action-btn action-reveal" title="Open folder" aria-label="Open folder" data-action="reveal" data-path="' + escapeHtml(item.path) + '">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>' +
    '</button>';
  }
  if (item.state === "progress" || item.state === "queued") {
    return '<button class="transfer-action-btn action-cancel" title="Cancel" aria-label="Cancel" data-action="cancel" data-job-id="' + escapeHtml(item.jobId) + '">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"/></svg>' +
    '</button>';
  }
  return "";
}

function renderJobList(items) {
  if (!jobListEl) return;
  var safeItems = Array.isArray(items) ? items.slice() : [];
  safeItems.sort(function(a, b) {
    var aTime = new Date((a && (a.updatedAt || a.createdAt)) || 0).getTime();
    var bTime = new Date((b && (b.updatedAt || b.createdAt)) || 0).getTime();
    return bTime - aTime;
  });

  state.items = safeItems;
  updateHero(safeItems);

  var filtered = getItemsForFocus(safeItems, state.focus, state.pinnedJobId);
  if (!filtered.length) {
    if (state.focus === "active") {
      renderEmptyState("No live transfers", "New jobs will appear here as soon as Ferry starts processing.");
      return;
    }
    if (state.focus === "attention") {
      renderEmptyState("No issues right now", "When something fails, it will show up here.");
      return;
    }
    if (state.focus === "done") {
      renderEmptyState("No finished jobs yet", "Completed transfers will stay visible here.");
      return;
    }
    renderEmptyState("No recent activity", "Start a download and Ferry will track it here.");
    return;
  }

  jobListEl.innerHTML = "";
  for (var i = 0; i < filtered.length; i++) {
    try {
      jobListEl.appendChild(createJobCard(filtered[i]));
    } catch (error) {
      console.error("[Ferry-Popup] Failed to render job card", filtered[i], error);
    }
  }
}

function updateJobCardInline(payload) {
  if (!payload || !payload.job_id) return;
  var card = document.getElementById("job-" + payload.job_id);
  if (!card) {
    loadActivity();
    return;
  }

  // Find the last badge in the badge row — that's our progress badge
  var badgeRow = card.querySelector(".transfer-badge-row");
  var activeBadge = badgeRow ? badgeRow.querySelector(".transfer-badge-active, .transfer-badge-queued, .transfer-badge-done, .transfer-badge-error") : null;

  if (payload.event === "progress") {
    var pct = typeof payload.percent === "number" ? payload.percent : 0;
    state.liveProgress[payload.job_id] = pct;

    if (activeBadge) {
      // Replace with active badge if it was queued
      if (!activeBadge.classList.contains("transfer-badge-active")) {
        var newBadge = document.createElement("span");
        newBadge.className = "transfer-badge transfer-badge-active";
        newBadge.style.marginLeft = "6px";
        newBadge.innerHTML = '<span class="ferry-spinner"></span><span class="transfer-pct">' + pct + '%</span>';
        activeBadge.replaceWith(newBadge);
      } else {
        var pctEl = activeBadge.querySelector(".transfer-pct");
        if (pctEl) pctEl.textContent = pct + "%";
      }
    }
  } else if (payload.event === "done") {
    if (activeBadge) {
      var doneBadge = document.createElement("span");
      doneBadge.className = "transfer-badge transfer-badge-done";
      doneBadge.style.marginLeft = "6px";
      doneBadge.textContent = "Done";
      activeBadge.replaceWith(doneBadge);
    }
    setTimeout(loadActivity, 800);
  } else if (payload.event === "error") {
    if (activeBadge) {
      var errBadge = document.createElement("span");
      errBadge.className = "transfer-badge transfer-badge-error";
      errBadge.style.marginLeft = "6px";
      errBadge.textContent = "Error";
      activeBadge.replaceWith(errBadge);
    }
    setTimeout(loadActivity, 800);
  }
}

function processBuffer() {
  while (eventBuffer.length > 0) {
    updateJobCardInline(eventBuffer.shift());
  }
}

var isInitialLoading = true;
var isActivityLoading = false;
var eventBuffer = [];

function loadActivity() {
  if (isActivityLoading) return Promise.resolve();
  isActivityLoading = true;

  return safeSendMessage({ type: "GET_ACTIVITY" }).then(function(response) {
    var items = (response && response.items) || [];
    // Merge live progress into items so re-renders don't flicker back to "queued"
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item && item.jobId && typeof state.liveProgress[item.jobId] === "number") {
        var livePct = state.liveProgress[item.jobId];
        if (livePct > 0 && (item.state === "queued" || item.state === "progress")) {
          item.state = "progress";
          item.progress = livePct;
        }
      }
    }
    renderJobList(items);
    isActivityLoading = false;
    processBuffer();
  }).catch(function() {
    isActivityLoading = false;
  });
}

function applyPrimaryAction(health) {
  state.health = health || null;
}

function setFocus(nextFocus) {
  state.focus = nextFocus;
  renderJobList(state.items);
}

function init() {
  loadThemeMode();

  if (runtimeAvailable()) {
    var runtime = globalThis.chrome && globalThis.chrome.runtime;
    if (runtime && runtime.onMessage) {
      runtime.onMessage.addListener(function(message) {
        if (!message) return;
        if (message.type === "WS_EVENT") {
          updateJobCardInline(message.payload);
          return;
        }
        if (message.type === "ACTIVITY_UPDATED") {
          loadActivity();
        }
      });
    }
  }

  var storageApi = globalThis.chrome && globalThis.chrome.storage;
  if (storageApi && storageApi.onChanged && typeof storageApi.onChanged.addListener === "function") {
    storageApi.onChanged.addListener(handleStorageChange);
  }

  signalCards.forEach(function(card) {
    card.addEventListener("click", function() {
      setFocus(card.dataset.signal === "attention" ? "attention" : card.dataset.signal || "all");
    });
  });

  if (systemThemeQuery) {
    if (typeof systemThemeQuery.addEventListener === "function") {
      systemThemeQuery.addEventListener("change", handleSystemThemeChange);
    } else if (typeof systemThemeQuery.addListener === "function") {
      systemThemeQuery.addListener(handleSystemThemeChange);
    }
  }

  if (openSettingsBtn) {
    openSettingsBtn.onclick = function() {
      openExtensionSettingsPage();
    };
  }

  if (launchAppBtn) {
    launchAppBtn.onclick = function() {
      openSettings();
    };
  }

  if (clearBtn) {
    clearBtn.onclick = function() {
      state.pinnedJobId = null;
      setFocus("all");
      safeSendMessage({ type: "STOP_WS" }).then(loadActivity);
    };
  }

  loadActivity().then(function() {
    isInitialLoading = false;
  });

  // Event delegation for action buttons — survives re-renders
  if (jobListEl) {
    jobListEl.addEventListener("click", function(e) {
      console.log("[Ferry Popup] jobList click, target:", e.target.tagName, e.target.className, "closest btn:", e.target.closest(".transfer-action-btn"));
      var btn = e.target.closest(".transfer-action-btn");
      if (!btn) return;
      e.stopPropagation();
      var action = btn.dataset.action;
      console.log("[Ferry Popup] Action button clicked:", action, "jobId:", btn.dataset.jobId);
      if (action === "reveal") {
        revealPath(btn.dataset.path).then(function(result) {
          if (result && result.ok === false) refreshHealthState();
        });
      } else if (action === "open") {
        openPath(btn.dataset.path).then(function(result) {
          if (result && result.ok === false) refreshHealthState();
        });
      } else if (action === "cancel") {
        var jobId = btn.dataset.jobId;
        console.log("[Ferry Popup] Cancel clicked, jobId:", jobId);
        if (!jobId) return;
        cancelJob(jobId).then(function(result) {
          console.log("[Ferry Popup] Cancel result:", JSON.stringify(result));
          if (result && result.ok === false) {
            return refreshHealthState().then(loadActivity);
          }
          return loadActivity();
        });
      }
    });
  }

  refreshTimer = setInterval(loadActivity, 2500);

  document.addEventListener("visibilitychange", function() {
    if (document.visibilityState === "visible") loadActivity();
  });

  refreshHealthState().then(function(health) {
    applyPrimaryAction(health);
  });
}

init();
