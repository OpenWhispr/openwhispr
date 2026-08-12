const https = require("https");
const http = require("http");
const dns = require("dns");
const { isIP } = require("net");
// Namespaced (not destructured) so tests can monkeypatch childProcess.spawn.
const childProcess = require("child_process");
const crypto = require("crypto");
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
// Reject absurdly long videos before downloading.
const MAX_DURATION_SECONDS = 6 * 60 * 60;
const USER_AGENT = "OpenWhispr/1.0";

// Writable yt-dlp cache, seeded from the read-only bundle so the binary can
// self-update (the bundled copy is read-only / inside the signed bundle).
// OPENWHISPR_YTDLP_CACHE_DIR overrides the location (relocate it, or isolate it in tests).
const YT_DLP_CACHE_DIR =
  process.env.OPENWHISPR_YTDLP_CACHE_DIR ||
  path.join(os.homedir(), ".cache", "openwhispr", "yt-dlp");
const YT_DLP_UPDATE_THROTTLE_MS = 24 * 60 * 60 * 1000;
// Bound the self-update so a stalled GitHub request can never hang a download
// or wedge the single-flight flag. Overridable via options.timeoutMs for tests.
const UPDATE_TIMEOUT_MS = 120_000;
// Absolute ceilings on yt-dlp runs so a wedged process can never hang a queue item.
const YT_DLP_METADATA_TIMEOUT_MS = 2 * 60 * 1000;
const YT_DLP_EXTRACTION_TIMEOUT_MS = 30 * 60 * 1000;
let ytDlpUpdateInFlight = false;
let ytDlpBusyCount = 0;

// Decode the IPv4 embedded in the trailing 32 bits of a NAT64 (64:ff9b::/96) address.
// Handles "::" compression; returns dotted IPv4 or null.
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
    // NAT64 well-known prefix embeds an IPv4 in the trailing 32 bits.
    // Match zero-padded first hextet too ("0064:ff9b" == "64:ff9b").
    if (isNat64Prefix(lower)) {
      const dottedTail = lower.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
      if (dottedTail) return isPrivateIp(dottedTail[1]);
      const embedded = nat64EmbeddedV4(lower);
      if (embedded) return isPrivateIp(embedded);
      return false;
    }
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    // Link-local is fe80::/10 (fe80–febf), not just the literal fe80 hextet.
    if (/^fe[89ab]/.test(lower)) return true;
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
    // (e.g. "0:0:0:0:0:ffff:7f00:1"). The leading [0:]+ ensures only zeros precede ffff.
    const v4mappedExpanded = lower.match(/^[0:]+:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (v4mappedExpanded) {
      const hi = parseInt(v4mappedExpanded[1], 16);
      const lo = parseInt(v4mappedExpanded[2], 16);
      const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isPrivateIp(dotted);
    }
    // Same expanded form but with a dotted IPv4 tail (e.g. "0:0:0:0:0:ffff:127.0.0.1").
    const v4mappedExpandedDotted = lower.match(/^[0:]+:ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4mappedExpandedDotted) {
      return isPrivateIp(v4mappedExpandedDotted[1]);
    }
    return false;
  }
  return false;
}

// True when the first two hextets are the NAT64 well-known prefix 64:ff9b,
// tolerating zero-padding ("0064:ff9b").
function isNat64Prefix(lower) {
  const head = lower.split("::")[0].split(":");
  if (head.length < 2) return false;
  const h0 = head[0].replace(/^0+/, "") || "0";
  const h1 = head[1].replace(/^0+/, "") || "0";
  return h0 === "64" && h1 === "ff9b";
}

// Unified accept gate for HEAD and GET so the two stages can never disagree.
function isAcceptableAudioContentType(contentType) {
  const ct = (contentType || "").toLowerCase();
  return ct.startsWith("audio/") || ct.startsWith("video/");
}

// autoSelectFamily/Happy Eyeballs (default on Node 18+) calls lookup with
// { all: true }, so dns.lookup yields an ARRAY of { address, family }. Reject if
// ANY resolved entry is private; forward the original value unchanged on success.
function ssrfSafeLookup(hostname, options, callback) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    const entries = Array.isArray(address) ? address : [{ address, family }];
    for (const e of entries) {
      if (isPrivateIp(e.address)) {
        return callback(
          Object.assign(
            new Error("Direct downloads from private/internal addresses are not allowed"),
            { code: "SSRF_BLOCKED" }
          )
        );
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

    const pathMatch = parsed.pathname.match(/^\/(shorts|embed|live)\/([a-zA-Z0-9_-]{11})/);
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
    touch() {
      lastDataTime = Date.now();
    },
    clear() {
      clearInterval(interval);
    },
  };
}

