const https = require("https");
const http = require("http");
const dns = require("dns");
const { isIP } = require("net");
// Namespaced (not destructured) so tests can monkeypatch childProcess.spawn. See T2.
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const debugLogger = require("./debugLogger");
const { getSafeTempDir } = require("./safeTempDir");
const { getFFmpegPath } = require("./ffmpegUtils");

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
// Reject absurdly long videos before downloading. See L1.
const MAX_DURATION_SECONDS = 6 * 60 * 60;

// Writable yt-dlp cache, seeded from the read-only bundle so the binary can
// self-update (the bundled copy is read-only / inside the signed bundle). See T2.
// OPENWHISPR_YTDLP_CACHE_DIR overrides the location (relocate it, or isolate it in tests).
const YT_DLP_CACHE_DIR =
  process.env.OPENWHISPR_YTDLP_CACHE_DIR ||
  path.join(os.homedir(), ".cache", "openwhispr", "yt-dlp");
const YT_DLP_UPDATE_THROTTLE_MS = 24 * 60 * 60 * 1000;
// Bound the -U self-update so a stalled GitHub request can never hang a download
// or wedge the single-flight flag. Overridable via options.timeoutMs for tests. See T2.
const UPDATE_TIMEOUT_MS = 120_000;
let ytDlpUpdateInFlight = false;
let ytDlpBusyCount = 0;

