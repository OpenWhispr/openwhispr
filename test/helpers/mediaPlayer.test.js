const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const Module = require("node:module");
const os = require("os");
const path = require("path");

const mediaPlayerModulePath = require.resolve("../../src/helpers/mediaPlayer");
const originalLoad = Module._load;

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "./debugLogger" && parent?.filename === mediaPlayerModulePath) {
    return {
      debug() {},
      warn() {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

let MediaPlayer;
try {
  ({ MediaPlayer } = require("../../src/helpers/mediaPlayer"));
} finally {
  Module._load = originalLoad;
}

function makeExecutable(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(filePath, 0o755);
}

test("resolves the bundled macOS media key helper from resources", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-media-key-"));
  const helperPath = path.join(tempDir, "bin", "macos-media-key");
  makeExecutable(helperPath);

  const player = new MediaPlayer({
    resourceRoot: tempDir,
    resourcesPath: undefined,
    env: { NODE_ENV: "production" },
    homeDir: () => "/missing-home",
  });

  assert.equal(player._resolveMacMediaKeyHelper(), helperPath);
});

test("allows the local mac-mediakey helper only in development", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-home-"));
  const localHelper = path.join(tempHome, ".local", "bin", "mac-mediakey");
  makeExecutable(localHelper);
  const missingResourceRoot = path.join(tempHome, "missing-resources");

  const productionPlayer = new MediaPlayer({
    resourceRoot: missingResourceRoot,
    resourcesPath: undefined,
    env: { NODE_ENV: "production" },
    homeDir: () => tempHome,
  });
  assert.equal(productionPlayer._resolveMacMediaKeyHelper(), null);

  const developmentPlayer = new MediaPlayer({
    resourceRoot: missingResourceRoot,
    resourcesPath: undefined,
    env: { NODE_ENV: "development" },
    homeDir: () => tempHome,
  });
  assert.equal(developmentPlayer._resolveMacMediaKeyHelper(), localHelper);
});

test("sends the bundled media key helper before falling back to osascript", () => {
  const player = new MediaPlayer();
  const calls = [];
  player._resolveMacMediaKeyHelper = () => "/tmp/macos-media-key";
  player._spawnSync = (command, args = []) => {
    calls.push({ command, args });
    return { status: command === "/tmp/macos-media-key" ? 0 : 1 };
  };

  assert.equal(player._sendMacMediaKey(), true);
  assert.deepEqual(calls, [{ command: "/tmp/macos-media-key", args: [] }]);
});

test("falls back to the legacy F8 osascript when the media key helper fails", () => {
  const player = new MediaPlayer();
  const calls = [];
  player._resolveMacMediaKeyHelper = () => "/tmp/macos-media-key";
  player._spawnSync = (command, args = []) => {
    calls.push({ command, args });
    return { status: command === "osascript" ? 0 : 1 };
  };

  assert.equal(player._sendMacMediaKey(), true);
  assert.deepEqual(calls, [
    { command: "/tmp/macos-media-key", args: [] },
    {
      command: "osascript",
      args: ["-e", 'tell application "System Events" to key code 100'],
    },
  ]);
});
