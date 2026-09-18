const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");

const fakeClipboard = {
  text: "",
  html: "",
  rtf: "",
  image: null,
  formats: ["text/plain"],
  writes: [],
  availableFormats() {
    return this.formats;
  },
  readText() {
    return this.text;
  },
  writeText(text) {
    this.text = text;
    this.html = "";
    this.rtf = "";
    this.image = null;
    this.formats = ["text/plain"];
    this.writes.push(["writeText", text]);
  },
  readHTML() {
    return this.html;
  },
  readRTF() {
    return this.rtf;
  },
  write(payload) {
    this.text = payload.text || "";
    this.html = payload.html || "";
    this.rtf = payload.rtf || "";
    this.image = payload.image || null;
    this.formats = [];
    if (Object.hasOwn(payload, "text")) this.formats.push("text/plain");
    if (Object.hasOwn(payload, "html")) this.formats.push("text/html");
    if (Object.hasOwn(payload, "rtf")) this.formats.push("text/rtf");
    if (Object.hasOwn(payload, "image")) this.formats.push("image/png");
    this.writes.push(["write", payload]);
  },
  readImage() {
    return this.image || emptyImage;
  },
  writeImage(image) {
    this.text = "";
    this.html = "";
    this.rtf = "";
    this.image = image;
    this.formats = image && !image.isEmpty() ? ["image/png"] : [];
    this.writes.push(["writeImage", image]);
  },
};

const emptyImage = { isEmpty: () => true };
const nonEmptyImage = { isEmpty: () => false };

const clipboardModulePath = require.resolve("../../src/helpers/clipboard");

const originalLoad = Module._load;

// The held-modifier wait spawns the fast-paste binary ahead of every Linux paste.
// Tests that pin the paste chain's spawn sequence see it as already released;
// the wait itself is covered by tests that load with `realModifierWait`.
function loadClipboardManager({ spawn, spawnSync, realModifierWait = false } = {}) {
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
    if (request === "child_process" && (spawn || spawnSync)) {
      return { ...childProcess, ...(spawn && { spawn }), ...(spawnSync && { spawnSync }) };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const LoadedClipboardManager = require("../../src/helpers/clipboard");
    if (!realModifierWait) {
      LoadedClipboardManager.prototype._awaitModifierRelease = async () => "released";
    }
    return LoadedClipboardManager;
  } finally {
    Module._load = originalLoad;
  }
}

const ClipboardManager = loadClipboardManager();
const initialExitListeners = new Set(process.listeners("exit"));

test.afterEach(() => {
  for (const listener of process.listeners("exit")) {
    if (!initialExitListeners.has(listener)) {
      process.removeListener("exit", listener);
    }
  }
});

function createSuccessfulSpawn(calls) {
  return function successfulSpawn(command, args = []) {
    calls.push({ command, args });
    const pasteProcess = new EventEmitter();
    pasteProcess.stderr = new EventEmitter();
    pasteProcess.stdout = new EventEmitter();
    process.nextTick(() => pasteProcess.emit("close", 0));
    return pasteProcess;
  };
}

function createSpawn(calls, exitCodes, { stdout = [] } = {}) {
  return function mockedSpawn(command, args = []) {
    calls.push({ command, args });
    const pasteProcess = new EventEmitter();
    pasteProcess.stderr = new EventEmitter();
    pasteProcess.stdout = new EventEmitter();
    const code = exitCodes.shift() ?? 0;
    const output = stdout.shift();
    process.nextTick(() => {
      if (output) pasteProcess.stdout.emit("data", output);
      pasteProcess.emit("close", code);
    });
    return pasteProcess;
  };
}

