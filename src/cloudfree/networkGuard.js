/**
 * CloudFree Network Guard
 *
 * Electron main-process module that enforces the URL allowlist.
 * Only requests matching an allowed domain + path pattern are permitted.
 * Everything else is implicitly blocked.
 *
 * Path patterns support wildcards:
 *   /v1/audio/*      — matches /v1/audio/transcriptions, /v1/audio/translations
 *   /{star}/resolve/main/{star} — matches /user/repo/resolve/main/file.bin
 *   /v1/realtime*     — matches /v1/realtime and /v1/realtime?intent=transcription
 *   /*                — matches any path (full domain access)
 *
 * Usage in main.js:
 *   const { installNetworkGuard } = require("./src/cloudfree/networkGuard");
 *   installNetworkGuard(session.defaultSession);
 */

const { ipcMain, app } = require("electron");
const path = require("path");
const fs = require("fs");

// Load allowlist from JSON
function loadAllowlist() {
  const allowlistPath = path.join(__dirname, "../../cloudfree-allowlist.json");
  const raw = fs.readFileSync(allowlistPath, "utf-8");
  return JSON.parse(raw);
}

let allowlist = loadAllowlist();

// --- User-managed rules (persisted to userData) ---

function getUserConfigPath() {
  return path.join(app.getPath("userData"), "cloudfree-user-rules.json");
}