// Decode the IPv4 embedded in the trailing 32 bits of a NAT64 (64:ff9b::/96) address.
// Handles "::" compression; returns dotted IPv4 or null. See L3.
function nat64EmbeddedV4(lowerAddr) {
  const parts = lowerAddr.split("::");
  const head = parts[0].split(":").filter(Boolean);
  const tail = parts.length > 1 ? parts[1].split(":").filter(Boolean) : [];
  let groups;
  if (parts.length > 1) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const g6 = parseInt(groups[6], 16);
  const g7 = parseInt(groups[7], 16);
  if (Number.isNaN(g6) || Number.isNaN(g7)) return null;
  return `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
}

function isPrivateIp(ip) {
  if (ip === "::1" || ip === "::") return true;
  if (isIP(ip) === 4) {
    const parts = ip.split(".").map(Number);
    if (parts[0] === 0) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] >= 224) return true;
    return false;
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    // NAT64 well-known prefix embeds an IPv4 in the trailing 32 bits. See L3.
    // Match zero-padded first hextet too ("0064:ff9b" == "64:ff9b"). See T4.
    if (isNat64Prefix(lower)) {
      const dottedTail = lower.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
      if (dottedTail) return isPrivateIp(dottedTail[1]);
      const embedded = nat64EmbeddedV4(lower);
      if (embedded) return isPrivateIp(embedded);
      return false;
    }
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("fe80")) return true;
    if (lower.startsWith("ff")) return true;
    const v4mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4mapped) return isPrivateIp(v4mapped[1]);
    const v4compat = lower.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
    if (v4compat) return isPrivateIp(v4compat[1]);
    const v4mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (v4mappedHex) {
      const hi = parseInt(v4mappedHex[1], 16);
      const lo = parseInt(v4mappedHex[2], 16);
      const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isPrivateIp(dotted);
    }
    // Fully-expanded / zero-padded v4-mapped form "<all-zero groups>:ffff:HHHH:HHHH"
    // (e.g. "0:0:0:0:0:ffff:7f00:1"). The leading [0:]+ ensures only zeros precede ffff. See T4.
    const v4mappedExpanded = lower.match(/^[0:]+:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (v4mappedExpanded) {
      const hi = parseInt(v4mappedExpanded[1], 16);
      const lo = parseInt(v4mappedExpanded[2], 16);
      const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isPrivateIp(dotted);
    }
    // Same expanded form but with a dotted IPv4 tail (e.g. "0:0:0:0:0:ffff:127.0.0.1"). See T4.
    const v4mappedExpandedDotted = lower.match(/^[0:]+:ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4mappedExpandedDotted) {
      return isPrivateIp(v4mappedExpandedDotted[1]);
    }
    return false;
  }
  return false;
}

// True when the first two hextets are the NAT64 well-known prefix 64:ff9b,
// tolerating zero-padding ("0064:ff9b"). See T4.
function isNat64Prefix(lower) {
  const head = lower.split("::")[0].split(":");
  if (head.length < 2) return false;
  const h0 = head[0].replace(/^0+/, "") || "0";
  const h1 = head[1].replace(/^0+/, "") || "0";
  return h0 === "64" && h1 === "ff9b";
}

// Unified accept gate for HEAD and GET so the two stages can never disagree. See L2.
function isAcceptableAudioContentType(contentType) {
  const ct = (contentType || "").toLowerCase();
  return ct.startsWith("audio/") || ct.startsWith("video/");
}

// autoSelectFamily/Happy Eyeballs (default on Node 18+) calls lookup with
// { all: true }, so dns.lookup yields an ARRAY of { address, family }. Reject if
// ANY resolved entry is private; forward the original value unchanged on success. See T1.
function ssrfSafeLookup(hostname, options, callback) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    const entries = Array.isArray(address) ? address : [{ address, family }];
    for (const e of entries) {
      if (isPrivateIp(e.address)) {
        return callback(Object.assign(
          new Error("Direct downloads from private/internal addresses are not allowed"),
          { code: "SSRF_BLOCKED" }
        ));
      }
    }
    callback(null, address, family);
  });
}

function firstHeaderValue(headers, name) {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
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
    if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return id;
    return null;
  }

  if (YOUTUBE_HOSTS.has(host)) {
    const watchId = parsed.searchParams.get("v");
    if (watchId && /^[A-Za-z0-9_-]{11}$/.test(watchId)) return watchId;

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

// Resolve the bundled yt-dlp sidecar binary. Mirrors whisper.js resolution. See J2.
function resolveYtDlpPath() {
  const name = `yt-dlp-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "bin", name));
  }
  candidates.push(path.join(__dirname, "..", "..", "resources", "bin", name));
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function ytDlpBinaryName() {
  return `yt-dlp-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
}

// Path to the writable (self-updating) yt-dlp copy. Same basename as the bundle. See T2.
function getCacheYtDlpPath() {
  return path.join(YT_DLP_CACHE_DIR, ytDlpBinaryName());
}

// Best-effort: copy the bundled binary into the writable cache on first use.
// Never throws — callers fall back to the bundled copy. See T2.
function seedYtDlpFromBundle() {
  let tempPath;
  try {
    const cachePath = getCacheYtDlpPath();
    if (fs.existsSync(cachePath)) return;
    const bundled = resolveYtDlpPath();
    if (!bundled) return;
    fs.mkdirSync(YT_DLP_CACHE_DIR, { recursive: true });
    // Atomic seed: copy to a temp path, chmod, then rename so a crash mid-copy
    // can never leave a truncated cache binary that would fail to spawn. See T2.
    tempPath = `${cachePath}.tmp-${process.pid}`;
    fs.copyFileSync(bundled, tempPath);
    fs.chmodSync(tempPath, 0o755);
    fs.renameSync(tempPath, cachePath);
  } catch (e) {
    if (tempPath) { try { fs.unlinkSync(tempPath); } catch {} }
    debugLogger.warn("Failed to seed yt-dlp from bundle", { error: e.message });
  }
}

function isExecutableFile(p) {
  if (process.platform === "win32") return fs.existsSync(p);
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Prefer the self-updating cache copy; fall back to the bundled binary; null if neither. See T2.
function resolveYtDlpBinary() {
  const cachePath = getCacheYtDlpPath();
  if (fs.existsSync(cachePath) && isExecutableFile(cachePath)) {
    return cachePath;
  }
  return resolveYtDlpPath();
}

// Wrap runYtDlp so maybeUpdateYtDlp can skip while a download holds the binary. See T2.
async function runYtDlpTracked(binaryPath, args, abortSignal) {
  ytDlpBusyCount += 1;
  try {
    return await runYtDlp(binaryPath, args, abortSignal);
  } finally {
    ytDlpBusyCount -= 1;
  }
}

// Throttled, single-flight, best-effort background self-update of the CACHE copy
// only (never the bundled binary). Never throws/rejects to the caller. See T2.
function maybeUpdateYtDlp({ force, abortSignal, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const stampPath = path.join(YT_DLP_CACHE_DIR, ".last-update");
    const touchStamp = () => {
      try {
        fs.mkdirSync(YT_DLP_CACHE_DIR, { recursive: true });
        fs.writeFileSync(stampPath, String(Date.now()));
      } catch {}
    };

    try {
      if (ytDlpUpdateInFlight) return resolve();
      if (ytDlpBusyCount > 0) return resolve();

      if (!force) {
        try {
          const st = fs.statSync(stampPath);
          if (Date.now() - st.mtimeMs < YT_DLP_UPDATE_THROTTLE_MS) return resolve();
        } catch {}
      }

      seedYtDlpFromBundle();
      const cacheBinary = getCacheYtDlpPath();
      if (!fs.existsSync(cacheBinary)) return resolve();

      ytDlpUpdateInFlight = true;
      let child;
      try {
        child = childProcess.spawn(cacheBinary, ["-U"], { windowsHide: true });
      } catch (e) {
        ytDlpUpdateInFlight = false;
        debugLogger.warn("yt-dlp self-update failed to start", { error: e.message });
        touchStamp();
        return resolve();
      }
      // Drain stdio so the child never blocks on a full pipe buffer.
      if (child.stdout) child.stdout.on("data", () => {});
      if (child.stderr) child.stderr.on("data", () => {});

      // Bounded kill timer so a stalled -U network request can never hang. See T2.
      const limit = typeof timeoutMs === "number" ? timeoutMs : UPDATE_TIMEOUT_MS;
      let killTimer = null;
      let onAbort = null;

      let done = false;
      // Always clears the timer/listener, resets the in-flight flag, stamps the
      // throttle, and resolves — never rejects (best-effort contract). See T2.
      const finish = (errMessage) => {
        if (done) return;
        done = true;
        if (killTimer) clearTimeout(killTimer);
        if (onAbort && abortSignal) abortSignal.removeEventListener("abort", onAbort);
        ytDlpUpdateInFlight = false;
        if (errMessage) debugLogger.warn("yt-dlp self-update error", { error: errMessage });
        touchStamp();
        resolve();
      };

      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        finish("yt-dlp -U timed out");
      }, limit);

      if (abortSignal) {
        if (abortSignal.aborted) {
          try { child.kill("SIGKILL"); } catch {}
          return finish(null);
        }
        onAbort = () => {
          try { child.kill("SIGKILL"); } catch {}
          finish(null);
        };
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      child.on("error", (err) => finish(err.message));
      child.on("close", () => finish(null));
    } catch (e) {
      ytDlpUpdateInFlight = false;
      debugLogger.warn("yt-dlp self-update unexpected error", { error: e.message });
      resolve();
    }
  });
}

// Resolve the OS/corporate proxy for a target URL via Electron. Returns a proxy
// URL string (e.g. "http://host:port") or null for DIRECT / when unavailable. See J1.
async function resolveProxyForUrl(targetUrl) {
  let session;
  try {
    ({ session } = require("electron"));
  } catch {
    return null;
  }
  if (!session || !session.defaultSession || typeof session.defaultSession.resolveProxy !== "function") {
    return null;
  }
  let result;
  try {
    result = await session.defaultSession.resolveProxy(targetUrl);
  } catch (e) {
    debugLogger.warn("resolveProxy failed; falling back to direct", { error: e.message });
    return null;
  }
  return parseProxyResult(result);
}

function parseProxyResult(result) {
  if (!result || typeof result !== "string") return null;
  const first = result.split(";")[0].trim();
  if (!first || first.toUpperCase() === "DIRECT") return null;
  const [scheme, hostPort] = first.split(/\s+/);
  if (!hostPort) return null;
  const s = scheme.toUpperCase();
  let proto;
  if (s === "PROXY") proto = "http";
  else if (s === "HTTPS") proto = "https";
  else if (s === "SOCKS" || s === "SOCKS5") proto = "socks5";
  else if (s === "SOCKS4") proto = "socks4";
  else return null;
  return `${proto}://${hostPort}`;
}

