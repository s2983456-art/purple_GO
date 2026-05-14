import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";

const SHEET_ID = "1q9hW9idIngzQYkSDmkBT0fTOr1vsYjg58jRLrnJUX2M";
const SHEET_GVIZ_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json`;
const OUTPUT_PATH = "data/live-status.json";
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

async function main() {
  const rows = await loadSheetRows();
  const channels = extractChannels(rows);
  const statusChannels = await mapWithConcurrency(channels, 6, probeChannelPreview);

  await mkdir("data", { recursive: true });
  await writeFile(
    OUTPUT_PATH,
    `${JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        source: "Twitch Preview",
        sheetId: SHEET_ID,
        channels: statusChannels,
        errors: [],
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const liveCount = statusChannels.filter((channel) => channel.isLive).length;
  console.log(`Wrote ${OUTPUT_PATH} with ${statusChannels.length} channels; ${liveCount} live.`);
}

async function loadSheetRows() {
  const response = await request(`${SHEET_GVIZ_URL}&cacheBust=${Date.now()}`);
  if (!response.ok) {
    throw new Error(`Google Sheets responded ${response.status}`);
  }

  const text = await response.text();
  const payload = parseGvizJson(text);
  return (payload.table?.rows || []).map((row) => {
    return (row.c || []).map((cell) => {
      const value = cell?.f ?? cell?.v ?? "";
      return String(value).replace(/\s+/g, " ").trim();
    });
  });
}

function parseGvizJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("Google Sheets returned an unexpected response.");
  }
  return JSON.parse(text.slice(start, end + 1));
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

async function probeChannelPreview(channel) {
  const previewUrl = getPreviewUrl(channel.login, PREVIEW_WIDTH, PREVIEW_HEIGHT);

  try {
    const response = await request(`${previewUrl}?cb=${Date.now()}`, {
      method: "HEAD",
    });

    if (!response.ok) {
      return { ...channel, status: "unknown", isLive: false };
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    const cacheControl = response.headers.get("cache-control") || "";
    const maxAge = getMaxAge(cacheControl);
    const isOfflinePlaceholder =
      contentLength > 0 &&
      (contentLength < LIVE_PREVIEW_MIN_BYTES || maxAge >= OFFLINE_PREVIEW_MAX_AGE);

    if (isOfflinePlaceholder) {
      return {
        ...channel,
        status: "offline",
        isLive: false,
        previewBytes: contentLength,
      };
    }

    return {
      ...channel,
      status: "live",
      isLive: true,
      previewBytes: contentLength,
      thumbnailUrl: getPreviewUrl(channel.login, 640, 360),
    };
  } catch (error) {
    return {
      ...channel,
      status: "unknown",
      isLive: false,
      error: error.message,
    };
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

async function request(url, options = {}, redirectCount = 0) {
  if (typeof fetch === "function") {
    return fetch(url, options);
  }

  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "http:" ? http : https;
    const req = transport.request(
      target,
      {
        method: options.method || "GET",
        headers: options.headers || {},
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          redirectCount < 5
        ) {
          res.resume();
          const nextUrl = new URL(res.headers.location, target).toString();
          resolve(request(nextUrl, options, redirectCount + 1));
          return;
        }

        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const headers = new Map();
          Object.entries(res.headers).forEach(([key, value]) => {
            headers.set(key.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value || ""));
          });

          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: {
              get: (key) => headers.get(String(key).toLowerCase()) || null,
            },
            text: async () => body,
            json: async () => JSON.parse(body),
          });
        });
      }
    );

    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

main().catch(async (error) => {
  console.error(error);
  await mkdir("data", { recursive: true });
  await writeFile(
    OUTPUT_PATH,
    `${JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        source: "error",
        sheetId: SHEET_ID,
        channels: [],
        errors: [error.message],
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  process.exitCode = 1;
});