async function withWaylandEnvironment(desktop, callback) {
  const previous = {
    XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE,
    XDG_CURRENT_DESKTOP: process.env.XDG_CURRENT_DESKTOP,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    HYPRLAND_INSTANCE_SIGNATURE: process.env.HYPRLAND_INSTANCE_SIGNATURE,
    DISPLAY: process.env.DISPLAY,
  };
  process.env.XDG_SESSION_TYPE = "wayland";
  process.env.XDG_CURRENT_DESKTOP = desktop;
  process.env.WAYLAND_DISPLAY = "wayland-1";
  delete process.env.DISPLAY;
  if (desktop === "Hyprland") process.env.HYPRLAND_INSTANCE_SIGNATURE = "test";
  else delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function resetClipboard({
  text = "",
  html = "",
  rtf = "",
  image = null,
  formats = ["text/plain"],
} = {}) {
  fakeClipboard.text = text;
  fakeClipboard.html = html;
  fakeClipboard.rtf = rtf;
  fakeClipboard.image = image;
  fakeClipboard.formats = formats;
  fakeClipboard.writes = [];
}

test("restore preserves rich clipboard formats atomically", () => {
  resetClipboard({
    formats: ["text/html", "text/rtf", "text/plain", "image/png"],
    text: "plain before",
    html: "<b>html before</b>",
    rtf: "{\\rtf1 before}",
    image: nonEmptyImage,
  });
  const manager = new ClipboardManager();

  const snapshot = manager._saveClipboard();
  fakeClipboard.writeText("dictated text");
  manager._restoreClipboard(snapshot);

  assert.deepEqual([...fakeClipboard.availableFormats()].sort(), [
    "image/png",
    "text/html",
    "text/plain",
    "text/rtf",
  ]);
  assert.equal(fakeClipboard.text, "plain before");
  assert.equal(fakeClipboard.html, "<b>html before</b>");
  assert.equal(fakeClipboard.rtf, "{\\rtf1 before}");
  assert.equal(fakeClipboard.image, nonEmptyImage);
  assert.equal(fakeClipboard.writes.at(-1)[0], "write");
});

test("restore runs when clipboard still contains the pasted text", async () => {
  resetClipboard();
  fakeClipboard.text = "dictated text";
  const manager = new ClipboardManager();

  await manager._restoreClipboardAfterDelay(
    { type: "text", data: "previous clipboard" },
    { delayMs: 0, expectedText: "dictated text" }
  );

  assert.equal(fakeClipboard.text, "previous clipboard");
});

test("restore is skipped when another clipboard write wins the race", async () => {
  resetClipboard();
  fakeClipboard.text = "user copied something else";
  const manager = new ClipboardManager();

  await manager._restoreClipboardAfterDelay(
    { type: "text", data: "previous clipboard" },
    { delayMs: 0, expectedText: "dictated text" }
  );

  assert.equal(fakeClipboard.text, "user copied something else");
});

test("pasteText waits for prior clipboard restoration before starting the next paste", async () => {
  const manager = new ClipboardManager();
  const events = [];
  let releaseFirstRestore;

  manager._pasteText = async (text) => {
    events.push(`start:${text}`);
    events.push(`end:${text}`);
    if (text === "first") {
      return {
        restoreComplete: new Promise((resolve) => {
          releaseFirstRestore = resolve;
        }),
      };
    }
    return { restoreComplete: Promise.resolve() };
  };

  await manager.pasteText("first");
  const secondPaste = manager.pasteText("second");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(events, ["start:first", "end:first"]);

  releaseFirstRestore();
  await secondPaste;
  assert.deepEqual(events, ["start:first", "end:first", "start:second", "end:second"]);
});

test("pasteWithFastPaste passes --restore-window <hwnd> when targetWindow is set (#859)", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSuccessfulSpawn(spawnCalls),
  });
  const manager = new TestClipboardManager();
  manager._restoreClipboardAfterDelay = () => Promise.resolve();

  const result = await manager.pasteWithFastPaste(
    "/tmp/windows-fast-paste.exe",
    { type: "text", data: "previous clipboard" },
    // Hex id: the binary prints "TARGET %p" (hex) from --detect-only and parses
    // --restore-window with strtoull base 16, so the handle stays hex end to end.
    { expectedClipboardText: "dictated text", targetWindow: "1A2B3C" }
  );
  await result.restoreComplete;

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "/tmp/windows-fast-paste.exe");
  assert.deepEqual(spawnCalls[0].args, ["--restore-window", "1A2B3C"]);
});

test("pasteWithFastPaste sends no args when nothing was captured", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSuccessfulSpawn(spawnCalls),
  });
  const manager = new TestClipboardManager();
  manager._restoreClipboardAfterDelay = () => Promise.resolve();

  const result = await manager.pasteWithFastPaste(
    "/tmp/windows-fast-paste.exe",
    { type: "text", data: "previous clipboard" },
    { expectedClipboardText: "dictated text" }
  );
  await result.restoreComplete;

  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].args, []);
});

test("Hyprland paste uses the current symbolic shortcut dispatcher", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [0], { stdout: ["ok\n"] }),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = (command) => command === "hyprctl";
  manager.resolveLinuxFastPasteBinary = () => null;
  manager._detectHyprlandWindowClass = () => "kitty";

  await withWaylandEnvironment("Hyprland", () => manager.pasteLinux(null));

  assert.deepEqual(spawnCalls, [
    {
      command: "hyprctl",
      args: [
        "dispatch",
        'hl.dsp.send_shortcut({ mods = "CTRL SHIFT", key = "V", window = "activewindow" })',
      ],
    },
  ]);
});

test("Hyprland paste falls back to the legacy symbolic shortcut dispatcher", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [0, 0], {
      stdout: ["invalid dispatcher\n", "ok\n"],
    }),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = (command) => command === "hyprctl";
  manager.resolveLinuxFastPasteBinary = () => null;
  manager._detectHyprlandWindowClass = () => null;

  await withWaylandEnvironment("Hyprland", () => manager.pasteLinux(null));

  assert.deepEqual(spawnCalls, [
    {
      command: "hyprctl",
      args: [
        "dispatch",
        'hl.dsp.send_shortcut({ mods = "SHIFT", key = "Insert", window = "activewindow" })',
      ],
    },
    { command: "hyprctl", args: ["dispatch", "sendshortcut", "SHIFT, Insert, activewindow"] },
  ]);
});

test("Hyprland prefers wtype over sendshortcut when installed", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [0]),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = (command) => command === "hyprctl" || command === "wtype";
  manager.resolveLinuxFastPasteBinary = () => null;
  manager._detectHyprlandWindowClass = () => null;

  await withWaylandEnvironment("Hyprland", () => manager.pasteLinux(null));

  assert.deepEqual(
    spawnCalls.map((call) => call.command),
    ["wtype"]
  );
});

test("failed wtype on Hyprland continues to sendshortcut", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [1, 0], { stdout: ["", "ok\n"] }),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = (command) => command === "hyprctl" || command === "wtype";
  manager.resolveLinuxFastPasteBinary = () => null;
  manager._detectHyprlandWindowClass = () => null;

  await withWaylandEnvironment("Hyprland", () => manager.pasteLinux(null));

  assert.deepEqual(
    spawnCalls.map((call) => call.command),
    ["wtype", "hyprctl"]
  );
});

test("wlroots tries wtype before native uinput", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSuccessfulSpawn(spawnCalls),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = (command) => command === "wtype";
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";

  await withWaylandEnvironment("Sway", () => manager.pasteLinux(null));

  assert.deepEqual(spawnCalls, [
    { command: "wtype", args: ["-M", "shift", "-k", "Insert", "-m", "shift"] },
  ]);
});