function deriveTitleAndExt(urlPath) {
  const extMatch = urlPath.match(/\.([a-zA-Z0-9]{2,5})$/);
  const ext = extMatch ? extMatch[1] : "audio";
  const fileName = path.basename(urlPath, `.${ext}`) || "audio";
  let title;
  try {
    title = decodeURIComponent(fileName).replace(/[_-]+/g, " ");
  } catch {
    title = fileName.replace(/[_-]+/g, " ");
  }
  return { title, ext };
}

// Reject hostnames that resolve (or already are) a private/internal address.
// Defense-in-depth pre-flight for the proxy path. See J1.
function assertPublicHost(hostname) {
  return new Promise((resolve, reject) => {
    const raw = hostname.replace(/^\[|\]$/g, "");
    if (isIP(raw)) {
      if (isPrivateIp(raw)) {
        return reject(Object.assign(
          new Error("Direct downloads from private/internal addresses are not allowed"),
          { code: "SSRF_BLOCKED" }
        ));
      }
      return resolve();
    }
    dns.lookup(raw, { all: true }, (err, addresses) => {
      if (err) {
        return reject(Object.assign(new Error(`DNS lookup failed: ${err.message}`), { code: "DOWNLOAD_FAILED" }));
      }
      for (const a of addresses) {
        if (isPrivateIp(a.address)) {
          return reject(Object.assign(
            new Error("Direct downloads from private/internal addresses are not allowed"),
            { code: "SSRF_BLOCKED" }
          ));
        }
      }
      resolve();
    });
  });
}

