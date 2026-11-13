const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

// KGlobalShortcutInfo wire order, from KDE's kglobalshortcutinfo_dbus.cpp:
// action/friendly name, component/friendly name, context/friendly name, keys/default keys.
const shortcut = (component, action = "dictation") => [
  action,
  "Action",
  component,
  "Component",
  "default",
  "Default",
  [],
  [],
];

async function register(owners, queryError = null) {
  const load = Module._load;
  const modulePath = require.resolve("../../src/helpers/kdeShortcut");
  Module._load = function (request, parent, isMain) {
    if (request === "./debugLogger") return { log() {} };
    if (request === "@homebridge/dbus-native")
      return {
        messageType: { methodCall: 1 },
        sessionBus() {
          throw new Error("Real session bus must not be opened");
        },
      };
    return load.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[modulePath];
    const Manager = require(modulePath);
    const manager = new Manager();
    const calls = [];
    const transportErrors = [];
    const actions = [];
    const component = new EventEmitter();
    let presses = 0;
    const key = Manager.convertToQtKeyCode("Control+Shift+H");
    manager.bus = {
      invoke(message, callback) {
        calls.push(message);
        if (queryError) {
          transportErrors.push(queryError);
          callback(queryError);
          return;
        }
        // Public KDE org.kde.KGlobalAccel.xml: getGlobalShortcutsByKey(i).
        // This same compatibility method exists in KF5 and kglobalacceld 6.8.
        if (
          message.member !== "getGlobalShortcutsByKey" ||
          message.signature !== "i" ||
          message.body.length !== 1 ||
          message.body[0] !== key
        ) {
          const error = new Error("No slot matched the method and signature");
          transportErrors.push(error);
          callback(error);
          return;
        }
        callback(null, owners);
      },
      getService() {
        return {
          getInterface(_path, _iface, callback) {
            callback(null, component);
          },
        };
      },
    };
    manager.kglobalaccel = {
      unRegister(id, callback) {
        actions.push(["unRegister", id]);
        callback(null);
      },
      doRegister(id, callback) {
        actions.push(["doRegister", id]);
        callback(null);
      },
      setShortcut(id, keys, flags, callback) {
        actions.push(["setShortcut", id, keys, flags]);
        callback(null, keys);
      },
    };
    const result = await manager.registerKeybinding(
      "Control+Shift+H",
      "dictation",
      () => presses++
    );
    component.emit("globalShortcutPressed", "openwhispr", "dictation", 0);
    return { result, calls, transportErrors, actions, presses, manager };
  } finally {
    Module._load = load;
    delete require.cache[modulePath];
  }
}

test("queries the stable single-key KDE interface before registering a free shortcut", async () => {
  const state = await register([]);
  assert.equal(state.result, true);
  assert.deepEqual(state.transportErrors, []);
  assert.equal(state.calls.length, 1);
  assert.deepEqual(
    state.actions.map((a) => a[0]),
    ["unRegister", "doRegister", "setShortcut"]
  );
  assert.equal(state.actions[2][3], 0x02);
  assert.equal(state.presses, 1);
});

test("refuses another component's shortcut before changing any registration", async () => {
  const state = await register([shortcut("org.kde.kwin", "Expose")]);
  assert.equal(state.result, "conflict");
  assert.deepEqual(state.transportErrors, []);
  assert.deepEqual(state.actions, []);
  assert.equal(state.presses, 0);
});

test("allows its own saved shortcut using the component field rather than the action field", async () => {
  const state = await register([shortcut("openwhispr")]);
  assert.equal(state.result, true);
  assert.deepEqual(state.transportErrors, []);
  assert.equal(state.presses, 1);
});

test("an action called openwhispr still conflicts when its component is someone else", async () => {
  const state = await register([shortcut("org.kde.kwin", "openwhispr")]);
  assert.equal(state.result, "conflict");
  assert.deepEqual(state.actions, []);
});

test("an unavailable conflict-query method does not by itself stop registration", async () => {
  const error = new Error("UnknownMethod: compatibility API disabled");
  const state = await register([], error);
  assert.equal(state.result, true);
  assert.deepEqual(state.transportErrors, [error]);
  assert.deepEqual(
    state.actions.map((action) => action[0]),
    ["unRegister", "doRegister", "setShortcut"]
  );
  assert.equal(state.presses, 1);
});
