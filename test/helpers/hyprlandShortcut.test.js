const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

const modulePath = require.resolve("../../src/helpers/hyprlandShortcut");
const originalLoad = Module._load;
const ENV_KEYS = ["HYPRLAND_CONFIG", "HYPRLAND_INSTANCE_SIGNATURE", "XDG_CONFIG_HOME"];

function loadManager(execFileSync) {
  delete require.cache[modulePath];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "child_process") return { ...childProcess, execFileSync };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
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

function withTempHyprConfig(fn) {
  return async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-hyprland-test-"));
    const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.XDG_CONFIG_HOME = path.join(root, "config");
    process.env.HYPRLAND_INSTANCE_SIGNATURE = "test";
    try {
      await fn(path.join(process.env.XDG_CONFIG_HOME, "hypr"));
    } finally {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function successfulHyprctl(provider) {
  const calls = [];
  return {
    calls,
    execFileSync(command, args) {
      calls.push({ command, args });
      if (command === "hyprctl" && args[0] === "systeminfo") {
        return `State:\n\nconfigProvider: ${provider}\n`;
      }
      return "ok\n";
    },
  };
}

const DBUS_COMMAND =
  "dbus-send --session --type=method_call --dest=com.openwhispr.App /com/openwhispr/App com.openwhispr.App.Toggle";

test("exports every Hyprland D-Bus toggle", async () => {
  let exported;
  const dbusModule = {
    sessionBus() {
      return {
        connection: { on() {}, end() {} },
        requestName(_name, _flags, callback) {
          callback(null, 1);
        },
        exportInterface(methods, _path, iface) {
          exported = { methods, iface };
        },
      };
    },
  };
  const HyprlandShortcutManager = loadManager(() => "ok\n");
  await withDbusMock(dbusModule, async () => {
    const calls = [];
    const manager = new HyprlandShortcutManager();

    assert.equal(await manager.initDBusService(() => calls.push("dictation")), true);
    manager.callbacks.meeting = () => calls.push("meeting");
    manager.callbacks.voiceAgent = () => calls.push("voiceAgent");
    manager.callbacks.translation = () => calls.push("translation");

    assert.deepEqual(Object.keys(exported.iface.methods).sort(), [
      "PttDown",
      "PttUp",
      "Toggle",
      "ToggleMeeting",
      "ToggleTranslation",
      "ToggleVoiceAgent",
    ]);
    exported.methods.Toggle();
    exported.methods.ToggleMeeting();
    exported.methods.ToggleVoiceAgent();
    exported.methods.ToggleTranslation();
    assert.deepEqual(calls, ["dictation", "meeting", "voiceAgent", "translation"]);
  });
});

test("fails D-Bus initialization when the connection errors before RequestName replies", async () => {
  let onError;
  const dbusModule = {
    sessionBus() {
      return {
        connection: {
          on(event, callback) {
            if (event === "error") onError = callback;
          },
          end() {},
        },
        requestName() {
          onError(new Error("disconnected"));
        },
      };
    },
  };
  const HyprlandShortcutManager = loadManager(() => "ok\n");
  await withDbusMock(dbusModule, async () => {
    assert.equal(await new HyprlandShortcutManager().initDBusService(() => {}), false);
  });
});

test("times out D-Bus initialization when RequestName never replies", async () => {
  let ended = false;
  const dbusModule = {
    sessionBus() {
      return {
        connection: {
          on() {},
          end() {
            ended = true;
          },
        },
        requestName() {},
      };
    },
  };
  const HyprlandShortcutManager = loadManager(() => "ok\n");
  await withDbusMock(dbusModule, async () => {
    const manager = new HyprlandShortcutManager({ dbusNameRequestTimeoutMs: 10 });
    assert.equal(await manager.initDBusService(() => {}), false);
    assert.equal(ended, true);
    assert.equal(manager.bus, null);
  });
});

test(
  "persists a legacy binding through hyprland.conf",
  withTempHyprConfig(async (configDir) => {
    const configPath = path.join(configDir, "hyprland.conf");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, "# legacy config\n");
    const hyprctl = successfulHyprctl("hyprlang");
    const HyprlandShortcutManager = loadManager(hyprctl.execFileSync);

    const manager = new HyprlandShortcutManager();
    assert.equal(await manager.registerKeybinding("Control+Shift+Enter"), true);

    assert.equal(HyprlandShortcutManager.getHyprlandConfigStatus().path, configPath);
    assert.ok(
      fs
        .readFileSync(configPath, "utf8")
        .includes(`source = ${path.join(configDir, "openwhispr-binds.conf")}\n`)
    );
    assert.match(
      fs.readFileSync(path.join(configDir, "openwhispr-binds.conf"), "utf8"),
      /bind = CTRL SHIFT, Return, exec, dbus-send/
    );
    assert.equal(await manager.unregisterKeybinding(), true);
    assert.deepEqual(
      hyprctl.calls.filter(({ args }) => args[0] === "keyword").map(({ args }) => args),
      [
        ["keyword", "unbind", "CTRL SHIFT, Return"],
        ["keyword", "bind", `CTRL SHIFT, Return, exec, ${DBUS_COMMAND}`],
        ["keyword", "unbind", "CTRL SHIFT, Return"],
      ]
    );
  })
);

test(
  "keeps runtime binds active when the Hyprland config cannot be persisted",
  withTempHyprConfig(async (configDir) => {
    fs.mkdirSync(configDir, { recursive: true });
    const hyprctl = successfulHyprctl("hyprlang");
    const HyprlandShortcutManager = loadManager(hyprctl.execFileSync);
    const manager = new HyprlandShortcutManager();

    assert.equal(await manager.registerKeybinding("Control+Shift+Enter"), true);
    assert.equal(await manager.registerSlotKeybinding("Alt+F9", "meeting", () => {}), true);
    assert.equal(manager.persistencePending, true);
    assert.deepEqual(Object.keys(manager.desiredBinds).sort(), ["dictation", "meeting"]);
    assert.deepEqual(Object.keys(manager.bindings).sort(), ["dictation", "meeting"]);
    assert.equal(fs.existsSync(path.join(configDir, "openwhispr-binds.conf")), false);
  })
);

test(
  "retries the same desired bind after persistence recovers",
  withTempHyprConfig(async (configDir) => {
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "hyprland.conf");
    const hyprctl = successfulHyprctl("hyprlang");
    const HyprlandShortcutManager = loadManager(hyprctl.execFileSync);
    const manager = new HyprlandShortcutManager();

    assert.equal(await manager.registerKeybinding("F8"), true);
    fs.writeFileSync(configPath, "# config\n");
    assert.equal(await manager.registerKeybinding("F8"), true);

    assert.match(fs.readFileSync(configPath, "utf8"), /openwhispr-binds\.conf/);
    assert.match(readBinds(configDir), /bind = , F8, exec/);
  })
);

