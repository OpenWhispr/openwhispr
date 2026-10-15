const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const { deferred } = require("./harness/deferred");

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

  assert.equal(
    await portal.registerKeybinding("ALT+R", () => undefined),
    GnomeGlobalShortcutsPortal.REGISTRATION.BOUND
  );
  const description = bindBody[1][0][1].find(([key]) => key === "description");
  assert.equal(description[1][1], "Mantener mientras hablas");
});

const sessionReply = (handle) => [["session_handle", ["o", [handle]]]];
const shortcutsReply = (id) => [["shortcuts", ["a(sa{sv})", [[[id, []]]]]]];
const shortcutSignal = (bus, member) =>
  bus.mangle("/org/freedesktop/portal/desktop", "org.freedesktop.portal.GlobalShortcuts", member);

test("a portal for another shortcut binds and reports only that shortcut", async () => {
  const bus = createBus();
  const GnomeGlobalShortcutsPortal = loadPortal(
    () => bus,
    (key) => (key === "app.buttons.cancelRecording" ? "Cancel recording" : key)
  );
  const portal = new GnomeGlobalShortcutsPortal({
    shortcutId: "cancel",
    descriptionKey: "app.buttons.cancelRecording",
  });
  const session = "/org/freedesktop/portal/desktop/session/1";
  let bindBody;
  portal._request = async (member, _signature, body) => {
    if (member === "CreateSession") return sessionReply(session);
    bindBody = body;
    return shortcutsReply("cancel");
  };
  const phases = [];

  assert.equal(
    await portal.registerKeybinding("Escape", (_e, phase) => phases.push(phase)),
    GnomeGlobalShortcutsPortal.REGISTRATION.BOUND
  );
  const [id, options] = bindBody[1][0];
  assert.equal(id, "cancel");
  assert.deepEqual(options.find(([key]) => key === "description")[1], ["s", "Cancel recording"]);

  for (const member of ["Activated", "Deactivated"]) {
    bus.signals.emit(shortcutSignal(bus, member), [session, "dictation"]);
    bus.signals.emit(shortcutSignal(bus, member), [
      "/org/freedesktop/portal/desktop/session/other",
      "cancel",
    ]);
  }
  assert.deepEqual(phases, []);
  for (const member of ["Activated", "Deactivated"]) {
    bus.signals.emit(shortcutSignal(bus, member), [session, "cancel"]);
  }
  assert.deepEqual(phases, ["down", "up"]);
});

test("an unregister during CreateSession closes the new session and binds nothing", async () => {
  const bus = createBus();
  const GnomeGlobalShortcutsPortal = loadPortal(() => bus);
  const portal = new GnomeGlobalShortcutsPortal({ shortcutId: "cancel" });
  const session = "/org/freedesktop/portal/desktop/session/1";
  const created = deferred();
  const requests = [];
  portal._request = (member) => {
    requests.push(member);
    return member === "CreateSession" ? created.promise : Promise.resolve(shortcutsReply("cancel"));
  };

  const registration = portal.registerKeybinding("Escape", () => undefined);
  await new Promise(setImmediate);
  await portal.unregisterKeybinding();
  created.resolve(sessionReply(session));

  assert.equal(await registration, GnomeGlobalShortcutsPortal.REGISTRATION.SUPERSEDED);
  assert.deepEqual(requests, ["CreateSession"]);
  assert.equal(portal.sessionHandle, null);
  assert.ok(bus.calls.invoke.some(({ member, path }) => member === "Close" && path === session));
});

test("an unregister during the first connection keeps the portal unbound", async () => {
  const GnomeGlobalShortcutsPortal = loadPortal(() => createBus());
  const portal = new GnomeGlobalShortcutsPortal({ shortcutId: "cancel" });
  const connected = deferred();
  const requests = [];
  portal.init = () => connected.promise;
  portal._request = async (member) => {
    requests.push(member);
    return member === "CreateSession"
      ? sessionReply("/org/freedesktop/portal/desktop/session/1")
      : shortcutsReply("cancel");
  };

  const registration = portal.registerKeybinding("Escape", () => undefined);
  await new Promise(setImmediate);
  await portal.unregisterKeybinding();
  connected.resolve(true);

  assert.equal(await registration, GnomeGlobalShortcutsPortal.REGISTRATION.SUPERSEDED);
  assert.deepEqual(requests, []);
});

