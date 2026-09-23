const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

const originalLoad = Module._load;
let settings;
let failTapBinding;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return { globalShortcut: {}, BrowserWindow: class {} };
  if (request === "child_process") {
    return {
      ...originalLoad.call(this, request, parent, isMain),
      execFileSync(command, [action, schema, property, value]) {
        assert.equal(command, "gsettings");
        const key = `${schema}:${property}`;
        if (action === "get")
          return settings.get(key) || (property === "custom-keybindings" ? "[]" : "''");
        if (action === "set") {
          if (property === "binding" && value === failTapBinding)
            throw new Error("gsettings refused");
          settings.set(key, value);
        } else if (action === "reset") settings.delete(key);
        else assert.fail(`unexpected gsettings action ${action}`);
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const HotkeyManager = require("../../src/helpers/hotkeyManager");
const GnomeShortcutManager = require("../../src/helpers/gnomeShortcut");
Module._load = originalLoad;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const oldDesktop = process.env.XDG_CURRENT_DESKTOP;
test.before(() => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  process.env.XDG_CURRENT_DESKTOP = "GNOME";
});
test.after(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  if (oldDesktop === undefined) delete process.env.XDG_CURRENT_DESKTOP;
  else process.env.XDG_CURRENT_DESKTOP = oldDesktop;
});

function setup() {
  settings = new Map();
  failTapBinding = null;
  const manager = new HotkeyManager();
  manager.currentHotkey = "F8";
  const gnome = new GnomeShortcutManager();
  const portal = gnome.globalShortcutsPortal;
  const failures = [];
  manager.notifyHotkeyFailure = (key) => failures.push(key);
  const bus = {
    signals: new EventEmitter(),
    mangle: (path, iface, member) => JSON.stringify({ path, iface, member }),
    addMatch: (_match, callback) => callback(null),
    removeMatch: (_match, callback) => callback?.(null),
    invoke: (_message, callback) => callback(null),
  };
  portal.bus = bus;
  portal.available = true;
  portal.init = async () => true;
  let session = 0;
  const faults = { refuseTrigger: null, refuseAll: false };
  portal._request = async (member, _signature, body) => {
    if (member === "CreateSession") return [["session_handle", ["o", [`/session/${++session}`]]]];
    const bound = body[1].filter(([, entries]) => {
      const trigger = entries.find(([key]) => key === "preferred_trigger")[1][1];
      return !faults.refuseAll && trigger !== faults.refuseTrigger;
    });
    return [["shortcuts", ["a(sa{sv})", [bound.map(([id]) => [id, []])]]]];
  };
  manager.useGnome = true;
  manager.gnomeManager = gnome;
  return { manager, gnome, portal, faults, failures };
}

function tapBinding(gnome, slotName) {
  const suffix = slotName === "voiceAgent" ? "voice-agent" : slotName;
  const bindingPath = `/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/openwhispr-${suffix}/`;
  assert.ok(gnome.getExistingKeybindings().includes(bindingPath));
  return settings.get(
    `org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:${bindingPath}:binding`
  );
}

for (const slotName of ["voiceAgent", "translation"]) {
  test(`${slotName}: rejected GNOME Tap-to-Hold restores gsettings and its callback`, async () => {
    const h = setup();
    let fired = false;
    const oldCallback = () => {
      fired = true;
    };
    await h.manager.registerSlot(slotName, "F9", oldCallback, {
      atomic: true,
      activationMode: "tap",
    });
    h.faults.refuseTrigger = "F10";
    const result = await h.manager.registerSlot(
      slotName,
      "F10",
      () => assert.fail("replacement callback"),
      { atomic: true, activationMode: "push" }
    );
    assert.equal(result.success, false);
    assert.equal(tapBinding(h.gnome, slotName), "F9");
    assert.equal(h.manager.getSlotActivationMode(slotName), "tap");
    assert.deepEqual(h.manager.getSlotHotkeys(slotName), ["F9"]);
    assert.equal(h.portal.shortcuts.has(slotName), false);
    h.gnome[`${slotName}Callback`]();
    assert.equal(fired, true);
  });

  test(`${slotName}: rejected GNOME Hold replacement restores its portal trigger`, async () => {
    const h = setup();
    await h.manager.registerSlot(slotName, "F9", () => undefined, {
      atomic: true,
      activationMode: "push",
    });
    h.faults.refuseTrigger = "F10";
    assert.equal(
      (
        await h.manager.registerSlot(slotName, "F10", () => undefined, {
          atomic: true,
          activationMode: "push",
        })
      ).success,
      false
    );
    assert.equal(h.portal.shortcuts.get(slotName).trigger, "F9");
    assert.notEqual(h.portal.sessionHandle, null);
    failTapBinding = "F11";
    assert.equal(
      (
        await h.manager.registerSlot(slotName, "F11", () => undefined, {
          atomic: true,
          activationMode: "tap",
        })
      ).success,
      false
    );
    assert.equal(h.manager.getSlotActivationMode(slotName), "push");
    assert.equal(h.portal.shortcuts.get(slotName).trigger, "F9");
    assert.deepEqual(h.manager.getSlotHotkeys(slotName), ["F9"]);
  });
}

test("a thrown GNOME clear after gsettings removal restores the previous Tap binding", async () => {
  const h = setup();
  await h.manager.registerSlot("voiceAgent", "F9", () => undefined, { atomic: true });
  const unregister = h.portal.unregisterKeybinding.bind(h.portal);
  let throwOnce = true;
  h.portal.unregisterKeybinding = async (...args) => {
    if (throwOnce) {
      throwOnce = false;
      throw new Error("transport disconnected");
    }
    return unregister(...args);
  };
  assert.equal(await h.manager.unregisterSlot("voiceAgent"), false);
  assert.equal(tapBinding(h.gnome, "voiceAgent"), "F9");
  assert.deepEqual(h.manager.getSlotHotkeys("voiceAgent"), ["F9"]);
});

test("unrecoverable GNOME portal replacement drops all affected Hold slots truthfully", async () => {
  const h = setup();
  await h.manager.registerSlot("voiceAgent", "F9", () => undefined, {
    atomic: true,
    activationMode: "push",
  });
  await h.manager.registerSlot("translation", "F10", () => undefined, {
    atomic: true,
    activationMode: "push",
  });
  h.faults.refuseAll = true;
  const result = await h.manager.registerSlot("voiceAgent", "F11", () => undefined, {
    atomic: true,
    activationMode: "push",
  });
  assert.equal(result.success, false);
  assert.equal(result.rollbackFailed, true);
  assert.equal(h.portal.sessionHandle, null);
  assert.equal(h.portal.shortcuts.size, 0);
  assert.deepEqual(h.manager.getSlotHotkeys("voiceAgent"), []);
  assert.deepEqual(h.manager.getSlotHotkeys("translation"), []);
  assert.deepEqual(h.failures.sort(), ["F10", "F9"]);
});