test(
  "retries the latest desired binds after persistence recovers",
  withTempHyprConfig(async (configDir) => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "hyprland.conf"), "# config\n");
    const hyprctl = successfulHyprctl("hyprlang");
    const HyprlandShortcutManager = loadManager(hyprctl.execFileSync);
    const manager = new HyprlandShortcutManager();

    assert.equal(await manager.registerKeybinding("Control+Shift+Enter"), true);
    const persistBinds = manager._persistBinds.bind(manager);
    let failNextPersist = true;
    manager._persistBinds = (...args) => {
      if (failNextPersist) {
        failNextPersist = false;
        throw new Error("disk unavailable");
      }
      return persistBinds(...args);
    };

    assert.equal(await manager.updateKeybinding("Alt+F9"), true);
    assert.equal(await manager.registerSlotKeybinding("Alt+F10", "meeting", () => {}), true);

    const binds = readBinds(configDir);
    assert.doesNotMatch(binds, /CTRL SHIFT, Return/);
    assert.match(binds, /ALT, F9, exec/);
    assert.match(binds, /ALT, F10, exec/);
  })
);

test(
  "prefers Hyprland's active Lua config when both formats exist",
  withTempHyprConfig(async (configDir) => {
    const luaPath = path.join(configDir, "hyprland.lua");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "hyprland.conf"), "# legacy config\n");
    fs.writeFileSync(luaPath, 'require("hypr.bindings")\n');
    const hyprctl = successfulHyprctl("lua");
    const HyprlandShortcutManager = loadManager(hyprctl.execFileSync);

    const manager = new HyprlandShortcutManager();
    assert.equal(hyprctl.calls.filter(({ args }) => args[0] === "systeminfo").length, 0);
    assert.equal(await manager.registerKeybinding("Control+Shift+Enter"), true);
    assert.equal(await manager.registerKeybinding("Control+Shift+Enter"), true);
    assert.equal(hyprctl.calls.filter(({ args }) => args[0] === "systeminfo").length, 1);

    assert.equal(HyprlandShortcutManager.getHyprlandConfigStatus().path, luaPath);
    assert.match(fs.readFileSync(luaPath, "utf8"), /pcall\(require, .+openwhispr-binds\.lua/);
    assert.equal(
      (fs.readFileSync(luaPath, "utf8").match(/openwhispr-binds\.lua/g) || []).length,
      1
    );
    const binds = fs.readFileSync(path.join(configDir, "openwhispr-binds.lua"), "utf8");
    assert.match(binds, /^-- OpenWhispr keybinds/m);
    assert.match(binds, /hl\.bind\("CTRL \+ SHIFT \+ RETURN", hl\.dsp\.exec_cmd\("dbus-send/);
    assert.doesNotMatch(
      fs.readFileSync(path.join(configDir, "hyprland.conf"), "utf8"),
      /openwhispr/
    );
    assert.equal(hyprctl.calls.filter(({ args }) => args[0] === "systeminfo").length, 1);
  })
);

test(
  "registers the default modifier-only hotkey through Lua eval",
  withTempHyprConfig(async (configDir) => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "hyprland.lua"), "-- lua config\n");
    const hyprctl = successfulHyprctl("lua");
    const HyprlandShortcutManager = loadManager(hyprctl.execFileSync);

    const manager = new HyprlandShortcutManager();
    assert.equal(await manager.registerKeybinding("Control+Super"), true);

    const runtimeCalls = hyprctl.calls.filter(({ args }) => args[0] !== "systeminfo");
    assert.deepEqual(
      runtimeCalls.map(({ args }) => args),
      [
        ["eval", 'hl.unbind("CTRL + SUPER_L")'],
        ["eval", `hl.bind("CTRL + SUPER_L", hl.dsp.exec_cmd(${JSON.stringify(DBUS_COMMAND)}))`],
      ]
    );
  })
);