test("failed wtype continues to native Shift+Insert uinput", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [1, 0]),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = (command) => command === "wtype";
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";

  await withWaylandEnvironment("Sway", () => manager.pasteLinux(null));

  assert.deepEqual(
    spawnCalls.map((call) => call.command),
    ["wtype", "/tmp/linux-fast-paste"]
  );
  assert.deepEqual(spawnCalls[1].args, ["--uinput", "--shift-insert"]);
});

test("GNOME tries uinput before a tokenless portal", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [0]),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = () => false;
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";
  manager._readPortalToken = () => null;

  await withWaylandEnvironment("GNOME", () => manager.pasteLinux(null));

  assert.deepEqual(spawnCalls, [
    { command: "/tmp/linux-fast-paste", args: ["--uinput", "--shift-insert"] },
  ]);
});

test("GNOME falls back to a tokenless portal after uinput fails", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [1, 0]),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = () => false;
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";
  manager._readPortalToken = () => null;

  await withWaylandEnvironment("GNOME", () => manager.pasteLinux(null));

  assert.deepEqual(spawnCalls, [
    { command: "/tmp/linux-fast-paste", args: ["--uinput", "--shift-insert"] },
    { command: "/tmp/linux-fast-paste", args: ["--portal", "--shift-insert"] },
  ]);
});

test("GNOME uses a saved portal token before uinput", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [0], { stdout: ["rotated-token\n"] }),
  });
  const manager = new TestClipboardManager();
  const savedTokens = [];
  manager.commandExists = () => false;
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";
  manager._readPortalToken = () => "restore-token";
  manager._savePortalToken = (token) => savedTokens.push(token);

  await withWaylandEnvironment("GNOME", () => manager.pasteLinux(null));

  assert.deepEqual(spawnCalls, [
    {
      command: "/tmp/linux-fast-paste",
      args: ["--portal", "--shift-insert", "--restore-token", "restore-token"],
    },
  ]);
  assert.deepEqual(savedTokens, ["rotated-token"]);
});

test("GNOME stops preferring a saved portal token after it fails", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [1, 0, 0]),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = () => false;
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";
  manager._readPortalToken = () => "restore-token";

  await withWaylandEnvironment("GNOME", async () => {
    await manager.pasteLinux(null);
    await manager.pasteLinux(null);
  });

  assert.deepEqual(
    spawnCalls.map((call) => call.args),
    [
      ["--portal", "--shift-insert", "--restore-token", "restore-token"],
      ["--uinput", "--shift-insert"],
      ["--uinput", "--shift-insert"],
    ]
  );
});

test("GNOME pastes through a running ydotoold before the ephemeral uinput device", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSuccessfulSpawn(spawnCalls),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = (command) => command === "ydotool";
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";
  manager._readPortalToken = () => null;
  manager._isYdotoolDaemonRunning = () => true;
  manager._isYdotoolLegacy = () => false;

  const result = await withWaylandEnvironment("GNOME", () => manager.pasteLinux(null));

  assert.equal(result.method, "ydotool");
  assert.deepEqual(spawnCalls, [
    { command: "ydotool", args: ["key", "42:1", "110:1", "110:0", "42:0"] },
  ]);
});

test("GNOME keeps a saved portal token ahead of ydotoold", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSuccessfulSpawn(spawnCalls),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = (command) => command === "ydotool";
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";
  manager._readPortalToken = () => "restore-token";
  manager._isYdotoolDaemonRunning = () => true;
  manager._isYdotoolLegacy = () => false;

  await withWaylandEnvironment("GNOME", () => manager.pasteLinux(null));

  assert.deepEqual(spawnCalls, [
    {
      command: "/tmp/linux-fast-paste",
      args: ["--portal", "--shift-insert", "--restore-token", "restore-token"],
    },
  ]);
});

test("GNOME falls back to the ephemeral uinput device when ydotool fails", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [1, 0]),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = (command) => command === "ydotool";
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";
  manager._readPortalToken = () => null;
  manager._isYdotoolDaemonRunning = () => true;
  manager._isYdotoolLegacy = () => false;

  const result = await withWaylandEnvironment("GNOME", () => manager.pasteLinux(null));

  assert.equal(result.method, "uinput");
  assert.deepEqual(spawnCalls, [
    { command: "ydotool", args: ["key", "42:1", "110:1", "110:0", "42:0"] },
    { command: "/tmp/linux-fast-paste", args: ["--uinput", "--shift-insert"] },
  ]);
});

test("GNOME does not retry a failed ydotool after the native paths also fail", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [1, 1, 1]),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = (command) => command === "ydotool";
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";
  manager._readPortalToken = () => null;
  manager._isYdotoolDaemonRunning = () => true;
  manager._isYdotoolLegacy = () => false;

  await assert.rejects(
    withWaylandEnvironment("GNOME", () => manager.pasteLinux(null)),
    { code: "PASTE_SIMULATION_FAILED" }
  );

  assert.deepEqual(
    spawnCalls.map((call) => call.args),
    [
      ["key", "42:1", "110:1", "110:0", "42:0"],
      ["--uinput", "--shift-insert"],
      ["--portal", "--shift-insert"],
    ]
  );
});

test("KDE tries portal before uinput", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [1, 0]),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = () => false;
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";
  manager._readPortalToken = () => null;

  await withWaylandEnvironment("KDE", () => manager.pasteLinux(null));

  assert.deepEqual(
    spawnCalls.map((call) => call.args),
    [
      ["--portal", "--shift-insert"],
      ["--uinput", "--shift-insert"],
    ]
  );
});

