const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

// Hyprland was the one Linux backend that never got the binding-id treatment
// GNOME and KDE have. It looked its D-Bus method up by the FULL binding id, so
// "dictation#1" matched nothing, the row was refused, and because a commit is
// all-or-nothing a second dictation shortcut failed the whole edit. Even with
// registration fixed there was no row identity on the wire: every bind called
// the argument-less Toggle, which dispatches to the first row.
//
// Reproduced live on Hyprland 0.56.2 before this test existed. The existing
// slot test could not see it: it uses the meeting slot, which is row 0, so its
// binding id is the bare slot name.
//
// These run the real HyprlandShortcutManager and the real HotkeyManager with
// hyprctl and D-Bus faked. Nothing here touches this machine's compositor.

const hyprlandPath = require.resolve("../../src/helpers/hyprlandShortcut");
const hotkeyManagerPath = require.resolve("../../src/helpers/hotkeyManager");
const ENV_KEYS = ["HYPRLAND_CONFIG", "HYPRLAND_INSTANCE_SIGNATURE", "XDG_CONFIG_HOME"];

require.cache[require.resolve("electron")] = {
  exports: {
    globalShortcut: {
      register: () => true,
      unregister() {},
      isRegistered: () => false,
      unregisterAll() {},
    },
    BrowserWindow: class {
      static getAllWindows() {
        return [];
      }
    },
  },
};

function load(execFileSync) {
  delete require.cache[hyprlandPath];
  delete require.cache[hotkeyManagerPath];
  const originalLoad = Module._load;
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "child_process") return { ...childProcess, execFileSync };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return {
      HyprlandShortcutManager: require(hyprlandPath),
      HotkeyManager: require(hotkeyManagerPath),
    };
  } finally {
    Module._load = originalLoad;
  }
}

function hyprctl(provider = "hyprlang") {
  const calls = [];
  return {
    calls,
    execFileSync(command, args) {
      calls.push({ command, args: [...args] });
      if (command === "hyprctl" && args[0] === "systeminfo") {
        return `State:\n\nconfigProvider: ${provider}\n`;
      }
      return "ok\n";
    },
  };
}

