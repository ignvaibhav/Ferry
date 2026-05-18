import { checkHealth, openSettings, openDownloads } from "./api.js";
import { ACTIVITY_KEY } from "./constants.js";

var THEME_STORAGE_KEY = "ferryPopupThemeMode";
var HEALTH_REFRESH_MS = 15000;
var FEEDBACK_HIDE_MS = 2800;
var systemThemeQuery = globalThis.matchMedia ? globalThis.matchMedia("(prefers-color-scheme: dark)") : null;

var statusEl = document.getElementById("settings-status");
var currentThemeModeEl = document.getElementById("current-theme-mode");
var desktopLinkStateEl = document.getElementById("desktop-link-state");
var islandPortEl = document.getElementById("island-port");
var downloadDirNameEl = document.getElementById("download-dir-name");
var themeButtons = Array.from(document.querySelectorAll("[data-theme-mode]"));
var desktopSettingsBtn = document.getElementById("open-desktop-settings");
var desktopDownloadsBtn = document.getElementById("open-desktop-downloads");
var closeSettingsBtn = document.getElementById("close-settings");
var feedbackEl = document.getElementById("settings-feedback");

var state = {
  themeMode: "system",
  feedbackTimer: null,
  healthRefreshTimer: null,
  latestRelease: null,
};

function getStorage() {
  return globalThis.chrome && globalThis.chrome.storage && globalThis.chrome.storage.local;
}

