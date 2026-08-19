const { execFileSync } = require("child_process");
const debugLogger = require("./debugLogger");

// GNOME can only grab an accelerator whose keysym exists in the active keymap.
// Stock xkeyboard-config maps the F13-F24 keycodes to XF86Launch*/XF86Tools
// keysyms, so a gsettings binding like "F16" registers fine and never fires.
// This module answers "is this keysym in the active keymap?" so registration
// can fail honestly instead. Query failures fail open ("unknown").

const QUERY_TIMEOUT_MS = 3000;
const QUERY_MAX_BUFFER = 5 * 1024 * 1024;
const CACHE_TTL_MS = 10_000;

// A real keymap carries hundreds of keysyms; fewer means a garbled query,
// and trusting it would risk a false "absent" on a working key.
const MIN_PLAUSIBLE_KEYSYMS = 30;

let cache = { keysyms: null, expiresAt: 0 };

function resetCacheForTests() {
  cache = { keysyms: null, expiresAt: 0 };
}

// "<Control><Shift>F16" -> "F16"
function extractKeysym(gnomeShortcut) {
  if (!gnomeShortcut || typeof gnomeShortcut !== "string") return null;
  const keysym = gnomeShortcut.replace(/<[^>]*>/g, "").trim();
  return keysym || null;
}

// xmodmap -pke lines: `keycode 194 = XF86Launch7 NoSymbol XF86Launch7`
function parseXmodmapKeysyms(output) {
  const keysyms = new Set();
  if (typeof output !== "string") return keysyms;
  for (const line of output.split("\n")) {
    if (!line.startsWith("keycode")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    for (const token of line.slice(eq + 1).trim().split(/\s+/)) {
      if (token && token !== "NoSymbol") keysyms.add(token);
    }
  }
  return keysyms;
}

// xkbcomp -xkb dump: keysyms appear inside [ ... ] groups of the
// xkb_symbols section, e.g. `key <AE01> { [ 1, exclam ] };`.
function parseXkbcompKeysyms(output) {
  const keysyms = new Set();
  if (typeof output !== "string") return keysyms;
  const symbolsStart = output.indexOf("xkb_symbols");
  if (symbolsStart === -1) return keysyms;
  let section = output.slice(symbolsStart);
  const geometryStart = section.indexOf("xkb_geometry");
  if (geometryStart !== -1) section = section.slice(0, geometryStart);

  const bracketGroup = /\[([^\]]*)\]/g;
  let match;
  while ((match = bracketGroup.exec(section)) !== null) {
    for (const token of match[1].split(",")) {
      const sym = token.trim();
      if (/^[A-Za-z0-9_]+$/.test(sym) && sym !== "NoSymbol") keysyms.add(sym);
    }
  }
  return keysyms;
}

function readActiveKeymapKeysyms(deps = {}) {
  const env = deps.env || process.env;
  const exec = deps.execFileSync || execFileSync;
  const display = env.DISPLAY;
  if (!display) {
    debugLogger.log("[XkbKeymapCheck] No DISPLAY available, cannot query keymap");
    return null;
  }

  const options = {
    encoding: "utf-8",
    timeout: QUERY_TIMEOUT_MS,
    maxBuffer: QUERY_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  };

  try {
    const keysyms = parseXmodmapKeysyms(exec("xmodmap", ["-pke"], options));
    if (keysyms.size >= MIN_PLAUSIBLE_KEYSYMS) return keysyms;
    debugLogger.log(`[XkbKeymapCheck] xmodmap output implausibly small (${keysyms.size} keysyms)`);
  } catch (err) {
    debugLogger.log("[XkbKeymapCheck] xmodmap query failed:", err.message);
  }

  try {
    const keysyms = parseXkbcompKeysyms(exec("xkbcomp", ["-xkb", display, "-"], options));
    if (keysyms.size >= MIN_PLAUSIBLE_KEYSYMS) return keysyms;
    debugLogger.log(`[XkbKeymapCheck] xkbcomp output implausibly small (${keysyms.size} keysyms)`);
  } catch (err) {
    debugLogger.log("[XkbKeymapCheck] xkbcomp query failed:", err.message);
  }

  return null;
}

/**
 * Check whether the keysym of a GNOME-format shortcut exists in the active keymap.
 * @param {string} gnomeShortcut e.g. "<Control><Shift>F16"
 * @param {{execFileSync?: Function, env?: object}} [deps] test injection; bypasses the cache
 * @returns {"present" | "absent" | "unknown"} "unknown" means the query failed — callers must fail open
 */
function checkKeysymAvailability(gnomeShortcut, deps) {
  const keysym = extractKeysym(gnomeShortcut);
  if (!keysym) return "unknown";

  let keysyms;
  if (deps) {
    keysyms = readActiveKeymapKeysyms(deps);
  } else {
    const now = Date.now();
    if (now >= cache.expiresAt) {
      cache = { keysyms: readActiveKeymapKeysyms(), expiresAt: now + CACHE_TTL_MS };
    }
    keysyms = cache.keysyms;
  }

  if (!keysyms) return "unknown";
  return keysyms.has(keysym) ? "present" : "absent";
}

module.exports = {
  checkKeysymAvailability,
  extractKeysym,
  parseXmodmapKeysyms,
  parseXkbcompKeysyms,
  readActiveKeymapKeysyms,
  resetCacheForTests,
};
