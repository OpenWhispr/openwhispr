const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const { i18nMain } = require("./i18nMain");

const PORTAL_SERVICE = "org.freedesktop.portal.Desktop";
const PORTAL_PATH = "/org/freedesktop/portal/desktop";
const GLOBAL_SHORTCUTS_INTERFACE = "org.freedesktop.portal.GlobalShortcuts";
const REQUEST_INTERFACE = "org.freedesktop.portal.Request";
const SESSION_INTERFACE = "org.freedesktop.portal.Session";
const REGISTRY_INTERFACE = "org.freedesktop.host.portal.Registry";
const APP_ID = "open-whispr";
const DBUS_CALL_TIMEOUT_MS = 5000;
const PORTAL_REQUEST_TIMEOUT_MS = 120000;

// What the portal's bind dialog shows next to each shortcut id.
const SHORTCUT_DESCRIPTION_KEYS = {
  dictation: "onboarding.activation.holdDescription",
  voiceAgent: "hotkey.portal.voiceAgentHold",
  translation: "hotkey.portal.translationHold",
};

let dbus = null;

function getDBus() {
  if (dbus) return dbus;
  try {
    dbus = require("@homebridge/dbus-native");
    return dbus;
  } catch (err) {
    debugLogger.log("[GnomeGlobalShortcutsPortal] Failed to load dbus-native:", err.message);
    return null;
  }
}

function vardict(entries = []) {
  return entries.map(([key, signature, value]) => [key, [signature, value]]);
}

function readVariant(value) {
  return Array.isArray(value?.[1]) ? value[1][0] : undefined;
}

function readDict(value) {
  return new Map((value || []).map(([key, variant]) => [key, readVariant(variant)]));
}

