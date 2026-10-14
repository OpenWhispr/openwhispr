const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const modulePath = require.resolve("../../src/helpers/ensureYdotool");
const realLoad = Module._load;
let session = { isWayland: false, isKde: false, isWlroots: false };
const commands = [];

function loadStatus() {
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === modulePath) {
      if (request === "electron") return { dialog: {} };
      if (request === "./linuxSession") return { getLinuxSessionInfo: () => session };
      if (request === "child_process") {
        return {
          spawnSync: () => {
            throw new Error("Settings diagnostics must not spawn synchronously");
          },
          execFile: (file, args, _options, callback) => {
            commands.push([file, ...args]);
            callback(null, {
              stdout:
                file === "groups" ? "user input\n" : file === "systemctl" ? "active\n" : "tool\n",
              stderr: "",
            });
          },
        };
      }
      if (request === "fs") {
        return {
          existsSync: () => {
            throw new Error("Settings diagnostics must not use synchronous filesystem probes");
          },
          constants: { W_OK: 2 },
          promises: {
            access: async (file) => {
              if (file === "/etc/NIXOS") throw new Error("not NixOS");
            },
            readdir: async () => [],
            readFile: async () => "ID=arch\n",
          },
        };
      }
    }
    return realLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[modulePath];
    return require(modulePath).getYdotoolStatus;
  } finally {
    Module._load = realLoad;
  }
}

test("Wayland diagnostics do not block main and skip irrelevant sessions", async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const getYdotoolStatus = loadStatus();
  try {
    // win32 and non-Wayland linux share the same early return; one linux run covers both.
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    session = { isWayland: false, isKde: false, isWlroots: false };
    const nonWayland = await getYdotoolStatus();
    assert.equal(nonWayland.isWayland, false);
    assert.equal(nonWayland.isLinux, true);
    assert.deepEqual(commands, [], "other sessions need no tool or filesystem probes");

    session = { isWayland: true, isKde: true, isWlroots: false };
    const status = await getYdotoolStatus();
    assert.equal(status.hasYdotool, true);
    assert.equal(status.daemonRunning, true);
    assert.equal(status.hasXclip, true);
    assert.equal(status.hasXsel, true);
    assert.ok(commands.some(([file, tool]) => file === "which" && tool === "ydotool"));
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
    delete require.cache[modulePath];
  }
});
