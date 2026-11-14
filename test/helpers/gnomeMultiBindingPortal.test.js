const test = require("node:test");
const assert = require("node:assert/strict");

// Two defects found by probing the REAL classes with a fake transport, not by
// reading stub return values:
//
//  1. registerKeybinding tore down the session on every call, so binding a
//     second row left only that row bound and closed the first session.
//  2. the single-row push path falls back to a gsettings Tap binding when the
//     portal refuses, so a FAILED row left an orphan holding the key while the
//     commit reported a clean rollback.
//
// Both are driven here through the real GnomeGlobalShortcutsPortal and
// GnomeShortcutManager. Nothing touches this machine's desktop.

const GnomeGlobalShortcutsPortal = require("../../src/helpers/gnomeGlobalShortcutsPortal.js");

// A portal stand-in at the D-Bus boundary: real class, fake wire.
function fakePortal({ bindFails = () => false } = {}) {
  const portal = new GnomeGlobalShortcutsPortal();
  const state = { sessions: [], closed: [], bound: [] };
  let nextSession = 0;

  portal.init = async () => {
    portal.available = true;
    return true;
  };
  portal._listenForShortcutEvents = async () => {};
  portal._removeShortcutListeners = () => {};
  portal._invoke = async () => ({});
  portal._request = async (member, _signature, body) => {
    if (member === "CreateSession") {
      const handle = `/session/${++nextSession}`;
      state.sessions.push(handle);
      return [["session_handle", ["o", [handle]]]];
    }
    if (member === "BindShortcuts") {
      const requested = body[1].map(([id]) => id);
      if (bindFails(requested)) return [["shortcuts", ["a(sa{sv})", [[]]]]];
      state.bound.push(requested);
      return [["shortcuts", ["a(sa{sv})", [requested.map((id) => [id, []])]]]];
    }
    return [];
  };
  const originalUnregister = portal.unregisterKeybinding.bind(portal);
  portal.unregisterKeybinding = async (bindingId) => {
    if (portal.sessionHandle) state.closed.push(portal.sessionHandle);
    portal.sessionHandle = null;
    return originalUnregister(bindingId);
  };
  return { portal, state };
}

test("two Hold rows are bound in one session, and both survive", async () => {
  const { portal, state } = fakePortal();

  const ok = await portal.registerKeybindings([
    { bindingId: "dictation", preferredTrigger: "CTRL+F8", callback: () => {} },
    { bindingId: "dictation#1", preferredTrigger: "CTRL+F9", callback: () => {} },
  ]);

  assert.equal(ok, true);
  assert.deepEqual([...portal.callbacks.keys()], ["dictation", "dictation#1"]);
  assert.equal(state.sessions.length, 1, "one session, not one per row");
  assert.deepEqual(state.bound, [["dictation", "dictation#1"]], "one BindShortcuts call");
});

test("each bound row receives its own press and release with identity", async () => {
  const { EventEmitter } = require("node:events");
  const { portal } = fakePortal();
  const fired = [];

  // Emit through the listeners the REAL _listenForShortcutEvents attaches,
  // rather than reconstructing them here: a test that rebuilds the handler
  // proves only that the test can route events.
  const signals = new EventEmitter();
  portal.bus = {
    mangle: (path, iface, member) => `${path}|${iface}|${member}`,
    signals,
    addMatch: (_rule, cb) => cb(null),
    removeMatch: (_rule, cb) => cb(null),
  };
  portal._addMatch = async () => {};
  delete portal._listenForShortcutEvents;
  portal._removeShortcutListeners = () => {};

  await portal.registerKeybindings([
    {
      bindingId: "dictation",
      preferredTrigger: "CTRL+F8",
      callback: (id, phase) => fired.push([id, phase]),
    },
    {
      bindingId: "dictation#1",
      preferredTrigger: "CTRL+F9",
      callback: (id, phase) => fired.push([id, phase]),
    },
  ]);

  const session = portal.sessionHandle;
  const activated = portal.bus.mangle(
    "/org/freedesktop/portal/desktop",
    "org.freedesktop.portal.GlobalShortcuts",
    "Activated"
  );
  const deactivated = portal.bus.mangle(
    "/org/freedesktop/portal/desktop",
    "org.freedesktop.portal.GlobalShortcuts",
    "Deactivated"
  );

  signals.emit(activated, [session, "dictation#1"]);
  signals.emit(deactivated, [session, "dictation#1"]);
  signals.emit(activated, [session, "dictation"]);
  // A signal from another session must be ignored outright.
  signals.emit(activated, ["/session/other", "dictation"]);

  // The secondary row must receive its RELEASE: without it a Hold started on
  // row 2 never stops and the mic runs to the safety timeout.
  assert.deepEqual(fired, [
    ["dictation#1", "down"],
    ["dictation#1", "up"],
    ["dictation", "down"],
  ]);
});

test("a partly refused bind fails whole rather than leaving rows dead", async () => {
  const { portal } = fakePortal({ bindFails: (ids) => ids.includes("dictation#1") });

  const ok = await portal.registerKeybindings([
    { bindingId: "dictation", preferredTrigger: "CTRL+F8", callback: () => {} },
    { bindingId: "dictation#1", preferredTrigger: "CTRL+F9", callback: () => {} },
  ]);

  assert.equal(ok, false);
  assert.equal(portal.callbacks.size, 0, "a refused bind leaves no half-registered rows");
});