function ytDlpBinaryName() {
  return `yt-dlp-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
}

// Resolve the bundled yt-dlp sidecar binary. Mirrors whisper.js resolution.
function resolveYtDlpPath() {
  const name = ytDlpBinaryName();
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "bin", name));
  }
  candidates.push(path.join(__dirname, "..", "..", "resources", "bin", name));
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// Path to the writable (self-updating) yt-dlp copy. Same basename as the bundle.
function getCacheYtDlpPath() {
  return path.join(YT_DLP_CACHE_DIR, ytDlpBinaryName());
}

function sha256File(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

// Trust anchors: the signed app bundle (seed) and yt-dlp's SUMS-verified self-update.
function recordCacheChecksum() {
  try {
    const cachePath = getCacheYtDlpPath();
    fs.writeFileSync(`${cachePath}.sha256`, sha256File(cachePath));
    verifiedCacheStat = null;
  } catch (e) {
    debugLogger.warn("Failed to record yt-dlp cache checksum", { error: e.message });
  }
}

// The cache dir is user-writable; verify before executing. Mismatch discards the
// copy so the next download re-seeds from the signed bundle. Hashing the ~40 MB
// binary blocks the main process, so remember the last verified (mtime, size) —
// an attacker who could forge those could also rewrite the sibling .sha256, so
// the memo adds no new trust.
let verifiedCacheStat = null;

function cacheChecksumValid(cachePath) {
  try {
    const st = fs.statSync(cachePath);
    if (
      verifiedCacheStat &&
      verifiedCacheStat.path === cachePath &&
      verifiedCacheStat.mtimeMs === st.mtimeMs &&
      verifiedCacheStat.size === st.size
    ) {
      return true;
    }
    const expected = fs.readFileSync(`${cachePath}.sha256`, "utf8").trim();
    if (expected && expected === sha256File(cachePath)) {
      verifiedCacheStat = { path: cachePath, mtimeMs: st.mtimeMs, size: st.size };
      return true;
    }
  } catch {}
  verifiedCacheStat = null;
  try {
    fs.unlinkSync(cachePath);
  } catch {}
  try {
    fs.unlinkSync(`${cachePath}.sha256`);
  } catch {}
  debugLogger.warn("yt-dlp cache failed checksum verification; discarded", { cachePath });
  return false;
}

// Best-effort: copy the bundled binary into the writable cache on first use.
// Never throws — callers fall back to the bundled copy.
function seedYtDlpFromBundle() {
  let tempPath;
  try {
    const cachePath = getCacheYtDlpPath();
    if (fs.existsSync(cachePath)) return;
    const bundled = resolveYtDlpPath();
    if (!bundled) return;
    fs.mkdirSync(YT_DLP_CACHE_DIR, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(YT_DLP_CACHE_DIR, 0o700);
    } catch {}
    // Atomic seed: copy to a temp path, chmod, then rename so a crash mid-copy
    // can never leave a truncated cache binary that would fail to spawn.
    tempPath = `${cachePath}.tmp-${process.pid}`;
    fs.copyFileSync(bundled, tempPath);
    fs.chmodSync(tempPath, 0o755);
    fs.renameSync(tempPath, cachePath);
    recordCacheChecksum();
  } catch (e) {
    if (tempPath) {
      try {
        fs.unlinkSync(tempPath);
      } catch {}
    }
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

// Checksum-verified cache copy, else bundled binary, else null. During an update
// swap, prefer the bundle so we never spawn a half-replaced file.
function resolveYtDlpBinary() {
  if (ytDlpUpdateInFlight) {
    const bundled = resolveYtDlpPath();
    if (bundled) return bundled;
  }
  const cachePath = getCacheYtDlpPath();
  if (fs.existsSync(cachePath) && isExecutableFile(cachePath) && cacheChecksumValid(cachePath)) {
    return cachePath;
  }
  return resolveYtDlpPath();
}

// Wrap runYtDlp so maybeUpdateYtDlp can skip while a download holds the binary.
async function runYtDlpTracked(binaryPath, args, abortSignal, timeoutMs, onOutput) {
  ytDlpBusyCount += 1;
  try {
    return await runYtDlp(binaryPath, args, abortSignal, timeoutMs, onOutput);
  } finally {
    ytDlpBusyCount -= 1;
  }
}

// Throttled, single-flight, best-effort background self-update of the CACHE copy
// only (never the bundled binary). Never throws/rejects to the caller.
function maybeUpdateYtDlp({ force, abortSignal, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const stampPath = path.join(YT_DLP_CACHE_DIR, ".last-update");
    const touchStamp = () => {
      try {
        fs.mkdirSync(YT_DLP_CACHE_DIR, { recursive: true, mode: 0o700 });
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
      // Never execute (or later bless) a tampered copy: verify first; a failed
      // check discards the copy, so reseed from the signed bundle and re-verify.
      if (!cacheChecksumValid(cacheBinary)) {
        seedYtDlpFromBundle();
        if (!fs.existsSync(cacheBinary) || !cacheChecksumValid(cacheBinary)) return resolve();
      }

      ytDlpUpdateInFlight = true;
      let child;
      try {
        // Nightly: upstream calls stable "prone to external breakage"; the updater
        // self-verifies against the release's SHA2-256SUMS.
        child = childProcess.spawn(cacheBinary, ["--update-to", "nightly"], { windowsHide: true });
      } catch (e) {
        ytDlpUpdateInFlight = false;
        debugLogger.warn("yt-dlp self-update failed to start", { error: e.message });
        touchStamp();
        return resolve();
      }
      // Drain stdio so the child never blocks on a full pipe buffer.
      if (child.stdout) child.stdout.on("data", () => {});
      if (child.stderr) child.stderr.on("data", () => {});

      // Bounded kill timer so a stalled -U network request can never hang.
      const limit = typeof timeoutMs === "number" ? timeoutMs : UPDATE_TIMEOUT_MS;
      let killTimer = null;
      let onAbort = null;

      let done = false;
      // Always clears the timer/listener, resets the in-flight flag, stamps the
      // throttle, and resolves — never rejects (best-effort contract).
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
        try {
          child.kill("SIGKILL");
        } catch {}
        finish("yt-dlp -U timed out");
      }, limit);

      if (abortSignal) {
        if (abortSignal.aborted) {
          try {
            child.kill("SIGKILL");
          } catch {}
          return finish(null);
        }
        onAbort = () => {
          try {
            child.kill("SIGKILL");
          } catch {}
          finish(null);
        };
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      child.on("error", (err) => finish(err.message));
      child.on("close", (code) => {
        // Only a successful update may move the trust anchor; a failed or killed
        // run leaves the previously verified binary (and checksum) in place.
        if (code === 0) recordCacheChecksum();
        finish(null);
      });
    } catch (e) {
      ytDlpUpdateInFlight = false;
      debugLogger.warn("yt-dlp self-update unexpected error", { error: e.message });
      resolve();
    }
  });
}

// Resolve the OS/corporate proxy for a target URL via Electron. Returns a proxy
// URL string (e.g. "http://host:port") or null for DIRECT / when unavailable.
async function resolveProxyForUrl(targetUrl) {
  let session;
  try {
    ({ session } = require("electron"));
  } catch {
    return null;
  }
  if (
    !session ||
    !session.defaultSession ||
    typeof session.defaultSession.resolveProxy !== "function"
  ) {
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
// Defense-in-depth pre-flight for the proxy path.
function assertPublicHost(hostname) {
  return new Promise((resolve, reject) => {
    const raw = hostname.replace(/^\[|\]$/g, "");
    if (isIP(raw)) {
      if (isPrivateIp(raw)) {
        return reject(
          Object.assign(
            new Error("Direct downloads from private/internal addresses are not allowed"),
            { code: "SSRF_BLOCKED" }
          )
        );
      }
      return resolve();
    }
    dns.lookup(raw, { all: true }, (err, addresses) => {
      if (err) {
        return reject(
          Object.assign(new Error(`DNS lookup failed: ${err.message}`), { code: "DOWNLOAD_FAILED" })
        );
      }
      for (const a of addresses) {
        if (isPrivateIp(a.address)) {
          return reject(
            Object.assign(
              new Error("Direct downloads from private/internal addresses are not allowed"),
              { code: "SSRF_BLOCKED" }
            )
          );
        }
      }
      resolve();
    });
  });
}

// yt-dlp needs an external JS runtime for YouTube player challenges. Reuse the
// app's Electron binary in Node mode; the env var is inherited by yt-dlp's child.
function jsRuntimeSpawnConfig() {
  return {
    args: ["--js-runtimes", `node:${process.execPath}`],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  };
}

// Kill yt-dlp AND its subprocesses (ffmpeg postprocessor, node JS-runtime):
// the detached process group on Unix, taskkill /T on Windows — a plain kill on
// the parent orphans them mid-download.
function killYtDlpTree(child, signal) {
  if (process.platform === "win32" && child.pid) {
    try {
      childProcess.spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      });
      return;
    } catch {}
  }
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  try {
    child.kill(signal);
  } catch {}
}

// Spawn the yt-dlp sidecar, capture stdout/stderr, honor abort and a hard timeout.
function runYtDlp(binaryPath, args, abortSignal, timeoutMs, onOutput) {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(Object.assign(new Error("Download cancelled"), { code: "DOWNLOAD_CANCELLED" }));
      return;
    }

    const runtime = jsRuntimeSpawnConfig();
    let child;
    try {
      child = childProcess.spawn(binaryPath, [...runtime.args, ...args], {
        windowsHide: true,
        env: runtime.env,
        detached: process.platform !== "win32",
      });
    } catch (e) {
      reject(
        Object.assign(new Error(e.message || "Failed to start yt-dlp"), { code: "DOWNLOAD_FAILED" })
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let aborted = false;
    let timedOut = false;

    const onAbort = () => {
      aborted = true;
      killYtDlpTree(child, "SIGTERM");
    };
    if (abortSignal) abortSignal.addEventListener("abort", onAbort, { once: true });

    const killTimer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killYtDlpTree(child, "SIGKILL");
        }, timeoutMs)
      : null;

    child.stdout.on("data", (d) => {
      const text = d.toString();
      stdout += text;
      onOutput?.(text);
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
    };

    child.on("error", (err) => {
      cleanup();
      reject(
        Object.assign(new Error(err.message || "yt-dlp failed to run"), { code: "DOWNLOAD_FAILED" })
      );
    });

    child.on("close", (code) => {
      cleanup();
      if (aborted || abortSignal?.aborted) {
        reject(Object.assign(new Error("Download cancelled"), { code: "DOWNLOAD_CANCELLED" }));
        return;
      }
      if (timedOut) {
        reject(Object.assign(new Error("yt-dlp timed out"), { code: "DOWNLOAD_FAILED", stderr }));
        return;
      }
      if (code !== 0) {
        reject(
          Object.assign(new Error(stderr.trim() || `yt-dlp exited with code ${code}`), {
            code: "DOWNLOAD_FAILED",
            stderr,
          })
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

// Heuristic: yt-dlp stderr/message that smells like a stale extractor (YouTube
// changed its player and a newer yt-dlp is needed). Drives the self-heal retry.
function looksLikeStaleExtractor(message) {
  return /unable to extract|nsig|signature|player|sig extraction|failed to extract|update yt-dlp|confirm.*latest version|please report/i.test(
    message || ""
  );
}

// YouTube refusing this network/IP (bot checks, 403s, login walls) — transient,
// hits even fully-updated clients.
function looksLikeYouTubeBlock(message) {
  return /sign in to confirm|not a bot|login_required|http error 403|403 forbidden|sabr/i.test(
    message || ""
  );
}

// Single self-heal retry: on stale-extractor failures, force-update and retry once.
async function runYtDlpWithSelfHeal(binary, args, abortSignal, timeoutMs, onBeforeRetry, onOutput) {
  try {
    return await runYtDlpTracked(binary, args, abortSignal, timeoutMs, onOutput);
  } catch (e) {
    if (e.code === "DOWNLOAD_CANCELLED") throw e;
    const text = `${e.message || ""} ${e.stderr || ""}`;
    if (!looksLikeStaleExtractor(text)) throw e;
    onBeforeRetry?.();
    await maybeUpdateYtDlp({ force: true, abortSignal });
    return runYtDlpTracked(resolveYtDlpBinary() || binary, args, abortSignal, timeoutMs, onOutput);
  }
}

// Startup sweep for orphans left by crashes or windows closed mid-download;
// live downloads are protected by the age cutoff.
function sweepStaleTempArtifacts(maxAgeMs = 24 * 60 * 60 * 1000) {
  try {
    const tempDir = getSafeTempDir();
    const cutoff = Date.now() - maxAgeMs;
    for (const f of fs.readdirSync(tempDir)) {
      if (!f.startsWith("ow-url-") && !f.startsWith("ow-diarize-")) continue;
      const p = path.join(tempDir, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch {}
    }
  } catch {}
}

// Remove any temp artifacts produced for a given base path. Best-effort.
function cleanupTempArtifacts(tempBase) {
  try {
    const tempDir = getSafeTempDir();
    const prefix = path.basename(tempBase);
    for (const f of fs.readdirSync(tempDir).filter((f) => f.startsWith(prefix))) {
      try {
        fs.unlinkSync(path.join(tempDir, f));
      } catch {}
    }
  } catch {}
}

const YT_DLP_AUDIO_EXTENSIONS = new Set([
  "m4a",
  "mp3",
  "opus",
  "webm",
  "ogg",
  "wav",
  "aac",
  "flac",
]);

// Select the finished audio file yt-dlp left for `prefix`, delete every other
// prefix-matched file (transient scratch files included), return its absolute path.
function selectYtDlpOutput(tempDir, prefix) {
  const all = fs.readdirSync(tempDir).filter((f) => f.startsWith(prefix));

  let best = null;
  for (const name of all) {
    // Match on the lowercased suffix after the prefix so the video id can never
    // trip an artifact pattern; yt-dlp writes these scratch suffixes lowercase.
    const rest = name.slice(prefix.length).toLowerCase();
    const isTransient =
      /-frag\d+/.test(rest) ||
      /\.(part|ytdl|aria2|meta)$/.test(rest) ||
      rest.endsWith(".temp") ||
      rest.includes(".temp.") ||
      rest.includes(".orig.");
    if (isTransient) continue;

    let mtimeMs;
    try {
      mtimeMs = fs.statSync(path.join(tempDir, name)).mtimeMs;
    } catch {
      continue; // vanished between readdir and stat
    }
    const knownAudio = YT_DLP_AUDIO_EXTENSIONS.has(path.extname(name).slice(1).toLowerCase());
    const tier = knownAudio ? (/\.f\d+\./.test(rest) ? 1 : 0) : 2;
    if (!best || tier < best.tier || (tier === best.tier && mtimeMs > best.mtimeMs)) {
      best = { name, tier, mtimeMs };
    }
  }

  if (!best) {
    const err = new Error("Download produced no output");
    err.code = "DOWNLOAD_FAILED";
    throw err;
  }

  for (const f of all) {
    if (f === best.name) continue;
    try {
      fs.unlinkSync(path.join(tempDir, f));
    } catch {}
  }
  return path.join(tempDir, best.name);
}

async function downloadYouTube(url, onProgress, abortSignal) {
  seedYtDlpFromBundle();
  const binary = resolveYtDlpBinary();
  if (!binary) {
    const err = new Error("yt-dlp binary not found in resources/bin");
    err.code = "DOWNLOAD_FAILED";
    throw err;
  }

  // yt-dlp's -x post-processor needs ffmpeg, which is not on PATH in packaged builds.
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

  // Route yt-dlp through the OS proxy when one is configured.
  const proxyUrl = await resolveProxyForUrl("https://www.youtube.com/");
  const proxyArgs = proxyUrl ? ["--proxy", proxyUrl] : [];

  let info;
  try {
    // Stale-extractor failures usually surface here, so this step self-heals too.
    const { stdout } = await runYtDlpWithSelfHeal(
      binary,
      [...proxyArgs, "--dump-single-json", "--no-warnings", sanitizedUrl],
      abortSignal,
      YT_DLP_METADATA_TIMEOUT_MS
    );
    info = JSON.parse(stdout);
  } catch (e) {
    if (e.code === "DOWNLOAD_CANCELLED" || abortSignal?.aborted) {
      const err = new Error("Download cancelled");
      err.code = "DOWNLOAD_CANCELLED";
      throw err;
    }
    const text = `${e.message || ""} ${e.stderr || ""}`;
    if (looksLikeYouTubeBlock(text)) {
      const err = new Error(
        "YouTube is temporarily blocking downloads from your network. Try again later."
      );
      err.code = "YOUTUBE_BLOCKED";
      throw err;
    }
    // A network stall is not "video unavailable" — keep it retryable.
    if (/timed out/i.test(e.message || "")) {
      const err = new Error("yt-dlp timed out");
      err.code = "DOWNLOAD_FAILED";
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
    "--audio-format",
    "best",
    "--max-filesize",
    "500M",
    "--ffmpeg-location",
    ffmpegDir,
    "-o",
    `${tempBase}.%(ext)s`,
    // Line-buffered progress ("[download]  42.3% of ...") instead of \r rewrites.
    "--newline",
    "--no-warnings",
    sanitizedUrl,
  ];

  // Cap at 99: after the download hits 100%, ffmpeg still has to extract audio.
  let lastPercent = 0;
  const onExtractionOutput = (text) => {
    const matches = text.match(/\[download\]\s+(\d{1,3}(?:\.\d+)?)%/g);
    if (!matches) return;
    const percent = Math.min(
      99,
      Math.round(parseFloat(matches[matches.length - 1].match(/([\d.]+)%/)[1]))
    );
    if (percent > lastPercent) {
      lastPercent = percent;
      onProgress?.({ stage: "downloading", percent, title });
    }
  };

  try {
    // The metadata step may have self-healed the cache copy; pick up the fresh binary.
    const { stdout: extractionOut } = await runYtDlpWithSelfHeal(
      resolveYtDlpBinary() || binary,
      extractionArgs,
      abortSignal,
      YT_DLP_EXTRACTION_TIMEOUT_MS,
      () => cleanupTempArtifacts(tempBase),
      onExtractionOutput
    );

    // --max-filesize makes yt-dlp skip the file and exit 0 with no output.
    if (/larger than max-filesize/i.test(extractionOut)) {
      const err = new Error("File too large. Maximum download size is 500 MB.");
      err.code = "FILE_TOO_LARGE";
      throw err;
    }

    const tempPath = selectYtDlpOutput(getSafeTempDir(), path.basename(tempBase));
    const sizeBytes = fs.statSync(tempPath).size;

    // --max-filesize doesn't enforce for unknown-size streams; re-check after the fact.
    if (sizeBytes > MAX_DOWNLOAD_BYTES) {
      try {
        fs.unlinkSync(tempPath);
      } catch {}
      const err = new Error("File too large. Maximum download size is 500 MB.");
      err.code = "FILE_TOO_LARGE";
      throw err;
    }

    // Throttled background self-update for next time (never awaited).
    maybeUpdateYtDlp();

    onProgress?.({ stage: "ready", percent: 100, title });

    return { tempPath, title, durationSeconds, sizeBytes };
  } catch (e) {
    cleanupTempArtifacts(tempBase);
    if (e.code === "DOWNLOAD_CANCELLED" || e.code === "PLAYLIST_URL") throw e;
    const text = `${e.message || ""} ${e.stderr || ""}`;
    if (looksLikeYouTubeBlock(text)) {
      const err = new Error(
        "YouTube is temporarily blocking downloads from your network. Try again later."
      );
      err.code = "YOUTUBE_BLOCKED";
      throw err;
    }
    const err = new Error(e.stderr || e.message || "Download failed");
    err.code = e.code || "DOWNLOAD_FAILED";
    throw err;
  }
}

function httpRequest(parsed, options) {
  const mod = parsed.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    // UA-less requests get bot-walled by common CDN fronts. `signal` lets a
    // cancel land during the connect phase, not just once data is streaming.
    const req = mod.request(
      parsed,
      { timeout: CONNECT_TIMEOUT_MS, headers: { "User-Agent": USER_AGENT }, ...options },
      resolve
    );
    req.on("error", (err) => {
      if (options.signal?.aborted) {
        reject(Object.assign(new Error("Download cancelled"), { code: "DOWNLOAD_CANCELLED" }));
      } else {
        reject(err);
      }
    });
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
function streamToFile(
  response,
  tempPath,
  { contentLength, title, onProgress, abortSignal, abort }
) {
  return new Promise((resolve, reject) => {
    // An already-dispatched abort event never re-fires for a late listener.
    if (abortSignal?.aborted) {
      try {
        abort();
      } catch {}
      reject(Object.assign(new Error("Download cancelled"), { code: "DOWNLOAD_CANCELLED" }));
      return;
    }
    const fileStream = fs.createWriteStream(tempPath);
    let downloaded = 0;
    let settled = false;

    const stall = createStallChecker(() => {
      if (settled) return;
      try {
        abort();
      } catch {}
      bail(Object.assign(new Error("Download stalled"), { code: "DOWNLOAD_FAILED" }));
    });

    // destroy() returns before the stream's async open finishes, so unlinking
    // right away can race a pending open into recreating the file. Wait for 'close'.
    const cleanupFile = () =>
      new Promise((done) => {
        const unlink = () =>
          fs.unlink(tempPath, (e) => {
            try {
              if (e && e.code !== "ENOENT") {
                debugLogger.warn("Failed to remove partial download", {
                  tempPath,
                  error: e.message,
                });
              }
            } finally {
              done();
            }
          });
        if (fileStream.closed) {
          unlink();
          return;
        }
        fileStream.once("close", unlink);
        fileStream.destroy();
      });

    const bail = (err) => {
      if (settled) return;
      settled = true;
      stall.clear();
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      cleanupFile().then(() => reject(err));
    };

    // React to cancel even while stalled (no data events arriving).
    const onAbort = () => {
      try {
        abort();
      } catch {}
      bail(Object.assign(new Error("Download cancelled"), { code: "DOWNLOAD_CANCELLED" }));
    };
    if (abortSignal) abortSignal.addEventListener("abort", onAbort, { once: true });

    response.on("data", (chunk) => {
      if (settled) return;

      stall.touch();
      downloaded += chunk.length;

      if (downloaded > MAX_DOWNLOAD_BYTES) {
        try {
          abort();
        } catch {}
        bail(
          Object.assign(new Error("File too large. Maximum download size is 500 MB."), {
            code: "FILE_TOO_LARGE",
          })
        );
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
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      try {
        const sizeBytes = fs.statSync(tempPath).size;
        resolve(sizeBytes);
      } catch {
        cleanupFile().then(() =>
          reject(
            Object.assign(new Error("Download produced no output"), { code: "DOWNLOAD_FAILED" })
          )
        );
      }
    });
  });
}

// Test seam: electron's net is unavailable under node --test.
let electronNetOverride = null;
function getElectronNet() {
  return electronNetOverride || require("electron").net;
}

// Internal sentinel: the redirect handler aborts the request and asks the caller
// to restart the download at the redirect URL (followRedirect must be invoked
// synchronously inside the redirect event, but our host validation is async).
const REDIRECT_RESTART = "REDIRECT_RESTART";

// Proxy path: route through Electron net.request (which honors the OS proxy
// automatically). For defense-in-depth we still pre-flight the target hostname and
// re-validate each redirect hop against private IPs. With a proxy the corporate
// egress policy is the primary SSRF control; net.request does not accept a
// per-request lookup, leaving a narrow DNS-rebinding TOCTOU residual.
async function downloadViaProxy(url, onProgress, abortSignal, redirectCount = 0) {
  const net = getElectronNet();

  await assertPublicHost(new URL(url).hostname);

  const settledResponse = await new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(Object.assign(new Error("Download cancelled"), { code: "DOWNLOAD_CANCELLED" }));
      return;
    }

    let redirects = redirectCount;
    let request;
    try {
      request = net.request({ url, method: "GET", redirect: "manual" });
      request.setHeader("User-Agent", USER_AGENT);
    } catch (e) {
      reject(Object.assign(new Error(e.message || "Download failed"), { code: "DOWNLOAD_FAILED" }));
      return;
    }

    // ClientRequest.abort() emits 'abort'/'close' but never 'error', so an abort
    // that lands after request.end() must settle the promise itself or it hangs.
    const onAbort = () => {
      try {
        request.abort();
      } catch {}
      detach();
      reject(Object.assign(new Error("Download cancelled"), { code: "DOWNLOAD_CANCELLED" }));
    };
    if (abortSignal) abortSignal.addEventListener("abort", onAbort, { once: true });
    // Chromium's net stack has no response-header timeout; without this a proxy
    // that accepts the connection but never answers wedges the queue forever
    // (the direct path gets the same bound from httpRequest's socket timeout).
    const connectTimer = setTimeout(() => {
      try {
        request.abort();
      } catch {}
      detach();
      reject(Object.assign(new Error("Connection timed out"), { code: "DOWNLOAD_FAILED" }));
    }, CONNECT_TIMEOUT_MS);
    const detach = () => {
      clearTimeout(connectTimer);
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
    };

    request.on("redirect", (statusCode, method, redirectUrl) => {
      redirects += 1;
      if (redirects > MAX_REDIRECTS) {
        try {
          request.abort();
        } catch {}
        detach();
        reject(Object.assign(new Error("Too many redirects"), { code: "DOWNLOAD_FAILED" }));
        return;
      }
      let next;
      try {
        next = new URL(redirectUrl);
      } catch {
        try {
          request.abort();
        } catch {}
        detach();
        reject(Object.assign(new Error("Invalid redirect URL"), { code: "INVALID_URL" }));
        return;
      }
      if (next.protocol !== "https:") {
        try {
          request.abort();
        } catch {}
        detach();
        reject(
          Object.assign(new Error("Only HTTPS URLs are supported for direct downloads"), {
            code: "INVALID_URL",
          })
        );
        return;
      }
      // Abort and restart at the redirect URL; the recursive call re-runs assertPublicHost.
      try {
        request.abort();
      } catch {}
      detach();
      reject(
        Object.assign(new Error("Redirected"), {
          code: REDIRECT_RESTART,
          url: next.href,
          redirects,
        })
      );
    });

    request.on("response", (response) => {
      detach();
      const statusCode = response.statusCode;
      if (statusCode !== 200) {
        response.resume();
        try {
          request.abort();
        } catch {}
        reject(Object.assign(new Error(`HTTP ${statusCode}`), { code: "DOWNLOAD_FAILED" }));
        return;
      }

      const contentType = (firstHeaderValue(response.headers, "content-type") || "").toLowerCase();
      if (!isAcceptableAudioContentType(contentType)) {
        response.resume();
        try {
          request.abort();
        } catch {}
        reject(
          Object.assign(
            new Error(`URL does not point to an audio file (content-type: ${contentType})`),
            { code: "CONTENT_TYPE_INVALID" }
          )
        );
        return;
      }

      const clHeader = firstHeaderValue(response.headers, "content-length");
      const contentLength = clHeader ? Number(clHeader) : null;
      if (contentLength && contentLength > MAX_DOWNLOAD_BYTES) {
        response.resume();
        try {
          request.abort();
        } catch {}
        reject(
          Object.assign(new Error("File too large. Maximum download size is 500 MB."), {
            code: "FILE_TOO_LARGE",
          })
        );
        return;
      }

      resolve({ response, contentLength, request });
    });

    request.on("error", (err) => {
      detach();
      if (abortSignal?.aborted) {
        reject(Object.assign(new Error("Download cancelled"), { code: "DOWNLOAD_CANCELLED" }));
      } else {
        reject(
          Object.assign(new Error(err.message || "Download failed"), { code: "DOWNLOAD_FAILED" })
        );
      }
    });

    request.end();
  }).catch((err) => {
    if (err && err.code === REDIRECT_RESTART) return err;
    throw err;
  });

  if (settledResponse && settledResponse.code === REDIRECT_RESTART) {
    return downloadViaProxy(
      settledResponse.url,
      onProgress,
      abortSignal,
      settledResponse.redirects
    );
  }

  const { response, contentLength, request } = settledResponse;

  const { title, ext } = deriveTitleAndExt(new URL(url).pathname);
  const tempPath = path.join(getSafeTempDir(), `ow-url-${Date.now()}.${ext}`);

  onProgress?.({ stage: "downloading", percent: 0, title });

  const sizeBytes = await streamToFile(response, tempPath, {
    contentLength,
    title,
    onProgress,
    abortSignal,
    abort: () => {
      try {
        request.abort();
      } catch {}
    },
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
  // as the default for the common no-proxy case.
  const proxyUrl = await resolveProxyForUrl(url);
  if (proxyUrl) {
    return downloadViaProxy(url, onProgress, abortSignal, redirectCount);
  }

  // Servers may refuse HEAD (GET-only presigned URLs, 405s): non-2xx or transport
  // failures fall through to the GET, which is fully re-validated anyway.
  let headParsed = parsed;
  let headRedirects = 0;
  let headResponse = null;
  try {
    while (true) {
      headResponse = await httpRequest(headParsed, {
        method: "HEAD",
        lookup: ssrfSafeLookup,
        signal: abortSignal,
      });
      headResponse.resume();
      if (
        headResponse.statusCode >= 300 &&
        headResponse.statusCode < 400 &&
        headResponse.headers.location
      ) {
        // Cumulative redirect bound across alternating GET+HEAD hops.
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
  } catch (e) {
    if (
      e.code === "SSRF_BLOCKED" ||
      e.code === "INVALID_URL" ||
      e.code === "DOWNLOAD_FAILED" ||
      e.code === "DOWNLOAD_CANCELLED"
    ) {
      throw e;
    }
    headResponse = null;
  }

  let contentLength = null;
  if (headResponse && headResponse.statusCode >= 200 && headResponse.statusCode < 300) {
    const contentType = (headResponse.headers["content-type"] || "").toLowerCase();
    if (!isAcceptableAudioContentType(contentType)) {
      const err = new Error(`URL does not point to an audio file (content-type: ${contentType})`);
      err.code = "CONTENT_TYPE_INVALID";
      throw err;
    }

    contentLength = headResponse.headers["content-length"]
      ? Number(headResponse.headers["content-length"])
      : null;

    if (contentLength && contentLength > MAX_DOWNLOAD_BYTES) {
      const err = new Error("File too large. Maximum download size is 500 MB.");
      err.code = "FILE_TOO_LARGE";
      throw err;
    }
  }

  const { title, ext } = deriveTitleAndExt(headParsed.pathname);
  const tempPath = path.join(getSafeTempDir(), `ow-url-${Date.now()}.${ext}`);

  onProgress?.({ stage: "downloading", percent: 0, title });

  const response = await httpRequest(headParsed, {
    method: "GET",
    lookup: ssrfSafeLookup,
    signal: abortSignal,
  });

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

  if (contentLength == null && response.headers["content-length"]) {
    contentLength = Number(response.headers["content-length"]);
    if (contentLength > MAX_DOWNLOAD_BYTES) {
      response.destroy();
      const err = new Error("File too large. Maximum download size is 500 MB.");
      err.code = "FILE_TOO_LARGE";
      throw err;
    }
  }

  const sizeBytes = await streamToFile(response, tempPath, {
    contentLength,
    title,
    onProgress,
    abortSignal,
    abort: () => {
      try {
        response.destroy();
      } catch {}
    },
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
  sweepStaleTempArtifacts,
  isPrivateIp,
  isAcceptableAudioContentType,
  ssrfSafeLookup,
  maybeUpdateYtDlp,
  downloadViaProxy,
  // Test-only seam: lets the regression test confirm the single-flight flag is cleared.
  _isYtDlpUpdateInFlight: () => ytDlpUpdateInFlight,
  // Test-only seam: injects a fake electron net for downloadViaProxy tests.
  _setElectronNetForTests: (net) => {
    electronNetOverride = net;
  },
  // Test-only seam: exposes yt-dlp output selection to the regression tests.
  _selectYtDlpOutput: selectYtDlpOutput,
  // Test-only seams: cache checksum verification and block-detection heuristics.
  _resolveYtDlpBinary: resolveYtDlpBinary,
  _recordCacheChecksum: recordCacheChecksum,
  _looksLikeYouTubeBlock: looksLikeYouTubeBlock,
};
