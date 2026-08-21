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
    assert.match(fs.readFileSync(configPath, "utf8"), /source = \.\/openwhispr-binds\.conf/);
    assert.match(
      fs.readFileSync(path.join(configDir, "openwhispr-binds.conf"), "utf8"),
      /bind = CTRL SHIFT, Return, exec, dbus-send/
    );
  })
);

test(
  "rejects modifier-only push-to-talk bindings",
  withTempHyprConfig(async (configDir) => {
    const configPath = path.join(configDir, "hyprland.conf");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, "# legacy config\n");
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
    const luaPath = path.join(configDir, "hyprland.lua");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(luaPath, "-- lua config\n");
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
  "rejects a Hyprland error reply even when hyprctl exits successfully",
  withTempHyprConfig(async (configDir) => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "hyprland.lua"), "-- lua config\n");
    const HyprlandShortcutManager = loadManager((_command, args) => {
      if (args[0] === "systeminfo") return "configProvider: lua\n";
      return "keyword can't work with non-legacy parsers. Use eval.\n";
    });

    const manager = new HyprlandShortcutManager();
    assert.equal(await manager.registerKeybinding("F8", true), false);
    assert.equal(manager.isRegistered, false);
    assert.equal(manager.currentBinding, null);
    assert.equal(fs.existsSync(path.join(configDir, "openwhispr-binds.lua")), false);
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
    assert.equal(await manager.registerKeybinding("Control+Shift+Enter"), true);
    assert.equal(await manager.registerKeybinding("Control+Shift+Enter"), true);
    assert.equal(hyprctl.calls.filter(({ args }) => args[0] === "systeminfo").length, 1);

    assert.equal(HyprlandShortcutManager.getHyprlandConfigStatus().path, luaPath);
    assert.match(fs.readFileSync(luaPath, "utf8"), /dofile\(.+openwhispr-binds\.lua/);
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
    assert.equal(hyprctl.calls.filter(({ args }) => args[0] === "systeminfo").length, 2);
  })
);
