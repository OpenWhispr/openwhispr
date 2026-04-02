const debugLogger = require("./debugLogger");

let dbus = null;

function getDBus() {
  if (dbus) return dbus;
  try {
    dbus = require("dbus-next");
    return dbus;
  } catch (err) {
    debugLogger.log("[KDEShortcut] Failed to load dbus-next:", err.message);
    return null;
  }
}

// Qt::Key and Qt::KeyboardModifier values for KGlobalAccel
const QT_MODIFIERS = {
  control: 0x04000000,
  ctrl: 0x04000000,
  alt: 0x08000000,
  shift: 0x02000000,
  super: 0x10000000,
  meta: 0x10000000,
  commandorcontrol: 0x04000000,
};

const QT_KEYS = {
  a: 0x41,
  b: 0x42,
  c: 0x43,
  d: 0x44,
  e: 0x45,
  f: 0x46,
  g: 0x47,
  h: 0x48,
  i: 0x49,
  j: 0x4a,
  k: 0x4b,
  l: 0x4c,
  m: 0x4d,
  n: 0x4e,
  o: 0x4f,
  p: 0x50,
  q: 0x51,
  r: 0x52,
  s: 0x53,
  t: 0x54,
  u: 0x55,
  v: 0x56,
  w: 0x57,
  x: 0x58,
  y: 0x59,
  z: 0x5a,
  0: 0x30,
  1: 0x31,
  2: 0x32,
  3: 0x33,
  4: 0x34,
  5: 0x35,
  6: 0x36,
  7: 0x37,
  8: 0x38,
  9: 0x39,
  f1: 0x01000030,
  f2: 0x01000031,
  f3: 0x01000032,
  f4: 0x01000033,
  f5: 0x01000034,
  f6: 0x01000035,
  f7: 0x01000036,
  f8: 0x01000037,
  f9: 0x01000038,
  f10: 0x01000039,
  f11: 0x0100003a,
  f12: 0x0100003b,
  space: 0x20,
  tab: 0x01000001,
  escape: 0x01000000,
  backspace: 0x01000003,
  enter: 0x01000005,
  return: 0x01000004,
  insert: 0x01000006,
  delete: 0x01000007,
  home: 0x01000010,
  end: 0x01000011,
  pageup: 0x01000016,
  pagedown: 0x01000017,
  up: 0x01000013,
  down: 0x01000015,
  left: 0x01000012,
  right: 0x01000014,
  "`": 0x60,
  grave: 0x60,
  print: 0x01000009,
  scrolllock: 0x01000026,
  pause: 0x01000008,
};

const COMPONENT_NAME = "openwhispr";

class KDEShortcutManager {
  constructor() {
    this.bus = null;
    this.kglobalaccel = null;
    this.componentProxy = null;
    this.callbacks = new Map();
    this.registeredSlots = new Set();
  }

  static isKDE() {
    const desktop = (process.env.XDG_CURRENT_DESKTOP || "").toLowerCase();
    return desktop.includes("kde");
  }

  static isWayland() {
    return process.env.XDG_SESSION_TYPE === "wayland";
  }

  static convertToQtKeyCode(electronHotkey) {
    const parts = electronHotkey.split("+");
    let qtKey = 0;

    for (const part of parts) {
      const lower = part.toLowerCase().trim();
      if (QT_MODIFIERS[lower]) {
        qtKey |= QT_MODIFIERS[lower];
      } else {
        const key = QT_KEYS[lower] || QT_KEYS[lower.replace("arrow", "")];
        if (key) {
          qtKey |= key;
        } else {
          debugLogger.log(`[KDEShortcut] Unknown key: "${part}"`);
          return null;
        }
      }
    }

    return qtKey;
  }

  async init() {
    const dbusModule = getDBus();
    if (!dbusModule) return false;

    try {
      this.bus = dbusModule.sessionBus();
      const proxy = await this.bus.getProxyObject("org.kde.kglobalaccel", "/kglobalaccel");
      this.kglobalaccel = proxy.getInterface("org.kde.KGlobalAccel");

      debugLogger.log("[KDEShortcut] Connected to KGlobalAccel D-Bus");
      return true;
    } catch (err) {
      debugLogger.log("[KDEShortcut] Failed to connect:", err.message);
      this.bus = null;
      this.kglobalaccel = null;
      return false;
    }
  }

