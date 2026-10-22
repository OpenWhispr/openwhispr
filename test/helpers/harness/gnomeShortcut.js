// Loads gnomeShortcut.js against a fake gsettings (no custom keybindings to
// start with; every write recorded) and a fake D-Bus session, for suites that
// check what the manager registers.
const childProcess = require("node:child_process");
const Module = require("node:module");

const modulePath = require.resolve("../../../src/helpers/gnomeShortcut");
const ENV_KEYS = ["OPENWHISPR_CHANNEL", "XDG_CURRENT_DESKTOP"];
const KEYBINDINGS = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings";
const SCHEMA = "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding";

function loadGnomeShortcut() {
  const writes = [];
  const execFileSync = (command, args) => {
    if (command !== "gsettings") return "";
    if (args[0] === "get") return "@as []\n";
    if (args[0] === "set") writes.push(args.slice(1));
    return "";
  };
  const originalLoad = Module._load;
  delete require.cache[modulePath];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "child_process") return { ...childProcess, execFileSync };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return { GnomeShortcutManager: require(modulePath), writes };
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
  }
}

// Runs fn on GNOME with the given env, restoring it afterwards.
function onGnome(env, fn) {
  return async () => {
    const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    Object.assign(process.env, { XDG_CURRENT_DESKTOP: "GNOME" }, env);
    try {
      await fn();
    } finally {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  };
}

// The name, binding and command written for one keybinding path.
const keybindingWrites = (writes, name) =>
  Object.fromEntries(
    writes
      .filter(([schema]) => schema === `${SCHEMA}:${KEYBINDINGS}/${name}/`)
      .map(([, key, value]) => [key, value])
  );

const wroteKeybinding = (writes, name) =>
  writes.some(([schema]) => schema === `${SCHEMA}:${KEYBINDINGS}/${name}/`);

// Starts the manager's D-Bus service on a fake session bus and reports the
// name it asked for and the interface it exported.
async function startDBusService(manager, dictationCallback = () => {}) {
  const bus = { requestedName: null, methods: null, iface: null };
  const dbusModule = {
    sessionBus: () => ({
      connection: { on() {}, end() {} },
      requestName(name) {
        bus.requestedName = name;
      },
      exportInterface(methods, _path, iface) {
        bus.methods = methods;
        bus.iface = iface;
      },
    }),
  };
  const previousLoad = Module._load;
  Module._load = function loadDbusMock(request, parent, isMain) {
    if (request === "@homebridge/dbus-native") return dbusModule;
    return previousLoad.call(this, request, parent, isMain);
  };
  try {
    bus.started = await manager.initDBusService(dictationCallback);
  } finally {
    Module._load = previousLoad;
  }
  return bus;
}

module.exports = {
  loadGnomeShortcut,
  onGnome,
  keybindingWrites,
  wroteKeybinding,
  startDBusService,
};
