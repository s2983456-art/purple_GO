const SHEET_ID = "1q9hW9idIngzQYkSDmkBT0fTOr1vsYjg58jRLrnJUX2M";
const SHEET_GVIZ_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq`;
const STATUS_URL = "data/live-status.json";
const PREVIEW_WIDTH = 320;
const PREVIEW_HEIGHT = 180;
const LIVE_PREVIEW_MIN_BYTES = 4096;
const OFFLINE_PREVIEW_MAX_AGE = 3600;
const CUSTOM_CHANNELS_KEY = "purple-go:custom-channels";
const WATCH_WINDOW_TYPES = [
  { id: "player", label: "直播" },
  { id: "chat", label: "聊天室" },
];
const watchResizeObservers = new Map();

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
  watchWindows: {},
  closedWatchWindows: new Set(),
  nextWindowZ: 1,
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
  addChannelButton: document.querySelector("#addChannelButton"),
  addChannelDialog: document.querySelector("#addChannelDialog"),
  addChannelForm: document.querySelector("#addChannelForm"),
  closeAddChannelButton: document.querySelector("#closeAddChannelButton"),
  cancelAddChannelButton: document.querySelector("#cancelAddChannelButton"),
  customChannelInput: document.querySelector("#customChannelInput"),
  customChannelMenu: document.querySelector("#customChannelMenu"),
  removeCustomChannelButton: document.querySelector("#removeCustomChannelButton"),
  searchInput: document.querySelector("#searchInput"),
  channelGrid: document.querySelector("#channelGrid"),
  emptyState: document.querySelector("#emptyState"),
  sourceBadge: document.querySelector("#sourceBadge"),
  watchTitle: document.querySelector("#watchTitle"),
  openWatchPageButton: document.querySelector("#openWatchPageButton"),
  watchLayoutButton: document.querySelector("#watchLayoutButton"),
  watchLayoutLabel: document.querySelector("#watchLayoutLabel"),
  watchShell: document.querySelector("#watchShell"),
};

async function init() {
  bindEvents();
  await loadChannels();
  loadCustomChannels();
  await loadGeneratedStatus();
  render();
  refreshLiveStatus();
}

function bindEvents() {
  elements.refreshButton.addEventListener("click", () => refreshLiveStatus());
  elements.pickTwoButton.addEventListener("click", () => pickRandomLiveChannels(2));
  elements.addChannelButton.addEventListener("click", () => openAddChannelDialog());
  elements.closeAddChannelButton.addEventListener("click", () => closeAddChannelDialog());
  elements.cancelAddChannelButton.addEventListener("click", () => closeAddChannelDialog());
  elements.addChannelForm.addEventListener("submit", (event) => {
    event.preventDefault();
    addCustomChannel(elements.customChannelInput.value);
  });
  elements.removeCustomChannelButton.addEventListener("click", () => {
    removeCustomChannel(elements.customChannelMenu.dataset.login);
  });
  elements.openWatchPageButton.addEventListener("click", () => openStandaloneWatchPage());
  elements.watchLayoutButton.addEventListener("click", () => resetWatchWindowsLayout());

  elements.searchInput.addEventListener("input", (event) => {
    state.query = event.target.value.trim().toLowerCase();
    renderChannels();
  });

  elements.channelGrid.addEventListener("contextmenu", (event) => {
    const card = event.target.closest(".channel-card");
    if (!card) {
      hideCustomChannelMenu();
      return;
    }

    const channel = state.channels.find((item) => item.login === card.dataset.login);
    if (!channel?.isCustom) {
      hideCustomChannelMenu();
      return;
    }

    event.preventDefault();
    showCustomChannelMenu(channel.login, event.clientX, event.clientY);
  });

  document.addEventListener("click", (event) => {
    if (elements.customChannelMenu.hidden || elements.customChannelMenu.contains(event.target)) {
      return;
    }
    hideCustomChannelMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideCustomChannelMenu();
  });

  window.addEventListener("resize", () => hideCustomChannelMenu());

  document.querySelectorAll(".segment-button").forEach((button) => {
    button.addEventListener("click", () => {
      setFilter(button.dataset.filter);
    });
  });
}

function setFilter(filter) {
  state.filter = filter;
  document.querySelectorAll(".segment-button").forEach((item) => {
    item.classList.toggle("active", item.dataset.filter === filter);
  });
  renderChannels();
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
        isSheetChannel: true,
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

function loadCustomChannels() {
  readCustomChannels().forEach((channel) => {
    upsertCustomChannel(channel.login, channel.label || channel.login);
  });
}

function readCustomChannels() {
  try {
    const payload = JSON.parse(localStorage.getItem(CUSTOM_CHANNELS_KEY) || "[]");
    if (!Array.isArray(payload)) return [];
    return payload.filter((item) => item?.login);
  } catch {
    return [];
  }
}

function saveCustomChannels() {
  const customChannels = state.channels
    .filter((channel) => channel.isCustom)
    .map((channel) => ({
      login: channel.login,
      label: channel.label,
    }));
  localStorage.setItem(CUSTOM_CHANNELS_KEY, JSON.stringify(customChannels));
}

function openAddChannelDialog() {
  elements.customChannelInput.value = "";
  if (typeof elements.addChannelDialog.showModal === "function") {
    elements.addChannelDialog.showModal();
  } else {
    elements.addChannelDialog.setAttribute("open", "");
  }
  elements.customChannelInput.focus();
}

function closeAddChannelDialog() {
  elements.addChannelDialog.close();
}

function addCustomChannel(value) {
  const login = normalizeCustomLogin(value);
  if (!login) {
    updateStatusLine("請輸入有效的 Twitch 帳號或連結");
    return;
  }

  upsertCustomChannel(login, login);
  saveCustomChannels();
  closeAddChannelDialog();
  setFilter("all");
  render();
  updateStatusLine(`已新增 @${login}`);
  refreshLiveStatus();
}

function removeCustomChannel(login) {
  const channel = state.channels.find((item) => item.login === login);
  if (!channel?.isCustom) return;

  if (channel.isSheetChannel) {
    channel.isCustom = false;
  } else {
    state.channels = state.channels.filter((item) => item.login !== login);
    state.selectedLogins = state.selectedLogins.filter((item) => item !== login);
    removeWatchWindowState(login);
  }

  saveCustomChannels();
  hideCustomChannelMenu();
  render();
  updateStatusLine(`已移除 @${login}`);
}

function showCustomChannelMenu(login, x, y) {
  elements.customChannelMenu.dataset.login = login;
  elements.customChannelMenu.hidden = false;
  elements.customChannelMenu.style.left = "0px";
  elements.customChannelMenu.style.top = "0px";

  const rect = elements.customChannelMenu.getBoundingClientRect();
  const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
  const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
  const left = Math.min(Math.max(8, x), maxLeft);
  const top = Math.min(Math.max(8, y), maxTop);

  elements.customChannelMenu.style.left = `${left}px`;
  elements.customChannelMenu.style.top = `${top}px`;
  elements.removeCustomChannelButton.focus({ preventScroll: true });
}

function hideCustomChannelMenu() {
  elements.customChannelMenu.hidden = true;
  delete elements.customChannelMenu.dataset.login;
}

function upsertCustomChannel(login, label) {
  const existing = state.channels.find((channel) => channel.login === login);
  if (existing) {
    existing.isCustom = true;
    existing.label = existing.label || label;
    return;
  }

  state.channels = [
    ...state.channels,
    {
      login,
      label,
      url: `https://www.twitch.tv/${login}`,
      status: "unknown",
      isLive: false,
      isCustom: true,
      isSheetChannel: false,
    },
  ].sort((a, b) => a.label.localeCompare(b.label, "zh-Hant"));
}

