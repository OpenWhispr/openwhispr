const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

const modulePath = require.resolve("../../src/helpers/gnomeGlobalShortcutsPortal");
const originalLoad = Module._load;

function loadPortal(sessionBus, translate = (key) => key) {
  delete require.cache[modulePath];
  const dbusPath = require.resolve("@homebridge/dbus-native");
  require.cache[dbusPath] = { exports: { sessionBus } };
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "./i18nMain") return { i18nMain: { t: translate } };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function createBus() {
  const calls = { invoke: [], invokeDbus: [] };
  const connection = new EventEmitter();
  connection.end = () => undefined;
  const bus = {
    calls,
    connection,
    name: ":1.42",
    signals: new EventEmitter(),
    invoke(message, callback) {
      calls.invoke.push(message);
      if (message.member === "Get") callback(null, ["u", [1]]);
      else callback(null);
    },
    invokeDbus(message, callback) {
      calls.invokeDbus.push(message);
      callback(null, "bus-id");
    },
    mangle(path, iface, member) {
      return JSON.stringify({ path, interface: iface, member });
    },
    addMatch(_match, callback) {
      callback(null);
    },
    removeMatch(_match, callback) {
      callback?.(null);
    },
  };
  return bus;
}

test("initialization sends GetId through the D-Bus helper with complete headers", async () => {
  const bus = createBus();
  const previousFlatpakId = process.env.FLATPAK_ID;
  process.env.FLATPAK_ID = "com.openwhispr.App";
  const GnomeGlobalShortcutsPortal = loadPortal(() => bus);

  try {
    const portal = new GnomeGlobalShortcutsPortal();
    assert.equal(await portal.init(), true);
    assert.deepEqual(bus.calls.invokeDbus, [{ member: "GetId" }]);
    assert.equal(
      bus.calls.invoke.some(({ member }) => member === "GetId"),
      false
    );
  } finally {
    if (previousFlatpakId === undefined) delete process.env.FLATPAK_ID;
    else process.env.FLATPAK_ID = previousFlatpakId;
  }
});

test("D-Bus method calls reject when the service never replies", async () => {
  const GnomeGlobalShortcutsPortal = loadPortal(() => createBus());
  const portal = new GnomeGlobalShortcutsPortal({ callTimeoutMs: 5 });
  portal.bus = { invoke: () => undefined };

  const deadline = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("test deadline expired")), 100);
  });

  await assert.rejects(
    Promise.race([portal._invoke({ member: "Get" }), deadline]),
    /D-Bus call "Get" timed out/
  );
});

test("portal requests time out and remove their response listener", async () => {
  const GnomeGlobalShortcutsPortal = loadPortal(() => createBus());
  const portal = new GnomeGlobalShortcutsPortal({ requestTimeoutMs: 5 });
  const signals = new EventEmitter();
  const removedMatches = [];
  portal.bus = {
    name: ":1.42",
    signals,
    mangle: (path, iface, member) => JSON.stringify({ path, iface, member }),
    addMatch: (_match, callback) => callback(null),
    removeMatch: (match, callback) => {
      removedMatches.push(match);
      callback?.(null);
    },
    invoke: () => undefined,
  };

  const request = portal._request("BindShortcuts", "", [], "request_token");
  const deadline = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("test deadline expired")), 100);
  });
  await assert.rejects(
    Promise.race([request, deadline]),
    /Portal request "BindShortcuts" timed out/
  );
  assert.equal(signals.eventNames().length, 0);
  assert.equal(removedMatches.length, 1);
});

test("close waits for Session.Close before ending the connection", async () => {
  const GnomeGlobalShortcutsPortal = loadPortal(() => createBus());
  const portal = new GnomeGlobalShortcutsPortal();
  let invokeCallback;
  let connectionEnded = false;
  portal.sessionHandle = "/org/freedesktop/portal/desktop/session/1";
  portal.bus = {
    signals: new EventEmitter(),
    invoke(_message, callback) {
      invokeCallback = callback;
    },
    connection: {
      end() {
        connectionEnded = true;
      },
    },
  };

  const closePromise = portal.close();
  assert.equal(connectionEnded, false);
  invokeCallback(null);
  await closePromise;
  assert.equal(connectionEnded, true);
});

