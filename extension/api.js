/**
 * API client for communicating with the Ferry local desktop companion.
 * Consolidates fetch wrappers previously duplicated in content.js and popup.js.
 */

import { API_BASE } from "./constants.js";

function postLocalAction(path, body, fallbackMessage) {
  return fetch(API_BASE + path, {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then(function(res) {
    if (!res.ok) {
      return Promise.resolve({
        ok: false,
        status: res.status,
        error: fallbackMessage + " (" + res.status + ")",
      });
    }
    return Promise.resolve({ ok: true, status: res.status });
  }).catch(function(err) {
    return {
      ok: false,
      status: 0,
      error: err && err.message ? err.message : fallbackMessage,
    };
  });
}

/**
 * Check if the desktop companion is reachable.
 * @returns {Promise<object>} Health response with { status, version, port }.
 */
export function checkHealth() {
  return fetch(API_BASE + "/health")
    .then(function(res) {
      if (!res.ok) throw new Error("health failed");
      return res.json();
    });
}

/**
 * Fetch available download formats for a video URL.
 * @param {string} url - The video URL.
 * @returns {Promise<Array>} List of format option objects.
 */
export function loadFormats(url) {
  return fetch(API_BASE + "/formats", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: url }),
  }).then(function(res) {
    if (!res.ok) throw new Error("formats failed");
    return res.json();
  }).then(function(data) {
    return data.formats || [];
  });
}

/**
 * Submit a download job to the queue.
 * @param {object} payload - Download request payload.
 * @returns {Promise<object>} Response with { job_id }.
 */
export function queueDownload(payload) {
  return fetch(API_BASE + "/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then(function(res) {
    if (!res.ok) throw new Error("download failed");
    return res.json();
  });
}

/**
 * Signal the desktop app to open the settings window.
 */
export function openSettings() {
  return postLocalAction("/action/open-settings", {}, "Failed to open settings");
}

/**
 * Signal the desktop app to open the root downloads directory.
 */
export function openDownloads() {
  return postLocalAction("/action/open-downloads", {}, "Failed to open downloads");
}

/**
 * Signal the desktop app to reveal a specific file or folder.
 * @param {string} path - Absolute path to reveal.
 */
export function revealPath(path) {
  if (!path) return Promise.resolve();
  return postLocalAction("/reveal", { path: path }, "Failed to reveal path");
}

export function openPath(path) {
  if (!path) return Promise.resolve();
  return postLocalAction("/open", { path: path }, "Failed to open file");
}

export function cancelJob(jobId) {
  if (!jobId) return Promise.resolve();
  return postLocalAction("/jobs/" + encodeURIComponent(jobId) + "/cancel", {}, "Failed to cancel job");
}

export function skipJob(jobId) {
  if (!jobId) return Promise.resolve();
  return postLocalAction("/jobs/" + encodeURIComponent(jobId) + "/skip", {}, "Failed to skip job");
}
