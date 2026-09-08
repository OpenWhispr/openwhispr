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

  assert.equal(await manager._runPortalPaste("/tmp/linux-fast-paste"), null);
  assert.equal(await manager._runPortalPaste("/tmp/linux-fast-paste"), "rotated-token");
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