test(
  "rejects modifier-only push-to-talk bindings",
  withTempHyprConfig(async (configDir) => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "hyprland.conf"), "# legacy config\n");
    const hyprctl = successfulHyprctl("hyprlang");
    const HyprlandShortcutManager = loadManager(hyprctl.execFileSync);

    const manager = new HyprlandShortcutManager();
    assert.equal(await manager.registerKeybinding("Control+Super", true), false);
    assert.equal(
      hyprctl.calls.some(({ args }) => args[0] === "keyword"),
      false
    );
  })
);

test(
  "registers keyed legacy push-to-talk press and release bindings",
  withTempHyprConfig(async (configDir) => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "hyprland.conf"), "# legacy config\n");
    const hyprctl = successfulHyprctl("hyprlang");
    const HyprlandShortcutManager = loadManager(hyprctl.execFileSync);

    const manager = new HyprlandShortcutManager();
    assert.equal(await manager.registerKeybinding("Alt+R", true), true);

    const bindCalls = hyprctl.calls.filter(({ args }) => args[0] === "keyword");
    assert.deepEqual(
      bindCalls.map(({ args }) => args[1]),
      ["unbind", "bindt", "bindrt"]
    );
    assert.match(bindCalls[1].args[2], /PttDown/);
    assert.match(bindCalls[2].args[2], /PttUp/);
  })
);