test("portal registration uses the current UI language for its description", async () => {
  const GnomeGlobalShortcutsPortal = loadPortal(
    () => createBus(),
    (key) => (key === "onboarding.activation.holdDescription" ? "Mantener mientras hablas" : key)
  );
  const portal = new GnomeGlobalShortcutsPortal();
  let bindBody;
  portal.init = async () => true;
  portal.unregisterKeybinding = async () => undefined;
  portal._listenForShortcutEvents = () => undefined;
  portal._request = async (member, _signature, body) => {
    if (member === "CreateSession") {
      return [["session_handle", ["o", ["/org/freedesktop/portal/desktop/session/1"]]]];
    }
    bindBody = body;
    return [["shortcuts", ["a(sa{sv})", [[["dictation", []]]]]]];
  };

  assert.equal(await portal.registerKeybinding("ALT+R", () => undefined), true);
  const description = bindBody[1][0][1].find(([key]) => key === "description");
  assert.equal(description[1][1], "Mantener mientras hablas");
});

const SESSION = "/org/freedesktop/portal/desktop/session/1";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listeningPortal({ keyRepeat = { delayMs: 20, intervalMs: 5 } } = {}) {
  const GnomeGlobalShortcutsPortal = loadPortal(() => createBus());
  const portal = new GnomeGlobalShortcutsPortal({ releaseGraceMs: 10 });
  const bus = createBus();
  const phases = [];
  portal.bus = bus;
  portal.sessionHandle = SESSION;
  portal.keyRepeat = keyRepeat;
  portal.callback = (_hotkey, phase) => phases.push(phase);
  await portal._listenForShortcutEvents();
  const emit = (member) =>
    bus.signals.emit(
      bus.mangle(
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.GlobalShortcuts",
        member
      ),
      [SESSION, "dictation"]
    );
  return { portal, phases, emit };
}

test("a hold whose repeats stop without Deactivated is released once", async () => {
  const { portal, phases, emit } = await listeningPortal();
  emit("Activated");
  emit("Activated");
  emit("Activated");
  await sleep(60);
  assert.deepEqual(phases, ["down", "down", "down", "up"]);

  // Later holds arm from their first press, before any repeat arrives.
  emit("Activated");
  await sleep(60);
  assert.deepEqual(phases.slice(4), ["down", "up"]);
  await portal.unregisterKeybinding();
});

test("Deactivated releases the hold without a second synthesized release", async () => {
  const { portal, phases, emit } = await listeningPortal();
  emit("Activated");
  emit("Activated");
  emit("Deactivated");
  await sleep(60);
  assert.deepEqual(phases, ["down", "down", "up"]);
  await portal.unregisterKeybinding();
});

test("a hold keeps recording while repeats keep arriving", async () => {
  const { portal, phases, emit } = await listeningPortal();
  emit("Activated");
  for (let i = 0; i < 8; i += 1) {
    await sleep(5);
    emit("Activated");
  }
  assert.equal(phases.includes("up"), false);
  emit("Deactivated");
  assert.equal(phases.at(-1), "up");
  assert.equal(phases.filter((phase) => phase === "up").length, 1);
  await portal.unregisterKeybinding();
});

test("without observed repeats a hold waits for Deactivated", async () => {
  const { portal, phases, emit } = await listeningPortal();
  emit("Activated");
  await sleep(60);
  assert.deepEqual(phases, ["down"]);
  await portal.unregisterKeybinding();
});

test("with key repeat off a hold waits for Deactivated", async () => {
  const { portal, phases, emit } = await listeningPortal({ keyRepeat: null });
  emit("Activated");
  emit("Activated");
  await sleep(60);
  assert.deepEqual(phases, ["down", "down"]);
  await portal.unregisterKeybinding();
});