// Defect 2: the orphan. A failed row must leave nothing behind holding its key.
test("a failed Hold commit leaves no orphan Tap binding", async () => {
  const registered = new Map();
  require.cache[require.resolve("electron")] = {
    exports: {
      globalShortcut: {
        register: () => true,
        unregister: () => {},
        isRegistered: () => false,
        unregisterAll: () => {},
      },
      BrowserWindow: class {},
    },
  };
  const HotkeyManager = require("../../src/helpers/hotkeyManager.js");

  const active = new Map();
  const manager = new HotkeyManager();
  manager.useGnome = true;
  manager.activationMode = "push";
  manager.gnomeManager = {
    // The real shape: the batch path never falls back, the single-row path does.
    async registerPushToTalkBindings(rows) {
      if (rows.some(({ hotkey }) => hotkey === "Ctrl+F9")) {
        return false;
      }
      for (const { bindingId, hotkey } of rows)
        active.set(bindingId, { hotkey, backend: "portal" });
      return true;
    },
    async registerKeybinding(shortcut, bindingId) {
      active.set(bindingId, { key: shortcut, backend: "gsettings" });
      return true;
    },
    async unregisterKeybinding(bindingId) {
      active.delete(bindingId);
    },
    setBindingCallback() {},
  };

  assert.equal((await manager.registerSlot("dictation", "Ctrl+F8", () => {})).success, true);
  assert.deepEqual([...active.keys()], ["dictation"]);

  const result = await manager.registerSlot("dictation", "Ctrl+F8,Ctrl+F9", () => {});

  assert.equal(result.success, false);
  // The orphan the probe caught: dictation#1 left bound as gsettings Tap.
  assert.deepEqual(
    [...active.keys()],
    ["dictation"],
    "no binding may survive for a row the commit refused"
  );
  assert.deepEqual(manager.getSlotHotkeys("dictation"), ["Ctrl+F8"]);
  assert.equal(result.degraded, false, "the previous row came back, so this is a clean rollback");
  assert.equal(registered.size, 0);
});

// The portal has no per-shortcut unbind: Close IS the release. A Close the
// portal never confirmed means the session may still hold every binding, so
// reporting a release — and throwing away the handle needed to retry — hides
// unresolved ownership of the user's keys.
test("an unconfirmed portal Close is reported as a failed release", async () => {
  // The real method, not the fake's recording wrapper: the wrapper clears the
  // handle before delegating, which is exactly the behaviour under test.
  const portal = new GnomeGlobalShortcutsPortal();
  portal.callbacks.set("dictation", () => {});
  portal.triggers.set("dictation", "CTRL+F8");
  portal.sessionHandle = "/session/old";
  portal.bus = { connection: { end() {} } };
  portal._removeShortcutListeners = () => {};
  portal._invoke = async () => {
    throw new Error("Close rejected by the portal");
  };

  const released = await portal.unregisterKeybinding("dictation");

  assert.equal(released, false, "an unconfirmed Close is not a release");
  assert.equal(
    portal.sessionHandle,
    "/session/old",
    "the handle is kept so the teardown can be retried"
  );
});

test("a confirmed Close reports success and drops the handle", async () => {
  const portal = new GnomeGlobalShortcutsPortal();
  portal.callbacks.set("dictation", () => {});
  portal.triggers.set("dictation", "CTRL+F8");
  portal.sessionHandle = "/session/live";
  portal.bus = { connection: { end() {} } };
  portal._removeShortcutListeners = () => {};
  portal._invoke = async () => ({});

  assert.equal(await portal.unregisterKeybinding("dictation"), true);
  assert.equal(portal.sessionHandle, null);
});

// Binding a new set means closing the old session first, because the portal has
// no per-shortcut unbind. A Close the portal never confirmed leaves a session
// that may still hold the user's keys, and opening a second one overwrites the
// only handle that could close it — so the bind is refused instead, and
// everything needed to route and retry is kept.
test("a bind is refused while a session that would not close may still hold the keys", async () => {
  const portal = new GnomeGlobalShortcutsPortal();
  const fired = [];
  const originalCallback = (id, phase) => fired.push([id, phase]);
  portal.callbacks.set("dictation", originalCallback);
  portal.triggers.set("dictation", "CTRL+F8");
  portal.sessionHandle = "/session/old";
  portal.bus = { connection: { end() {} } };
  portal.init = async () => true;
  portal._removeShortcutListeners = () => {};
  portal._listenForShortcutEvents = async () => {};
  let sessionsCreated = 0;
  portal._invoke = async () => {
    throw new Error("Close rejected by the portal");
  };
  portal._request = async (member) => {
    if (member === "CreateSession") {
      sessionsCreated += 1;
      return [["session_handle", ["o", ["/session/new"]]]];
    }
    return [];
  };

  const bound = await portal.registerKeybindings([
    { bindingId: "dictation", preferredTrigger: "CTRL+F9", callback: () => {} },
  ]);

  assert.equal(bound, false, "a bind over unresolved ownership is refused");
  assert.equal(sessionsCreated, 0, "no second session is opened beside the surviving one");
  assert.equal(portal.sessionHandle, "/session/old", "the only closable handle is kept");
  // The old row is still the live one, and still routable: the compositor may
  // keep delivering its key, and a release in flight must still stop a hold.
  assert.deepEqual([...portal.triggers], [["dictation", "CTRL+F8"]]);
  assert.equal(portal.callbacks.get("dictation"), originalCallback);
});