test(
  "registers Lua push-to-talk bindings through the active runtime API",
  withTempHyprConfig(async (configDir) => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "hyprland.lua"), "-- lua config\n");
    const hyprctl = successfulHyprctl("lua");
    const HyprlandShortcutManager = loadManager(hyprctl.execFileSync);

    const manager = new HyprlandShortcutManager();
    assert.equal(await manager.registerKeybinding("F8", true), true);

    const runtimeCalls = hyprctl.calls.filter(({ args }) => args[0] === "eval");
    assert.equal(runtimeCalls.length, 3);
    assert.match(runtimeCalls[1].args[1], /PttDown/);
    assert.match(runtimeCalls[1].args[1], /transparent = true/);
    assert.match(runtimeCalls[2].args[1], /PttUp/);
    assert.match(runtimeCalls[2].args[1], /release = true/);
  })
);

test(
  "reuses each exact Lua key string when changing and unregistering a hotkey",
  withTempHyprConfig(async (configDir) => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "hyprland.lua"), "-- lua config\n");
    const hyprctl = successfulHyprctl("lua");
    const HyprlandShortcutManager = loadManager(hyprctl.execFileSync);
    const manager = new HyprlandShortcutManager();

    assert.equal(await manager.registerKeybinding("Control+Shift+Enter"), true);
    assert.equal(await manager.updateKeybinding("Alt+PageUp"), true);
    assert.equal(await manager.unregisterKeybinding(), true);

    const evalExpressions = hyprctl.calls
      .filter(({ args }) => args[0] === "eval")
      .map(({ args }) => args[1]);
    assert.deepEqual(evalExpressions, [
      'hl.unbind("CTRL + SHIFT + RETURN")',
      `hl.bind("CTRL + SHIFT + RETURN", hl.dsp.exec_cmd(${JSON.stringify(DBUS_COMMAND)}))`,
      'hl.unbind("ALT + PAGE_UP")',
      `hl.bind("ALT + PAGE_UP", hl.dsp.exec_cmd(${JSON.stringify(DBUS_COMMAND)}))`,
      'hl.unbind("CTRL + SHIFT + RETURN")',
      'hl.unbind("ALT + PAGE_UP")',
    ]);
  })
);

test(
  "rejects a Hyprland error reply even when hyprctl exits successfully",
  withTempHyprConfig(async (configDir) => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "hyprland.lua"), "-- lua config\n");
    const calls = [];
    const HyprlandShortcutManager = loadManager((command, args) => {
      calls.push({ command, args });
      if (args[0] === "systeminfo") return "configProvider: lua\n";
      return "keyword can't work with non-legacy parsers. Use eval.\n";
    });

    const manager = new HyprlandShortcutManager();
    assert.equal(await manager.registerKeybinding("Control+Shift+Enter"), false);
    assert.equal(manager.isRegistered, false);
    assert.equal(manager.bindings.dictation, undefined);
    assert.equal(fs.existsSync(path.join(configDir, "openwhispr-binds.lua")), false);
  })
);

test(
  "keeps a Lua binding registered when runtime unbind fails",
  withTempHyprConfig(async (configDir) => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "hyprland.lua"), "-- lua config\n");
    let rejectUnbind = false;
    const HyprlandShortcutManager = loadManager((command, args) => {
      if (args[0] === "systeminfo") return "configProvider: lua\n";
      if (rejectUnbind && args[1] === 'hl.unbind("CTRL + SHIFT + RETURN")') {
        return "unbind failed\n";
      }
      return "ok\n";
    });
    const manager = new HyprlandShortcutManager();

    assert.equal(await manager.registerKeybinding("Control+Shift+Enter"), true);
    rejectUnbind = true;

    assert.equal(await manager.unregisterKeybinding(), false);
    assert.equal(manager.bindings.dictation, "CTRL + SHIFT + RETURN");
    assert.equal(manager.isRegistered, true);
  })
);