test("an unregister during BindShortcuts leaves nothing bound", async () => {
  const bus = createBus();
  const GnomeGlobalShortcutsPortal = loadPortal(() => bus);
  const portal = new GnomeGlobalShortcutsPortal();
  const session = "/org/freedesktop/portal/desktop/session/1";
  const bound = deferred();
  portal._request = (member) =>
    member === "CreateSession" ? Promise.resolve(sessionReply(session)) : bound.promise;

  const registration = portal.registerKeybinding("Escape", () => undefined);
  await new Promise(setImmediate);
  await portal.unregisterKeybinding();
  bound.resolve(shortcutsReply("dictation"));

  assert.equal(await registration, GnomeGlobalShortcutsPortal.REGISTRATION.SUPERSEDED);
  assert.equal(portal.sessionHandle, null);
  assert.equal(portal.activationListener, null);
  assert.ok(bus.calls.invoke.some(({ member, path }) => member === "Close" && path === session));
});

test("a superseded registration that fails leaves the newer one bound", async () => {
  const bus = createBus();
  const GnomeGlobalShortcutsPortal = loadPortal(() => bus);
  const portal = new GnomeGlobalShortcutsPortal();
  const firstBind = deferred();
  let sessions = 0;
  portal._request = (member) => {
    if (member === "CreateSession") {
      sessions += 1;
      return Promise.resolve(sessionReply(`/org/freedesktop/portal/desktop/session/${sessions}`));
    }
    return sessions === 1 ? firstBind.promise : Promise.resolve(shortcutsReply("dictation"));
  };

  const first = portal.registerKeybinding("Escape", () => undefined);
  await new Promise(setImmediate);
  assert.equal(
    await portal.registerKeybinding("Escape", () => undefined),
    GnomeGlobalShortcutsPortal.REGISTRATION.BOUND
  );
  firstBind.reject(new Error("Portal request was rejected (2)"));

  assert.equal(await first, GnomeGlobalShortcutsPortal.REGISTRATION.SUPERSEDED);
  assert.equal(portal.sessionHandle, "/org/freedesktop/portal/desktop/session/2");
});

// Answers each portal request through its Response signal, as the portal does.
function respondWith(bus, portal, responses) {
  const invoke = bus.invoke;
  bus.invoke = (message, callback) => {
    const response = responses[message.member];
    if (!response) return invoke.call(bus, message, callback);
    callback(null);
    const options = message.member === "CreateSession" ? message.body[0] : message.body[3];
    const token = options.find(([key]) => key === "handle_token")[1][1];
    const signal = bus.mangle(
      portal._requestPath(token),
      "org.freedesktop.portal.Request",
      "Response"
    );
    setImmediate(() => bus.signals.emit(signal, response));
  };
}

test("a dismissed approval dialog is declined and any other refusal failed", async () => {
  for (const [code, expected] of [
    [1, "DECLINED"],
    [2, "FAILED"],
  ]) {
    const bus = createBus();
    const GnomeGlobalShortcutsPortal = loadPortal(() => bus);
    const portal = new GnomeGlobalShortcutsPortal({ shortcutId: "cancel" });
    respondWith(bus, portal, {
      CreateSession: [0, sessionReply("/org/freedesktop/portal/desktop/session/1")],
      BindShortcuts: [code, []],
    });

    assert.equal(
      await portal.registerKeybinding("Escape", () => undefined),
      GnomeGlobalShortcutsPortal.REGISTRATION[expected]
    );
    assert.equal(portal.sessionHandle, null);
  }
});

function holdSessionClose(bus) {
  const closing = deferred();
  const invoke = bus.invoke;
  bus.invoke = (message, callback) => {
    if (message.member !== "Close") return invoke.call(bus, message, callback);
    closing.promise.then(() => callback(null));
  };
  return closing;
}

test("an unregister while the previous session closes keeps the next registration unbound", async () => {
  const bus = createBus();
  const GnomeGlobalShortcutsPortal = loadPortal(() => bus);
  const portal = new GnomeGlobalShortcutsPortal({ shortcutId: "cancel" });
  await portal.init();
  portal.sessionHandle = "/org/freedesktop/portal/desktop/session/1";
  const closing = holdSessionClose(bus);
  const requests = [];
  portal._request = async (member) => {
    requests.push(member);
    return member === "CreateSession"
      ? sessionReply("/org/freedesktop/portal/desktop/session/2")
      : shortcutsReply("cancel");
  };

  const registration = portal.registerKeybinding("Escape", () => undefined);
  await portal.unregisterKeybinding();
  closing.resolve();

  assert.equal(await registration, GnomeGlobalShortcutsPortal.REGISTRATION.SUPERSEDED);
  assert.deepEqual(requests, []);
  assert.equal(portal.sessionHandle, null);
});

