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
    // One entry per bound row. BindShortcuts takes a(sa{sv}) - an array of
    // (id, options) - and Activated/Deactivated both report the shortcut id,
    // so multi-binding with owner identity is protocol-native. Only the single
    // callback field and the literal "dictation" id ever blocked it.
    this.callbacks = new Map();
    this.triggers = new Map();
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

  /**
   * Binds every row in ONE portal session. BindShortcuts takes a(sa{sv}), so
   * the whole set goes in a single call: registering rows one at a time tore
   * down the previous session and left only the last row bound.
   *
   * `entries` is [{ bindingId, preferredTrigger, callback }].
   */
  async registerKeybindings(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return false;
    if (!(await this.init())) return false;

    // The portal has no per-shortcut unbind, so binding a new set means ending
    // the old session first. If that Close was NOT confirmed, the old session
    // may still be alive and holding the user's keys: opening a second session
    // here would overwrite the only handle that can close it and report
    // success over an unresolved native binding. Refuse instead, leaving the
    // existing callbacks and listeners in place so the surviving session's
    // events still reach their rows.
    if (!(await this.unregisterKeybinding())) {
      debugLogger.log(
        "[GnomeGlobalShortcutsPortal] Refusing to bind: the previous session would not close"
      );
      return false;
    }
    for (const { bindingId, callback, preferredTrigger } of entries) {
      this.callbacks.set(bindingId, callback);
      this.triggers.set(bindingId, preferredTrigger);
    }

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
      this.sessionHandle = readDict(session).get("session_handle");
      if (!this.sessionHandle) throw new Error("Portal did not return a session handle");

      await this._listenForShortcutEvents();
      const bindRequestToken = this._newToken();
      const result = await this._request(
        "BindShortcuts",
        "oa(sa{sv})sa{sv}",
        [
          this.sessionHandle,
          entries.map(({ bindingId, preferredTrigger }) => [
            bindingId,
            vardict([
              ["description", "s", i18nMain.t("onboarding.activation.holdDescription")],
              ["preferred_trigger", "s", preferredTrigger],
            ]),
          ]),
          "",
          vardict([["handle_token", "s", bindRequestToken]]),
        ],
        bindRequestToken
      );
      const shortcuts = readDict(result).get("shortcuts") || [];
      const bound = new Set(shortcuts.map(([id]) => id));
      // All or nothing: a half-bound set would leave rows silently dead.
      const missing = entries.filter(({ bindingId }) => !bound.has(bindingId));
      if (missing.length > 0) {
        throw new Error(
          `Portal did not bind: ${missing.map((entry) => entry.bindingId).join(", ")}`
        );
      }

      debugLogger.log("[GnomeGlobalShortcutsPortal] Bound shortcuts", {
        ids: entries.map(({ bindingId }) => bindingId),
      });
      return true;
    } catch (err) {
      debugLogger.log("[GnomeGlobalShortcutsPortal] Failed to bind shortcuts:", err.message);
      await this.unregisterKeybinding();
      return false;
    }
  }

  async registerKeybinding(preferredTrigger, callback, bindingId = "dictation") {
    // Rebinding one row re-binds every row this session already holds.
    // Binding them one at a time used to recreate the session and leave only
    // the last row alive.
    const union = [...this.callbacks.keys()]
      .filter((id) => id !== bindingId && this.triggers.has(id))
      .map((id) => ({
        bindingId: id,
        preferredTrigger: this.triggers.get(id),
        callback: this.callbacks.get(id),
      }));
    return this.registerKeybindings([...union, { bindingId, preferredTrigger, callback }]);
  }

  /**
   * Releases one binding, or all of them when no id is given.
   *
   * NOTE: the portal has no per-shortcut unbind — ending the session is the
   * only way to drop a binding, so even a single-id release closes the session
   * and unbinds EVERY row. The callback and trigger maps keep the survivors so
   * the usual release-all-then-register-all flow rebuilds them, but a caller
   * that releases one binding and does NOT re-register must expect the other
   * rows to be gone from the compositor until it does.
   */
  async unregisterKeybinding(bindingId = null) {
    if (!this.sessionHandle || !this.bus) {
      this._forgetBindings(bindingId);
      return true;
    }

    const sessionHandle = this.sessionHandle;
    try {
      await this._invoke({
        destination: PORTAL_SERVICE,
        path: sessionHandle,
        interface: SESSION_INTERFACE,
        member: "Close",
      });
    } catch (err) {
      // Nothing is torn down on an unconfirmed Close. The session may still be
      // alive and holding every binding, so the handle is kept for a later
      // attempt and the callbacks and signal listeners stay attached — a row
      // whose key the compositor still delivers must still reach its owner,
      // and a release in flight must still be able to stop a recording.
      debugLogger.log("[GnomeGlobalShortcutsPortal] Failed to close session:", err.message);
      return false;
    }
    this.sessionHandle = null;
    this._forgetBindings(bindingId);
    return true;
  }

  // Drops routing state for one binding, or all of them. Only ever called once
  // the compositor has confirmed it no longer holds the keys.
  _forgetBindings(bindingId = null) {
    this._removeShortcutListeners();
    if (bindingId) {
      this.callbacks.delete(bindingId);
      this.triggers.delete(bindingId);
    } else {
      this.callbacks.clear();
      this.triggers.clear();
    }
  }

  async close() {
    await this.unregisterKeybinding();
    const bus = this.bus;
    this.bus = null;
    this.available = false;
    bus?.connection.end();
    // Dropping the connection ends every session it owns, so this is the one
    // place that may forget bindings a refused Close left behind.
    this.sessionHandle = null;
    this.activationListener = null;
    this.deactivationListener = null;
    this.callbacks.clear();
    this.triggers.clear();
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
      if (sessionHandle !== this.sessionHandle) return;
      this.callbacks.get(shortcutId)?.(shortcutId, "down");
    };
    this.deactivationListener = ([sessionHandle, shortcutId]) => {
      if (sessionHandle !== this.sessionHandle) return;
      // Release is never gated: the row that started a hold must always be
      // able to end it, or the mic stays open until the safety timeout.
      this.callbacks.get(shortcutId)?.(shortcutId, "up");
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
