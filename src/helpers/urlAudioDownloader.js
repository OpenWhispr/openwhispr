const https = require("https");
const http = require("http");
const dns = require("dns");
const { isIP } = require("net");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const { getSafeTempDir } = require("./safeTempDir");

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

const STALL_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
const MAX_REDIRECTS = 3;

function isPrivateIp(ip) {
  if (ip === "0.0.0.0" || ip === "::1" || ip === "::") return true;
  if (isIP(ip) === 4) {
    const parts = ip.split(".").map(Number);
    if (parts[0] === 127) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    return false;
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("fe80")) return true;
    return false;
  }
  return false;
}

async function validateHostname(hostname) {
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      const err = new Error("Direct downloads from private/internal addresses are not allowed");
      err.code = "SSRF_BLOCKED";
      throw err;
    }
    return;
  }
  const { address } = await dns.promises.lookup(hostname);
  if (isPrivateIp(address)) {
    const err = new Error("Direct downloads from private/internal addresses are not allowed");
    err.code = "SSRF_BLOCKED";
    throw err;
  }
}

function detectUrlType(urlString) {
  if (!urlString || typeof urlString !== "string") {
    const err = new Error("Invalid URL");
    err.code = "INVALID_URL";
    throw err;
  }

  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    const err = new Error(`Invalid URL: ${urlString}`);
    err.code = "INVALID_URL";
    throw err;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    const err = new Error(`Unsupported protocol: ${parsed.protocol}`);
    err.code = "INVALID_URL";
    throw err;
  }

  const host = parsed.hostname.toLowerCase();
  if (YOUTUBE_HOSTS.has(host)) {
    return "youtube";
  }

  return "direct";
}

function extractYouTubeVideoId(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();

  if (host === "youtu.be") {
    const id = parsed.pathname.slice(1).split("/")[0];
    return id || null;
  }

  if (YOUTUBE_HOSTS.has(host)) {
    const watchId = parsed.searchParams.get("v");
    if (watchId) return watchId;

    const pathMatch = parsed.pathname.match(/^\/(shorts|embed)\/([a-zA-Z0-9_-]{11})/);
    if (pathMatch) return pathMatch[2];
  }

  return null;
}

function isPlaylistUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const host = parsed.hostname.toLowerCase();
    if (!YOUTUBE_HOSTS.has(host)) return false;
    return parsed.pathname === "/playlist" && parsed.searchParams.has("list");
  } catch {
    return false;
  }
}

function createStallChecker(onStall) {
  let lastDataTime = Date.now();
  const interval = setInterval(() => {
    if (Date.now() - lastDataTime > STALL_TIMEOUT_MS) {
      clearInterval(interval);
      onStall();
    }
  }, 5_000);

  return {
    touch() { lastDataTime = Date.now(); },
    clear() { clearInterval(interval); },
  };
}

async function downloadYouTube(url, onProgress, abortSignal) {
  const youtubedl = require("youtube-dl-exec");

  onProgress?.({ stage: "resolving", percent: 0 });

  if (isPlaylistUrl(url)) {
    const err = new Error("Playlists are not supported. Paste a single video URL.");
    err.code = "PLAYLIST_URL";
    throw err;
  }

  const videoId = extractYouTubeVideoId(url);
  if (!videoId) {
    const err = new Error("Could not extract video ID from URL");
    err.code = "INVALID_URL";
    throw err;
  }

  let info;
  try {
    info = await youtubedl(url, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
    });
  } catch (e) {
    const err = new Error(e.message || "Video unavailable");
    err.code = "VIDEO_UNAVAILABLE";
    throw err;
  }

  if (info.is_live) {
    const err = new Error("Live streams are not supported");
    err.code = "VIDEO_UNAVAILABLE";
    throw err;
  }

  const title = info.title || `youtube-${videoId}`;
  const durationSeconds = info.duration || null;

  onProgress?.({ stage: "downloading", percent: 0, title });

  if (abortSignal?.aborted) {
    const err = new Error("Download cancelled");
    err.code = "DOWNLOAD_CANCELLED";
    throw err;
  }

  const tempBase = path.join(getSafeTempDir(), `ow-url-${Date.now()}-${videoId}`);

  try {
    await youtubedl(url, {
      extractAudio: true,
      audioFormat: "best",
      output: `${tempBase}.%(ext)s`,
      noCheckCertificates: true,
      noWarnings: true,
    });

    const tempDir = getSafeTempDir();
    const prefix = path.basename(tempBase);
    const files = fs.readdirSync(tempDir)
      .filter((f) => f.startsWith(prefix))
      .sort((a, b) => b.length - a.length);

    if (files.length === 0) {
      const err = new Error("Download produced no output");
      err.code = "DOWNLOAD_FAILED";
      throw err;
    }

    const tempPath = path.join(tempDir, files[0]);
    const sizeBytes = fs.statSync(tempPath).size;

    onProgress?.({ stage: "ready", percent: 100, title });

    return { tempPath, title, durationSeconds, sizeBytes };
  } catch (e) {
    const tempDir = getSafeTempDir();
    const prefix = path.basename(tempBase);
    for (const f of fs.readdirSync(tempDir).filter((f) => f.startsWith(prefix))) {
      try { fs.unlinkSync(path.join(tempDir, f)); } catch {}
    }
    if (e.code === "DOWNLOAD_CANCELLED" || e.code === "PLAYLIST_URL") throw e;
    const err = new Error(e.stderr || e.message || "Download failed");
    err.code = e.code || "DOWNLOAD_FAILED";
    throw err;
  }
}