test("portal exit zero succeeds with or without a restore token", async () => {
  const calls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(calls, [0, 0], { stdout: ["", "rotated-token\n"] }),
  });
  const manager = new TestClipboardManager();
  const saved = [];
  const restoreTokens = [null, "restore-token"];
  manager._readPortalToken = () => restoreTokens.shift();
  manager._savePortalToken = (token) => saved.push(token);

  assert.equal(await manager._runPortalPaste("/tmp/linux-fast-paste"), "");
  assert.equal(await manager._runPortalPaste("/tmp/linux-fast-paste"), "rotated-token\n");
  assert.deepEqual(
    calls.map((call) => call.args),
    [["--portal"], ["--portal", "--restore-token", "restore-token"]]
  );
  assert.deepEqual(saved, ["rotated-token"]);
});

test("portal symbolic input failure is suppressed for the process", async () => {
  const manager = new ClipboardManager();
  const attempts = [];
  manager.commandExists = () => false;
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";
  manager._readPortalToken = () => "restore-token";
  manager._runPortalPaste = async () => {
    attempts.push("portal");
    throw new Error("portal symbolic keyboard input unavailable");
  };
  manager._runLinuxPasteCommand = async () => attempts.push("uinput");

  await withWaylandEnvironment("GNOME", async () => {
    await manager.pasteLinux(null);
    await manager.pasteLinux(null);
  });

  assert.deepEqual(attempts, ["portal", "uinput", "uinput"]);
});

test("portal denial is attempted once per process", async () => {
  const manager = new ClipboardManager();
  const attempts = [];
  manager.commandExists = () => false;
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";
  manager._readPortalToken = () => "restore-token";
  manager._runPortalPaste = async () => {
    attempts.push("portal");
    throw new Error("portal-denied");
  };
  manager._runLinuxPasteCommand = async () => attempts.push("uinput");

  await withWaylandEnvironment("GNOME", async () => {
    await manager.pasteLinux(null);
    await manager.pasteLinux(null);
  });

  assert.deepEqual(attempts, ["portal", "uinput", "uinput"]);
});

test("portal exit six reports unavailable symbolic input", async () => {
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn([], [6]),
  });
  const manager = new TestClipboardManager();

  await assert.rejects(
    manager._runPortalPaste("/tmp/linux-fast-paste"),
    /portal symbolic keyboard input unavailable/
  );
});

test("Wayland ydotool uses raw Shift+Insert keycodes", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSuccessfulSpawn(spawnCalls),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = (command) => command === "ydotool";
  manager._isYdotoolDaemonRunning = () => true;
  manager._isYdotoolLegacy = () => false;
  manager.resolveLinuxFastPasteBinary = () => null;

  await withWaylandEnvironment("Unknown", () => manager.pasteLinux(null));

  assert.deepEqual(spawnCalls, [
    { command: "ydotool", args: ["key", "42:1", "110:1", "110:0", "42:0"] },
  ]);
});

test("successful Wayland dispatch starts clipboard restoration", async () => {
  const manager = new ClipboardManager();
  let restoreCalled = false;
  manager.commandExists = (command) => command === "hyprctl";
  manager.resolveLinuxFastPasteBinary = () => null;
  manager._detectHyprlandWindowClass = () => null;
  manager._runLinuxPasteCommand = async () => {};
  manager._restoreClipboardAfterDelay = () => {
    restoreCalled = true;
    return Promise.resolve();
  };

  const result = await withWaylandEnvironment("Hyprland", () =>
    manager.pasteLinux({ type: "text", data: "previous" }, { expectedClipboardText: "dictated" })
  );
  await result.restoreComplete;

  assert.equal(restoreCalled, true);
});

test("XWayland fallback remains reachable after native Wayland failure", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [1, 0]),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = () => false;
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";

  await withWaylandEnvironment("Unknown", async () => {
    process.env.DISPLAY = ":0";
    await manager.pasteLinux(null);
  });

  assert.deepEqual(
    spawnCalls.map((call) => call.args),
    [["--uinput", "--shift-insert"], ["--shift-insert"]]
  );
});

const MODIFIER_WAIT_CALL = {
  command: "/tmp/linux-fast-paste",
  args: ["--capabilities", "--await-modifier-release", "1500"],
};

// A chord injected into still-held modifiers reaches the target as a different
// shortcut (#2113), so every paste tool — not only the fast-paste binary — waits.
for (const [desktop, commandExists, injector] of [
  ["Sway", (command) => command === "wtype", "wtype"],
  ["GNOME", () => false, "/tmp/linux-fast-paste"],
]) {
  test(`${desktop} waits for held modifiers before ${injector} injects the paste`, async () => {
    const spawnCalls = [];
    const TestClipboardManager = loadClipboardManager({
      spawn: createSpawn(spawnCalls, [0, 0], { stdout: ["MODIFIERS released 120\n"] }),
      realModifierWait: true,
    });
    const manager = new TestClipboardManager();
    manager.commandExists = commandExists;
    manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";
    manager._readPortalToken = () => null;

    const result = await withWaylandEnvironment(desktop, () => manager.pasteLinux(null));

    assert.deepEqual(spawnCalls[0], MODIFIER_WAIT_CALL);
    assert.deepEqual(
      spawnCalls.slice(1).map((call) => call.command),
      [injector]
    );
    assert.notEqual(result.pasted, false);
  });
}

test("modifiers still held leave the text on the clipboard without injecting", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [0], { stdout: ["MODIFIERS held 1500\n"] }),
    realModifierWait: true,
  });
  const manager = new TestClipboardManager();
  let restoreScheduled = false;
  manager.commandExists = (command) => command === "wtype";
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";
  manager._restoreClipboardAfterDelay = async () => {
    restoreScheduled = true;
  };

  const result = await withWaylandEnvironment("Sway", () =>
    manager.pasteLinux({ type: "text", data: "previous clipboard" })
  );

  assert.deepEqual(spawnCalls, [MODIFIER_WAIT_CALL]);
  assert.equal(result.pasted, false);
  assert.equal(result.reason, "modifiers-held");
  assert.equal(restoreScheduled, false, "the transcript stays on the clipboard");
});