// Spawn the yt-dlp sidecar, capture stdout/stderr, honor abort. See J2.
function runYtDlp(binaryPath, args, abortSignal) {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(Object.assign(new Error("Download cancelled"), { code: "DOWNLOAD_CANCELLED" }));
      return;
    }

    let child;
    try {
      child = childProcess.spawn(binaryPath, args, { windowsHide: true });
    } catch (e) {
      reject(Object.assign(new Error(e.message || "Failed to start yt-dlp"), { code: "DOWNLOAD_FAILED" }));
      return;
    }

    let stdout = "";
    let stderr = "";
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      try { child.kill("SIGTERM"); } catch {}
    };
    if (abortSignal) abortSignal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.on("error", (err) => {
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      reject(Object.assign(new Error(err.message || "yt-dlp failed to run"), { code: "DOWNLOAD_FAILED" }));
    });

    child.on("close", (code) => {
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      if (aborted || abortSignal?.aborted) {
        reject(Object.assign(new Error("Download cancelled"), { code: "DOWNLOAD_CANCELLED" }));
        return;
      }
      if (code !== 0) {
        reject(Object.assign(
          new Error(stderr.trim() || `yt-dlp exited with code ${code}`),
          { code: "DOWNLOAD_FAILED", stderr }
        ));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

// Heuristic: yt-dlp stderr/message that smells like a stale extractor (YouTube
// changed its player and a newer yt-dlp is needed). Drives the self-heal retry. See T2.
function looksLikeStaleExtractor(message) {
  return /unable to extract|nsig|signature|player|sig extraction|failed to extract|update yt-dlp|confirm.*latest version|please report/i.test(
    message || ""
  );
}

// Remove any temp artifacts produced for a given base path. Best-effort. See T2.
function cleanupTempArtifacts(tempBase) {
  try {
    const tempDir = getSafeTempDir();
    const prefix = path.basename(tempBase);
    for (const f of fs.readdirSync(tempDir).filter((f) => f.startsWith(prefix))) {
      try { fs.unlinkSync(path.join(tempDir, f)); } catch {}
    }
  } catch {}
}

async function downloadYouTube(url, onProgress, abortSignal) {
  seedYtDlpFromBundle();
  const binary = resolveYtDlpBinary();
  if (!binary) {
    const err = new Error("yt-dlp binary not found in resources/bin");
    err.code = "DOWNLOAD_FAILED";
    throw err;
  }

  // yt-dlp's -x post-processor needs ffmpeg, which is not on PATH in packaged builds. See B2.
  const ffmpegPath = getFFmpegPath();
  if (!ffmpegPath) {
    const err = new Error("FFmpeg not found — required for YouTube audio extraction");
    err.code = "DOWNLOAD_FAILED";
    throw err;
  }
  const ffmpegDir = path.dirname(ffmpegPath);

  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:") {
    parsedUrl.protocol = "https:";
    url = parsedUrl.href;
  }

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

  const sanitizedUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Route yt-dlp through the OS proxy when one is configured. See J1.
  const proxyUrl = await resolveProxyForUrl("https://www.youtube.com/");
  const proxyArgs = proxyUrl ? ["--proxy", proxyUrl] : [];

  let info;
  try {
    const { stdout } = await runYtDlpTracked(
      binary,
      [...proxyArgs, "--dump-single-json", "--no-warnings", sanitizedUrl],
      abortSignal
    );
    info = JSON.parse(stdout);
  } catch (e) {
    if (e.code === "DOWNLOAD_CANCELLED" || abortSignal?.aborted) {
      const err = new Error("Download cancelled");
      err.code = "DOWNLOAD_CANCELLED";
      throw err;
    }
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

  // Reject absurdly long videos before downloading. See L1.
  if (durationSeconds && durationSeconds > MAX_DURATION_SECONDS) {
    const err = new Error("Video is too long to download. Maximum length is 6 hours.");
    err.code = "FILE_TOO_LARGE";
    throw err;
  }

  onProgress?.({ stage: "downloading", percent: 0, title });

  if (abortSignal?.aborted) {
    const err = new Error("Download cancelled");
    err.code = "DOWNLOAD_CANCELLED";
    throw err;
  }

  const tempBase = path.join(getSafeTempDir(), `ow-url-${Date.now()}-${videoId}`);

  const extractionArgs = [
    ...proxyArgs,
    "-x",
    "--audio-format", "best",
    "--max-filesize", "500M",
    "--ffmpeg-location", ffmpegDir,
    "-o", `${tempBase}.%(ext)s`,
    "--no-warnings",
    sanitizedUrl,
  ];

  try {
    // Extract with a single self-heal retry: if it looks like a stale extractor,
    // force-update the cache copy and retry once with the refreshed binary. See T2.
    let retried = false;
    let extractionBinary = binary;
    while (true) {
      try {
        await runYtDlpTracked(extractionBinary, extractionArgs, abortSignal);
        break;
      } catch (e) {
        if (e.code === "DOWNLOAD_CANCELLED") throw e;
        const text = `${e.message || ""} ${e.stderr || ""}`;
        const userError = e.code === "PLAYLIST_URL" || e.code === "VIDEO_UNAVAILABLE";
        if (!retried && !userError && looksLikeStaleExtractor(text)) {
          retried = true;
          cleanupTempArtifacts(tempBase);
          await maybeUpdateYtDlp({ force: true, abortSignal });
          const binary2 = resolveYtDlpBinary();
          if (binary2) extractionBinary = binary2;
          continue;
        }
        throw e;
      }
    }

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
    for (const f of files.slice(1)) {
      try { fs.unlinkSync(path.join(tempDir, f)); } catch {}
    }
    const sizeBytes = fs.statSync(tempPath).size;

    // --max-filesize doesn't enforce for unknown-size streams; re-check after the fact. See T3.
    if (sizeBytes > MAX_DOWNLOAD_BYTES) {
      try { fs.unlinkSync(tempPath); } catch {}
      const err = new Error("File too large. Maximum download size is 500 MB.");
      err.code = "FILE_TOO_LARGE";
      throw err;
    }

    // Throttled background self-update for next time (never awaited). See T2.
    maybeUpdateYtDlp();

    onProgress?.({ stage: "ready", percent: 100, title });

    return { tempPath, title, durationSeconds, sizeBytes };
  } catch (e) {
    cleanupTempArtifacts(tempBase);
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

// Stream a readable HTTP response to disk under the shared caps (size, stall,
// abort, progress). Used by both the direct and proxy paths. `abort` tears down
// the underlying transport. Resolves to byte size; cleans up temp file on failure.
function streamToFile(response, tempPath, { contentLength, title, onProgress, abortSignal, abort }) {
  return new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(tempPath);
    let downloaded = 0;
    let settled = false;

    const stall = createStallChecker(() => {
      if (settled) return;
      try { abort(); } catch {}
      bail(Object.assign(new Error("Download stalled"), { code: "DOWNLOAD_FAILED" }));
    });

    const cleanupFile = () => {
      fileStream.destroy();
      try { fs.unlinkSync(tempPath); } catch {}
    };

    const bail = (err) => {
      if (settled) return;
      settled = true;
      stall.clear();
      cleanupFile();
      reject(err);
    };

    response.on("data", (chunk) => {
      if (settled) return;

      if (abortSignal?.aborted) {
        try { abort(); } catch {}
        bail(Object.assign(new Error("Download cancelled"), { code: "DOWNLOAD_CANCELLED" }));
        return;
      }

      stall.touch();
      downloaded += chunk.length;

      if (downloaded > MAX_DOWNLOAD_BYTES) {
        try { abort(); } catch {}
        bail(Object.assign(new Error("File too large. Maximum download size is 500 MB."), { code: "FILE_TOO_LARGE" }));
        return;
      }

      if (contentLength) {
        const percent = Math.min(99, Math.round((downloaded / contentLength) * 100));
        onProgress?.({ stage: "downloading", percent, title });
      }
    });

    response.on("error", (e) => {
      bail(Object.assign(new Error(e.message || "Download failed"), { code: "DOWNLOAD_FAILED" }));
    });

    response.pipe(fileStream);

    fileStream.on("error", (e) => {
      bail(Object.assign(new Error(e.message || "Write failed"), { code: "DOWNLOAD_FAILED" }));
    });

    fileStream.on("finish", () => {
      if (settled) return;
      settled = true;
      stall.clear();
      try {
        const sizeBytes = fs.statSync(tempPath).size;
        resolve(sizeBytes);
      } catch {
        cleanupFile();
        reject(Object.assign(new Error("Download produced no output"), { code: "DOWNLOAD_FAILED" }));
      }
    });
  });
}

// Proxy path: route through Electron net.request (which honors the OS proxy
// automatically). For defense-in-depth we still pre-flight the target hostname and
// re-validate each redirect hop against private IPs. With a proxy the corporate
// egress policy is the primary SSRF control; net.request does not accept a
// per-request lookup, leaving a narrow DNS-rebinding TOCTOU residual. See J1.
async function downloadViaProxy(url, onProgress, abortSignal, redirectCount = 0) {
  const { net } = require("electron");

  await assertPublicHost(new URL(url).hostname);

  const { response, contentLength, request } = await new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(Object.assign(new Error("Download cancelled"), { code: "DOWNLOAD_CANCELLED" }));
      return;
    }

    let redirects = redirectCount;
    let request;
    try {
      request = net.request({ url, method: "GET", redirect: "manual" });
    } catch (e) {
      reject(Object.assign(new Error(e.message || "Download failed"), { code: "DOWNLOAD_FAILED" }));
      return;
    }

    const onAbort = () => { try { request.abort(); } catch {} };
    if (abortSignal) abortSignal.addEventListener("abort", onAbort, { once: true });
    const detach = () => { if (abortSignal) abortSignal.removeEventListener("abort", onAbort); };

    request.on("redirect", (statusCode, method, redirectUrl) => {
      redirects += 1;
      if (redirects > MAX_REDIRECTS) {
        try { request.abort(); } catch {}
        detach();
        reject(Object.assign(new Error("Too many redirects"), { code: "DOWNLOAD_FAILED" }));
        return;
      }
      let next;
      try {
        next = new URL(redirectUrl);
      } catch {
        try { request.abort(); } catch {}
        detach();
        reject(Object.assign(new Error("Invalid redirect URL"), { code: "INVALID_URL" }));
        return;
      }
      if (next.protocol !== "https:") {
        try { request.abort(); } catch {}
        detach();
        reject(Object.assign(new Error("Only HTTPS URLs are supported for direct downloads"), { code: "INVALID_URL" }));
        return;
      }
      assertPublicHost(next.hostname)
        .then(() => { try { request.followRedirect(); } catch (e) {
          detach();
          reject(Object.assign(new Error(e.message || "Download failed"), { code: "DOWNLOAD_FAILED" }));
        } })
        .catch((e) => {
          try { request.abort(); } catch {}
          detach();
          reject(e);
        });
    });

    request.on("response", (response) => {
      detach();
      const statusCode = response.statusCode;
      if (statusCode !== 200) {
        response.resume();
        try { request.abort(); } catch {}
        reject(Object.assign(new Error(`HTTP ${statusCode}`), { code: "DOWNLOAD_FAILED" }));
        return;
      }

      const contentType = (firstHeaderValue(response.headers, "content-type") || "").toLowerCase();
      if (!isAcceptableAudioContentType(contentType)) {
        response.resume();
        try { request.abort(); } catch {}
        reject(Object.assign(
          new Error(`URL does not point to an audio file (content-type: ${contentType})`),
          { code: "CONTENT_TYPE_INVALID" }
        ));
        return;
      }

      const clHeader = firstHeaderValue(response.headers, "content-length");
      const contentLength = clHeader ? Number(clHeader) : null;
      if (contentLength && contentLength > MAX_DOWNLOAD_BYTES) {
        response.resume();
        try { request.abort(); } catch {}
        reject(Object.assign(new Error("File too large. Maximum download size is 500 MB."), { code: "FILE_TOO_LARGE" }));
        return;
      }

      resolve({ response, contentLength, request });
    });

    request.on("error", (err) => {
      detach();
      if (abortSignal?.aborted) {
        reject(Object.assign(new Error("Download cancelled"), { code: "DOWNLOAD_CANCELLED" }));
      } else {
        reject(Object.assign(new Error(err.message || "Download failed"), { code: "DOWNLOAD_FAILED" }));
      }
    });

    request.end();
  });

  const { title, ext } = deriveTitleAndExt(new URL(url).pathname);
  const tempPath = path.join(getSafeTempDir(), `ow-url-${Date.now()}.${ext}`);

  onProgress?.({ stage: "downloading", percent: 0, title });

  const sizeBytes = await streamToFile(response, tempPath, {
    contentLength,
    title,
    onProgress,
    abortSignal,
    abort: () => { try { request.abort(); } catch {} },
  });

  onProgress?.({ stage: "ready", percent: 100, title });
  return { tempPath, title, durationSeconds: null, sizeBytes };
}

