const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  getUnixToolBinDirs,
  getSystemFfmpegCandidates,
} = require("../../src/helpers/unixToolBinDirs");

test("macOS candidates include Homebrew and nix-darwin prefixes", () => {
  const dirs = getUnixToolBinDirs({
    platform: "darwin",
    env: { HOME: "/Users/ada" },
    homedir: "/Users/ada",
  });

  assert.ok(dirs.includes("/opt/homebrew/bin"));
  assert.ok(dirs.includes("/usr/local/bin"));
  assert.ok(dirs.includes("/run/current-system/sw/bin"));
  assert.ok(dirs.includes(path.join("/Users/ada", ".nix-profile", "bin")));
  assert.ok(dirs.includes("/nix/var/nix/profiles/default/bin"));
  assert.ok(
    getSystemFfmpegCandidates({ platform: "darwin", env: { HOME: "/Users/ada" } }).includes(
      "/run/current-system/sw/bin/ffmpeg"
    )
  );
});

test("Linux candidates include system bins and NixOS current-system", () => {
  const dirs = getUnixToolBinDirs({
    platform: "linux",
    env: { HOME: "/home/ada" },
    homedir: "/home/ada",
  });

  assert.ok(dirs.includes("/usr/bin"));
  assert.ok(dirs.includes("/run/current-system/sw/bin"));
  assert.equal(getSystemFfmpegCandidates({ platform: "win32" })[0], "C:\\ffmpeg\\bin\\ffmpeg.exe");
});