// "unknown" (a Wayland session without /dev/input access) and the capabilities
// line an older binary prints for the unknown flag both mean the state can't be
// read, which must paste exactly as before.
for (const [label, output] of [
  ["an unreadable key state", "MODIFIERS unknown 0\n"],
  ["an older binary", "paste-v1 selection-copy-v1 target-window-v1\n"],
]) {
  test(`${label} still pastes`, async () => {
    const spawnCalls = [];
    const TestClipboardManager = loadClipboardManager({
      spawn: createSpawn(spawnCalls, [0, 0], { stdout: [output] }),
      realModifierWait: true,
    });
    const manager = new TestClipboardManager();
    manager.commandExists = (command) => command === "wtype";
    manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";

    await withWaylandEnvironment("Sway", () => manager.pasteLinux(null));

    assert.deepEqual(
      spawnCalls.map((call) => call.command),
      ["/tmp/linux-fast-paste", "wtype"]
    );
  });
}

// The helper can only hang if the X server or an evdev read stalls, but a hung
// wait must never hang the paste: the watchdog kills it and pastes as before.
test("a hung modifier wait is killed after the watchdog budget, reads as unknown, and ignores its late answer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const debugLogger = require("../../src/helpers/debugLogger");
  const info = t.mock.method(debugLogger, "info");
  const kills = [];
  let hungProcess;
  const TestClipboardManager = loadClipboardManager({
    spawn: () => {
      hungProcess = new EventEmitter();
      hungProcess.stdout = new EventEmitter();
      hungProcess.stderr = new EventEmitter();
      hungProcess.exitCode = null;
      hungProcess.kill = (signal) => kills.push(signal);
      return hungProcess;
    },
    realModifierWait: true,
  });
  const manager = new TestClipboardManager();
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";

  let state = null;
  const wait = manager._awaitModifierRelease().then((resolved) => {
    state = resolved;
  });
  t.mock.timers.tick(2499);
  await Promise.resolve();
  assert.equal(state, null, "the wait budget plus a second of slack is honored");
  assert.deepEqual(kills, []);

  t.mock.timers.tick(1);
  await wait;
  assert.equal(state, "unknown");
  assert.deepEqual(kills, ["SIGKILL"]);

  hungProcess.stdout.emit("data", "MODIFIERS held 1500\n");
  hungProcess.emit("close", null);
  assert.equal(
    info.mock.calls.filter((call) => call.arguments[0] === "Waited for held modifier keys").length,
    0,
    "a killed helper's late output is not logged as a wait"
  );
});

// Without /dev/input access on Wayland the helper answers "unknown" and the fix
// is inert; the log must say so once, or support cannot tell that from "released".
test("an unreadable modifier state is logged once per session", async (t) => {
  const debugLogger = require("../../src/helpers/debugLogger");
  const info = t.mock.method(debugLogger, "info");
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn([], [0, 0, 0, 0], {
      stdout: ["MODIFIERS unknown 0\n", "", "MODIFIERS unknown 0\n", ""],
    }),
    realModifierWait: true,
  });
  const manager = new TestClipboardManager();
  manager.commandExists = (command) => command === "wtype";
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";

  await withWaylandEnvironment("Sway", async () => {
    await manager.pasteLinux(null);
    await manager.pasteLinux(null);
  });

  const unreadable = info.mock.calls.filter(
    (call) => call.arguments[0] === "Modifier key state unreadable, pasting without waiting"
  );
  assert.equal(unreadable.length, 1);
  assert.deepEqual(unreadable[0].arguments[1], {
    isWayland: true,
    helperOutput: "MODIFIERS unknown 0",
  });
  assert.equal(unreadable[0].arguments[2], "clipboard");
});

test(
  "a modifier wait whose helper fails to spawn reads as unknown",
  { timeout: 5000 },
  async (t) => {
    // Frozen timers: only the spawn error itself may settle the wait, not the watchdog.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const TestClipboardManager = loadClipboardManager({
      spawn: () => {
        const failedProcess = new EventEmitter();
        failedProcess.stdout = new EventEmitter();
        failedProcess.stderr = new EventEmitter();
        process.nextTick(() => failedProcess.emit("error", new Error("ENOENT")));
        return failedProcess;
      },
      realModifierWait: true,
    });
    const manager = new TestClipboardManager();
    manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";

    assert.equal(await manager._awaitModifierRelease(), "unknown");
  }
);

test("without the fast-paste binary the paste chain is unchanged", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSuccessfulSpawn(spawnCalls),
    realModifierWait: true,
  });
  const manager = new TestClipboardManager();
  manager.commandExists = (command) => command === "wtype";
  manager.resolveLinuxFastPasteBinary = () => null;

  await withWaylandEnvironment("Sway", () => manager.pasteLinux(null));

  assert.deepEqual(
    spawnCalls.map((call) => call.command),
    ["wtype"]
  );
});

test("pasteMacOS restores clipboard after the short macOS delay on successful fast paste", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSuccessfulSpawn(spawnCalls),
  });
  const manager = new TestClipboardManager();
  const originalClipboard = { type: "text", data: "previous clipboard" };
  let restoreCall;

  manager.resolveFastPasteBinary = () => "/tmp/openwhispr-fast-paste";
  manager._restoreClipboardAfterDelay = (original, options) => {
    restoreCall = { original, options };
    return Promise.resolve();
  };

  const result = await manager.pasteMacOS(originalClipboard, {
    expectedClipboardText: "dictated text",
    fromStreaming: true,
  });
  await result.restoreComplete;

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "/tmp/openwhispr-fast-paste");
  assert.equal(restoreCall.original, originalClipboard);
  assert.deepEqual(restoreCall.options, {
    delayMs: 450,
    expectedText: "dictated text",
  });
});

