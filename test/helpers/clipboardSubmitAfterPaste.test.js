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
  readHTML() {
    return "";
  },
  readRTF() {
    return "";
  },
  readImage() {
    return { isEmpty: () => true };
  },
  write() {},
  writeImage() {},
};

const clipboardModulePath = require.resolve("../../src/helpers/clipboard");

const originalLoad = Module._load;

// Delegate spawn through a mutable reference so the module is loaded once but
// each test can install its own recorder.
let currentSpawn = childProcess.spawn;

function loadClipboardManager() {
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
    if (request === "child_process") {
      return { ...childProcess, spawn: (...args) => currentSpawn(...args) };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require("../../src/helpers/clipboard");
  } finally {
    Module._load = originalLoad;
  }
}

const ClipboardManager = loadClipboardManager();

// Each ClipboardManager registers a process "exit" listener; these tests create
// one instance per case, which trips the default max-listeners warning.
process.setMaxListeners(30);

function recordingSpawn(calls, { failFor = () => false, stdoutFor = () => null } = {}) {
  return (command, args = []) => {
    calls.push({ command, args });
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout = new EventEmitter();
    process.nextTick(() => {
      const output = stdoutFor(command, args);
      if (output) proc.stdout.emit("data", Buffer.from(output));
      proc.emit("close", failFor(command) ? 1 : 0);
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

const LINUX_SESSION_ENV_KEYS = [
  "XDG_SESSION_TYPE",
  "WAYLAND_DISPLAY",
  "DISPLAY",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_DESKTOP",
  "DESKTOP_SESSION",
  "SWAYSOCK",
  "HYPRLAND_INSTANCE_SIGNATURE",
];

async function withLinuxSession(vars, fn) {
  const saved = {};
  for (const key of LINUX_SESSION_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const key of LINUX_SESSION_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function createLinuxManager({
  fastPasteBinary = null,
  commands = [],
  ydotoolDaemon = false,
  ydotoolLegacy = false,
} = {}) {
  const manager = new ClipboardManager();
  const available = new Set(commands);
  manager.resolveLinuxFastPasteBinary = () => fastPasteBinary;
  manager.commandExists = (cmd) => available.has(cmd);
  manager._isYdotoolDaemonRunning = () => ydotoolDaemon;
  manager._isYdotoolLegacy = () => ydotoolLegacy;
  return manager;
}

test("macOS Enter uses the native binary with cleared flags when available", async () => {
  const calls = [];
  currentSpawn = recordingSpawn(calls);
  const manager = new ClipboardManager();
  manager.resolveFastPasteBinary = () => "/fake/macos-fast-paste";

  await withPlatform("darwin", () => manager._pressEnter());

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { command: "/fake/macos-fast-paste", args: ["--press-enter"] });
});

test("macOS Enter falls back to osascript with modifier releases before key code 36", async () => {
  const calls = [];
  currentSpawn = recordingSpawn(calls);
  const manager = new ClipboardManager();
  manager.resolveFastPasteBinary = () => null;

  await withPlatform("darwin", () => manager._pressEnter());

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "osascript");
  const script = calls[0].args.join("\n");
  assert.match(script, /key up control/);
  assert.match(script, /key up command/);
  assert.match(script, /key code 36/);
  // Releases must come before the Enter keystroke
  assert.ok(script.indexOf("key up control") < script.indexOf("key code 36"));
});

test("Windows Enter uses the native binary when it supports --press-enter", async () => {
  const calls = [];
  currentSpawn = recordingSpawn(calls, {
    stdoutFor: (command, args) =>
      args.includes("--detect-only")
        ? "WINDOW_CLASS foo\nIS_TERMINAL false\nSUPPORTS press-enter\n"
        : null,
  });
  const manager = new ClipboardManager();
  manager.resolveWindowsFastPasteBinary = () => "C:\\fake\\windows-fast-paste.exe";
  manager.getNircmdPath = () => "C:\\fake\\nircmd.exe";

  await withPlatform("win32", () => manager._pressEnter());

  assert.deepEqual(
    calls.map((c) => c.args),
    [["--detect-only"], ["--press-enter"]]
  );

  // Capability probe is cached: second Enter goes straight to --press-enter
  await withPlatform("win32", () => manager._pressEnter());
  assert.deepEqual(calls.at(-1).args, ["--press-enter"]);
  assert.equal(calls.length, 3);
});

test("Windows Enter skips an old native binary without the capability marker", async () => {
  const calls = [];
  currentSpawn = recordingSpawn(calls, {
    stdoutFor: (command, args) =>
      args.includes("--detect-only") ? "WINDOW_CLASS foo\nIS_TERMINAL false\n" : null,
  });
  const manager = new ClipboardManager();
  manager.resolveWindowsFastPasteBinary = () => "C:\\fake\\windows-fast-paste.exe";
  manager.getNircmdPath = () => "C:\\fake\\nircmd.exe";

  await withPlatform("win32", () => manager._pressEnter());

  // Probe, then nircmd modifier releases and Enter — never --press-enter
  assert.ok(!calls.some((c) => c.args.includes("--press-enter")));
  const nircmdCalls = calls.filter((c) => c.command === "C:\\fake\\nircmd.exe");
  assert.deepEqual(nircmdCalls.at(-1).args, ["sendkeypress", "enter"]);
  const releases = nircmdCalls.filter((c) => c.args[0] === "sendkey" && c.args[2] === "up");
  assert.deepEqual(
    releases.map((c) => c.args[1]),
    ["ctrl", "shift", "alt", "lwin", "rwin"]
  );
});

test("Windows Enter falls back to PowerShell with modifier release and restore", async () => {
  const calls = [];
  currentSpawn = recordingSpawn(calls);
  const manager = new ClipboardManager();
  manager.resolveWindowsFastPasteBinary = () => null;
  manager.getNircmdPath = () => null;

  await withPlatform("win32", () => manager._pressEnter());

  assert.equal(calls.at(-1).command, "powershell.exe");
  const script = calls.at(-1).args.at(-1);
  assert.match(script, /GetAsyncKeyState/);
  assert.match(script, /keybd_event/);
  assert.match(script, /SendWait\('\{ENTER\}'\)/);
  // Restore must come after the Enter keystroke
  assert.ok(script.indexOf("SendWait") < script.lastIndexOf("keybd_event"));
});

test("Linux Enter uses the native binary with --press-enter when available", async () => {
  const calls = [];
  currentSpawn = recordingSpawn(calls);
  const manager = createLinuxManager({ fastPasteBinary: "/opt/linux-fast-paste" });

  await withLinuxSession({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }, () =>
    manager._pressEnterLinux()
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { command: "/opt/linux-fast-paste", args: ["--press-enter"] });
});

test("Linux Enter restricts the native binary to uinput on Wayland (no XTest false positive)", async () => {
  const calls = [];
  currentSpawn = recordingSpawn(calls);
  const manager = createLinuxManager({
    fastPasteBinary: "/opt/linux-fast-paste",
    commands: ["ydotool"],
    ydotoolDaemon: true,
  });

  await withLinuxSession(
    {
      XDG_SESSION_TYPE: "wayland",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_CURRENT_DESKTOP: "gnome",
      DISPLAY: ":0",
    },
    () => manager._pressEnterLinux("uinput")
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    command: "/opt/linux-fast-paste",
    args: ["--press-enter", "--uinput"],
  });
});

test("Linux Enter allows plain XTest when the paste itself was delivered via XTest", async () => {
  const calls = [];
  currentSpawn = recordingSpawn(calls);
  const manager = createLinuxManager({ fastPasteBinary: "/opt/linux-fast-paste" });

  await withLinuxSession(
    {
      XDG_SESSION_TYPE: "wayland",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_CURRENT_DESKTOP: "gnome",
      DISPLAY: ":0",
    },
    () => manager._pressEnterLinux("xtest-xwayland")
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { command: "/opt/linux-fast-paste", args: ["--press-enter"] });
});

test("Linux Enter reuses the portal when the paste was delivered via portal", async () => {
  const calls = [];
  currentSpawn = recordingSpawn(calls);
  const portalCalls = [];
  const manager = createLinuxManager({ fastPasteBinary: "/opt/linux-fast-paste" });
  manager._runPortalPaste = async (binary, options) => {
    portalCalls.push({ binary, options });
  };

  await withLinuxSession(
    { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "kde" },
    () => manager._pressEnterLinux("portal")
  );

  assert.equal(calls.length, 0);
  assert.deepEqual(portalCalls, [
    { binary: "/opt/linux-fast-paste", options: { pressEnter: true } },
  ]);
});

test("Linux Enter reuses the external tool that delivered the paste", async () => {
  const calls = [];
  currentSpawn = recordingSpawn(calls);
  const manager = createLinuxManager({
    fastPasteBinary: "/opt/linux-fast-paste",
    commands: ["xdotool", "ydotool"],
    ydotoolDaemon: true,
  });

  // GNOME Wayland normally prefers ydotool, but the paste landed via xdotool.
  await withLinuxSession(
    {
      XDG_SESSION_TYPE: "wayland",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_CURRENT_DESKTOP: "gnome",
      DISPLAY: ":0",
    },
    () => manager._pressEnterLinux("xdotool")
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { command: "xdotool", args: ["key", "--clearmodifiers", "Return"] });
});

test("Linux Enter falls back to xdotool when the native binary fails on X11", async () => {
  const calls = [];
  currentSpawn = recordingSpawn(calls, { failFor: (cmd) => cmd === "/opt/linux-fast-paste" });
  const manager = createLinuxManager({
    fastPasteBinary: "/opt/linux-fast-paste",
    commands: ["xdotool", "ydotool"],
    ydotoolDaemon: true,
  });

  await withLinuxSession({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }, () =>
    manager._pressEnterLinux()
  );

  assert.deepEqual(
    calls.map((c) => c.command),
    ["/opt/linux-fast-paste", "xdotool"]
  );
  assert.deepEqual(calls[1].args, ["key", "--clearmodifiers", "Return"]);
});

test("Linux Enter prefers wtype on wlroots Wayland", async () => {
  const calls = [];
  currentSpawn = recordingSpawn(calls);
  const manager = createLinuxManager({
    commands: ["wtype", "xdotool", "ydotool"],
    ydotoolDaemon: true,
  });

  await withLinuxSession(
    {
      XDG_SESSION_TYPE: "wayland",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_CURRENT_DESKTOP: "sway",
      DISPLAY: ":0",
    },
    () => manager._pressEnterLinux()
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { command: "wtype", args: ["-k", "Return"] });
});

test("Linux Enter prefers ydotool on GNOME Wayland with modern raw keycodes", async () => {
  const calls = [];
  currentSpawn = recordingSpawn(calls);
  const manager = createLinuxManager({
    commands: ["xdotool", "ydotool"],
    ydotoolDaemon: true,
  });

  await withLinuxSession(
    {
      XDG_SESSION_TYPE: "wayland",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_CURRENT_DESKTOP: "gnome",
      DISPLAY: ":0",
    },
    () => manager._pressEnterLinux()
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { command: "ydotool", args: ["key", "28:1", "28:0"] });
});

test("Linux Enter uses evdev key name for legacy ydotool 0.1.x", async () => {
  const calls = [];
  currentSpawn = recordingSpawn(calls);
  const manager = createLinuxManager({
    commands: ["ydotool"],
    ydotoolDaemon: true,
    ydotoolLegacy: true,
  });

  await withLinuxSession(
    { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "gnome" },
    () => manager._pressEnterLinux()
  );

  assert.deepEqual(calls[0], { command: "ydotool", args: ["key", "enter"] });
});

test("Linux Enter skips ydotool when the client binary is missing despite a daemon socket", async () => {
  const calls = [];
  currentSpawn = recordingSpawn(calls);
  const manager = createLinuxManager({
    commands: ["xdotool"],
    ydotoolDaemon: true,
  });

  await withLinuxSession(
    {
      XDG_SESSION_TYPE: "wayland",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_CURRENT_DESKTOP: "gnome",
      DISPLAY: ":0",
    },
    () => manager._pressEnterLinux()
  );

  assert.deepEqual(
    calls.map((c) => c.command),
    ["xdotool"]
  );
});

test("Linux Enter throws when no tool is available", async () => {
  currentSpawn = recordingSpawn([]);
  const manager = createLinuxManager();

  await withLinuxSession({ XDG_SESSION_TYPE: "x11" }, () =>
    assert.rejects(manager._pressEnterLinux(), /No tool available to send Enter on Linux/)
  );
});

test("pasteText sends Enter after paste only when submitAfterPaste is set", async () => {
  currentSpawn = recordingSpawn([]);
  const events = [];
  const manager = new ClipboardManager();
  manager.resolveWindowsFastPasteBinary = () => null;
  manager.getNircmdPath = () => null;
  manager.pasteWindows = async () => {
    events.push("paste");
    return { restoreComplete: Promise.resolve() };
  };
  manager._pressEnter = async () => {
    events.push("enter");
  };

  await withPlatform("win32", async () => {
    await manager.pasteText("hello", { restoreClipboard: false });
    assert.deepEqual(events, ["paste"]);

    await manager.pasteText("hello", { restoreClipboard: false, submitAfterPaste: true });
    assert.deepEqual(events, ["paste", "paste", "enter"]);
  });
});

test("pasteText resolves even when sending Enter fails", async () => {
  currentSpawn = recordingSpawn([]);
  const manager = new ClipboardManager();
  manager.resolveWindowsFastPasteBinary = () => null;
  manager.getNircmdPath = () => null;
  manager.pasteWindows = async () => ({ restoreComplete: Promise.resolve() });
  manager._pressEnter = async () => {
    throw new Error("no tool");
  };

  await withPlatform("win32", () =>
    manager.pasteText("hello", { restoreClipboard: false, submitAfterPaste: true })
  );
});
