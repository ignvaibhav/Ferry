import { checkHealth, openSettings, openDownloads } from "./api.js";
import { ACTIVITY_KEY } from "./constants.js";

var THEME_STORAGE_KEY = "ferryPopupThemeMode";
var systemThemeQuery = globalThis.matchMedia ? globalThis.matchMedia("(prefers-color-scheme: dark)") : null;

var statusEl = document.getElementById("settings-status");
var versionEl = document.getElementById("extension-version");
var currentThemeModeEl = document.getElementById("current-theme-mode");
var desktopLinkStateEl = document.getElementById("desktop-link-state");
var activityCountEl = document.getElementById("activity-count");
var themeButtons = Array.from(document.querySelectorAll("[data-theme-mode]"));
var clearActivityBtn = document.getElementById("clear-extension-activity");
var desktopSettingsBtn = document.getElementById("open-desktop-settings");
var desktopDownloadsBtn = document.getElementById("open-desktop-downloads");
var backToPopupBtn = document.getElementById("back-to-popup");

var state = {
  themeMode: "system",
  healthOnline: false,
};

function getStorage() {
  return globalThis.chrome && globalThis.chrome.storage && globalThis.chrome.storage.local;
}

function getResolvedTheme(themeMode) {
  if (themeMode === "light") return "light";
  if (themeMode === "dark") return "dark";
  return systemThemeQuery && systemThemeQuery.matches ? "dark" : "light";
}

function syncThemeButtons() {
  themeButtons.forEach(function(button) {
    var active = button.dataset.themeMode === state.themeMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  if (currentThemeModeEl) {
    currentThemeModeEl.textContent = state.themeMode.charAt(0).toUpperCase() + state.themeMode.slice(1);
  }
}

function applyThemeMode(themeMode) {
  var nextMode = themeMode === "light" || themeMode === "dark" ? themeMode : "system";
  state.themeMode = nextMode;
  if (document.body) {
    document.body.setAttribute("data-theme-mode", nextMode);
    document.body.setAttribute("data-theme", getResolvedTheme(nextMode));
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

function loadActivityCount() {
  var storage = getStorage();
  if (!storage || !storage.get) return Promise.resolve();
  return storage.get(ACTIVITY_KEY).then(function(data) {
    var items = Array.isArray(data && data[ACTIVITY_KEY]) ? data[ACTIVITY_KEY] : [];
    if (activityCountEl) {
      activityCountEl.textContent = items.length + (items.length === 1 ? " item" : " items");
    }
  }).catch(function() {
    if (activityCountEl) activityCountEl.textContent = "0 items";
  });
}

function clearActivity() {
  var storage = getStorage();
  if (!storage || !storage.set) return Promise.resolve();
  var payload = {};
  payload[ACTIVITY_KEY] = [];
  return storage.set(payload).then(loadActivityCount).catch(function() {});
}

function updateHealthState(online, version) {
  state.healthOnline = !!online;
  if (statusEl) {
    statusEl.className = "health-pill " + (online ? "online" : "offline");
    statusEl.textContent = online ? "Island online" : "Island offline";
  }
  if (desktopLinkStateEl) {
    desktopLinkStateEl.textContent = online ? ("Connected" + (version ? " (" + version + ")" : "")) : "Not reachable";
  }
}

function checkDesktopHealth() {
  return checkHealth().then(function(health) {
    updateHealthState(true, health && health.version ? health.version : "");
  }).catch(function() {
    updateHealthState(false, "");
  });
}

function initMeta() {
  var runtime = globalThis.chrome && globalThis.chrome.runtime;
  if (runtime && typeof runtime.getManifest === "function" && versionEl) {
    var manifest = runtime.getManifest();
    versionEl.textContent = manifest && manifest.version ? manifest.version : "0.0.0";
  }
}

function openPopupFallback() {
  var runtime = globalThis.chrome && globalThis.chrome.runtime;
  var tabs = globalThis.chrome && globalThis.chrome.tabs;
  if (runtime && typeof runtime.getURL === "function" && tabs && typeof tabs.create === "function") {
    return tabs.create({ url: runtime.getURL("popup.html") }).catch(function() {});
  }
  return Promise.resolve();
}

function bindEvents() {
  themeButtons.forEach(function(button) {
    button.addEventListener("click", function() {
      var nextMode = button.dataset.themeMode || "system";
      applyThemeMode(nextMode);
      saveThemeMode(nextMode);
    });
  });

  if (clearActivityBtn) {
    clearActivityBtn.addEventListener("click", function() {
      clearActivity();
    });
  }

  if (desktopSettingsBtn) {
    desktopSettingsBtn.addEventListener("click", function() {
      openSettings();
    });
  }

  if (desktopDownloadsBtn) {
    desktopDownloadsBtn.addEventListener("click", function() {
      openDownloads();
    });
  }

  if (backToPopupBtn) {
    backToPopupBtn.addEventListener("click", function() {
      openPopupFallback();
    });
  }

  if (systemThemeQuery) {
    if (typeof systemThemeQuery.addEventListener === "function") {
      systemThemeQuery.addEventListener("change", function() {
        if (state.themeMode === "system") applyThemeMode("system");
      });
    } else if (typeof systemThemeQuery.addListener === "function") {
      systemThemeQuery.addListener(function() {
        if (state.themeMode === "system") applyThemeMode("system");
      });
    }
  }
}

Promise.all([
  loadThemeMode(),
  loadActivityCount(),
  checkDesktopHealth()
]).finally(function() {
  initMeta();
  bindEvents();
});