function withTempHyprConfig(fn) {
  return async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-hyprland-rows-"));
    const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.XDG_CONFIG_HOME = path.join(root, "config");
    process.env.HYPRLAND_INSTANCE_SIGNATURE = "test";
    const configDir = path.join(process.env.XDG_CONFIG_HOME, "hypr");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "hyprland.conf"), "# config\n");
    try {
      await fn(configDir);
    } finally {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function managerWith(HotkeyManager, hyprlandManager, { activationMode = "tap" } = {}) {
  const manager = new HotkeyManager();
  manager.useHyprland = true;
  manager.hyprlandManager = hyprlandManager;
  manager.activationMode = activationMode;
  return manager;
}

function dbusMock(onExport) {
  return {
    sessionBus() {
      return {
        connection: { on() {}, end() {} },
        requestName(_name, _flags, callback) {
          callback(null, 1);
        },
        exportInterface(methods, _path, iface) {
          onExport({ methods, iface });
        },
      };
    },
  };
}

async function withDbusMock(dbusModule, fn) {
  const previousLoad = Module._load;
  Module._load = function loadDbusMock(request, parent, isMain) {
    if (request === "@homebridge/dbus-native") return dbusModule;
    return previousLoad.call(this, request, parent, isMain);
  };
  try {
    await fn();
  } finally {
    Module._load = previousLoad;
  }
}

test(
  "a second dictation row registers instead of failing the whole commit",
  withTempHyprConfig(async () => {
    const exec = hyprctl();
    const { HyprlandShortcutManager, HotkeyManager } = load(exec.execFileSync);
    const hypr = new HyprlandShortcutManager();
    const manager = managerWith(HotkeyManager, hypr);

    const result = await manager._registerDesktopBindings(
      "hyprland",
      "dictation",
      ["Control+Alt+F8", "Control+Alt+F9"],
      () => {}
    );

    assert.equal(result.success, true, result.error);
    assert.deepEqual(result.hotkeys, ["Control+Alt+F8", "Control+Alt+F9"]);
    assert.deepEqual(Object.keys(hypr.bindings).sort(), ["dictation", "dictation#1"]);
    assert.deepEqual(manager.getSlotHotkeys("dictation"), ["Control+Alt+F8", "Control+Alt+F9"]);
  })
);

test(
  "row 0 keeps the bare toggle and later rows carry their own identity",
  withTempHyprConfig(async () => {
    const exec = hyprctl();
    const { HyprlandShortcutManager, HotkeyManager } = load(exec.execFileSync);
    const hypr = new HyprlandShortcutManager();
    const manager = managerWith(HotkeyManager, hypr);

    await manager._registerDesktopBindings(
      "hyprland",
      "dictation",
      ["Control+Alt+F8", "Control+Alt+F9"],
      () => {}
    );

    // Row 0 must stay byte-identical to what older builds wrote, or a bind
    // already in the user's config stops matching.
    assert.match(hypr.desiredBinds.dictation.press, /com\.openwhispr\.App\.Toggle$/);
    assert.match(
      hypr.desiredBinds["dictation#1"].press,
      /com\.openwhispr\.App\.ToggleBinding string:dictation uint32:1$/
    );
    // The row travels as slot plus index, never as "dictation#1": a literal #
    // in a hyprlang line starts a comment and would truncate the command.
    assert.equal(hypr.desiredBinds["dictation#1"].press.includes("#"), false);
  })
);

test(
  "each row's press reaches its own callback over D-Bus",
  withTempHyprConfig(async () => {
    const exec = hyprctl();
    const { HyprlandShortcutManager, HotkeyManager } = load(exec.execFileSync);
    let exported;
    await withDbusMock(
      dbusMock((e) => {
        exported = e;
      }),
      async () => {
        const hypr = new HyprlandShortcutManager();
        const manager = managerWith(HotkeyManager, hypr);
        assert.equal(await hypr.initDBusService(() => {}), true);

        const fired = [];
        await manager._registerDesktopBindings(
          "hyprland",
          "dictation",
          ["Control+Alt+F8", "Control+Alt+F9"],
          (hotkey, phase) => fired.push({ hotkey, phase })
        );

        assert.deepEqual(Object.keys(exported.iface.methods).sort(), [
          "PttDown",
          "PttDownBinding",
          "PttUp",
          "PttUpBinding",
          "Toggle",
          "ToggleBinding",
          "ToggleMeeting",
          "ToggleTranslation",
          "ToggleVoiceAgent",
        ]);

        exported.methods.Toggle();
        exported.methods.ToggleBinding("dictation", 1);
        // Identity comes from the per-row closure, so each press reports the
        // hotkey of the row that was pressed — which is what resolves that
        // row's cleanup mode.
        assert.deepEqual(fired, [
          { hotkey: "Control+Alt+F8", phase: undefined },
          { hotkey: "Control+Alt+F9", phase: undefined },
        ]);

        // An id no row holds any more resolves to nothing rather than falling
        // back to row 0, same as GNOME's ToggleBinding. Any process on the
        // session bus can make these calls, so a malformed row is refused too
        // instead of reading as row 0, which is always bound.
        exported.methods.ToggleBinding("dictation", 7);
        exported.methods.ToggleBinding("dictation", "not-a-row");
        exported.methods.ToggleBinding("dictation", -1);
        exported.methods.ToggleBinding("dictation", 1.5);
        exported.methods.ToggleBinding("", 1);
        exported.methods.ToggleBinding(undefined, 1);
        exported.methods.PttDownBinding("dictation", "nope");
        assert.equal(fired.length, 2, "no malformed row reached a callback");
      }
    );
  })
);

test(
  "Hold gives each row its own down and up",
  withTempHyprConfig(async () => {
    const exec = hyprctl();
    const { HyprlandShortcutManager, HotkeyManager } = load(exec.execFileSync);
    let exported;
    await withDbusMock(
      dbusMock((e) => {
        exported = e;
      }),
      async () => {
        const hypr = new HyprlandShortcutManager();
        const manager = managerWith(HotkeyManager, hypr, { activationMode: "push" });
        assert.equal(await hypr.initDBusService(() => {}), true);

        const fired = [];
        const result = await manager._registerDesktopBindings(
          "hyprland",
          "dictation",
          ["Control+Alt+F8", "Control+Alt+F9"],
          (hotkey, phase) => fired.push({ hotkey, phase })
        );
        assert.equal(result.success, true, result.error);

        assert.match(hypr.desiredBinds.dictation.press, /\.PttDown$/);
        assert.match(hypr.desiredBinds.dictation.release, /\.PttUp$/);
        assert.match(
          hypr.desiredBinds["dictation#1"].press,
          /\.PttDownBinding string:dictation uint32:1$/
        );
        assert.match(
          hypr.desiredBinds["dictation#1"].release,
          /\.PttUpBinding string:dictation uint32:1$/
        );

        exported.methods.PttDownBinding("dictation", 1);
        exported.methods.PttUpBinding("dictation", 1);
        exported.methods.PttDown();
        exported.methods.PttUp();
        assert.deepEqual(fired, [
          { hotkey: "Control+Alt+F9", phase: "down" },
          { hotkey: "Control+Alt+F9", phase: "up" },
          { hotkey: "Control+Alt+F8", phase: "down" },
          { hotkey: "Control+Alt+F8", phase: "up" },
        ]);
      }
    );
  })
);
