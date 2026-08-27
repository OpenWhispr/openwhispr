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
      'hl.unbind("CTRL + SHIFT + RETURN")',
      'hl.unbind("ALT + PAGE_UP")',
      `hl.bind("ALT + PAGE_UP", hl.dsp.exec_cmd(${JSON.stringify(DBUS_COMMAND)}))`,
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
    assert.equal(manager.currentBinding, null);
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
    assert.equal(manager.currentBinding, "CTRL + SHIFT + RETURN");
    assert.equal(manager.isRegistered, true);
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

test("punctuation accelerators validate and convert to XKB key names", () => {
  const HyprlandShortcutManager = loadManager(() => "ok\n");

  assert.equal(HyprlandShortcutManager.isValidHotkey("F8"), true);
  assert.equal(HyprlandShortcutManager.isValidHotkey("Control+F8"), true);
  assert.equal(HyprlandShortcutManager.isValidHotkey("Control+Super"), true);

  assert.equal(HyprlandShortcutManager.isValidHotkey("Control+,"), true);
  assert.equal(HyprlandShortcutManager.isValidHotkey("Alt+."), true);
  assert.equal(HyprlandShortcutManager.isValidHotkey("Control+/"), true);
  assert.equal(HyprlandShortcutManager.isValidHotkey("Control+-"), true);
  assert.equal(HyprlandShortcutManager.isValidHotkey("Control+Plus"), true);

  assert.equal(HyprlandShortcutManager.convertToHyprlandFormat("Control+,").bindKey, "CTRL, comma");
  assert.equal(HyprlandShortcutManager.convertToHyprlandFormat("Alt+.").bindKey, "ALT, period");
  assert.equal(HyprlandShortcutManager.convertToHyprlandFormat("Control+/").bindKey, "CTRL, slash");
  assert.equal(HyprlandShortcutManager.convertToHyprlandFormat("Control+-").bindKey, "CTRL, minus");
  assert.equal(
    HyprlandShortcutManager.convertToHyprlandFormat("Control+Plus").bindKey,
    "CTRL, plus"
  );
});
