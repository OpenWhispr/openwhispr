const test = require("node:test");
const assert = require("node:assert/strict");

const GnomeShortcutManager = require("../../src/helpers/gnomeShortcut");

// Fake gsettings: "get custom-keybindings" returns an empty list, writes no-op.
function makeGsettingsFake() {
  const calls = [];
  const execFileSync = (file, args) => {
    calls.push({ file, args });
    if (file !== "gsettings") throw new Error(`unexpected spawn: ${file}`);
    if (args[0] === "get") return "@as []";
    return "";
  };
  return { execFileSync, calls };
}

function makeManager(availability, gsettings = makeGsettingsFake()) {
  const checkerCalls = [];
  const manager = new GnomeShortcutManager({
    execFileSync: gsettings.execFileSync,
    checkKeysymAvailability: (shortcut) => {
      checkerCalls.push(shortcut);
      return typeof availability === "function" ? availability() : availability;
    },
  });
  return { manager, checkerCalls, gsettingsCalls: gsettings.calls };
}

function withGnomeEnv(fn) {
  const saved = process.env.XDG_CURRENT_DESKTOP;
  process.env.XDG_CURRENT_DESKTOP = "GNOME";
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.XDG_CURRENT_DESKTOP;
    else process.env.XDG_CURRENT_DESKTOP = saved;
  }
}

test("registerKeybinding returns keysym_missing and writes nothing when the keysym is absent", async () => {
  await withGnomeEnv(async () => {
    const { manager, checkerCalls, gsettingsCalls } = makeManager("absent");
    const result = await manager.registerKeybinding("<Control><Shift>F16", "dictation");
    assert.equal(result, "keysym_missing");
    assert.deepEqual(checkerCalls, ["<Control><Shift>F16"]);
    assert.equal(gsettingsCalls.length, 0);
    assert.equal(manager.registeredSlots.has("dictation"), false);
  });
});

test("registerKeybinding proceeds and succeeds when the keysym is present", async () => {
  await withGnomeEnv(async () => {
    const { manager, gsettingsCalls } = makeManager("present");
    const result = await manager.registerKeybinding("F8", "dictation");
    assert.equal(result, true);
    const bindingWrite = gsettingsCalls.find(
      (c) => c.args[0] === "set" && c.args[2] === "binding"
    );
    assert.equal(bindingWrite.args[3], "F8");
    assert.equal(manager.registeredSlots.has("dictation"), true);
  });
});

test("registerKeybinding fails open when keymap availability is unknown", async () => {
  await withGnomeEnv(async () => {
    const { manager, gsettingsCalls } = makeManager("unknown");
    const result = await manager.registerKeybinding("F16", "dictation");
    assert.equal(result, true);
    assert.ok(gsettingsCalls.some((c) => c.args[0] === "set" && c.args[2] === "binding"));
  });
});

test("updateKeybinding returns keysym_missing and keeps the old binding when the keysym is absent", async () => {
  await withGnomeEnv(async () => {
    let availability = "present";
    const gsettings = makeGsettingsFake();
    const { manager } = makeManager(() => availability, gsettings);
    assert.equal(await manager.registerKeybinding("F8", "dictation"), true);

    availability = "absent";
    const writesBefore = gsettings.calls.length;
    const result = await manager.updateKeybinding("<Control>F16", "dictation");
    assert.equal(result, "keysym_missing");
    assert.equal(gsettings.calls.length, writesBefore);
  });
});

test("updateKeybinding on an unregistered slot routes through the same keymap gate", async () => {
  await withGnomeEnv(async () => {
    const { manager, gsettingsCalls } = makeManager("absent");
    const result = await manager.updateKeybinding("F13", "dictation");
    assert.equal(result, "keysym_missing");
    assert.equal(gsettingsCalls.length, 0);
  });
});