test("pasteMacOSWithOsascript fallback uses the short macOS restore delay", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSuccessfulSpawn(spawnCalls),
  });
  const manager = new TestClipboardManager();
  const originalClipboard = { type: "text", data: "previous clipboard" };
  let restoreCall;

  manager._restoreClipboardAfterDelay = (original, options) => {
    restoreCall = { original, options };
    return Promise.resolve();
  };

  const result = await manager.pasteMacOSWithOsascript(originalClipboard, {
    expectedClipboardText: "dictated text",
  });
  await result.restoreComplete;

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "osascript");
  assert.deepEqual(spawnCalls[0].args, [
    "-e",
    'tell application "System Events" to key code 9 using command down',
  ]);
  assert.equal(restoreCall.original, originalClipboard);
  assert.deepEqual(restoreCall.options, {
    delayMs: 450,
    expectedText: "dictated text",
  });
});

// Terminal detection now serves two callers: the Linux paste path, which matches
// window classes, and macOS selection capture, which matches localized app names.
test("terminal detection matches window classes and macOS app names alike", () => {
  const manager = new ClipboardManager();

  for (const signature of ["konsole", "org.kde.konsole", "Ghostty", "kitty", "WezTerm"]) {
    assert.equal(manager.isTerminalSignature(signature), true, signature);
  }
  // iTerm2 has no Linux window class, so it only appears in the macOS-facing list.
  assert.equal(manager.isTerminalSignature("iTerm2"), true);
  assert.equal(manager.isTerminalSignature("Terminal"), true);

  for (const signature of ["Dia", "Google Chrome", "Mail", "", null, undefined]) {
    assert.equal(manager.isTerminalSignature(signature), false, String(signature));
  }

  // The Linux window-class entry point keeps behaving exactly as before.
  assert.equal(manager.isLinuxTerminalWindowClass("konsole"), true);
  assert.equal(manager.isLinuxTerminalWindowClass("org.mozilla.firefox"), false);
  assert.equal(manager.isLinuxTerminalWindowClass(null), false);
});

// Submit after paste: Enter rides in the same helper call as the paste, so a helper
// too old for the flag pastes once and never presses Enter instead of pasting twice.
const SUBMIT_ARGS = ["--submit", "enter", "--submit-delay", "250"];

async function withX11Environment(callback) {
  const previous = {
    XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    DISPLAY: process.env.DISPLAY,
  };
  process.env.XDG_SESSION_TYPE = "x11";
  process.env.DISPLAY = ":0";
  delete process.env.WAYLAND_DISPLAY;
  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("macOS asks the fast-paste helper to submit and reads its outcome", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [0], { stdout: ["SUBMIT_OK\n"] }),
  });
  const manager = new TestClipboardManager();
  manager.resolveFastPasteBinary = () => "/tmp/openwhispr-fast-paste";

  const result = await manager.pasteMacOS(null, {
    expectedClipboardText: "dictated text",
    fromStreaming: true,
    submitKey: "enter",
  });

  assert.deepEqual(spawnCalls, [{ command: "/tmp/openwhispr-fast-paste", args: SUBMIT_ARGS }]);
  assert.equal(result.submitted, true);
});

test("a helper that predates --submit pastes once and reports no submit", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSuccessfulSpawn(spawnCalls),
  });
  const manager = new TestClipboardManager();
  manager.resolveFastPasteBinary = () => "/tmp/openwhispr-fast-paste";

  const result = await manager.pasteMacOS(null, {
    expectedClipboardText: "dictated text",
    fromStreaming: true,
    submitKey: "enter",
  });

  assert.equal(spawnCalls.length, 1);
  assert.equal(result.submitted, false);
  assert.equal(result.submitSkipReason, "helper-unsupported");
});

test("the macOS osascript fallback pastes without submitting", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSuccessfulSpawn(spawnCalls),
  });
  const manager = new TestClipboardManager();
  manager.resolveFastPasteBinary = () => null;

  const result = await manager.pasteMacOS(null, {
    expectedClipboardText: "dictated text",
    fromStreaming: true,
    submitKey: "enter",
  });

  assert.deepEqual(
    spawnCalls.map((call) => call.command),
    ["osascript"]
  );
  assert.equal(result.submitted, undefined);
});

test("Windows fast paste submits after the restore and reports a skipped Enter", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [0], {
      // The Windows C runtime writes text-mode stdout, so lines end in CRLF.
      stdout: ["PASTE_OK Chrome_WidgetWin_1 ctrl+v\r\nSUBMIT_SKIPPED focus-changed\r\n"],
    }),
  });
  const manager = new TestClipboardManager();

  const result = await manager.pasteWithFastPaste("/tmp/windows-fast-paste.exe", null, {
    expectedClipboardText: "dictated text",
    targetWindow: "1A2B3C",
    submitKey: "enter",
  });

  assert.deepEqual(spawnCalls[0].args, ["--restore-window", "1A2B3C", ...SUBMIT_ARGS]);
  assert.equal(result.submitted, false);
  assert.equal(result.submitSkipReason, "focus-changed");
});

