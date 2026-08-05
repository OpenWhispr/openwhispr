const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");

const fakeClipboard = {
  text: "",
  formats: ["text/plain"],
  availableFormats() {
    return this.formats;
  },
  readText() {
    return this.text;
  },
  writeText(text) {
    this.text = text;
    this.formats = ["text/plain"];
  },
  readHTML: () => "",
  readRTF: () => "",
  write() {},
  readImage: () => ({ isEmpty: () => true }),
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
        systemPreferences: { isTrustedAccessibilityClient: () => true },
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

function createSpawn(calls, { exitCode = 0, emitError = null } = {}) {
  return function fakeSpawn(command, args = [], options = {}) {
    calls.push({ command, args, options });
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout = new EventEmitter();
    process.nextTick(() => {
      if (emitError) proc.emit("error", new Error(emitError));
      else proc.emit("close", exitCode);
    });
    return proc;
  };
}

async function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

async function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// Builds a macOS manager whose paste outcome is fully controlled, and records
// whether the post-paste Enter fired.
function createMacManager(ClipboardManager, { pasteFails = false, hasPermissions = true } = {}) {
  const manager = new ClipboardManager();
  const enterCalls = [];

  manager.resolveFastPasteBinary = () => null;
  manager.checkAccessibilityPermissions = async () => hasPermissions;
  manager.pasteMacOS = async () => {
    if (pasteFails) throw new Error("paste failed");
    return { restoreComplete: Promise.resolve() };
  };
  manager.pressEnter = async () => {
    enterCalls.push(Date.now());
    return true;
  };

  return { manager, enterCalls };
}

test("Enter is not sent when the setting is off", async () => {
  const ClipboardManager = loadClipboardManager();
  await withPlatform("darwin", async () => {
    const { manager, enterCalls } = createMacManager(ClipboardManager);

    await manager._pasteText("dictated text", { restoreClipboard: false });

    assert.equal(enterCalls.length, 0);
  });
});

test("Enter is sent after a successful paste when the setting is on", async () => {
  const ClipboardManager = loadClipboardManager();
  await withPlatform("darwin", async () => {
    const { manager, enterCalls } = createMacManager(ClipboardManager);

    await manager._pasteText("dictated text", {
      restoreClipboard: false,
      pressEnterAfterPaste: true,
    });

    assert.equal(enterCalls.length, 1);
  });
});

test("Enter is not sent when the paste fails", async () => {
  const ClipboardManager = loadClipboardManager();
  await withPlatform("darwin", async () => {
    const { manager, enterCalls } = createMacManager(ClipboardManager, { pasteFails: true });

    await assert.rejects(
      manager._pasteText("dictated text", {
        restoreClipboard: false,
        pressEnterAfterPaste: true,
      }),
      /paste failed/
    );

    assert.equal(enterCalls.length, 0);
  });
});

test("Enter is not sent when macOS falls back to clipboard-only", async () => {
  const ClipboardManager = loadClipboardManager();
  await withPlatform("darwin", async () => {
    const { manager, enterCalls } = createMacManager(ClipboardManager, { hasPermissions: false });

    await manager._pasteText("dictated text", {
      restoreClipboard: false,
      pressEnterAfterPaste: true,
      allowClipboardFallback: true,
    });

    assert.equal(enterCalls.length, 0);
  });
});

test("Enter is not sent when macOS has no accessibility permission and no fallback", async () => {
  const ClipboardManager = loadClipboardManager();
  await withPlatform("darwin", async () => {
    const { manager, enterCalls } = createMacManager(ClipboardManager, { hasPermissions: false });

    await assert.rejects(
      manager._pasteText("dictated text", {
        restoreClipboard: false,
        pressEnterAfterPaste: true,
      }),
      /Accessibility permissions required/
    );

    assert.equal(enterCalls.length, 0);
  });
});

test("truthy-but-not-true values do not trigger Enter", async () => {
  const ClipboardManager = loadClipboardManager();
  await withPlatform("darwin", async () => {
    const { manager, enterCalls } = createMacManager(ClipboardManager);

    await manager._pasteText("dictated text", {
      restoreClipboard: false,
      pressEnterAfterPaste: "yes",
    });

    assert.equal(enterCalls.length, 0);
  });
});

test("pressEnter sends Return via osascript on macOS", async () => {
  const spawnCalls = [];
  const ClipboardManager = loadClipboardManager({ spawn: createSpawn(spawnCalls) });

  await withPlatform("darwin", async () => {
    const manager = new ClipboardManager();

    assert.equal(await manager.pressEnter(), true);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].command, "osascript");
    assert.deepEqual(spawnCalls[0].args, [
      "-e",
      'tell application "System Events" to key code 36',
    ]);
  });
});

test("pressEnter reports failure instead of throwing when the keystroke command fails", async () => {
  const spawnCalls = [];
  const ClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, { exitCode: 1 }),
  });

  await withPlatform("darwin", async () => {
    const manager = new ClipboardManager();
    assert.equal(await manager.pressEnter(), false);
  });
});