function loadUserConfig() {
  try {
    const raw = fs.readFileSync(getUserConfigPath(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return { userRules: [], disabledGroups: [] };
  }
}

function saveUserConfig(config) {
  fs.writeFileSync(getUserConfigPath(), JSON.stringify(config, null, 2), "utf-8");
}

let userConfig = loadUserConfig();

// In-memory log of recent blocked/allowed requests for the UI
const MAX_LOG_ENTRIES = 200;
const networkLog = [];
const internalLog = [];
const MAX_INTERNAL_LOG = 100;
let stats = { allowed: 0, blocked: 0, internal: 0 };

function resetStats() {
  stats = { allowed: 0, blocked: 0, internal: 0 };
  networkLog.length = 0;
  internalLog.length = 0;
}

/**
 * Build a flat list of { domain, paths, group } from the allowlist rules,
 * respecting disabled groups and including user-added rules.
 */
function getRules() {
  const rules = [];
  const disabled = new Set(userConfig.disabledGroups || []);

  for (const [group, config] of Object.entries(allowlist.rules || {})) {
    if (disabled.has(group)) continue;
    for (const entry of config.entries || []) {
      rules.push({ domain: entry.domain, paths: entry.paths || ["/*"], group });
    }
  }

  // Append user-defined rules
  for (const entry of userConfig.userRules || []) {
    rules.push({ domain: entry.domain, paths: entry.paths || ["/*"], group: "user" });
  }

  return rules;
}

function extractUrlParts(url) {
  try {
    const parsed = new URL(url);
    return {
      hostname: parsed.hostname.toLowerCase(),
      pathname: parsed.pathname + parsed.search,
    };
  } catch {
    return null;
  }
}

function matchesDomain(hostname, ruleDomain) {
  if (hostname === ruleDomain) return true;
  if (hostname.endsWith(`.${ruleDomain}`)) return true;
  return false;
}

/**
 * Match a URL path against a wildcard pattern.
 * '*' matches any sequence of characters within or across path segments.
 */
function matchesPath(urlPath, pattern) {
  // Convert wildcard pattern to regex
  // Escape regex special chars except *, then replace * with .*
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp("^" + escaped.replace(/\*/g, ".*"));
  return regex.test(urlPath);
}

function checkUrl(url) {
  // Allow data: and file: URLs
  if (url.startsWith("data:") || url.startsWith("file:") || url.startsWith("devtools:")) {
    return { allowed: true, reason: "internal" };
  }

  // Allow chrome-extension:// URLs
  if (url.startsWith("chrome-extension:")) {
    return { allowed: true, reason: "internal" };
  }

  const parts = extractUrlParts(url);
  if (!parts) {
    return { allowed: false, reason: "invalid URL" };
  }

  const { hostname, pathname } = parts;
  const rules = getRules();

  for (const rule of rules) {
    if (!matchesDomain(hostname, rule.domain)) continue;

    // Domain matched — check paths
    for (const pathPattern of rule.paths) {
      if (matchesPath(pathname, pathPattern)) {
        return { allowed: true, reason: `${rule.group}: ${rule.domain} ${pathPattern}` };
      }
    }

    // Domain matched but no path matched
    return { allowed: false, reason: `path not allowed on ${rule.domain}: ${pathname}` };
  }

  return { allowed: false, reason: `domain not in allowlist: ${hostname}` };
}

function addLogEntry(entry) {
  networkLog.unshift(entry);
  if (networkLog.length > MAX_LOG_ENTRIES) {
    networkLog.pop();
  }
}

/**
 * Install the network guard on an Electron session.
 * Call this once during app startup.
 */
function installNetworkGuard(electronSession, debugLogger) {
  const log = debugLogger || console;

  electronSession.webRequest.onBeforeRequest((details, callback) => {
    const { url, resourceType } = details;

    const result = checkUrl(url);
    const timestamp = Date.now();

    // Classify internal/local traffic separately
    const isInternal = result.reason === "internal" ||
      url.startsWith("devtools://") ||
      /^(https?|wss?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/.test(url);

    if (result.allowed) {
      if (isInternal) {
        stats.internal++;
        const truncatedUrl = url.length > 200 ? url.substring(0, 200) + "..." : url;
        internalLog.unshift({ timestamp, url: truncatedUrl, status: "internal", reason: result.reason, resourceType });
        if (internalLog.length > MAX_INTERNAL_LOG) internalLog.pop();
      } else {
        stats.allowed++;
        addLogEntry({
          timestamp,
          url: url.length > 200 ? url.substring(0, 200) + "..." : url,
          status: "allowed",
          reason: result.reason,
          resourceType,
        });
      }
      callback({});
    } else {
      stats.blocked++;
      const entry = {
        timestamp,
        url: url.length > 200 ? url.substring(0, 200) + "..." : url,
        status: "blocked",
        reason: result.reason,
        resourceType,
      };
      addLogEntry(entry);
      log.warn?.(`[CloudFree] BLOCKED: ${url} (${result.reason})`) ||
        log.log?.(`[CloudFree] BLOCKED: ${url} (${result.reason})`);
      callback({ cancel: true });
    }
  });

  // IPC handlers for UI
  ipcMain.handle("cloudfree:get-network-log", () => {
    return { log: networkLog, internalLog, stats, allowlist: getAllowlistSummary() };
  });

  ipcMain.handle("cloudfree:get-allowlist", () => {
    return getAllowlistSummary();
  });

  ipcMain.handle("cloudfree:reset-stats", () => {
    resetStats();
    return { ok: true };
  });

  ipcMain.handle("cloudfree:add-user-rule", (_event, { domain, paths }) => {
    if (!domain || typeof domain !== "string") return { ok: false, error: "domain required" };
    const cleanDomain = domain.toLowerCase().replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
    if (!cleanDomain) return { ok: false, error: "invalid domain" };
    const cleanPaths = Array.isArray(paths) && paths.length > 0 ? paths : ["/*"];
    // Avoid duplicates
    const existing = userConfig.userRules.find((r) => r.domain === cleanDomain);
    if (existing) {
      // Merge paths
      const pathSet = new Set([...existing.paths, ...cleanPaths]);
      existing.paths = [...pathSet];
    } else {
      userConfig.userRules.push({ domain: cleanDomain, paths: cleanPaths });
    }
    saveUserConfig(userConfig);
    return { ok: true };
  });

  ipcMain.handle("cloudfree:remove-user-rule", (_event, { domain }) => {
    userConfig.userRules = userConfig.userRules.filter((r) => r.domain !== domain);
    saveUserConfig(userConfig);
    return { ok: true };
  });

  ipcMain.handle("cloudfree:toggle-group", (_event, { group, enabled }) => {
    const disabled = new Set(userConfig.disabledGroups || []);
    if (enabled) {
      disabled.delete(group);
    } else {
      disabled.add(group);
    }
    userConfig.disabledGroups = [...disabled];
    saveUserConfig(userConfig);
    return { ok: true };
  });

  ipcMain.handle("cloudfree:get-user-config", () => {
    return { userRules: userConfig.userRules || [], disabledGroups: userConfig.disabledGroups || [] };
  });

  log.info?.("[CloudFree] Network guard installed") ||
    log.log?.("[CloudFree] Network guard installed");

  return { checkUrl, getStats: () => stats };
}

function getAllowlistSummary() {
  const disabled = new Set(userConfig.disabledGroups || []);
  const summary = { rules: {}, disabledGroups: [...disabled] };
  for (const [group, config] of Object.entries(allowlist.rules || {})) {
    summary.rules[group] = {
      comment: config._comment || "",
      entries: (config.entries || []).map((e) => ({
        domain: e.domain,
        paths: e.paths || ["/*"],
      })),
      enabled: !disabled.has(group),
    };
  }
  // Include user rules as their own group
  if (userConfig.userRules && userConfig.userRules.length > 0) {
    summary.rules.user = {
      comment: "User-added custom rules",
      entries: userConfig.userRules.map((e) => ({
        domain: e.domain,
        paths: e.paths || ["/*"],
      })),
      enabled: true,
    };
  }
  return summary;
}

module.exports = { installNetworkGuard, checkUrl, loadAllowlist };