function formatThemeMode(themeMode) {
  var value = themeMode || "system";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatDownloadButtonLabel(downloadDirName) {
  if (!downloadDirName) return "Open downloads folder";
  return "Open " + downloadDirName + " folder";
}

function getResolvedTheme(themeMode) {
  if (themeMode === "light") return "light";
  if (themeMode === "dark") return "dark";
  return systemThemeQuery && systemThemeQuery.matches ? "dark" : "light";
}

function setFeedback(message, tone) {
  if (!feedbackEl) return;

  if (state.feedbackTimer) {
    clearTimeout(state.feedbackTimer);
    state.feedbackTimer = null;
  }

  if (!message) {
    feedbackEl.hidden = true;
    feedbackEl.textContent = "";
    feedbackEl.removeAttribute("data-tone");
    return;
  }

  feedbackEl.hidden = false;
  feedbackEl.textContent = message;
  feedbackEl.setAttribute("data-tone", tone || "info");

  state.feedbackTimer = setTimeout(function() {
    feedbackEl.hidden = true;
    feedbackEl.textContent = "";
    feedbackEl.removeAttribute("data-tone");
    state.feedbackTimer = null;
  }, FEEDBACK_HIDE_MS);
}

function syncThemeButtons() {
  themeButtons.forEach(function(button) {
    var active = button.dataset.themeMode === state.themeMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });

  if (currentThemeModeEl) {
    currentThemeModeEl.textContent = formatThemeMode(state.themeMode);
  }
}

function applyThemeMode(themeMode) {
  var nextMode = themeMode === "light" || themeMode === "dark" ? themeMode : "system";
  var resolvedTheme = getResolvedTheme(nextMode);
  state.themeMode = nextMode;
  if (document.documentElement) {
    document.documentElement.setAttribute("data-theme-mode", nextMode);
    document.documentElement.setAttribute("data-theme", resolvedTheme);
  }
  if (document.body) {
    document.body.setAttribute("data-theme-mode", nextMode);
    document.body.setAttribute("data-theme", resolvedTheme);
  }
  syncThemeButtons();
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

function saveThemeMode(themeMode) {
  var storage = getStorage();
  if (!storage || !storage.set) return Promise.resolve();
  var payload = {};
  payload[THEME_STORAGE_KEY] = themeMode;
  return storage.set(payload).catch(function() {});
}

function loadLatestReleaseInfo() {
  var releaseVersionEl = document.getElementById("latest-release-version");
  if (releaseVersionEl && !state.latestRelease) releaseVersionEl.textContent = "Checking…";

  return fetch("https://api.github.com/repos/ignvaibhav/Ferry/releases/latest", {
    headers: { Accept: "application/vnd.github+json" }
  }).then(function(res) {
    if (!res.ok) throw new Error();
    return res.json();
  }).then(function(data) {
    if (data && data.tag_name) {
      state.latestRelease = data.tag_name;
      if (releaseVersionEl) releaseVersionEl.textContent = data.tag_name;
    } else {
      state.latestRelease = null;
      if (releaseVersionEl) releaseVersionEl.textContent = "Unavailable";
    }
  }).catch(function() {
    state.latestRelease = null;
    if (releaseVersionEl) releaseVersionEl.textContent = "Unavailable";
  });
}

function writeValue(element, value) {
  if (!element) return;
  element.textContent = value || "—";
}

function updateHealthState(health) {
  var online = Boolean(health);
  var downloadDirName = health && health.download_dir_name ? health.download_dir_name : "";

  if (statusEl) {
    statusEl.className = "pill " + (online ? "pill-live" : "pill-error");
    statusEl.textContent = online ? "Island online" : "Island offline";
  }

  if (desktopLinkStateEl) {
    desktopLinkStateEl.textContent = online ? "Connected" : "Offline";
  }

  writeValue(islandPortEl, health && health.port ? String(health.port) : "—");
  writeValue(downloadDirNameEl, downloadDirName || "—");

  if (desktopDownloadsBtn) {
    desktopDownloadsBtn.textContent = formatDownloadButtonLabel(downloadDirName);
  }
}

function checkDesktopHealth() {
  return checkHealth().then(function(health) {
    updateHealthState(health);
    return health;
  }).catch(function() {
    updateHealthState(null);
    return null;
  });
}

function openPopupFallback() {
  if (history.length > 1) {
    history.back();
    return Promise.resolve();
  }

  try {
    globalThis.close();
    return Promise.resolve();
  } catch (_) {}

  return Promise.resolve();
}

function setButtonBusy(button, busy) {
  if (!button) return;
  button.disabled = Boolean(busy);
}

function runDesktopAction(button, action, successMessage, failureMessage) {
  setButtonBusy(button, true);
  return action().then(function(result) {
    if (result && result.ok === false) {
      setFeedback(result.error || failureMessage, "error");
      return null;
    }
    setFeedback(successMessage, "success");
    return checkDesktopHealth();
  }).catch(function() {
    setFeedback(failureMessage, "error");
    return null;
  }).finally(function() {
    setButtonBusy(button, false);
  });
}

function handleSystemThemeChange() {
  if (state.themeMode === "system") {
    applyThemeMode("system");
  }
}

function handleStorageChange(changes, areaName) {
  if (areaName !== "local" || !changes) return;

  if (changes[THEME_STORAGE_KEY]) {
    applyThemeMode(changes[THEME_STORAGE_KEY].newValue || "system");
  }
}

function bindEvents() {
  themeButtons.forEach(function(button) {
    button.addEventListener("click", function() {
      var nextMode = button.dataset.themeMode || "system";
      applyThemeMode(nextMode);
      saveThemeMode(nextMode).then(function() {
        setFeedback("Theme updated to " + formatThemeMode(nextMode) + ".", "success");
      });
    });
  });

  if (desktopSettingsBtn) {
    desktopSettingsBtn.addEventListener("click", function() {
      runDesktopAction(
        desktopSettingsBtn,
        openSettings,
        "Opened Island settings.",
        "Could not open Island settings."
      );
    });
  }

  if (desktopDownloadsBtn) {
    desktopDownloadsBtn.addEventListener("click", function() {
      runDesktopAction(
        desktopDownloadsBtn,
        openDownloads,
        "Opened downloads folder.",
        "Could not open downloads folder."
      );
    });
  }

  if (closeSettingsBtn) {
    closeSettingsBtn.addEventListener("click", function() {
      openPopupFallback();
    });
  }

  if (systemThemeQuery) {
    if (typeof systemThemeQuery.addEventListener === "function") {
      systemThemeQuery.addEventListener("change", handleSystemThemeChange);
    } else if (typeof systemThemeQuery.addListener === "function") {
      systemThemeQuery.addListener(handleSystemThemeChange);
    }
  }

  var storageApi = globalThis.chrome && globalThis.chrome.storage;
  if (storageApi && storageApi.onChanged && typeof storageApi.onChanged.addListener === "function") {
    storageApi.onChanged.addListener(handleStorageChange);
  }

  document.addEventListener("visibilitychange", function() {
    if (document.visibilityState === "visible") {
      checkDesktopHealth();
      loadLatestReleaseInfo();
    }
  });
}

function startHealthRefreshLoop() {
  if (state.healthRefreshTimer) clearInterval(state.healthRefreshTimer);
  state.healthRefreshTimer = setInterval(checkDesktopHealth, HEALTH_REFRESH_MS);
}

Promise.all([
  loadThemeMode(),
  checkDesktopHealth(),
  loadLatestReleaseInfo(),
]).finally(function() {
  bindEvents();
  startHealthRefreshLoop();
});