class GnomeGlobalShortcutsPortal {
  constructor({
    callTimeoutMs = DBUS_CALL_TIMEOUT_MS,
    requestTimeoutMs = PORTAL_REQUEST_TIMEOUT_MS,
  } = {}) {
    this.bus = null;
    this.sessionHandle = null;
    // shortcut id -> { trigger, callback }. One session carries every Hold
    // slot, because a session binds its shortcuts exactly once: any change to
    // this set means a fresh session bound with the full set.
    this.shortcuts = new Map();
    this._pending = null;
    this.available = false;
    this.activationListener = null;
    this.deactivationListener = null;
    this.callTimeoutMs = callTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async init() {
    if (this.bus) return this.available;

    const dbusModule = getDBus();
    if (!dbusModule) return false;

    try {
      this.bus = dbusModule.sessionBus();
      this.bus.connection.on("error", (err) => {
        debugLogger.log("[GnomeGlobalShortcutsPortal] D-Bus connection error:", err.message);
      });
      await this._invokeDbus({ member: "GetId" });
      if (!process.env.FLATPAK_ID) {
        await this._invoke({
          destination: PORTAL_SERVICE,
          path: PORTAL_PATH,
          interface: REGISTRY_INTERFACE,
          member: "Register",
          signature: "sa{sv}",
          body: [APP_ID, vardict()],
        });
      }
      const version = await this._invoke({
        destination: PORTAL_SERVICE,
        path: PORTAL_PATH,
        interface: "org.freedesktop.DBus.Properties",
        member: "Get",
        signature: "ss",
        body: [GLOBAL_SHORTCUTS_INTERFACE, "version"],
      });
      this.available = Number(readVariant(version)) >= 1;
      if (!this.available) await this.close();
      return this.available;
    } catch (err) {
      debugLogger.log(
        "[GnomeGlobalShortcutsPortal] Global Shortcuts portal unavailable:",
        err.message
      );
      await this.close();
      return false;
    }
  }

  isAvailable() {
    return this.available;
  }

  // Register (or replace) one slot's shortcut. Serialised with every other
  // register/unregister so two callers can never race two sessions into life.
  registerKeybinding(preferredTrigger, callback, shortcutId = "dictation") {
    return this._serialize(async () => {
      if (!(await this.init())) return false;

      this.shortcuts.set(shortcutId, { trigger: preferredTrigger, callback });
      try {
        await this._bindAll();
        debugLogger.log(`[GnomeGlobalShortcutsPortal] "${shortcutId}" shortcut registered`);
        return true;
      } catch (err) {
        debugLogger.log(
          `[GnomeGlobalShortcutsPortal] Failed to register "${shortcutId}" shortcut:`,
          err.message
        );
        // Keep the slots that did bind; only the refused one is dropped.
        this.shortcuts.delete(shortcutId);
        await this._bindAll().catch(() => this._closeSession());
        return false;
      }
    });
  }

  // Drop one slot's shortcut; with no id, drop every shortcut and the session.
  unregisterKeybinding(shortcutId) {
    return this._serialize(async () => {
      if (shortcutId === undefined) {
        this.shortcuts.clear();
        await this._closeSession();
        return;
      }
      if (!this.shortcuts.delete(shortcutId)) return;
      try {
        await this._bindAll();
      } catch (err) {
        debugLogger.log(
          `[GnomeGlobalShortcutsPortal] Rebind after dropping "${shortcutId}" failed:`,
          err.message
        );
        await this._closeSession();
      }
    });
  }

  // Run tasks one at a time. An idle queue starts the task right away (its
  // first D-Bus call goes out synchronously); a busy one chains behind the
  // task in flight.
  _serialize(task) {
    const previous = this._pending;
    const run = previous ? previous.then(task, task) : (async () => task())();
    const settled = run
      .catch(() => undefined)
      .then(() => {
        if (this._pending === settled) this._pending = null;
      });
    this._pending = settled;
    return run;
  }

  // Replace the session with one bound to the current shortcut set. Throws
  // when the portal binds fewer shortcuts than asked.
  async _bindAll() {
    await this._closeSession();
    if (this.shortcuts.size === 0) return;

    const sessionToken = this._newToken();
    const createRequestToken = this._newToken();
    const session = await this._request(
      "CreateSession",
      "a{sv}",
      [
        vardict([
          ["handle_token", "s", createRequestToken],
          ["session_handle_token", "s", sessionToken],
        ]),
      ],
      createRequestToken
    );
    this.sessionHandle = readDict(session).get("session_handle");
    if (!this.sessionHandle) throw new Error("Portal did not return a session handle");

    await this._listenForShortcutEvents();
    const bindRequestToken = this._newToken();
    const entries = [...this.shortcuts].map(([id, { trigger }]) => [
      id,
      vardict([
        [
          "description",
          "s",
          i18nMain.t(SHORTCUT_DESCRIPTION_KEYS[id] || SHORTCUT_DESCRIPTION_KEYS.dictation),
        ],
        ["preferred_trigger", "s", trigger],
      ]),
    ]);
    const result = await this._request(
      "BindShortcuts",
      "oa(sa{sv})sa{sv}",
      [this.sessionHandle, entries, "", vardict([["handle_token", "s", bindRequestToken]])],
      bindRequestToken
    );
    const bound = new Set((readDict(result).get("shortcuts") || []).map(([id]) => id));
    const missing = [...this.shortcuts.keys()].filter((id) => !bound.has(id));
    if (missing.length > 0) {
      throw new Error(`Portal did not bind: ${missing.join(", ")}`);
    }
  }

  async _closeSession() {
    this._removeShortcutListeners();
    if (!this.sessionHandle || !this.bus) {
      this.sessionHandle = null;
      return;
    }

    const sessionHandle = this.sessionHandle;
    this.sessionHandle = null;
    try {
      await this._invoke({
        destination: PORTAL_SERVICE,
        path: sessionHandle,
        interface: SESSION_INTERFACE,
        member: "Close",
      });
    } catch (err) {
      debugLogger.log("[GnomeGlobalShortcutsPortal] Failed to close session:", err.message);
    }
  }

  async close() {
    await this.unregisterKeybinding();
    const bus = this.bus;
    this.bus = null;
    this.available = false;
    bus?.connection.end();
  }

  async _listenForShortcutEvents() {
    const bus = this.bus;
    const activationSignal = this.bus.mangle(PORTAL_PATH, GLOBAL_SHORTCUTS_INTERFACE, "Activated");
    const deactivationSignal = this.bus.mangle(
      PORTAL_PATH,
      GLOBAL_SHORTCUTS_INTERFACE,
      "Deactivated"
    );
    this.activationListener = ([sessionHandle, shortcutId]) => {
      if (sessionHandle === this.sessionHandle) {
        this.shortcuts.get(shortcutId)?.callback?.(undefined, "down");
      }
    };
    this.deactivationListener = ([sessionHandle, shortcutId]) => {
      if (sessionHandle === this.sessionHandle) {
        this.shortcuts.get(shortcutId)?.callback?.(undefined, "up");
      }
    };
    bus.signals.on(activationSignal, this.activationListener);
    bus.signals.on(deactivationSignal, this.deactivationListener);
    try {
      await Promise.all([
        this._addMatch(this._shortcutMatch("Activated")),
        this._addMatch(this._shortcutMatch("Deactivated")),
      ]);
    } catch (err) {
      this._removeShortcutListeners();
      throw err;
    }
  }

  _removeShortcutListeners() {
    if (!this.bus) return;
    if (this.activationListener) {
      this.bus.signals.removeListener(
        this.bus.mangle(PORTAL_PATH, GLOBAL_SHORTCUTS_INTERFACE, "Activated"),
        this.activationListener
      );
      this.activationListener = null;
      this.bus.removeMatch(this._shortcutMatch("Activated"), () => {});
    }
    if (this.deactivationListener) {
      this.bus.signals.removeListener(
        this.bus.mangle(PORTAL_PATH, GLOBAL_SHORTCUTS_INTERFACE, "Deactivated"),
        this.deactivationListener
      );
      this.deactivationListener = null;
      this.bus.removeMatch(this._shortcutMatch("Deactivated"), () => {});
    }
  }

  async _request(member, signature, body, token) {
    const bus = this.bus;
    const requestPath = this._requestPath(token);
    const signal = bus.mangle(requestPath, REQUEST_INTERFACE, "Response");
    const match = `type='signal',sender='${PORTAL_SERVICE}',path='${requestPath}',interface='${REQUEST_INTERFACE}',member='Response'`;
    await this._addMatch(match);

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId;
      const cleanup = () => {
        clearTimeout(timeoutId);
        bus.signals.removeListener(signal, onResponse);
        try {
          bus.removeMatch(match, () => undefined);
        } catch {}
      };
      const finish = (err, result) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err);
        else resolve(result);
      };
      const onResponse = ([response, results]) => {
        if (response === 0) finish(null, results);
        else finish(new Error(`Portal request was rejected (${response})`));
      };
      bus.signals.once(signal, onResponse);
      timeoutId = setTimeout(
        () => finish(new Error(`Portal request "${member}" timed out`)),
        this.requestTimeoutMs
      );
      timeoutId.unref?.();
      bus.invoke(
        {
          destination: PORTAL_SERVICE,
          path: PORTAL_PATH,
          interface: GLOBAL_SHORTCUTS_INTERFACE,
          member,
          signature,
          body,
        },
        (err) => {
          if (!err) return;
          finish(err);
        }
      );
    });
  }

  _invoke(message) {
    return this._callWithTimeout(message.member, (callback) => this.bus.invoke(message, callback));
  }

  _invokeDbus(message) {
    return this._callWithTimeout(message.member, (callback) =>
      this.bus.invokeDbus(message, callback)
    );
  }

  _addMatch(match) {
    return this._callWithTimeout("AddMatch", (callback) => this.bus.addMatch(match, callback));
  }

  _callWithTimeout(member, invoke) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (err) reject(err);
        else resolve(result);
      };
      const timeoutId = setTimeout(
        () => finish(new Error(`D-Bus call "${member}" timed out`)),
        this.callTimeoutMs
      );
      timeoutId.unref?.();
      try {
        invoke(finish);
      } catch (err) {
        finish(err);
      }
    });
  }

  _newToken() {
    return `openwhispr_${crypto.randomUUID().replace(/-/g, "_")}`;
  }

  _requestPath(token) {
    const sender = this.bus.name.slice(1).replace(/\./g, "_");
    return `/org/freedesktop/portal/desktop/request/${sender}/${token}`;
  }

  _shortcutMatch(member) {
    return `type='signal',sender='${PORTAL_SERVICE}',interface='${GLOBAL_SHORTCUTS_INTERFACE}',member='${member}'`;
  }
}

module.exports = GnomeGlobalShortcutsPortal;
