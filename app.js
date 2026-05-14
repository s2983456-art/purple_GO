const SHEET_ID = "1q9hW9idIngzQYkSDmkBT0fTOr1vsYjg58jRLrnJUX2M";
const SHEET_GVIZ_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq`;
const STATUS_URL = "data/live-status.json";
const PREVIEW_WIDTH = 320;
const PREVIEW_HEIGHT = 180;
const LIVE_PREVIEW_MIN_BYTES = 4096;
const OFFLINE_PREVIEW_MAX_AGE = 3600;

const RESERVED_TWITCH_PATHS = new Set([
  "about",
  "admin",
  "bits",
  "collections",
  "communities",
  "directory",
  "downloads",
  "drops",
  "embed",
  "event",
  "friends",
  "inventory",
  "jobs",
  "login",
  "moderator",
  "p",
  "payments",
  "popout",
  "prime",
  "products",
  "settings",
  "signup",
  "store",
  "subscriptions",
  "team",
  "turbo",
  "videos",
  "wallet",
]);

const state = {
  channels: [],
  filter: "live",
  query: "",
  selectedLogins: [],
  watchLayout: "paired",
  statusSource: "Sheet",
  lastUpdated: "",
  isRefreshing: false,
  errors: [],
};

const elements = {
  statusLine: document.querySelector("#statusLine"),
  totalCount: document.querySelector("#totalCount"),
  liveCount: document.querySelector("#liveCount"),
  offlineCount: document.querySelector("#offlineCount"),
  unknownCount: document.querySelector("#unknownCount"),
  refreshButton: document.querySelector("#refreshButton"),
  pickTwoButton: document.querySelector("#pickTwoButton"),
  searchInput: document.querySelector("#searchInput"),
  channelGrid: document.querySelector("#channelGrid"),
  emptyState: document.querySelector("#emptyState"),
  sourceBadge: document.querySelector("#sourceBadge"),
  watchTitle: document.querySelector("#watchTitle"),
  watchLayoutButton: document.querySelector("#watchLayoutButton"),
  watchLayoutLabel: document.querySelector("#watchLayoutLabel"),
  watchShell: document.querySelector("#watchShell"),
};

async function init() {
  bindEvents();
  await loadChannels();
  await loadGeneratedStatus();
  render();
  refreshLiveStatus();
}

function bindEvents() {
  elements.refreshButton.addEventListener("click", () => refreshLiveStatus());
  elements.pickTwoButton.addEventListener("click", () => pickRandomLiveChannels(2));
  elements.watchLayoutButton.addEventListener("click", () => toggleWatchLayout());

  elements.searchInput.addEventListener("input", (event) => {
    state.query = event.target.value.trim().toLowerCase();
    renderChannels();
  });

  document.querySelectorAll(".segment-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      document.querySelectorAll(".segment-button").forEach((item) => {
        item.classList.toggle("active", item === button);
      });
      renderChannels();
    });
  });
}

async function loadChannels() {
  try {
    const response = await loadSheetResponse();
    const rows = gvizToRows(response);
    state.channels = extractChannels(rows);
    state.statusSource = "Sheet";
  } catch (error) {
    state.errors.push(`Sheet 載入失敗：${error.message}`);
    state.channels = [];
  }
}

function loadSheetResponse() {
  return new Promise((resolve, reject) => {
    const callbackName = `purpleGoSheet_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}`;
    const script = document.createElement("script");
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("讀取逾時"));
    }, 15000);

    function cleanup() {
      window.clearTimeout(timeout);
      script.remove();
      delete window[callbackName];
    }

    window[callbackName] = (payload) => {
      cleanup();
      if (!payload || payload.status !== "ok") {
        reject(new Error(payload?.errors?.[0]?.detailed_message || "回傳格式不正確"));
        return;
      }
      resolve(payload);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("無法連線到 Google Sheets"));
    };

    const params = new URLSearchParams({
      tqx: `out:json;responseHandler:${callbackName}`,
      cacheBust: String(Date.now()),
    });
    script.src = `${SHEET_GVIZ_URL}?${params.toString()}`;
    document.head.append(script);
  });
}

function gvizToRows(payload) {
  return (payload.table?.rows || []).map((row) => {
    return (row.c || []).map((cell) => {
      const value = cell?.f ?? cell?.v ?? "";
      return String(value).replace(/\s+/g, " ").trim();
    });
  });
}

function extractChannels(rows) {
  const byLogin = new Map();

  rows.forEach((row) => {
    const textCells = row.filter(Boolean);
    const rowText = textCells.join(" ");
    const links = rowText.match(/https?:\/\/(?:www\.)?twitch\.tv\/[^\s"'<>]+/gi) || [];

    links.forEach((link) => {
      const login = loginFromTwitchUrl(link);
      if (!login) return;

      const existing = byLogin.get(login);
      const label = findLabelForRow(textCells, login);

      byLogin.set(login, {
        login,
        label: existing?.label || label || login,
        url: `https://www.twitch.tv/${login}`,
        status: existing?.status || "unknown",
        isLive: existing?.isLive || false,
      });
    });
  });

  return [...byLogin.values()].sort((a, b) =>
    a.label.localeCompare(b.label, "zh-Hant")
  );
}

function loginFromTwitchUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!/(^|\.)twitch\.tv$/i.test(url.hostname)) return "";
    const segment = url.pathname.split("/").filter(Boolean)[0]?.toLowerCase() || "";
    if (!segment || RESERVED_TWITCH_PATHS.has(segment)) return "";
    if (!/^[a-z0-9_]{3,25}$/.test(segment)) return "";
    return segment;
  } catch {
    return "";
  }
}

function findLabelForRow(cells, login) {
  const nonLinks = cells.filter((cell) => !cell.toLowerCase().includes("twitch.tv"));
  return (
    nonLinks.find((cell) => cell && !cell.includes("http")) ||
    cells.find((cell) => cell.toLowerCase().includes(login)) ||
    login
  );
}

async function loadGeneratedStatus() {
  try {
    const response = await fetch(`${STATUS_URL}?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return;

    const payload = await response.json();
    mergeStatus(payload.channels || []);
    state.lastUpdated = payload.updatedAt || "";
    state.statusSource = payload.source || "Preview";
    if (payload.errors?.length) {
      state.errors.push(...payload.errors);
    }
  } catch {
    state.statusSource = "Sheet";
  }
}

async function refreshLiveStatus() {
  if (!state.channels.length || state.isRefreshing) return;

  state.isRefreshing = true;
  render();

  try {
    const statuses = await mapWithConcurrency(state.channels, 6, probeChannelPreview);
    mergeStatus(statuses);
    state.lastUpdated = new Date().toISOString();
    state.statusSource = "Twitch Preview";
    state.errors = state.errors.filter((message) => !message.startsWith("Twitch Preview"));
  } catch (error) {
    state.errors.push(`Twitch Preview：${error.message}`);
  } finally {
    state.isRefreshing = false;
    render();
  }
}

async function probeChannelPreview(channel) {
  const previewUrl = getPreviewUrl(channel.login, PREVIEW_WIDTH, PREVIEW_HEIGHT);

  try {
    const response = await fetch(`${previewUrl}?cb=${Date.now()}`, {
      method: "HEAD",
      cache: "no-store",
    });

    if (!response.ok) {
      return { login: channel.login, status: "unknown", isLive: false };
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    const cacheControl = response.headers.get("cache-control") || "";
    const maxAge = getMaxAge(cacheControl);
    const isOfflinePlaceholder =
      contentLength > 0 &&
      (contentLength < LIVE_PREVIEW_MIN_BYTES || maxAge >= OFFLINE_PREVIEW_MAX_AGE);

    if (isOfflinePlaceholder) {
      return {
        login: channel.login,
        status: "offline",
        isLive: false,
        previewBytes: contentLength,
      };
    }

    return {
      login: channel.login,
      status: "live",
      isLive: true,
      previewBytes: contentLength,
      thumbnailUrl: getPreviewUrl(channel.login, 640, 360),
    };
  } catch {
    return { login: channel.login, status: "unknown", isLive: false };
  }
}

function getPreviewUrl(login, width, height) {
  return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${encodeURIComponent(login)}-${width}x${height}.jpg`;
}

function getMaxAge(cacheControl) {
  const match = cacheControl.match(/max-age=(\d+)/i);
  return match ? Number(match[1]) : 0;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

function mergeStatus(statuses) {
  const byLogin = new Map(
    statuses
      .filter((item) => item?.login)
      .map((item) => [String(item.login).toLowerCase(), item])
  );

  state.channels = state.channels.map((channel) => {
    const status = byLogin.get(channel.login);
    if (!status) return channel;
    return {
      ...channel,
      ...status,
      login: channel.login,
      label: channel.label,
      url: channel.url,
      status: status.isLive ? "live" : status.status || "offline",
    };
  });

  const liveLogins = new Set(
    state.channels.filter((channel) => channel.isLive).map((channel) => channel.login)
  );
  state.selectedLogins = state.selectedLogins.filter((login) => liveLogins.has(login));
}

function render() {
  renderSummary();
  renderChannels();
  renderWatch();
  renderIcons();
}

function renderSummary() {
  const liveCount = state.channels.filter((channel) => channel.isLive).length;
  const offlineCount = state.channels.filter((channel) => channel.status === "offline").length;
  const unknownCount = state.channels.filter((channel) => channel.status === "unknown").length;

  elements.totalCount.textContent = state.channels.length;
  elements.liveCount.textContent = liveCount;
  elements.offlineCount.textContent = offlineCount;
  elements.unknownCount.textContent = unknownCount;
  elements.sourceBadge.textContent = state.statusSource;

  if (state.isRefreshing) {
    updateStatusLine("正在用 Twitch 預覽圖確認開台狀態");
  } else if (state.lastUpdated) {
    updateStatusLine(`開台狀態更新於 ${formatDateTime(state.lastUpdated)}`);
  } else if (state.errors.length) {
    updateStatusLine(state.errors[state.errors.length - 1]);
  } else {
    updateStatusLine(`已讀取 ${state.channels.length} 個頻道`);
  }
}

function updateStatusLine(text) {
  elements.statusLine.textContent = text;
}

function renderChannels() {
  const query = state.query;
  const filtered = state.channels.filter((channel) => {
    const matchesFilter =
      state.filter === "all" ||
      (state.filter === "live" && channel.isLive) ||
      (state.filter === "offline" && channel.status === "offline");
    const searchable = `${channel.label} ${channel.login} ${channel.title || ""} ${channel.gameName || ""}`.toLowerCase();
    return matchesFilter && (!query || searchable.includes(query));
  });

  elements.emptyState.hidden = filtered.length > 0;
  elements.channelGrid.innerHTML = filtered.map(renderChannelCard).join("");

  elements.channelGrid.querySelectorAll(".channel-card").forEach((button) => {
    button.addEventListener("click", () => {
      const channel = state.channels.find((item) => item.login === button.dataset.login);
      if (!channel?.isLive) return;
      toggleSelectedChannel(channel.login);
      renderChannels();
      renderWatch();
      document.querySelector(".watch-section")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  });

  renderIcons();
}

function toggleSelectedChannel(login) {
  if (state.selectedLogins.includes(login)) {
    state.selectedLogins = state.selectedLogins.filter((item) => item !== login);
    return;
  }
  state.selectedLogins = [...state.selectedLogins, login];
}

function toggleWatchLayout() {
  state.watchLayout = state.watchLayout === "paired" ? "single" : "paired";
  renderWatch();
}

function pickRandomLiveChannels(count) {
  const liveChannels = state.channels.filter((channel) => channel.isLive);
  const picked = shuffle(liveChannels)
    .slice(0, Math.min(count, liveChannels.length))
    .map((channel) => channel.login);

  state.selectedLogins = picked;
  renderChannels();
  renderWatch();

  if (picked.length) {
    document.querySelector(".watch-section")?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function renderChannelCard(channel) {
  const statusClass = channel.isLive
    ? "live"
    : channel.status === "offline"
      ? "offline"
      : "unknown";
  const statusText = channel.isLive
    ? "LIVE"
    : channel.status === "offline"
      ? "離線"
      : "確認中";
  const meta = channel.isLive
    ? [channel.gameName, formatViewerCount(channel.viewerCount)].filter(Boolean).join(" · ") || "直播中"
    : "";

  return `
    <button
      class="channel-card ${channel.isLive ? "is-live" : ""} ${state.selectedLogins.includes(channel.login) ? "is-selected" : ""}"
      type="button"
      data-login="${escapeHtml(channel.login)}"
      ${channel.isLive ? "" : "disabled"}
      aria-pressed="${state.selectedLogins.includes(channel.login) ? "true" : "false"}"
    >
      <span class="channel-main">
        <span class="channel-name">${escapeHtml(channel.displayName || channel.label)}</span>
        <span class="channel-login">@${escapeHtml(channel.login)}</span>
        ${meta ? `<span class="channel-meta">${escapeHtml(meta)}</span>` : ""}
        ${channel.title ? `<span class="channel-title">${escapeHtml(channel.title)}</span>` : ""}
      </span>
      <span class="status-pill ${statusClass}">${statusText}</span>
    </button>
  `;
}

function renderWatch() {
  const selectedChannels = state.selectedLogins
    .map((login) => state.channels.find((item) => item.login === login))
    .filter((channel) => channel?.isLive);

  if (!selectedChannels.length) {
    elements.watchTitle.textContent = "選擇開台中的頻道";
    elements.watchLayoutButton.hidden = true;
    elements.watchShell.className = "watch-shell";
    elements.watchShell.innerHTML = `
      <div class="watch-placeholder">
        <i data-lucide="radio" aria-hidden="true"></i>
        <p>目前還沒有選取直播</p>
      </div>
    `;
    renderIcons();
    return;
  }

  const parents = getTwitchParents();
  const parentParams = parents
    .map((parent) => `parent=${encodeURIComponent(parent)}`)
    .join("&");
  elements.watchTitle.textContent = `已選擇 ${selectedChannels.length} 個頻道`;
  elements.watchLayoutButton.hidden = false;
  elements.watchLayoutButton.setAttribute(
    "aria-pressed",
    state.watchLayout === "paired" ? "true" : "false"
  );
  elements.watchLayoutLabel.textContent =
    state.watchLayout === "paired" ? "不要並排" : "兩兩並排";
  elements.watchShell.className = `watch-shell has-streams layout-${state.watchLayout}`;
  elements.watchShell.innerHTML = `
    <div class="watch-stack">
      ${selectedChannels.map((channel) => renderWatchEntry(channel, parentParams)).join("")}
    </div>
  `;
  renderIcons();
}

function renderWatchEntry(channel, parentParams) {
  const playerUrl = `https://player.twitch.tv/?channel=${encodeURIComponent(channel.login)}&${parentParams}&autoplay=true&muted=false`;
  const chatUrl = `https://www.twitch.tv/embed/${encodeURIComponent(channel.login)}/chat?${parentParams}&darkpopout`;
  const title = channel.displayName || channel.label;

  return `
    <article class="watch-entry">
      <div class="watch-entry-heading">
        <div>
          <span class="eyebrow">Now Watching</span>
          <h3>${escapeHtml(title)}</h3>
        </div>
        <div class="watch-entry-actions">
          <a class="external-link" href="${escapeHtml(channel.url)}" target="_blank" rel="noreferrer">
            <span>前往 Twitch</span>
            <i data-lucide="external-link" aria-hidden="true"></i>
          </a>
        </div>
      </div>
      <div class="watch-grid">
        <iframe
          class="player-frame"
          src="${playerUrl}"
          title="${escapeHtml(channel.label)} 直播"
          allowfullscreen
          allow="autoplay; fullscreen; picture-in-picture">
        </iframe>
        <iframe
          class="chat-frame"
          src="${chatUrl}"
          title="${escapeHtml(channel.label)} 聊天室"
          sandbox="allow-storage-access-by-user-activation allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-modals">
        </iframe>
      </div>
    </article>
  `;
}

function getTwitchParents() {
  if (window.location.hostname) return [window.location.hostname];
  return ["localhost"];
}

function renderIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatViewerCount(value) {
  if (!Number.isFinite(Number(value))) return "";
  return `${new Intl.NumberFormat("zh-TW").format(Number(value))} 位觀眾`;
}

init();