test("a failed Windows fast paste falls back to nircmd once and never submits", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [1, 0]),
  });
  const manager = new TestClipboardManager();
  manager.getNircmdPath = () => "C:\\nircmd.exe";

  const result = await manager.pasteWithFastPaste("/tmp/windows-fast-paste.exe", null, {
    expectedClipboardText: "dictated text",
    submitKey: "enter",
  });

  assert.deepEqual(spawnCalls.slice(1), [
    { command: "C:\\nircmd.exe", args: ["sendkeypress", "ctrl+v"] },
  ]);
  assert.equal(result.submitted, undefined);
});

// The helper waits inside the paste call, so its timeout must cover the wait:
// killing a helper that already pasted sends the caller to a fallback that
// pastes a second time.
test("a submitting Windows fast paste gets the longer timeout before its fallback", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const spawnCalls = [];
  let helperKilled = false;
  const TestClipboardManager = loadClipboardManager({
    spawn(command, args = []) {
      spawnCalls.push({ command, args });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.kill = () => {
        helperKilled = true;
      };
      // The fast-paste helper hangs; the nircmd fallback succeeds.
      if (command !== "/tmp/windows-fast-paste.exe") {
        process.nextTick(() => child.emit("close", 0));
      }
      return child;
    },
  });
  const manager = new TestClipboardManager();
  manager.getNircmdPath = () => "C:\\nircmd.exe";

  const pasting = manager.pasteWithFastPaste("/tmp/windows-fast-paste.exe", null, {
    expectedClipboardText: "dictated text",
    submitKey: "enter",
  });
  t.mock.timers.tick(10);
  t.mock.timers.tick(2499);
  assert.equal(helperKilled, false, "2000 ms plus the submit budget has not run out");
  t.mock.timers.tick(1);
  assert.equal(helperKilled, true);
  t.mock.timers.tick(30);
  const result = await pasting;

  assert.deepEqual(
    spawnCalls.map((call) => call.command),
    ["/tmp/windows-fast-paste.exe", "C:\\nircmd.exe"]
  );
  assert.equal(result.submitted, undefined);
});

test("wlroots presses Enter with wtype after the wtype paste", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSuccessfulSpawn(spawnCalls),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = (command) => command === "wtype";
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";

  const result = await withWaylandEnvironment("Sway", () =>
    manager.pasteLinux(null, { submitKey: "enter" })
  );

  assert.deepEqual(spawnCalls, [
    { command: "wtype", args: ["-M", "shift", "-k", "Insert", "-m", "shift"] },
    { command: "wtype", args: ["-k", "Return"] },
  ]);
  assert.equal(result.submitted, true);
});

// The check before Enter must not wait: focus can move while a key is held
// (Alt+Tab), and a tool route can't tell where Enter would land.
test("a modifier held again after a tool paste skips the Enter without waiting", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSuccessfulSpawn(spawnCalls),
  });
  const manager = new TestClipboardManager();
  const modifierWaits = [];
  const modifierStates = ["released", "held"];
  manager._awaitModifierRelease = async (waitMs) => {
    modifierWaits.push(waitMs);
    return modifierStates.shift();
  };
  manager.commandExists = (command) => command === "wtype";
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";

  const result = await withWaylandEnvironment("Sway", () =>
    manager.pasteLinux(null, { submitKey: "enter" })
  );

  assert.deepEqual(modifierWaits, [undefined, 0], "the paste gate waits; the Enter check doesn't");
  assert.equal(spawnCalls.length, 1, "only the paste was injected");
  assert.equal(result.submitted, false);
  assert.equal(result.submitSkipReason, "modifiers-held");
});

test("a failed tool Enter is reported without pasting again", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [0, 1]),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = (command) => command === "wtype";
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";

  const result = await withWaylandEnvironment("Sway", () =>
    manager.pasteLinux(null, { submitKey: "enter" })
  );

  assert.deepEqual(
    spawnCalls.map((call) => call.args),
    [
      ["-M", "shift", "-k", "Insert", "-m", "shift"],
      ["-k", "Return"],
    ]
  );
  assert.equal(result.method, "wtype");
  assert.equal(result.submitted, false);
  assert.equal(result.submitSkipReason, "failed");
});

for (const [legacy, pasteArgs, enterArgs] of [
  [false, ["key", "42:1", "110:1", "110:0", "42:0"], ["key", "28:1", "28:0"]],
  [true, ["key", "shift+Insert"], ["key", "enter"]],
]) {
  test(`GNOME submits through ydotoold with ${legacy ? "legacy" : "current"} ydotool`, async () => {
    const spawnCalls = [];
    const TestClipboardManager = loadClipboardManager({
      spawn: createSuccessfulSpawn(spawnCalls),
    });
    const manager = new TestClipboardManager();
    manager.commandExists = (command) => command === "ydotool";
    manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";
    manager._readPortalToken = () => null;
    manager._isYdotoolDaemonRunning = () => true;
    manager._isYdotoolLegacy = () => legacy;

    const result = await withWaylandEnvironment("GNOME", () =>
      manager.pasteLinux(null, { submitKey: "enter" })
    );

    assert.deepEqual(spawnCalls, [
      { command: "ydotool", args: pasteArgs },
      { command: "ydotool", args: enterArgs },
    ]);
    assert.equal(result.submitted, true);
  });
}

// A compositor can pick up the throwaway device late, dropping the paste yet
// taking a later Enter from it (#956), which would send the previous draft.
for (const desktop of ["GNOME", "Sway"]) {
  test(`${desktop}'s throwaway uinput paste never submits`, async () => {
    const spawnCalls = [];
    const TestClipboardManager = loadClipboardManager({
      spawn: createSpawn(spawnCalls, [0]),
    });
    const manager = new TestClipboardManager();
    manager.commandExists = () => false;
    manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";
    manager._readPortalToken = () => null;

    const result = await withWaylandEnvironment(desktop, () =>
      manager.pasteLinux(null, { submitKey: "enter" })
    );

    assert.deepEqual(spawnCalls, [
      { command: "/tmp/linux-fast-paste", args: ["--uinput", "--shift-insert"] },
    ]);
    assert.equal(result.submitted, undefined);
  });
}