test(
  "keeps a slot binding when its replacement fails",
  withTempHyprConfig(async (configDir) => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "hyprland.conf"), "# config\n");
    let failReplacement = false;
    const HyprlandShortcutManager = loadManager((command, args) => {
      if (args[0] === "systeminfo") return "configProvider: hyprlang\n";
      if (failReplacement && command === "hyprctl" && args[1] === "bind") {
        return "bind failed\n";
      }
      return "ok\n";
    });
    const manager = new HyprlandShortcutManager();
    const callback = () => {};

    assert.equal(await manager.registerSlotKeybinding("F8", "meeting", callback), true);
    failReplacement = true;
    assert.equal(await manager.registerSlotKeybinding("Alt+F9", "meeting", () => {}), false);
    assert.equal(manager.bindings.meeting, ", F8");
    assert.equal(manager.callbacks.meeting, callback);
    assert.match(readBinds(configDir), /bind = , F8, exec, .*ToggleMeeting/);
  })
);

test(
  "uses HYPRLAND_CONFIG for a Lua config without spawning systeminfo",
  withTempHyprConfig(async (configDir) => {
    const configPath = path.join(configDir, "dotfiles", "custom.lua");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "-- custom lua config\n");
    process.env.HYPRLAND_CONFIG = configPath;
    const hyprctl = successfulHyprctl("hyprlang");
    const HyprlandShortcutManager = loadManager(hyprctl.execFileSync);
    const manager = new HyprlandShortcutManager();

    assert.equal(await manager.registerKeybinding("Control+Shift+Enter"), true);
    assert.equal(HyprlandShortcutManager.getHyprlandConfigStatus().path, configPath);
    assert.equal(hyprctl.calls.filter(({ args }) => args[0] === "systeminfo").length, 0);
    assert.match(fs.readFileSync(configPath, "utf8"), /pcall\(require,/);
    assert.equal(fs.existsSync(path.join(path.dirname(configPath), "openwhispr-binds.lua")), true);
  })
);

test(
  "falls back to an existing Lua config when systeminfo fails",
  withTempHyprConfig(async (configDir) => {
    const luaPath = path.join(configDir, "hyprland.lua");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(luaPath, "-- lua config\n");
    const calls = [];
    const HyprlandShortcutManager = loadManager((command, args) => {
      calls.push({ command, args });
      if (args[0] === "systeminfo") throw new Error("hyprctl timed out");
      return "ok\n";
    });
    const manager = new HyprlandShortcutManager();

    assert.equal(calls.length, 0);
    assert.equal(await manager.registerKeybinding("Control+Shift+Enter"), true);
    assert.equal(calls.filter(({ args }) => args[0] === "systeminfo").length, 1);
    assert.equal(calls.filter(({ args }) => args[0] === "eval").length, 2);
    assert.equal(fs.existsSync(path.join(configDir, "openwhispr-binds.lua")), true);
  })
);

test(
  "falls back to an existing Lua config when systeminfo returns unusable output",
  withTempHyprConfig(async (configDir) => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "hyprland.lua"), "-- lua config\n");
    const calls = [];
    const HyprlandShortcutManager = loadManager((command, args) => {
      calls.push({ command, args });
      if (args[0] === "systeminfo") return "Hyprland IPC unavailable\n";
      return "ok\n";
    });

    assert.equal(
      await new HyprlandShortcutManager().registerKeybinding("Control+Shift+Enter"),
      true
    );
    assert.equal(calls.filter(({ args }) => args[0] === "eval").length, 2);
    assert.equal(calls.filter(({ args }) => args[0] === "keyword").length, 0);
  })
);

