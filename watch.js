const WINDOW_TYPES = [
  { id: "stream", label: "直播" },
  { id: "chat", label: "聊天室" },
];

const state = {
  layouts: {},
  nextZ: 1,
};

const elements = {
  canvas: document.querySelector("#watchCanvas"),
  emptyState: document.querySelector("#emptyState"),
  resetButton: document.querySelector("#resetButton"),
};

const channels = parseChannels();

init();

function init() {
  elements.resetButton.addEventListener("click", () => {
    state.layouts = {};
    render();
  });
  render();
}

function render() {
  elements.emptyState.hidden = channels.length > 0;
  elements.canvas.hidden = channels.length === 0;
  if (!channels.length) return;

  elements.canvas.textContent = "";
  elements.canvas.style.minHeight = `${Math.max(760, 620 + (channels.length - 1) * 470)}px`;

  channels.forEach((login, index) => {
    WINDOW_TYPES.forEach((type) => {
      const key = `${login}:${type.id}`;
      const windowElement = createWindow(login, type, key, index);
      elements.canvas.append(windowElement);
    });
  });
}

function createWindow(login, type, key, index) {
  const layout = ensureLayout(key, type.id, index);
  const windowElement = document.createElement("article");
  windowElement.className = `watch-window ${type.id}`;
  windowElement.dataset.key = key;
  Object.assign(windowElement.style, {
    left: `${layout.x}px`,
    top: `${layout.y}px`,
    width: `${layout.width}px`,
    height: `${layout.height}px`,
    zIndex: layout.z,
  });

  const bar = document.createElement("div");
  bar.className = "window-bar";
  bar.addEventListener("pointerdown", (event) => startDrag(event, key));

  const grip = document.createElement("span");
  grip.className = "grip";
  grip.textContent = "::";

  const title = document.createElement("span");
  title.className = "title";
  title.textContent = `${login} ${type.label}`;

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(
    createButton("⟳", "重新整理", () => refreshWindow(windowElement)),
    createButton("×", "關閉", () => windowElement.remove())
  );
  bar.append(grip, title, actions);

  const body = document.createElement("div");
  body.className = "window-body";
  body.append(type.id === "stream" ? createPlayerIframe(login) : createChatIframe(login));

  windowElement.addEventListener("pointerdown", () => bringToFront(key, windowElement));
  windowElement.addEventListener("pointerup", () => rememberSize(key, windowElement));
  windowElement.append(bar, body);
  return windowElement;
}

function createButton(text, title, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.title = title;
  button.textContent = text;
  button.addEventListener("pointerdown", (event) => event.stopPropagation());
  button.addEventListener("click", handler);
  return button;
}

function createPlayerIframe(login) {
  const iframe = document.createElement("iframe");
  iframe.src = `https://player.twitch.tv/?channel=${encodeURIComponent(login)}&parent=${encodeURIComponent(getParent())}&muted=false`;
  iframe.title = `${login} 直播`;
  iframe.allowFullscreen = true;
  return iframe;
}

function createChatIframe(login) {
  const iframe = document.createElement("iframe");
  iframe.src = `https://www.twitch.tv/embed/${encodeURIComponent(login)}/chat?parent=${encodeURIComponent(getParent())}&darkpopout`;
  iframe.title = `${login} 聊天室`;
  iframe.setAttribute(
    "sandbox",
    "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
  );
  return iframe;
}

function refreshWindow(windowElement) {
  const iframe = windowElement.querySelector("iframe");
  if (!iframe?.src) return;
  iframe.src = iframe.src;
}

function startDrag(event, key) {
  if (event.button !== 0 || event.target.closest("button")) return;
  const windowElement = event.currentTarget.closest(".watch-window");
  const canvasRect = elements.canvas.getBoundingClientRect();
  const windowRect = windowElement.getBoundingClientRect();
  const offset = {
    x: event.clientX - windowRect.left,
    y: event.clientY - windowRect.top,
  };

  event.preventDefault();
  bringToFront(key, windowElement);

  function move(moveEvent) {
    const layout = state.layouts[key];
    layout.x = Math.max(0, Math.round(moveEvent.clientX - canvasRect.left - offset.x));
    layout.y = Math.max(0, Math.round(moveEvent.clientY - canvasRect.top - offset.y));
    windowElement.style.left = `${layout.x}px`;
    windowElement.style.top = `${layout.y}px`;
  }

  function stop() {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", stop);
  }

  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", stop, { once: true });
}

function bringToFront(key, windowElement) {
  state.layouts[key].z = ++state.nextZ;
  windowElement.style.zIndex = state.layouts[key].z;
}

function rememberSize(key, windowElement) {
  const layout = state.layouts[key];
  layout.width = Math.round(windowElement.offsetWidth);
  layout.height = Math.round(windowElement.offsetHeight);
}

function ensureLayout(key, type, index) {
  if (state.layouts[key]) return state.layouts[key];

  const width = Math.max(980, window.innerWidth || 1180);
  const rowTop = 24 + index * 470;
  const streamWidth = Math.max(520, Math.round(width * 0.58));
  const chatWidth = Math.max(340, width - streamWidth - 72);

  state.layouts[key] =
    type === "chat"
      ? { x: streamWidth + 48, y: rowTop + 20, width: chatWidth, height: 430, z: ++state.nextZ }
      : { x: 24, y: rowTop + 120, width: streamWidth, height: 430, z: ++state.nextZ };

  return state.layouts[key];
}

function parseChannels() {
  const params = new URLSearchParams(window.location.search);
  return (params.get("channels") || "")
    .split(",")
    .map((channel) => channel.trim().toLowerCase())
    .filter((channel) => /^[a-z0-9_]{3,25}$/.test(channel));
}

function getParent() {
  if (window.location.protocol === "file:") return "localhost";
  if (["127.0.0.1", "0.0.0.0"].includes(window.location.hostname)) return "localhost";
  return window.location.hostname || "localhost";
}