function httpRequest(parsed, options) {
  const mod = parsed.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(parsed, { timeout: CONNECT_TIMEOUT_MS, ...options }, resolve);
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Connection timed out"));
    });
    req.end();
  });
}

async function downloadDirect(url, onProgress, abortSignal, redirectCount = 0) {
  onProgress?.({ stage: "resolving", percent: 0 });

  const parsed = new URL(url);

  if (parsed.protocol !== "https:") {
    const err = new Error("Only HTTPS URLs are supported for direct downloads");
    err.code = "INVALID_URL";
    throw err;
  }

  await validateHostname(parsed.hostname);

  const headResponse = await httpRequest(parsed, { method: "HEAD" });

  const contentType = (headResponse.headers["content-type"] || "").toLowerCase();
  const isAudioVideo =
    contentType.startsWith("audio/") ||
    contentType.startsWith("video/");

  if (!isAudioVideo) {
    const err = new Error(`URL does not point to an audio file (content-type: ${contentType})`);
    err.code = "CONTENT_TYPE_INVALID";
    throw err;
  }

  const contentLength = headResponse.headers["content-length"]
    ? Number(headResponse.headers["content-length"])
    : null;

  if (contentLength && contentLength > MAX_DOWNLOAD_BYTES) {
    const err = new Error("File too large. Maximum download size is 500 MB.");
    err.code = "FILE_TOO_LARGE";
    throw err;
  }

  const urlPath = parsed.pathname;
  const extMatch = urlPath.match(/\.([a-zA-Z0-9]{2,5})$/);
  const ext = extMatch ? extMatch[1] : "audio";
  const fileName = path.basename(urlPath, `.${ext}`) || "audio";
  const title = decodeURIComponent(fileName).replace(/[_-]+/g, " ");
  const tempPath = path.join(getSafeTempDir(), `ow-url-${Date.now()}.${ext}`);

  onProgress?.({ stage: "downloading", percent: 0, title });

  const response = await httpRequest(parsed, { method: "GET" });

  if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
    response.destroy();
    if (redirectCount >= MAX_REDIRECTS) {
      const err = new Error("Too many redirects");
      err.code = "DOWNLOAD_FAILED";
      throw err;
    }
    return downloadDirect(response.headers.location, onProgress, abortSignal, redirectCount + 1);
  }

  if (response.statusCode !== 200) {
    response.destroy();
    const err = new Error(`HTTP ${response.statusCode}`);
    err.code = "DOWNLOAD_FAILED";
    throw err;
  }

  const fileStream = fs.createWriteStream(tempPath);
  let downloaded = 0;

  const stall = createStallChecker(() => {
    response.destroy(new Error("Download stalled"));
  });

  try {
    await new Promise((resolve, reject) => {
      response.on("data", (chunk) => {
        if (abortSignal?.aborted) {
          response.destroy();
          reject(Object.assign(new Error("Download cancelled"), { code: "DOWNLOAD_CANCELLED" }));
          return;
        }

        stall.touch();
        downloaded += chunk.length;

        if (downloaded > MAX_DOWNLOAD_BYTES) {
          response.destroy();
          reject(Object.assign(new Error("File too large. Maximum download size is 500 MB."), { code: "FILE_TOO_LARGE" }));
          return;
        }

        if (contentLength) {
          const percent = Math.min(99, Math.round((downloaded / contentLength) * 100));
          onProgress?.({ stage: "downloading", percent, title });
        }
      });

      response.on("error", reject);
      response.pipe(fileStream);
      fileStream.on("finish", resolve);
      fileStream.on("error", reject);
    });

    const sizeBytes = fs.statSync(tempPath).size;
    onProgress?.({ stage: "ready", percent: 100, title });

    return { tempPath, title, durationSeconds: null, sizeBytes };
  } catch (e) {
    try { fs.unlinkSync(tempPath); } catch {}
    if (e.code === "DOWNLOAD_CANCELLED") throw e;
    const err = new Error(e.message || "Download failed");
    err.code = "DOWNLOAD_FAILED";
    throw err;
  } finally {
    stall.clear();
  }
}

async function download(url, onProgress, abortSignal) {
  const type = detectUrlType(url);
  debugLogger.log("URL audio download starting", { url, type });

  if (type === "youtube") {
    return downloadYouTube(url, onProgress, abortSignal);
  }

  return downloadDirect(url, onProgress, abortSignal);
}

module.exports = { detectUrlType, extractYouTubeVideoId, isPlaylistUrl, download };
