const test = require("node:test");
const assert = require("node:assert/strict");

const registered = new Map();
require.cache[require.resolve("electron")] = {
  exports: {
    globalShortcut: {
      register(accelerator, callback) {
        if (registered.has(accelerator)) return false;
        registered.set(accelerator, callback);
        return true;
      },
      unregister(accelerator) {
        registered.delete(accelerator);
      },
      isRegistered(accelerator) {
        return registered.has(accelerator);
      },
      unregisterAll() {
        registered.clear();
      },
    },
    BrowserWindow: class {},
  },
};

const GnomeShortcutManager = require("../../src/helpers/gnomeShortcut");
const HotkeyManager = require("../../src/helpers/hotkeyManager.js");

const noop = () => {};

test.beforeEach(() => {
  registered.clear();
});

function withSessionType(type, fn) {
  return async () => {
    const saved = process.env.XDG_SESSION_TYPE;
    process.env.XDG_SESSION_TYPE = type;
    try {
      await fn();
    } finally {
      if (saved === undefined) delete process.env.XDG_SESSION_TYPE;
      else process.env.XDG_SESSION_TYPE = saved;
    }
  };
}

function gnomeManagerWithPortal(registerKeybinding, { portalAvailable = true } = {}) {
  const manager = new GnomeShortcutManager();
  const triggers = [];
  manager.globalShortcutsPortal.isAvailable = () => portalAvailable;
  manager.cancelShortcutsPortal = {
    registerKeybinding(trigger, callback) {
      triggers.push(trigger);
      return registerKeybinding(trigger, callback);
    },
    unregisterKeybinding: async () => undefined,
  };
  return { manager, triggers };
}

test(
  "the GNOME cancel shortcut binds Escape through the portal and fires on press only",
  withSessionType("wayland", async () => {
    const { manager, triggers } = gnomeManagerWithPortal(async (_trigger, callback) => {
      callback(undefined, "down");
      callback(undefined, "up");
      return true;
    });
    let cancels = 0;

    assert.equal(await manager.registerCancelShortcut("Escape", () => cancels++), true);
    assert.deepEqual(triggers, ["Escape"]);
    assert.equal(cancels, 1);
  })
);

test(
  "a failed cancel binding is not retried until restart",
  withSessionType("wayland", async () => {
    const { manager, triggers } = gnomeManagerWithPortal(async () => false);

    assert.equal(await manager.registerCancelShortcut("Escape", noop), false);
    assert.equal(await manager.registerCancelShortcut("Escape", noop), false);
    assert.deepEqual(triggers, ["Escape"]);
  })
);

test(
  "a cancel binding superseded by its recording ending is tried again next time",
  withSessionType("wayland", async () => {
    let finishFirst;
    const { manager, triggers } = gnomeManagerWithPortal((_trigger) =>
      triggers.length === 1
        ? new Promise((resolve) => {
            finishFirst = resolve;
          })
        : Promise.resolve(true)
    );

    const first = manager.registerCancelShortcut("Escape", noop);
    await manager.unregisterCancelShortcut();
    finishFirst(false);
    assert.equal(await first, false);

    assert.equal(await manager.registerCancelShortcut("Escape", noop), true);
    assert.deepEqual(triggers, ["Escape", "Escape"]);
  })
);

test(
  "the GNOME cancel shortcut is never bound on X11 or without the portal",
  withSessionType("x11", async () => {
    const onX11 = gnomeManagerWithPortal(async () => true);
    assert.equal(await onX11.manager.registerCancelShortcut("Escape", noop), false);
    assert.deepEqual(onX11.triggers, []);

    process.env.XDG_SESSION_TYPE = "wayland";
    const noPortal = gnomeManagerWithPortal(async () => true, { portalAvailable: false });
    assert.equal(await noPortal.manager.registerCancelShortcut("Escape", noop), false);
    assert.deepEqual(noPortal.triggers, []);
  })
);

function hotkeyManagerOnGnome(activationMode) {
  const calls = [];
  const manager = new HotkeyManager();
  manager.useGnome = true;
  manager.activationMode = activationMode;
  manager.gnomeManager = {
    async registerCancelShortcut(hotkey, callback) {
      calls.push(["register", hotkey, callback]);
      return false;
    },
    async unregisterCancelShortcut() {
      calls.push(["unregister"]);
    },
  };
  return { manager, calls };
}

test("in Tap mode on GNOME, cancel keeps its X11 grab and also binds the portal", async () => {
  const { manager, calls } = hotkeyManagerOnGnome("tap");
  const callback = () => {};

  assert.equal((await manager.registerSlot("cancel", "Escape", callback)).success, true);
  assert.ok(registered.has("Escape"));
  assert.deepEqual(calls, [["register", "Escape", callback]]);

  manager.unregisterSlot("cancel");
  assert.equal(registered.has("Escape"), false);
  assert.deepEqual(calls.at(-1), ["unregister"]);
});

test("in Hold mode on GNOME, cancel stays on the X11 grab alone", async () => {
  const { manager, calls } = hotkeyManagerOnGnome("push");

  assert.equal((await manager.registerSlot("cancel", "Escape", noop)).success, true);
  assert.ok(registered.has("Escape"));
  assert.deepEqual(calls, []);
  manager.unregisterSlot("cancel");
});