test(
  "replaces an old dofile loader before a trailing top-level return",
  withTempHyprConfig(async (configDir) => {
    const luaPath = path.join(configDir, "hyprland.lua");
    const bindsPath = path.join(configDir, "openwhispr-binds.lua");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      luaPath,
      `-- lua config\ndofile("${bindsPath}")\nreturn {}\n-- trailing comment\n`
    );
    const hyprctl = successfulHyprctl("lua");
    const HyprlandShortcutManager = loadManager(hyprctl.execFileSync);

    assert.equal(
      await new HyprlandShortcutManager().registerKeybinding("Control+Shift+Enter"),
      true
    );

    const content = fs.readFileSync(luaPath, "utf8");
    const protectedLoader = `pcall(require, "${bindsPath}")`;
    assert.doesNotMatch(content, /dofile\(/);
    assert.equal((content.match(/openwhispr-binds\.lua/g) || []).length, 1);
    assert.ok(content.indexOf(protectedLoader) < content.indexOf("return {}"));
  })
);

test(
  "preserves user-authored lines that merely mention the D-Bus service",
  withTempHyprConfig(async (configDir) => {
    const configPath = path.join(configDir, "hyprland.conf");
    const bindsPath = path.join(configDir, "openwhispr-binds.conf");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, "# legacy config\n");
    fs.writeFileSync(bindsPath, "exec-once = notify-send com.openwhispr.App\n");
    const hyprctl = successfulHyprctl("hyprlang");
    const HyprlandShortcutManager = loadManager(hyprctl.execFileSync);

    assert.equal(await new HyprlandShortcutManager().registerKeybinding("F8"), true);

    const content = fs.readFileSync(bindsPath, "utf8");
    assert.match(content, /exec-once = notify-send com\.openwhispr\.App/);
    assert.match(content, /bind = , F8, exec, dbus-send/);
  })
);

test(
  "reports persistence unavailable when the managed binds path is not a file",
  withTempHyprConfig(async (configDir) => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "hyprland.conf"), "# legacy config\n");
    fs.mkdirSync(path.join(configDir, "openwhispr-binds.conf"));
    const HyprlandShortcutManager = loadManager(successfulHyprctl("hyprlang").execFileSync);

    assert.equal(HyprlandShortcutManager.getHyprlandConfigStatus().canWrite, false);
  })
);

test(
  "removes the previous header wording when rewriting managed binds",
  withTempHyprConfig(async (configDir) => {
    const configPath = path.join(configDir, "hyprland.conf");
    const bindsPath = path.join(configDir, "openwhispr-binds.conf");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, "# legacy config\n");
    fs.writeFileSync(
      bindsPath,
      "# OpenWhispr keybinds (managed automatically)\n" +
        "# If you delete this file, also remove the matching source line from your Hyprland config.\n"
    );
    const hyprctl = successfulHyprctl("hyprlang");
    const HyprlandShortcutManager = loadManager(hyprctl.execFileSync);

    assert.equal(
      await new HyprlandShortcutManager().registerKeybinding("Control+Shift+Enter"),
      true
    );

    const content = fs.readFileSync(bindsPath, "utf8");
    assert.doesNotMatch(content, /matching source line/);
    assert.equal((content.match(/OpenWhispr keybinds/g) || []).length, 1);
  })
);

test(
  "preserves user content while removing stale managed legacy binds",
  withTempHyprConfig(async (configDir) => {
    const confPath = path.join(configDir, "hyprland.conf");
    const legacyBindsPath = path.join(configDir, "openwhispr-binds.conf");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "hyprland.lua"), "-- lua config\n");
    fs.writeFileSync(confPath, "source = ./openwhispr-binds.conf\n");
    fs.writeFileSync(
      legacyBindsPath,
      "# OpenWhispr keybinds (managed automatically)\n" +
        "exec-once = notify-send com.openwhispr.App\n" +
        `bind = CTRL SHIFT, Return, exec, ${DBUS_COMMAND}\n`
    );
    const HyprlandShortcutManager = loadManager(successfulHyprctl("lua").execFileSync);

    assert.equal(await new HyprlandShortcutManager().registerKeybinding("F8"), true);

    assert.equal(
      fs.readFileSync(legacyBindsPath, "utf8"),
      "exec-once = notify-send com.openwhispr.App\n"
    );
    assert.equal(fs.readFileSync(confPath, "utf8"), "source = ./openwhispr-binds.conf\n");
  })
);

