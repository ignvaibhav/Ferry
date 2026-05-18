const GITHUB_REPO = "https://github.com/ignvaibhav/Ferry";
const LATEST_RELEASE_API = "https://api.github.com/repos/ignvaibhav/Ferry/releases/latest";
const FALLBACK_RELEASE_URL = `${GITHUB_REPO}/releases/latest`;

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.style.opacity = "1";
      entry.target.style.transform = "translateY(0)";
    }
  });
}, { threshold: 0.1 });

document.querySelectorAll(".problem-card, .feature-card, .flow-step, .install-step").forEach((el) => {
  el.style.opacity = "0";
  el.style.transform = "translateY(20px)";
  el.style.transition = "opacity 0.5s ease, transform 0.5s ease";
  observer.observe(el);
});

document.querySelectorAll(".feature-card").forEach((el, i) => {
  el.style.transitionDelay = `${i * 0.07}s`;
});

document.querySelectorAll(".problem-card").forEach((el, i) => {
  el.style.transitionDelay = `${i * 0.1}s`;
});

function detectOS() {
  const ua = navigator.userAgent;
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
  if (/Mac|iPhone|iPad|iPod/i.test(platform) || /Mac/i.test(ua)) return "mac";
  if (/Win/i.test(platform) || /Windows/i.test(ua)) return "windows";
  if (/Linux/i.test(platform) || /Linux/i.test(ua)) return "linux";
  return "unknown";
}

function getAssetForOS(assets, os) {
  if (!assets || !assets.length) return null;
  const patterns = {
    mac: [/mac/i, /darwin/i, /\.dmg$/i, /macos/i, /osx/i],
    windows: [/win/i, /\.exe$/i, /windows/i, /setup/i],
    linux: [/linux/i, /\.AppImage$/i, /\.deb$/i, /\.rpm$/i],
  };
  const matchers = patterns[os] || [];
  for (const pattern of matchers) {
    const match = assets.find((a) => pattern.test(a.name));
    if (match) return match.browser_download_url;
  }
  return null;
}

function getOSLabel(os) {
  const betaBadge = `<span style="font-size: 9px; background: rgba(255, 255, 255, 0.15); color: #fff; padding: 2px 5px; border-radius: 4px; margin-left: 6px; vertical-align: middle; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 800;">BETA</span>`;
  if (os === "mac") return { label: "Download for macOS", icon: "" };
  if (os === "windows") return { label: `Download for Windows ${betaBadge}`, icon: "🪟" };
  if (os === "linux") return { label: `Download for Linux ${betaBadge}`, icon: "🐧" };
  return { label: "Download", icon: "⬇" };
}

function updatePlatformPills(os) {
  document.querySelectorAll(".platform-pill").forEach((pill) => {
    const text = pill.textContent.toLowerCase();
    const isActive =
      (os === "mac" && text.includes("macos")) ||
      (os === "windows" && text.includes("windows")) ||
      (os === "linux" && text.includes("linux"));

    pill.classList.toggle("platform-active", isActive);
    const dot = pill.querySelector(".platform-dot");
    if (dot) {
      dot.style.background = isActive ? "var(--accent)" : "var(--muted2)";
    }
  });
}

async function syncLatestRelease() {
  const os = detectOS();
  const { label, icon } = getOSLabel(os);

  const releaseLinks = Array.from(document.querySelectorAll("[data-release-link]"));
  const releaseLabels = Array.from(document.querySelectorAll("[data-release-version]"));

  // Set initial OS-aware label on buttons
  releaseLinks.forEach((link) => {
    link.href = FALLBACK_RELEASE_URL;
    if (link.tagName === "A" && link.classList.contains("btn-primary")) {
      link.innerHTML = `<span class="btn-icon">${icon || "⬇"}</span> ${label}`;
    }
  });

  updatePlatformPills(os);

  try {
    const response = await fetch(LATEST_RELEASE_API, {
      headers: { Accept: "application/vnd.github+json" },
    });

    if (!response.ok) throw new Error(`GitHub API responded with ${response.status}`);

    const data = await response.json();
    const version = typeof data.tag_name === "string" ? data.tag_name : "Latest release";
    const releaseUrl = typeof data.html_url === "string" ? data.html_url : FALLBACK_RELEASE_URL;
    const assetUrl = getAssetForOS(data.assets || [], os);
    const extAsset = (data.assets || []).find((a) => /ferry-extension\.zip$/i.test(a.name));
    
    // Update step 2 button
    const extDownloadBtn = document.getElementById("ext-download-btn");
    if (extDownloadBtn && extAsset) {
      extDownloadBtn.href = extAsset.browser_download_url;
    } else if (extDownloadBtn) {
      extDownloadBtn.href = releaseUrl;
    }

    // Update hero button
    const heroExtBtn = document.getElementById("hero-ext-btn");
    if (heroExtBtn && extAsset) {
      heroExtBtn.href = extAsset.browser_download_url;
    } else if (heroExtBtn) {
      heroExtBtn.href = releaseUrl;
    }

    releaseLinks.forEach((link) => {
      // Use direct asset download if available, else fallback to release page
      link.href = assetUrl || releaseUrl;
    });

    releaseLabels.forEach((node) => {
      node.textContent = version;
    });
  } catch (err) {
    console.error("Failed to load release info:", err);
  }
}

async function loadContributors() {
  const container = document.getElementById("github-contributors");
  if (!container) return;

  const CACHE_KEY = "ferry_contributors";
  const CACHE_TIME = 1000 * 60 * 60; // 1 hour

  let contributors = [
    { login: "ignvaibhav", avatar_url: "https://github.com/ignvaibhav.png", html_url: "https://github.com/ignvaibhav", contributions: 100 }
  ];

  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Date.now() - parsed.timestamp < CACHE_TIME) {
        contributors = parsed.data;
      }
    }

    if (contributors.length === 1) { // Only fetch if we don't have valid cache
      const res = await fetch("https://api.github.com/repos/ignvaibhav/Ferry/contributors?per_page=5");
      if (res.ok) {
        contributors = await res.json();
        localStorage.setItem(CACHE_KEY, JSON.stringify({ timestamp: Date.now(), data: contributors }));
      } else {
        console.warn("GitHub API rate limit exceeded. Using fallback contributors.");
      }
    }
  } catch (err) {
    console.error("Failed to load contributors:", err);
  }

  let html = "";
  const sizes = [38, 34, 30, 28, 28]; // Largest for top contributor
  contributors.forEach((c, idx) => {
    const size = sizes[idx] || 28;
    html += `<a href="${c.html_url}" target="_blank" rel="noreferrer" title="${c.login} (${c.contributions || ''} contributions)" style="width: ${size}px; height: ${size}px; z-index: ${10 - idx};">
      <img src="${c.avatar_url}" alt="${c.login}">
    </a>`;
  });
  
  container.innerHTML = html;
}

document.addEventListener("DOMContentLoaded", () => {
  syncLatestRelease();
  loadContributors();
});