test("KDE submits inside the portal session and saves only the restore token", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [0], { stdout: ["rotated-token\nSUBMIT_OK\n"] }),
  });
  const manager = new TestClipboardManager();
  const savedTokens = [];
  manager.commandExists = () => false;
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";
  manager._readPortalToken = () => "restore-token";
  manager._savePortalToken = (token) => savedTokens.push(token);

  const result = await withWaylandEnvironment("KDE", () =>
    manager.pasteLinux(null, { submitKey: "enter" })
  );

  assert.deepEqual(spawnCalls[0].args, [
    "--portal",
    "--shift-insert",
    "--restore-token",
    "restore-token",
    ...SUBMIT_ARGS,
  ]);
  assert.deepEqual(savedTokens, ["rotated-token"]);
  assert.equal(result.submitted, true);
});

// A Start response without a restore token leaves the SUBMIT_* line as the only
// output; saving it as the token would break the next pre-approved session.
test("a portal run that prints only its submit outcome saves no restore token", async () => {
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn([], [0], { stdout: ["SUBMIT_OK\n"] }),
  });
  const manager = new TestClipboardManager();
  const savedTokens = [];
  manager._readPortalToken = () => "restore-token";
  manager._savePortalToken = (token) => savedTokens.push(token);

  await manager._runPortalPaste("/tmp/linux-fast-paste", { submitKey: "enter" });

  assert.deepEqual(savedTokens, []);
});

test("Hyprland's sendshortcut paste never submits", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [0], { stdout: ["ok\n"] }),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = (command) => command === "hyprctl";
  manager.resolveLinuxFastPasteBinary = () => null;
  manager._detectHyprlandWindowClass = () => "kitty";

  const result = await withWaylandEnvironment("Hyprland", () =>
    manager.pasteLinux(null, { submitKey: "enter" })
  );

  assert.equal(spawnCalls.length, 1);
  assert.equal(result.method, "hyprland-sendshortcut");
  assert.equal(result.submitted, undefined);
});

test("X11 submits inside the XTest paste call", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [0], { stdout: ["SUBMIT_SKIPPED modifiers-held\n"] }),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = () => false;
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";

  const result = await withX11Environment(() => manager.pasteLinux(null, { submitKey: "enter" }));

  assert.deepEqual(spawnCalls, [{ command: "/tmp/linux-fast-paste", args: SUBMIT_ARGS }]);
  assert.equal(result.method, "xtest");
  assert.equal(result.submitted, false);
  assert.equal(result.submitSkipReason, "modifiers-held");
});

// The paste's own window lookups run through spawnSync; "123" is the window
// that is active when the paste starts.
function xdotoolWindowSpawnSync(command, args = []) {
  if (command === "xdotool" && args[0] === "getactivewindow") {
    return { status: 0, stdout: Buffer.from("123\n") };
  }
  return { status: 1, stdout: Buffer.from("") };
}

for (const [label, lookupExit, activeAfterDelay, skipReason] of [
  ["presses Enter with xdotool", 0, "123", null],
  ["skips Enter when focus moved", 0, "456", "focus-changed"],
  ["skips Enter when the active window can't be read", 1, "", "focus-unknown"],
]) {
  test(`X11 without the helper ${label}`, async () => {
    const submitted = skipReason === null;
    const spawnCalls = [];
    const TestClipboardManager = loadClipboardManager({
      spawn: createSpawn(spawnCalls, [0, lookupExit, 0], { stdout: ["", `${activeAfterDelay}\n`] }),
      spawnSync: xdotoolWindowSpawnSync,
    });
    const manager = new TestClipboardManager();
    manager.commandExists = (command) => command === "xdotool";
    manager.resolveLinuxFastPasteBinary = () => null;

    const result = await withX11Environment(() => manager.pasteLinux(null, { submitKey: "enter" }));

    assert.deepEqual(spawnCalls, [
      { command: "xdotool", args: ["windowactivate", "--sync", "123", "key", "ctrl+v"] },
      { command: "xdotool", args: ["getactivewindow"] },
      ...(submitted ? [{ command: "xdotool", args: ["key", "Return"] }] : []),
    ]);
    assert.equal(result.method, "xdotool");
    assert.equal(result.submitted, submitted);
    if (!submitted) assert.equal(result.submitSkipReason, skipReason);
  });
}

test("a Wayland clipboard write is unconfirmed only when wl-copy is there and fails", () => {
  const TestClipboardManager = loadClipboardManager({ spawnSync: () => ({ status: 1 }) });
  const manager = new TestClipboardManager();

  manager.commandExists = (command) => command === "wl-copy";
  assert.equal(manager._writeClipboardWayland("dictated text", null), false);
  // Without wl-copy, Electron's clipboard is the only write the system has.
  manager.commandExists = () => false;
  assert.equal(manager._writeClipboardWayland("dictated text", null), true);
});

test("an unconfirmed Wayland clipboard write pastes without submitting", async (t) => {
  const realPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", { value: realPlatform }));
  const manager = new ClipboardManager();
  const pasteOptions = [];
  manager._isWayland = () => true;
  manager._writeClipboardWayland = () => false;
  manager._writePrimarySelection = () => {};
  manager.pasteLinux = async (_original, options) => {
    pasteOptions.push(options);
    return { method: "wtype", restoreComplete: Promise.resolve() };
  };

  await manager._pasteText("dictated text", { restoreClipboard: false, submitKey: "enter" });

  assert.equal(pasteOptions[0].submitKey, undefined);
});
