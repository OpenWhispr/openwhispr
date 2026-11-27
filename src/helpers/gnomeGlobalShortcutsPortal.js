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
// The Request.Response code for a dialog the user dismissed or denied.
const USER_CANCELLED_RESPONSE = 1;

const REGISTRATION = Object.freeze({
  BOUND: "bound",
  DECLINED: "declined",
  // An unregister, or a newer registration, took over before this one finished.
  SUPERSEDED: "superseded",
  FAILED: "failed",
});

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
    shortcutId = "dictation",
    descriptionKey = "onboarding.activation.holdDescription",
    callTimeoutMs = DBUS_CALL_TIMEOUT_MS,
    requestTimeoutMs = PORTAL_REQUEST_TIMEOUT_MS,
  } = {}) {
    this.bus = null;
    this.connecting = null;
    this.sessionHandle = null;
    this.callback = null;
    this.available = false;
    this.activationListener = null;
    this.deactivationListener = null;
    this.shortcutId = shortcutId;
    this.descriptionKey = descriptionKey;
    // Bumped by every unregister, so a registration still waiting on the portal
    // knows it was superseded and must not leave its session bound.
    this.generation = 0;
    this.callTimeoutMs = callTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  // One connection attempt at a time: a caller arriving mid-connect would
  // otherwise find the bus half open and report the portal unavailable.
  init() {
    this.connecting ??= this._connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async _connect() {
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

  async registerKeybinding(preferredTrigger, callback) {
    const unregistering = this.unregisterKeybinding();
    const generation = this.generation;
    await unregistering;
    if (generation !== this.generation) return REGISTRATION.SUPERSEDED;
    if (!(await this.init())) return REGISTRATION.FAILED;
    if (generation !== this.generation) return REGISTRATION.SUPERSEDED;
    this.callback = callback;

    try {
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
      const sessionHandle = readDict(session).get("session_handle");
      if (!sessionHandle) throw new Error("Portal did not return a session handle");
      if (generation !== this.generation) {
        await this._closeSession(sessionHandle);
        return REGISTRATION.SUPERSEDED;
      }
      this.sessionHandle = sessionHandle;

      await this._listenForShortcutEvents(generation);
      // The unregister that superseded this registration already closed its session.
      if (generation !== this.generation) return REGISTRATION.SUPERSEDED;
      const bindRequestToken = this._newToken();
      const result = await this._request(
        "BindShortcuts",
        "oa(sa{sv})sa{sv}",
        [
          sessionHandle,
          [
            [
              this.shortcutId,
              vardict([
                ["description", "s", i18nMain.t(this.descriptionKey)],
                ["preferred_trigger", "s", preferredTrigger],
              ]),
            ],
          ],
          "",
          vardict([["handle_token", "s", bindRequestToken]]),
        ],
        bindRequestToken
      );
      if (generation !== this.generation) return REGISTRATION.SUPERSEDED;
      const shortcuts = readDict(result).get("shortcuts") || [];
      if (!shortcuts.some(([id]) => id === this.shortcutId)) {
        throw new Error(`Portal did not bind the ${this.shortcutId} shortcut`);
      }

      debugLogger.log(`[GnomeGlobalShortcutsPortal] ${this.shortcutId} shortcut registered`);
      return REGISTRATION.BOUND;
    } catch (err) {
      debugLogger.log(
        `[GnomeGlobalShortcutsPortal] Failed to register ${this.shortcutId} shortcut:`,
        err.message
      );
      if (generation !== this.generation) return REGISTRATION.SUPERSEDED;
      await this.unregisterKeybinding();
      return err.portalResponse === USER_CANCELLED_RESPONSE
        ? REGISTRATION.DECLINED
        : REGISTRATION.FAILED;
    }
  }

  async unregisterKeybinding() {
    this.generation += 1;
    this._removeShortcutListeners();
    this.callback = null;
    if (!this.sessionHandle || !this.bus) return;

    const sessionHandle = this.sessionHandle;
    this.sessionHandle = null;
    await this._closeSession(sessionHandle);
  }

  async _closeSession(sessionHandle) {
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

  async _listenForShortcutEvents(generation) {
    const bus = this.bus;
    const activationSignal = this.bus.mangle(PORTAL_PATH, GLOBAL_SHORTCUTS_INTERFACE, "Activated");
    const deactivationSignal = this.bus.mangle(
      PORTAL_PATH,
      GLOBAL_SHORTCUTS_INTERFACE,
      "Deactivated"
    );
    this.activationListener = ([sessionHandle, shortcutId]) => {
      if (sessionHandle === this.sessionHandle && shortcutId === this.shortcutId) {
        this.callback?.(undefined, "down");
      }
    };
    this.deactivationListener = ([sessionHandle, shortcutId]) => {
      if (sessionHandle === this.sessionHandle && shortcutId === this.shortcutId) {
        this.callback?.(undefined, "up");
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
      // Once superseded, these listeners are gone and any left belong to the newer registration.
      if (generation === this.generation) this._removeShortcutListeners();
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
        if (response === 0) {
          finish(null, results);
          return;
        }
        const err = new Error(`Portal request was rejected (${response})`);
        err.portalResponse = response;
        finish(err);
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

GnomeGlobalShortcutsPortal.REGISTRATION = REGISTRATION;

module.exports = GnomeGlobalShortcutsPortal;