test(
  "removes stale managed legacy artifacts after migrating to Lua",
  withTempHyprConfig(async (configDir) => {
    const confPath = path.join(configDir, "hyprland.conf");
    const legacyBindsPath = path.join(configDir, "openwhispr-binds.conf");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "hyprland.lua"), "-- lua config\n");
    fs.writeFileSync(confPath, "# keep this comment\nsource = ./openwhispr-binds.conf\n");
    fs.writeFileSync(
      legacyBindsPath,
      "# OpenWhispr keybinds (managed automatically)\n" +
        `bind = CTRL SHIFT, Return, exec, ${DBUS_COMMAND}\n`
    );
    const hyprctl = successfulHyprctl("lua");
    const HyprlandShortcutManager = loadManager(hyprctl.execFileSync);

    assert.equal(
      await new HyprlandShortcutManager().registerKeybinding("Control+Shift+Enter"),
      true
    );

    assert.equal(fs.existsSync(legacyBindsPath), false);
    assert.equal(fs.readFileSync(confPath, "utf8"), "# keep this comment\n");
  })
);

function readBinds(configDir) {
  return fs.readFileSync(path.join(configDir, "openwhispr-binds.conf"), "utf8");
}

test(
  "keeps per-slot Hyprland binds and callbacks isolated",
  withTempHyprConfig(async (configDir) => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "hyprland.conf"), "# config\n");
    const hyprctl = successfulHyprctl("hyprlang");
    const HyprlandShortcutManager = loadManager(hyprctl.execFileSync);

    const manager = new HyprlandShortcutManager();
    const cb = {
      meeting: () => undefined,
      voiceAgent: () => undefined,
      translation: () => undefined,
    };

    await manager.registerKeybinding("Control+Shift+Enter");
    await manager.registerSlotKeybinding("Alt+F9", "meeting", cb.meeting);
    await manager.registerSlotKeybinding("Alt+F10", "voiceAgent", cb.voiceAgent);
    await manager.registerSlotKeybinding("Alt+F11", "translation", cb.translation);

    const binds = readBinds(configDir);
    assert.match(binds, /\.Toggle\b/);
    assert.match(binds, /\.ToggleMeeting/);
    assert.match(binds, /\.ToggleVoiceAgent/);
    assert.match(binds, /\.ToggleTranslation/);

    assert.equal(await manager.updateKeybinding("Alt+F12"), true);
    const afterDictationUpdate = readBinds(configDir);
    assert.match(afterDictationUpdate, /\.ToggleMeeting/);
    assert.match(afterDictationUpdate, /\.ToggleVoiceAgent/);
    assert.match(afterDictationUpdate, /\.ToggleTranslation/);

    assert.equal(await manager.unregisterKeybinding("meeting"), true);
    const after = readBinds(configDir);
    assert.doesNotMatch(after, /ToggleMeeting/);
    assert.match(after, /ToggleVoiceAgent/);
    assert.match(after, /ToggleTranslation/);
    assert.equal(manager.callbacks.meeting, undefined);
    assert.equal(manager.callbacks.voiceAgent, cb.voiceAgent);

    const teardown = manager.unregisterKeybinding();
    assert.deepEqual(manager.bindings, {});
    assert.equal(await teardown, true);
    assert.equal(manager.bindings.voiceAgent, undefined);
    assert.equal(manager.bindings.translation, undefined);
  })
);