function normalizeCustomLogin(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";

  const fromUrl = loginFromTwitchUrl(
    /^https?:\/\//i.test(trimmed) ? trimmed : `https://www.twitch.tv/${trimmed}`
  );
  return fromUrl || "";
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

  state.selectedLogins = state.selectedLogins.filter((login) =>
    state.channels.some((channel) => channel.login === login)
  );
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
    removeWatchWindowState(login);
    return;
  }
  clearClosedWatchWindows(login);
  state.selectedLogins = [...state.selectedLogins, login];
}

function resetWatchWindowsLayout() {
  state.watchWindows = {};
  renderWatch();
}

function openStandaloneWatchPage() {
  const channels = state.selectedLogins
    .map((login) => state.channels.find((channel) => channel.login === login))
    .filter(Boolean)
    .map((channel) => channel.login);

  if (!channels.length) return;

  const url = new URL("watch.html", window.location.href);
  url.searchParams.set("channels", channels.join(","));
  window.open(url.toString(), "_blank", "noopener,noreferrer");
}

function pickRandomLiveChannels(count) {
  const liveChannels = state.channels.filter((channel) => channel.isLive);
  const picked = shuffle(liveChannels)
    .slice(0, Math.min(count, liveChannels.length))
    .map((channel) => channel.login);

  state.selectedLogins = picked;
  picked.forEach(clearClosedWatchWindows);
  Object.keys(state.watchWindows).forEach((key) => {
    const login = key.split(":")[0];
    if (!picked.includes(login)) delete state.watchWindows[key];
  });
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

  const isButtonDisabled = !channel.isLive && !channel.isCustom;

  return `
    <button
      class="channel-card ${channel.isLive ? "is-live" : ""} ${channel.isCustom ? "is-custom" : ""} ${state.selectedLogins.includes(channel.login) ? "is-selected" : ""}"
      type="button"
      data-login="${escapeHtml(channel.login)}"
      ${isButtonDisabled ? "disabled" : ""}
      aria-disabled="${channel.isLive ? "false" : "true"}"
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
    .filter(Boolean);

  if (!selectedChannels.length) {
    clearWatchWindows();
    elements.watchTitle.textContent = "選擇開台中的頻道";
    elements.openWatchPageButton.hidden = true;
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

  elements.watchTitle.textContent = `已選擇 ${selectedChannels.length} 個頻道`;
  elements.openWatchPageButton.hidden = false;
  elements.watchLayoutButton.hidden = false;
  elements.watchLayoutButton.removeAttribute("aria-pressed");
  elements.watchLayoutLabel.textContent = "重新排列";
  elements.watchShell.className = "watch-shell has-streams canvas-mode";

  let canvas = elements.watchShell.querySelector(".watch-canvas");
  if (!canvas) {
    elements.watchShell.textContent = "";
    canvas = document.createElement("div");
    canvas.className = "watch-canvas";
    elements.watchShell.append(canvas);
  }

  syncWatchCanvasHeight(canvas, selectedChannels.length);

  const activeKeys = new Set();
  selectedChannels.forEach((channel, channelIndex) => {
    WATCH_WINDOW_TYPES.forEach((type) => {
      const key = getWatchWindowKey(channel.login, type.id);
      if (state.closedWatchWindows.has(key)) return;
      activeKeys.add(key);

      let windowElement = canvas.querySelector(
        `.canvas-window[data-window-key="${cssEscape(key)}"]`
      );
      if (!windowElement) {
        windowElement = createCanvasWindow(channel, type, channelIndex);
        canvas.append(windowElement);
        observeCanvasWindowResize(windowElement, key);
      } else {
        updateCanvasWindow(windowElement, channel, type);
      }
      applyCanvasWindowLayout(windowElement, key, channelIndex, type.id, canvas);
    });
  });

  canvas.querySelectorAll(".canvas-window").forEach((windowElement) => {
    const key = windowElement.dataset.windowKey;
    if (!activeKeys.has(key)) {
      unobserveCanvasWindowResize(key);
      windowElement.remove();
    }
  });

  renderIcons();
}

function createCanvasWindow(channel, type, channelIndex) {
  const key = getWatchWindowKey(channel.login, type.id);
  const windowElement = document.createElement("article");
  windowElement.className = `canvas-window ${type.id === "chat" ? "is-chat" : "is-player"}`;
  windowElement.dataset.windowKey = key;
  windowElement.dataset.login = channel.login;
  windowElement.dataset.type = type.id;

  const header = document.createElement("div");
  header.className = "canvas-window-header";
  header.addEventListener("pointerdown", (event) => startCanvasWindowDrag(event, key));

  const grip = document.createElement("span");
  grip.className = "canvas-window-grip";
  grip.innerHTML = '<i data-lucide="grip" aria-hidden="true"></i>';

  const title = document.createElement("span");
  title.className = "canvas-window-title";
  title.textContent = getCanvasWindowTitle(channel, type);

  const actions = document.createElement("div");
  actions.className = "canvas-window-actions";
  const refreshButton = createCanvasWindowButton("refresh-cw", "重新整理", () =>
    refreshCanvasWindow(key)
  );
  const closeButton = createCanvasWindowButton("x", "關閉", () => closeCanvasWindow(key));
  actions.append(refreshButton, closeButton);
  header.append(grip, title, actions);

  const body = document.createElement("div");
  body.className = "canvas-window-body";
  if (type.id === "player") {
    body.append(createPlayerIframe(channel.login));
  } else {
    body.append(createChatIframe(channel));
  }

  windowElement.addEventListener("pointerdown", () => bringCanvasWindowToFront(key));
  windowElement.append(header, body);
  ensureCanvasWindowLayout(key, channelIndex, type.id);
  return windowElement;
}

function updateCanvasWindow(windowElement, channel, type) {
  windowElement.querySelector(".canvas-window-title").textContent = getCanvasWindowTitle(
    channel,
    type
  );

  const iframe = windowElement.querySelector("iframe");
  if (!iframe) return;
  iframe.title = getCanvasWindowTitle(channel, type);
}

function createCanvasWindowButton(icon, label, handler) {
  const button = document.createElement("button");
  button.className = "canvas-window-button";
  button.type = "button";
  button.title = label;
  button.innerHTML = `<i data-lucide="${icon}" aria-hidden="true"></i><span class="sr-only">${label}</span>`;
  button.addEventListener("pointerdown", (event) => event.stopPropagation());
  button.addEventListener("click", handler);
  return button;
}

function createPlayerIframe(login) {
  const iframe = document.createElement("iframe");
  iframe.src = getPlayerUrl(login);
  iframe.title = `${login} 直播`;
  iframe.allowFullscreen = true;
  return iframe;
}

function createChatIframe(channel) {
  const iframe = document.createElement("iframe");
  iframe.src = getChatUrl(channel.login);
  iframe.title = `${channel.displayName || channel.label} 聊天室`;
  iframe.setAttribute(
    "sandbox",
    "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
  );
  return iframe;
}

function refreshCanvasWindow(key) {
  const iframe = elements.watchShell.querySelector(
    `.canvas-window[data-window-key="${cssEscape(key)}"] iframe`
  );
  if (!iframe?.src) return;
  iframe.src = iframe.src;
}

function closeCanvasWindow(key) {
  const [login] = key.split(":");
  state.closedWatchWindows.add(key);
  delete state.watchWindows[key];
  unobserveCanvasWindowResize(key);

  const allClosed = WATCH_WINDOW_TYPES.every((type) =>
    state.closedWatchWindows.has(getWatchWindowKey(login, type.id))
  );
  if (allClosed) {
    state.selectedLogins = state.selectedLogins.filter((item) => item !== login);
    removeWatchWindowState(login);
    renderChannels();
  }

  renderWatch();
}

function startCanvasWindowDrag(event, key) {
  if (event.button !== 0 || event.target.closest(".canvas-window-button")) return;

  const windowElement = event.currentTarget.closest(".canvas-window");
  const canvas = elements.watchShell.querySelector(".watch-canvas");
  if (!windowElement || !canvas) return;

  event.preventDefault();
  bringCanvasWindowToFront(key);

  const canvasRect = canvas.getBoundingClientRect();
  const windowRect = windowElement.getBoundingClientRect();
  const pointerOffset = {
    x: event.clientX - windowRect.left,
    y: event.clientY - windowRect.top,
  };

  function moveWindow(moveEvent) {
    const layout = state.watchWindows[key];
    if (!layout) return;

    layout.x = Math.max(0, Math.round(moveEvent.clientX - canvasRect.left - pointerOffset.x));
    layout.y = Math.max(0, Math.round(moveEvent.clientY - canvasRect.top - pointerOffset.y));
    windowElement.style.left = `${layout.x}px`;
    windowElement.style.top = `${layout.y}px`;
  }

  function stopMove() {
    document.removeEventListener("pointermove", moveWindow);
    document.removeEventListener("pointerup", stopMove);
  }

  document.addEventListener("pointermove", moveWindow);
  document.addEventListener("pointerup", stopMove, { once: true });
}

function applyCanvasWindowLayout(windowElement, key, channelIndex, typeId, canvas) {
  const layout = ensureCanvasWindowLayout(key, channelIndex, typeId, canvas);
  windowElement.style.left = `${layout.x}px`;
  windowElement.style.top = `${layout.y}px`;
  windowElement.style.width = `${layout.width}px`;
  windowElement.style.height = `${layout.height}px`;
  windowElement.style.zIndex = layout.z;
}

function ensureCanvasWindowLayout(key, channelIndex, typeId, canvas) {
  if (!state.watchWindows[key]) {
    state.watchWindows[key] = getDefaultCanvasWindowLayout(channelIndex, typeId, canvas);
  }
  return state.watchWindows[key];
}

function getDefaultCanvasWindowLayout(channelIndex, typeId, canvas) {
  const width = Math.max(980, canvas?.clientWidth || elements.watchShell.clientWidth || 1180);
  const rowTop = 24 + channelIndex * 470;
  const playerWidth = Math.max(520, Math.round(width * 0.58));
  const chatWidth = Math.max(340, width - playerWidth - 72);

  if (typeId === "chat") {
    return {
      x: playerWidth + 48,
      y: rowTop + 20,
      width: chatWidth,
      height: 430,
      z: ++state.nextWindowZ,
    };
  }

  return {
    x: 24,
    y: rowTop + 120,
    width: playerWidth,
    height: 430,
    z: ++state.nextWindowZ,
  };
}

function syncWatchCanvasHeight(canvas, selectedCount) {
  canvas.style.minHeight = `${Math.max(760, 620 + (selectedCount - 1) * 470)}px`;
}

function observeCanvasWindowResize(windowElement, key) {
  if (watchResizeObservers.has(key) || !window.ResizeObserver) return;

  const observer = new ResizeObserver(([entry]) => {
    const layout = state.watchWindows[key];
    if (!layout) return;
    layout.width = Math.round(entry.contentRect.width);
    layout.height = Math.round(entry.contentRect.height);
  });
  observer.observe(windowElement);
  watchResizeObservers.set(key, observer);
}

function unobserveCanvasWindowResize(key) {
  watchResizeObservers.get(key)?.disconnect();
  watchResizeObservers.delete(key);
}

function bringCanvasWindowToFront(key) {
  const layout = state.watchWindows[key];
  if (!layout) return;
  layout.z = ++state.nextWindowZ;
  const windowElement = elements.watchShell.querySelector(
    `.canvas-window[data-window-key="${cssEscape(key)}"]`
  );
  if (windowElement) windowElement.style.zIndex = layout.z;
}

function clearWatchWindows() {
  watchResizeObservers.forEach((observer) => observer.disconnect());
  watchResizeObservers.clear();
  state.watchWindows = {};
  state.closedWatchWindows.clear();
}

function removeWatchWindowState(login) {
  WATCH_WINDOW_TYPES.forEach((type) => {
    const key = getWatchWindowKey(login, type.id);
    delete state.watchWindows[key];
    state.closedWatchWindows.delete(key);
    unobserveCanvasWindowResize(key);
  });
}

function clearClosedWatchWindows(login) {
  WATCH_WINDOW_TYPES.forEach((type) => {
    state.closedWatchWindows.delete(getWatchWindowKey(login, type.id));
  });
}

function getCanvasWindowTitle(channel, type) {
  return `${channel.displayName || channel.label} ${type.label}`;
}

function getWatchWindowKey(login, typeId) {
  return `${login}:${typeId}`;
}

function getPlayerUrl(login) {
  return `https://player.twitch.tv/?channel=${encodeURIComponent(login)}&${getTwitchParentParams()}&muted=false`;
}

function getChatUrl(login) {
  return `https://www.twitch.tv/embed/${encodeURIComponent(login)}/chat?${getTwitchParentParams()}&darkpopout`;
}

function getTwitchParentParams() {
  return getTwitchParents()
    .map((parent) => `parent=${encodeURIComponent(parent)}`)
    .join("&");
}

function cssEscape(value) {
  return window.CSS?.escape ? window.CSS.escape(value) : String(value).replaceAll('"', '\\"');
}

function getTwitchParents() {
  if (window.location.protocol === "file:") return ["localhost"];
  if (["127.0.0.1", "0.0.0.0"].includes(window.location.hostname)) return ["localhost"];
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