test("closing while a registration waits on the previous session does not reconnect", async () => {
  let connections = 0;
  const bus = createBus();
  const GnomeGlobalShortcutsPortal = loadPortal(() => {
    connections += 1;
    return bus;
  });
  const portal = new GnomeGlobalShortcutsPortal({ shortcutId: "cancel" });
  await portal.init();
  portal.sessionHandle = "/org/freedesktop/portal/desktop/session/1";
  const closing = holdSessionClose(bus);

  const registration = portal.registerKeybinding("Escape", () => undefined);
  await portal.close();
  closing.resolve();

  assert.equal(await registration, GnomeGlobalShortcutsPortal.REGISTRATION.SUPERSEDED);
  assert.equal(connections, 1);
  assert.equal(portal.bus, null);
});

function holdShortcutMatches(bus) {
  const held = deferred();
  const addMatch = bus.addMatch;
  let holding = true;
  bus.addMatch = (match, callback) => {
    if (holding && /member='(Activated|Deactivated)'/.test(match)) {
      held.promise.then(
        () => callback(null),
        (err) => callback(err)
      );
      return;
    }
    addMatch.call(bus, match, callback);
  };
  return {
    held,
    release() {
      holding = false;
    },
  };
}

test("an unregister during listener setup sends no BindShortcuts", async () => {
  const bus = createBus();
  const GnomeGlobalShortcutsPortal = loadPortal(() => bus);
  const portal = new GnomeGlobalShortcutsPortal({ shortcutId: "cancel" });
  const { held } = holdShortcutMatches(bus);
  const requests = [];
  portal._request = async (member) => {
    requests.push(member);
    return member === "CreateSession"
      ? sessionReply("/org/freedesktop/portal/desktop/session/1")
      : shortcutsReply("cancel");
  };

  const registration = portal.registerKeybinding("Escape", () => undefined);
  await new Promise(setImmediate);
  await portal.unregisterKeybinding();
  held.resolve();

  assert.equal(await registration, GnomeGlobalShortcutsPortal.REGISTRATION.SUPERSEDED);
  assert.deepEqual(requests, ["CreateSession"]);
});

test("a superseded registration whose listener setup fails keeps the newer one's listeners", async () => {
  const bus = createBus();
  const GnomeGlobalShortcutsPortal = loadPortal(() => bus);
  const portal = new GnomeGlobalShortcutsPortal();
  const matches = holdShortcutMatches(bus);
  let sessions = 0;
  portal._request = async (member) => {
    if (member !== "CreateSession") return shortcutsReply("dictation");
    sessions += 1;
    return sessionReply(`/org/freedesktop/portal/desktop/session/${sessions}`);
  };
  const phases = [];

  const first = portal.registerKeybinding("ALT+R", () => phases.push("first"));
  await new Promise(setImmediate);
  matches.release();
  assert.equal(
    await portal.registerKeybinding("ALT+R", (_e, phase) => phases.push(phase)),
    GnomeGlobalShortcutsPortal.REGISTRATION.BOUND
  );
  matches.held.reject(new Error('D-Bus call "AddMatch" timed out'));

  assert.equal(await first, GnomeGlobalShortcutsPortal.REGISTRATION.SUPERSEDED);
  bus.signals.emit(shortcutSignal(bus, "Activated"), [
    "/org/freedesktop/portal/desktop/session/2",
    "dictation",
  ]);
  assert.deepEqual(phases, ["down"]);
});

test("callers arriving while the first connection is still open share it", async () => {
  let connections = 0;
  const bus = createBus();
  const connected = deferred();
  const invokeDbus = bus.invokeDbus;
  bus.invokeDbus = (message, callback) => {
    connected.promise.then(() => invokeDbus.call(bus, message, callback));
  };
  const GnomeGlobalShortcutsPortal = loadPortal(() => {
    connections += 1;
    return bus;
  });
  const portal = new GnomeGlobalShortcutsPortal();

  const first = portal.init();
  const second = portal.init();
  connected.resolve();

  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(connections, 1);
});

test("a connection that failed is tried again by the next caller", async () => {
  let connections = 0;
  const GnomeGlobalShortcutsPortal = loadPortal(() => {
    connections += 1;
    const bus = createBus();
    if (connections === 1) bus.invokeDbus = (_message, callback) => callback(new Error("no bus"));
    return bus;
  });
  const portal = new GnomeGlobalShortcutsPortal();

  assert.equal(await portal.init(), false);
  assert.equal(await portal.init(), true);
  assert.equal(connections, 2);
});
