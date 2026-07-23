// Resolving system tools (ffmpeg, ffprobe, whisper.cpp, ...) on macOS and Linux
// is more than checking a couple of hardcoded paths. GUI apps are launched by
// launchd/systemd with a minimal PATH that never sources the user's shell
// profile, so anything installed by Homebrew or Nix is invisible to
// process.env.PATH. This resolver combines the inherited PATH, the real
// login-shell PATH, and known extra install locations, and keeps the resolution
// logic injectable so it can be unit-tested without a real filesystem.

const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");

// Common non-standard bin directories a GUI-launched app would otherwise miss.
// Nix (including nix-darwin) installs here, which is why ffmpeg/ffprobe are not
// found at the usual Homebrew/system locations on those machines.
function extraBinDirs(platform, homedir) {
  if (platform === "win32") return ["C:\\ffmpeg\\bin"];

  const nix = [
    "/run/current-system/sw/bin", // nix-darwin / NixOS system profile
    path.posix.join(homedir, ".nix-profile", "bin"), // per-user nix profile
    "/nix/var/nix/profiles/default/bin", // default nix profile
  ];

  const base =
    platform === "darwin"
      ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
      : ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

  return [...base, ...nix];
}

function splitPath(value, sep) {
  return String(value || "")
    .split(sep)
    .map((entry) => entry.replace(/^"|"$/g, "").trim())
    .filter(Boolean);
}

let cachedShellDirs;

// Ask the user's login shell for the PATH it would actually use. This is the
// standard Electron-on-macOS fix for launchd's minimal PATH. Best-effort:
// returns [] on Windows, on error, or if nothing usable comes back. Cached
// because spawning a login shell is relatively expensive.
function loginShellPathDirs(opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const exec = opts.exec || childProcess.execFileSync;

  if (opts.clearCache) cachedShellDirs = undefined;
  if (cachedShellDirs !== undefined) return cachedShellDirs;
  if (platform === "win32") {
    cachedShellDirs = [];
    return cachedShellDirs;
  }

  const shell = env.SHELL || "/bin/zsh";
  try {
    // A sentinel keeps us from being fooled by banners or rc-file chatter that
    // an interactive login shell may print before the PATH line.
    const out = exec(shell, ["-lic", 'printf "__OW_PATH__=%s\\n" "$PATH"'], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = /__OW_PATH__=(.*)/.exec(String(out || ""));
    cachedShellDirs = match ? splitPath(match[1], ":") : [];
  } catch {
    cachedShellDirs = [];
  }
  return cachedShellDirs;
}

// Reset the login-shell PATH cache. Exposed for tests and for callers that know
// the environment changed.
function clearShellPathCache() {
  cachedShellDirs = undefined;
}

// Ordered, de-duplicated directories to search for a system binary: inherited
// PATH first, then the login-shell PATH, then the known extra locations.
function systemBinDirs(opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const homedir = opts.homedir || os.homedir();
  const sep = platform === "win32" ? ";" : ":";

  const dirs = [
    ...splitPath(env.PATH, sep),
    ...loginShellPathDirs({ ...opts, platform, env }),
    ...extraBinDirs(platform, homedir),
  ];

  const seen = new Set();
  const out = [];
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out;
}

function defaultIsExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Resolve an executable by name across systemBinDirs. Returns the absolute path
// or null. Filesystem access is injectable so the ordering/matching logic is
// unit-testable without touching the real disk.
function findSystemBinary(binaryName, opts = {}) {
  const platform = opts.platform || process.platform;
  const existsSync = opts.existsSync || fs.existsSync;
  const isExecutable = opts.isExecutable || defaultIsExecutable;

  const name =
    platform === "win32" && !binaryName.endsWith(".exe") ? `${binaryName}.exe` : binaryName;
  const join = platform === "win32" ? path.win32.join : path.posix.join;

  for (const dir of systemBinDirs(opts)) {
    const candidate = join(dir, name);
    if (!existsSync(candidate)) continue;
    if (platform !== "win32" && !isExecutable(candidate)) continue;
    return candidate;
  }
  return null;
}

// Build a PATH string that includes the login-shell PATH and the known extra
// dirs, so child processes (yt-dlp -> ffprobe, whisper.cpp) inherit a PATH that
// can actually find system tools even when the app was launched with a minimal
// one.
function buildAugmentedPath(opts = {}) {
  const platform = opts.platform || process.platform;
  const sep = platform === "win32" ? ";" : ":";
  return systemBinDirs(opts).join(sep);
}

module.exports = {
  extraBinDirs,
  loginShellPathDirs,
  clearShellPathCache,
  systemBinDirs,
  findSystemBinary,
  buildAugmentedPath,
};