async function downloadDirect(url, onProgress, abortSignal, redirectCount = 0) {
  onProgress?.({ stage: "resolving", percent: 0 });

  const parsed = new URL(url);

  if (parsed.protocol !== "https:") {
    const err = new Error("Only HTTPS URLs are supported for direct downloads");
    err.code = "INVALID_URL";
    throw err;
  }

  const rawHost = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isIP(rawHost) && isPrivateIp(rawHost)) {
    const err = new Error("Direct downloads from private/internal addresses are not allowed");
    err.code = "SSRF_BLOCKED";
    throw err;
  }

  // When the OS has a proxy configured, raw node-https would bypass it. Route through
  // Electron net.request instead; keep the airtight node-https + ssrfSafeLookup path
  // as the default for the common no-proxy case. See J1.
  const proxyUrl = await resolveProxyForUrl(url);
  if (proxyUrl) {
    return downloadViaProxy(url, onProgress, abortSignal, redirectCount);
  }

  let headParsed = parsed;
  let headRedirects = 0;
  let headResponse;
  while (true) {
    headResponse = await httpRequest(headParsed, { method: "HEAD", lookup: ssrfSafeLookup });
    headResponse.resume();
    if (headResponse.statusCode >= 300 && headResponse.statusCode < 400 && headResponse.headers.location) {
      // Cumulative redirect bound across alternating GET+HEAD hops. See L3.
      if (redirectCount + ++headRedirects > MAX_REDIRECTS) {
        const err = new Error("Too many redirects");
        err.code = "DOWNLOAD_FAILED";
        throw err;
      }
      const nextUrl = new URL(headResponse.headers.location, headParsed.href);
      if (nextUrl.protocol !== "https:") {
        const err = new Error("Only HTTPS URLs are supported for direct downloads");
        err.code = "INVALID_URL";
        throw err;
      }
      const nextRawHost = nextUrl.hostname.replace(/^\[|\]$/g, "");
      if (isIP(nextRawHost) && isPrivateIp(nextRawHost)) {
        const err = new Error("Direct downloads from private/internal addresses are not allowed");
        err.code = "SSRF_BLOCKED";
        throw err;
      }
      headParsed = nextUrl;
      continue;
    }
    break;
  }

  const contentType = (headResponse.headers["content-type"] || "").toLowerCase();
  if (!isAcceptableAudioContentType(contentType)) {
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

  const { title, ext } = deriveTitleAndExt(headParsed.pathname);
  const tempPath = path.join(getSafeTempDir(), `ow-url-${Date.now()}.${ext}`);

  onProgress?.({ stage: "downloading", percent: 0, title });

  const response = await httpRequest(headParsed, { method: "GET", lookup: ssrfSafeLookup });

  if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
    response.destroy();
    if (redirectCount + headRedirects >= MAX_REDIRECTS) {
      const err = new Error("Too many redirects");
      err.code = "DOWNLOAD_FAILED";
      throw err;
    }
    const redirectUrl = new URL(response.headers.location, headParsed.href).href;
    return downloadDirect(redirectUrl, onProgress, abortSignal, redirectCount + headRedirects + 1);
  }

  if (response.statusCode !== 200) {
    response.destroy();
    const err = new Error(`HTTP ${response.statusCode}`);
    err.code = "DOWNLOAD_FAILED";
    throw err;
  }

  const getContentType = (response.headers["content-type"] || "").toLowerCase();
  if (!isAcceptableAudioContentType(getContentType)) {
    response.destroy();
    const err = new Error(`URL does not point to an audio file (content-type: ${getContentType})`);
    err.code = "CONTENT_TYPE_INVALID";
    throw err;
  }

  const sizeBytes = await streamToFile(response, tempPath, {
    contentLength,
    title,
    onProgress,
    abortSignal,
    abort: () => { try { response.destroy(); } catch {} },
  });

  onProgress?.({ stage: "ready", percent: 100, title });
  return { tempPath, title, durationSeconds: null, sizeBytes };
}

async function download(url, onProgress, abortSignal) {
  const type = detectUrlType(url);
  debugLogger.log("URL audio download starting", { url, type });

  if (type === "youtube") {
    return downloadYouTube(url, onProgress, abortSignal);
  }

  return downloadDirect(url, onProgress, abortSignal);
}

module.exports = {
  detectUrlType,
  extractYouTubeVideoId,
  isPlaylistUrl,
  download,
  isPrivateIp,
  isAcceptableAudioContentType,
  ssrfSafeLookup,
  resolveYtDlpPath,
  maybeUpdateYtDlp,
  // Test-only seam: lets the regression test confirm the single-flight flag is cleared. See T2.
  _isYtDlpUpdateInFlight: () => ytDlpUpdateInFlight,
};