test("a failed Enter does not fail the paste that already succeeded", async () => {
  const spawnCalls = [];
  const ClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, { exitCode: 1 }),
  });

  await withPlatform("darwin", async () => {
    const manager = new ClipboardManager();
    manager.resolveFastPasteBinary = () => null;
    manager.checkAccessibilityPermissions = async () => true;
    manager.pasteMacOS = async () => ({ restoreComplete: Promise.resolve() });

    await manager._pasteText("dictated text", {
      restoreClipboard: false,
      pressEnterAfterPaste: true,
    });

    assert.equal(spawnCalls.at(-1).command, "osascript");
  });
});

test("pressEnter uses xdotool with Return on Linux X11", async () => {
  const spawnCalls = [];
  const ClipboardManager = loadClipboardManager({ spawn: createSpawn(spawnCalls) });

  await withPlatform("linux", () =>
    withEnv(
      { XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: undefined, HYPRLAND_INSTANCE_SIGNATURE: undefined },
      async () => {
        const manager = new ClipboardManager();
        manager.commandExists = (cmd) => cmd === "xdotool";
        manager._isYdotoolLegacy = () => false;

        assert.equal(await manager.pressEnter(), true);
        assert.equal(spawnCalls.length, 1);
        assert.equal(spawnCalls[0].command, "xdotool");
        assert.deepEqual(spawnCalls[0].args, ["key", "--clearmodifiers", "Return"]);
      }
    )
  );
});

test("pressEnter falls through to the next Linux tool when the first fails", async () => {
  const spawnCalls = [];
  const ClipboardManager = loadClipboardManager({
    spawn(command, args, options) {
      spawnCalls.push({ command, args, options });
      const proc = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdout = new EventEmitter();
      process.nextTick(() => proc.emit("close", command === "xdotool" ? 1 : 0));
      return proc;
    },
  });

  await withPlatform("linux", () =>
    withEnv(
      { XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: undefined, HYPRLAND_INSTANCE_SIGNATURE: undefined },
      async () => {
        const manager = new ClipboardManager();
        manager.commandExists = () => true;
        manager._isYdotoolLegacy = () => false;
        manager._isYdotoolDaemonRunning = () => true;

        assert.equal(await manager.pressEnter(), true);
        assert.deepEqual(
          spawnCalls.map((c) => c.command),
          ["xdotool", "ydotool"]
        );
        assert.deepEqual(spawnCalls[1].args, ["key", "28:1", "28:0"]);
      }
    )
  );
});

test("pressEnter reports failure when no Linux keystroke tool is installed", async () => {
  const spawnCalls = [];
  const ClipboardManager = loadClipboardManager({ spawn: createSpawn(spawnCalls) });

  await withPlatform("linux", () =>
    withEnv({ XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: undefined }, async () => {
      const manager = new ClipboardManager();
      manager.commandExists = () => false;
      manager._isYdotoolLegacy = () => false;

      assert.equal(await manager.pressEnter(), false);
      assert.equal(spawnCalls.length, 0);
    })
  );
});

test("pressEnter skips ydotool when its daemon is not running", async () => {
  const spawnCalls = [];
  const ClipboardManager = loadClipboardManager({ spawn: createSpawn(spawnCalls) });

  await withPlatform("linux", () =>
    withEnv({ XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: undefined }, async () => {
      const manager = new ClipboardManager();
      manager.commandExists = (cmd) => cmd === "ydotool";
      manager._isYdotoolLegacy = () => false;
      manager._isYdotoolDaemonRunning = () => false;

      assert.equal(await manager.pressEnter(), false);
      assert.equal(spawnCalls.length, 0);
    })
  );
});

test("pressEnter uses nircmd on Windows when available", async () => {
  const spawnCalls = [];
  const ClipboardManager = loadClipboardManager({ spawn: createSpawn(spawnCalls) });

  await withPlatform("win32", async () => {
    const manager = new ClipboardManager();
    manager.getNircmdPath = () => "C:\\nircmd.exe";

    assert.equal(await manager.pressEnter(), true);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].command, "C:\\nircmd.exe");
    assert.deepEqual(spawnCalls[0].args, ["sendkeypress", "enter"]);
  });
});

test("pressEnter falls back to PowerShell SendKeys on Windows without nircmd", async () => {
  const spawnCalls = [];
  const ClipboardManager = loadClipboardManager({ spawn: createSpawn(spawnCalls) });

  await withPlatform("win32", async () => {
    const manager = new ClipboardManager();
    manager.getNircmdPath = () => null;

    assert.equal(await manager.pressEnter(), true);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].command, "powershell.exe");
    assert.match(spawnCalls[0].args.at(-1), /SendWait\('\{ENTER\}'\)/);
  });
});
