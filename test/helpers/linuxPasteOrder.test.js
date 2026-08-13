const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");

const fakeClipboard = {
  text: "",
  availableFormats: () => ["text/plain"],
  readText() {
    return this.text;
  },
  writeText(text) {
    this.text = text;
  },
  readHTML: () => "",
  readRTF: () => "",
  readImage: () => ({ isEmpty: () => true }),
  write() {},
  writeImage() {},
};

const clipboardModulePath = require.resolve("../../src/helpers/clipboard");

const originalLoad = Module._load;

function loadClipboardManager({ spawn } = {}) {
  delete require.cache[clipboardModulePath];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return {
        clipboard: fakeClipboard,
        systemPreferences: {
          isTrustedAccessibilityClient: () => true,
        },
      };
    }
    if (request === "child_process" && spawn) {
      return { ...childProcess, spawn };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require("../../src/helpers/clipboard");
  } finally {
    Module._load = originalLoad;
  }
}

function createRecordingSpawn(calls) {
  return function recordingSpawn(command, args = []) {
    calls.push({ command, args });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    process.nextTick(() => proc.emit("close", 0));
    return proc;
  };
}

const GNOME_WAYLAND_ENV = {
  XDG_SESSION_TYPE: "wayland",
  WAYLAND_DISPLAY: "wayland-0",
  XDG_CURRENT_DESKTOP: "GNOME",
  DISPLAY: "",
};

function withEnv(overrides, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === "") delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function createGnomeManager(ClipboardManager, { portalToken }) {
  const manager = new ClipboardManager();
  manager.commandExists = () => false;
  manager.resolveLinuxFastPasteBinary = () => "/fake/linux-fast-paste";
  manager._canAccessUinput = () => true;
  manager._isYdotoolDaemonRunning = () => false;
  manager._readPortalToken = () => portalToken;
  manager._savePortalToken = () => {};
  return manager;
}

test("GNOME paste prefers the portal when a restore token exists", async () => {
  const calls = [];
  const ClipboardManager = loadClipboardManager({ spawn: createRecordingSpawn(calls) });

  await withEnv(GNOME_WAYLAND_ENV, async () => {
    const manager = createGnomeManager(ClipboardManager, { portalToken: "token-123" });
    const result = await manager.pasteLinux(null, {});
    assert.equal(result.method, "portal");
  });

  assert.ok(calls.length > 0, "expected the fast-paste binary to be spawned");
  assert.ok(
    calls[0].args.includes("--portal"),
    `expected first spawn to use --portal, got: ${calls[0].args.join(" ")}`
  );
  assert.ok(
    calls[0].args.includes("--restore-token"),
    "expected the saved restore token to be passed"
  );
});

test("GNOME paste keeps uinput first when no restore token exists", async () => {
  const calls = [];
  const ClipboardManager = loadClipboardManager({ spawn: createRecordingSpawn(calls) });

  await withEnv(GNOME_WAYLAND_ENV, async () => {
    const manager = createGnomeManager(ClipboardManager, { portalToken: null });
    const result = await manager.pasteLinux(null, {});
    assert.equal(result.method, "uinput");
  });

  assert.ok(calls.length > 0, "expected the fast-paste binary to be spawned");
  assert.ok(
    calls[0].args.includes("--uinput"),
    `expected first spawn to use --uinput, got: ${calls[0].args.join(" ")}`
  );
});

test("GNOME paste keeps uinput first after a tokened portal paste fails", async () => {
  const calls = [];
  const failPortalSpawn = (command, args = []) => {
    calls.push({ command, args });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    process.nextTick(() => proc.emit("close", args.includes("--portal") ? 1 : 0));
    return proc;
  };
  const ClipboardManager = loadClipboardManager({ spawn: failPortalSpawn });

  await withEnv(GNOME_WAYLAND_ENV, async () => {
    const manager = createGnomeManager(ClipboardManager, { portalToken: "token-123" });
    const firstResult = await manager.pasteLinux(null, {});
    const secondResult = await manager.pasteLinux(null, {});
    assert.equal(firstResult.method, "uinput");
    assert.equal(secondResult.method, "uinput");
  });

  assert.deepEqual(
    calls.map((call) => (call.args.includes("--portal") ? "portal" : "uinput")),
    ["portal", "uinput", "uinput"]
  );
});