  async _listenForComponent() {
    if (this.componentProxy) return true;

    try {
      const componentPath = `/component/${COMPONENT_NAME}`;
      const proxy = await this.bus.getProxyObject("org.kde.kglobalaccel", componentPath);
      const iface = proxy.getInterface("org.kde.kglobalaccel.Component");

      iface.on("globalShortcutPressed", (componentUnique, shortcutUnique, timestamp) => {
        debugLogger.log("[KDEShortcut] Shortcut pressed", { componentUnique, shortcutUnique });
        // Tested on KDE Plasma 6 (Fedora 43): signal sends the actionFriendly
        // name ("OpenWhispr") not the actionUnique ("dictation"). The fallback
        // maps friendly names back to slot names.
        const callback =
          this.callbacks.get(shortcutUnique) || this._findCallbackByFriendlyName(shortcutUnique);
        if (callback) {
          callback();
        } else {
          debugLogger.log("[KDEShortcut] No callback found for", {
            shortcutUnique,
            registered: [...this.callbacks.keys()],
          });
        }
      });

      this.componentProxy = iface;
      debugLogger.log("[KDEShortcut] Listening for globalShortcutPressed on", componentPath);
      return true;
    } catch (err) {
      debugLogger.log("[KDEShortcut] Failed to listen on component:", err.message);
      return false;
    }
  }

  _findCallbackByFriendlyName(name) {
    // Map friendly names back to slot names
    const friendlyToSlot = {};
    for (const slotName of this.registeredSlots) {
      friendlyToSlot[`OpenWhispr ${slotName}`] = slotName;
      friendlyToSlot[`OpenWhispr`] = "dictation"; // legacy compat
    }
    const slotName = friendlyToSlot[name];
    return slotName ? this.callbacks.get(slotName) : null;
  }

  setAgentCallback(callback) {
    this.callbacks.set("agent", callback);
    debugLogger.log("[KDEShortcut] Agent callback set");
  }

  async registerKeybinding(electronHotkey, slotName = "dictation", callback) {
    if (!this.kglobalaccel) return false;

    const qtKey = KDEShortcutManager.convertToQtKeyCode(electronHotkey);
    if (qtKey === null) {
      debugLogger.log(`[KDEShortcut] Could not convert "${electronHotkey}" to Qt key code`);
      return false;
    }

    // actionId: [componentUnique, componentFriendly, actionUnique, actionFriendly]
    const actionId = [COMPONENT_NAME, "OpenWhispr", slotName, `OpenWhispr ${slotName}`];

    try {
      // Register action then set shortcut
      await this.kglobalaccel.doRegister(actionId);
      const result = await this.kglobalaccel.setShortcut(actionId, [qtKey], 0x02);

      if (callback) this.callbacks.set(slotName, callback);
      this.registeredSlots.add(slotName);

      // Start listening for press events on the component
      const listening = await this._listenForComponent();
      if (!listening) {
        debugLogger.log(
          `[KDEShortcut] Keybinding registered but listener failed for "${slotName}"`
        );
        return false;
      }

      debugLogger.log("[KDEShortcut] Registered", {
        slot: slotName,
        hotkey: electronHotkey,
        qtKey: `0x${qtKey.toString(16)}`,
        result,
      });
      return true;
    } catch (err) {
      debugLogger.log(`[KDEShortcut] Registration failed for "${slotName}":`, err.message);
      return false;
    }
  }

  async unregisterKeybinding(slotName = "dictation") {
    if (!this.kglobalaccel) return;

    const actionId = [COMPONENT_NAME, "OpenWhispr", slotName, `OpenWhispr ${slotName}`];

    try {
      await this.kglobalaccel.unRegister(actionId);
      this.callbacks.delete(slotName);
      this.registeredSlots.delete(slotName);
      debugLogger.log("[KDEShortcut] Unregistered", { slot: slotName });
    } catch (err) {
      debugLogger.log(`[KDEShortcut] Unregister failed for "${slotName}":`, err.message);
    }
  }

  close() {
    // Best-effort cleanup on app shutdown. unRegister calls are async D-Bus
    // calls that may not complete before disconnect, but KGlobalAccel will
    // clean up stale registrations from dead processes anyway.
    const promises = [];
    for (const slotName of this.registeredSlots) {
      const actionId = [COMPONENT_NAME, "OpenWhispr", slotName, `OpenWhispr ${slotName}`];
      try {
        promises.push(this.kglobalaccel?.unRegister(actionId));
      } catch {}
    }

    Promise.allSettled(promises).finally(() => {
      if (this.bus) {
        try {
          this.bus.disconnect();
        } catch {}
        this.bus = null;
        this.kglobalaccel = null;
        this.componentProxy = null;
      }
    });

    this.callbacks.clear();
    this.registeredSlots.clear();
  }
}

module.exports = KDEShortcutManager;
