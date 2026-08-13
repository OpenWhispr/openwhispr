const debugLogger = require("./debugLogger");

let dbus = null;
try {
  dbus = require("@homebridge/dbus-native");
} catch (err) {
  debugLogger.warn("Failed to load dbus-native, native notifications unavailable", {
    error: err.message,
  });
}

const APP_NAME = "OpenWhispr";
// Icon and desktop-entry match the executable name electron-builder packages
// under (see linuxAutostart.js), so daemons resolve the installed icon and
// apply the user's per-app notification settings.
const LINUX_APP_ID = "open-whispr";
const NOTIFICATIONS_SERVICE = "org.freedesktop.Notifications";
const NOTIFICATIONS_PATH = "/org/freedesktop/Notifications";
const DBUS_CALL_TIMEOUT_MS = 3000;
const MAX_TEXT_LENGTH = 512;

const CLOSE_REASON_EXPIRED = 1;
const CLOSE_REASON_DISMISSED = 2;

const PROMPT_VARIANTS = new Set(["detected", "starting", "underway"]);

function truncate(value) {
  const text = typeof value === "string" ? value : "";
  return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
}

// Servers advertising body-markup parse the body as XML-ish markup, so literal
// &, <, > must be entity-escaped to display as typed.
function escapeBodyMarkup(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildMeetingPromptContent(promptData, t) {
  const variant = PROMPT_VARIANTS.has(promptData?.variant) ? promptData.variant : "detected";
  const eventSummary =
    typeof promptData?.event?.summary === "string" ? promptData.event.summary.trim() : "";
  // Mirrors MeetingNotificationOverlay: calendar-backed prompts lead with the
  // event name, mic-only detections with the generic title.
  const title = truncate(
    (variant !== "detected" && eventSummary) || t("meetingNotification.title")
  );
  const body = truncate(t(`meetingNotification.body.${variant}`));
  const actionKey = promptData?.joinUrl ? "join" : "start";
  const actionLabel = truncate(
    t(promptData?.joinUrl ? "meetingNotification.join" : "meetingNotification.start")
  );
  return { title, body, actionKey, actionLabel };
}

function buildUpdatePromptContent(info, t) {
  return {
    title: truncate(t("updateNotification.title")),
    body: truncate(t("updateNotification.body", { version: info?.version ?? "" })),
    actionKey: "update",
    actionLabel: truncate(t("updateNotification.cta")),
  };
}

// Native Linux notifications over the org.freedesktop.Notifications D-Bus
// interface (the protocol behind notify-send/libnotify). See #1599.
class LinuxNotifier {
  constructor({
    platform = process.platform,
    dbusModule = dbus,
    callTimeoutMs = DBUS_CALL_TIMEOUT_MS,
  } = {}) {
    this._platform = platform;
    this._dbus = dbusModule;
    this._callTimeoutMs = callTimeoutMs;
    this._broken = false;
    this._bus = null;
    this._connectPromise = null;
    this._capabilities = null;
    this._active = new Map();
  }

  isSupported() {
    return this._platform === "linux" && !!this._dbus && !this._broken;
  }

  // Wraps a callback-style D-Bus call with a deadline: a hung daemon must fail
  // the native path so the caller can fall back to the overlay.
  _call(fn, ...args) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("D-Bus call timed out"));
      }, this._callTimeoutMs);
      try {
        fn(...args, (err, result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) reject(err instanceof Error ? err : new Error(String(err)));
          else resolve(result);
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      }
    });
  }

  _connect() {
    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("D-Bus connection timed out"));
      }, this._callTimeoutMs);

      try {
        const bus = this._dbus.sessionBus();
        if (!bus) throw new Error("No session bus available");
        this._bus = bus;

        // Without this handler a dropped connection raises an uncaught
        // EventEmitter error and takes the whole main process down.
        bus.connection.on("error", (err) => {
          debugLogger.warn("Notification D-Bus connection error", { error: err.message });
          this._markBroken();
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        });

        bus
          .getService(NOTIFICATIONS_SERVICE)
          .getInterface(NOTIFICATIONS_PATH, NOTIFICATIONS_SERVICE, (err, iface) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
              return;
            }
            iface.on("ActionInvoked", (id, actionKey) => this._onActionInvoked(id, actionKey));
            iface.on("NotificationClosed", (id, reason) => this._onClosed(id, reason));
            resolve(iface);
          });
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      }
    });

    return this._connectPromise;
  }

  _onActionInvoked(id, actionKey) {
    const entry = this._active.get(id);
    if (!entry) return;
    const action = actionKey === "default" ? entry.actionKey : actionKey;
    if (action !== entry.actionKey) return;
    // Settle before invoking: the daemon follows up with NotificationClosed,
    // which must not also fire the dismiss path.
    this._active.delete(id);
    try {
      entry.onAction(action);
    } catch (err) {
      debugLogger.error("Notification action handler failed", { error: err.message });
    }
  }

  _onClosed(id, reason) {
    const entry = this._active.get(id);
    if (!entry) return;
    this._active.delete(id);
    if (reason !== CLOSE_REASON_EXPIRED && reason !== CLOSE_REASON_DISMISSED) return;
    try {
      entry.onClose(reason);
    } catch (err) {
      debugLogger.error("Notification close handler failed", { error: err.message });
    }
  }

  _markBroken() {
    this._broken = true;
    this._active.clear();
  }

  // Shows a native notification with one primary action (also bound to the
  // notification's default click). Returns { id, close } or null on any
  // failure, after which the notifier stays unavailable for the session.
  async show({
    title,
    body,
    actionKey,
    actionLabel,
    timeoutMs,
    replacesId = 0,
    onAction,
    onClose,
  }) {
    if (!this.isSupported()) return null;

    try {
      const iface = await this._connect();

      if (!this._capabilities) {
        this._capabilities = await this._call(iface.GetCapabilities.bind(iface));
      }
      const caps = Array.isArray(this._capabilities) ? this._capabilities : [];
      if (!caps.includes("actions")) {
        throw new Error("Notification server does not support actions");
      }

      const safeBody = caps.includes("body-markup") ? escapeBodyMarkup(body) : body;

      const id = await this._call(
        iface.Notify.bind(iface),
        APP_NAME,
        replacesId >>> 0,
        LINUX_APP_ID,
        title,
        safeBody,
        ["default", actionLabel, actionKey, actionLabel],
        [
          ["urgency", ["y", 1]],
          ["desktop-entry", ["s", LINUX_APP_ID]],
        ],
        Math.max(0, Math.trunc(timeoutMs))
      );

      const entry = { actionKey, onAction, onClose };
      this._active.set(id, entry);

      return {
        id,
        close: () => {
          // Drop callbacks first so the reason-3 NotificationClosed that
          // follows our CloseNotification is ignored.
          this._active.delete(id);
          try {
            iface.CloseNotification(id, () => {});
          } catch (err) {
            debugLogger.warn("CloseNotification failed", { error: err.message });
          }
        },
      };
    } catch (err) {
      debugLogger.warn("Native notification failed, falling back to overlay", {
        error: err.message,
      });
      this._markBroken();
      return null;
    }
  }

  stop() {
    this._active.clear();
    this._capabilities = null;
    this._connectPromise = null;
    if (this._bus) {
      try {
        this._bus.connection.end();
      } catch {
        // Connection may already be gone.
      }
      this._bus = null;
    }
  }
}

const linuxNotifier = new LinuxNotifier();

module.exports = {
  linuxNotifier,
  LinuxNotifier,
  buildMeetingPromptContent,
  buildUpdatePromptContent,
  CLOSE_REASON_EXPIRED,
  CLOSE_REASON_DISMISSED,
};
