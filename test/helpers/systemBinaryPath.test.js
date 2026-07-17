const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extraBinDirs,
  findSystemBinary,
  systemBinDirs,
  buildAugmentedPath,
} = require("../../src/helpers/systemBinaryPath");

const NIX_FFMPEG = "/run/current-system/sw/bin/ffmpeg";
const NIX_FFPROBE = "/run/current-system/sw/bin/ffprobe";

// A minimal PATH is exactly what launchd hands a GUI-launched Electron app on
// macOS: no Homebrew, no Nix, no user profile.
const LAUNCHD_MINIMAL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

// exec stub standing in for a login shell that reports a Nix-augmented PATH.
function loginShellReturning(pathValue) {
  return () => `__OW_PATH__=${pathValue}\n`;
}

// existsSync stub: only the listed absolute paths exist.
function existsAmong(...present) {
  const set = new Set(present);
  return (candidate) => set.has(candidate);
}

test("regression: the old hardcoded darwin list misses a Nix ffmpeg", () => {
  // This mirrors the exact detection the code used before the fix.
  const oldDarwinCandidates = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
  const oldPathScanDirs = LAUNCHD_MINIMAL_PATH.split(":");
  const exists = existsAmong(NIX_FFMPEG, NIX_FFPROBE);

  const foundViaOldList = oldDarwinCandidates.find((c) => exists(c)) || null;
  const foundViaOldPathScan =
    oldPathScanDirs.map((d) => `${d}/ffmpeg`).find((c) => exists(c)) || null;

  assert.equal(foundViaOldList, null, "old hardcoded list should not find the Nix ffmpeg");
  assert.equal(foundViaOldPathScan, null, "scanning launchd's minimal PATH should not find it");
});

test("findSystemBinary finds a Nix ffmpeg via the extra bin dirs", () => {
  const found = findSystemBinary("ffmpeg", {
    platform: "darwin",
    env: { PATH: LAUNCHD_MINIMAL_PATH },
    homedir: "/Users/nixuser",
    exec: () => {
      throw new Error("no login shell available");
    },
    existsSync: existsAmong(NIX_FFMPEG),
    isExecutable: () => true,
    clearCache: true,
  });

  assert.equal(found, NIX_FFMPEG);
});

test("findSystemBinary finds ffprobe via the login-shell PATH", () => {
  // The bundled ffmpeg-static ships no ffprobe, so this is the binary yt-dlp
  // actually fails on. A login shell that exposes the Nix profile fixes it.
  const found = findSystemBinary("ffprobe", {
    platform: "darwin",
    env: { PATH: LAUNCHD_MINIMAL_PATH, SHELL: "/bin/zsh" },
    homedir: "/Users/nixuser",
    exec: loginShellReturning("/run/current-system/sw/bin:/usr/bin:/bin"),
    existsSync: existsAmong(NIX_FFPROBE),
    isExecutable: () => true,
    clearCache: true,
  });

  assert.equal(found, NIX_FFPROBE);
});

test("findSystemBinary skips a match that is not executable", () => {
  const found = findSystemBinary("ffmpeg", {
    platform: "darwin",
    env: { PATH: LAUNCHD_MINIMAL_PATH },
    homedir: "/Users/nixuser",
    exec: () => {
      throw new Error("no login shell");
    },
    existsSync: existsAmong(NIX_FFMPEG),
    isExecutable: () => false,
    clearCache: true,
  });

  assert.equal(found, null);
});

test("findSystemBinary appends .exe and honors the win32 fallback dir", () => {
  const winFfmpeg = "C:\\ffmpeg\\bin\\ffmpeg.exe";
  const found = findSystemBinary("ffmpeg", {
    platform: "win32",
    env: { PATH: "C:\\Windows\\system32" },
    homedir: "C:\\Users\\me",
    existsSync: existsAmong(winFfmpeg),
    clearCache: true,
  });

  assert.equal(found, winFfmpeg);
});

test("extraBinDirs lists the common Nix locations on darwin", () => {
  const dirs = extraBinDirs("darwin", "/Users/nixuser");
  assert.ok(dirs.includes("/run/current-system/sw/bin"));
  assert.ok(dirs.includes("/Users/nixuser/.nix-profile/bin"));
  assert.ok(dirs.includes("/nix/var/nix/profiles/default/bin"));
  assert.ok(dirs.includes("/opt/homebrew/bin"));
});

test("systemBinDirs de-duplicates while preserving priority order", () => {
  const dirs = systemBinDirs({
    platform: "darwin",
    env: { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" },
    homedir: "/Users/nixuser",
    exec: loginShellReturning("/usr/bin:/run/current-system/sw/bin"),
    clearCache: true,
  });

  // Inherited PATH entries come first and are not repeated by the login shell.
  assert.equal(dirs.indexOf("/usr/bin"), 0);
  assert.equal(dirs.filter((d) => d === "/usr/bin").length, 1);
  assert.ok(dirs.includes("/run/current-system/sw/bin"));
});

test("buildAugmentedPath injects Nix dirs a launchd PATH is missing", () => {
  const augmented = buildAugmentedPath({
    platform: "darwin",
    env: { PATH: LAUNCHD_MINIMAL_PATH, SHELL: "/bin/zsh" },
    homedir: "/Users/nixuser",
    exec: loginShellReturning("/run/current-system/sw/bin:/usr/bin"),
    clearCache: true,
  });

  const dirs = augmented.split(":");
  assert.ok(dirs.includes("/run/current-system/sw/bin"));
  assert.ok(dirs.includes("/Users/nixuser/.nix-profile/bin"));
  // The original minimal entries survive.
  assert.ok(dirs.includes("/usr/bin"));
});
