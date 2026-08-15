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
      return Buffer.from("");
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
  "prefers Hyprland's active Lua config when both formats exist",
  withTempHyprConfig(async (configDir) => {
    const luaPath = path.join(configDir, "hyprland.lua");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "hyprland.conf"), "# legacy config\n");
    fs.writeFileSync(luaPath, "require(\"hypr.bindings\")\n");
    const hyprctl = successfulHyprctl("lua");
    const HyprlandShortcutManager = loadManager(hyprctl.execFileSync);

    const manager = new HyprlandShortcutManager();
    assert.equal(await manager.registerKeybinding("Control+Shift+Enter"), true);
    assert.equal(await manager.registerKeybinding("Control+Shift+Enter"), true);
    assert.equal(hyprctl.calls.filter(({ args }) => args[0] === "systeminfo").length, 1);

    assert.equal(HyprlandShortcutManager.getHyprlandConfigStatus().path, luaPath);
    assert.match(fs.readFileSync(luaPath, "utf8"), /dofile\(.+openwhispr-binds\.lua/);
    assert.equal((fs.readFileSync(luaPath, "utf8").match(/openwhispr-binds\.lua/g) || []).length, 1);
    const binds = fs.readFileSync(path.join(configDir, "openwhispr-binds.lua"), "utf8");
    assert.match(binds, /^-- OpenWhispr keybinds/m);
    assert.match(binds, /hl\.bind\("CTRL \+ SHIFT \+ RETURN", hl\.dsp\.exec_cmd\("dbus-send/);
    assert.doesNotMatch(fs.readFileSync(path.join(configDir, "hyprland.conf"), "utf8"), /openwhispr/);
    assert.equal(hyprctl.calls.filter(({ args }) => args[0] === "systeminfo").length, 2);
  })
);
