const debugLogger = require("./debugLogger");
const { LINUX_APP_NAME } = require("./linuxAutostart");

let dbus = null;
try {
  dbus = require("@homebridge/dbus-native");
} catch (err) {
  debugLogger.warn("Failed to load dbus-native, native notifications unavailable", {
    error: err.message,
  });
}

const APP_NAME = "OpenWhispr";
const NOTIFICATIONS_SERVICE = "org.freedesktop.Notifications";
const NOTIFICATIONS_PATH = "/org/freedesktop/Notifications";
const DBUS_CALL_TIMEOUT_MS = 3000;
const MAX_TEXT_LENGTH = 512;
// Failure backoff, so a daemon that is slow at login gets retried later.
const RETRY_BASE_MS = 30 * 1000;
const RETRY_MAX_MS = 30 * 60 * 1000;

const CLOSE_REASON_EXPIRED = 1;
const CLOSE_REASON_DISMISSED = 2;

const PROMPT_VARIANTS = new Set(["detected", "starting", "underway"]);

function truncate(value) {
  const text = typeof value === "string" ? value : "";
  if (text.length <= MAX_TEXT_LENGTH) return text;
  const cut = text.slice(0, MAX_TEXT_LENGTH);
  // Never end on a dangling high surrogate.
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

// Escape &, <, > for servers that parse the notification body as markup.
function escapeBodyMarkup(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildMeetingPromptContent(promptData, t) {
  const variant = PROMPT_VARIANTS.has(promptData?.variant) ? promptData.variant : "detected";
  const eventSummary =
    typeof promptData?.event?.summary === "string" ? promptData.event.summary.trim() : "";
  // Same rule as MeetingNotificationOverlay: event name only for calendar-backed variants.
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

// Native Linux notifications over the org.freedesktop.Notifications session bus.
class LinuxNotifier {
  constructor({
    platform = process.platform,
    dbusModule = dbus,
    callTimeoutMs = DBUS_CALL_TIMEOUT_MS,
    now = Date.now,
  } = {}) {
    this._platform = platform;
    this._dbus = dbusModule;
    this._callTimeoutMs = callTimeoutMs;
    this._now = now;
    this._failureCount = 0;
    this._retryAt = 0;
    this._bus = null;
    this._iface = null;
    this._connectPromise = null;
    this._capabilities = null;
    this._active = new Map();
  }

  isSupported() {
    return this._platform === "linux" && !!this._dbus && this._now() >= this._retryAt;
  }

  _withTimeout(promise, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  _call(fn, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("D-Bus call timed out"));
      }, timeoutMs);
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

        // A connection error with no handler is an uncaught EventEmitter error.
        bus.connection.on("error", (err) => {
          if (this._bus !== bus) return;
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
            this._iface = iface;
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
    // A rejection may be observed only through _withTimeout races.
    this._connectPromise.catch(() => {});

    return this._connectPromise;
  }

  _onActionInvoked(id, actionKey) {
    const entry = this._active.get(id);
    if (!entry) return;
    const action = actionKey === "default" ? entry.actionKey : actionKey;
    if (action !== entry.actionKey) return;
    // Settle before invoking, so the daemon's follow-up NotificationClosed is a no-op.
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
    const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** this._failureCount);
    this._failureCount = Math.min(this._failureCount + 1, 16);
    this._retryAt = this._now() + backoff;

    // Owners of live notifications must not keep waiting on a dead connection.
    const orphans = [...this._active.values()];
    this._active.clear();
    for (const entry of orphans) {
      try {
        entry.onClose(CLOSE_REASON_EXPIRED);
      } catch (err) {
        debugLogger.error("Notification close handler failed", { error: err.message });
      }
    }

    this._capabilities = null;
    this._connectPromise = null;
    this._iface = null;
    if (this._bus) {
      try {
        this._bus.connection.end();
      } catch {
        // Connection may already be gone.
      }
      this._bus = null;
    }
  }

  // Shows a notification with one primary action, also bound to the default click.
  // Returns { id, close } or null; failures back off and retry later.
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

    const deadline = this._now() + this._callTimeoutMs;
    const remaining = () => Math.max(1, deadline - this._now());

    try {
      const iface = await this._withTimeout(this._connect(), remaining(), "D-Bus connection");

      if (!this._capabilities) {
        this._capabilities = await this._call(iface.GetCapabilities.bind(iface), [], remaining());
      }
      const caps = Array.isArray(this._capabilities) ? this._capabilities : [];
      if (!caps.includes("actions")) {
        throw new Error("Notification server does not support actions");
      }

      const safeBody = caps.includes("body-markup") ? escapeBodyMarkup(body) : body;

      const id = await this._call(
        iface.Notify.bind(iface),
        [
          APP_NAME,
          replacesId >>> 0,
          LINUX_APP_NAME,
          title,
          safeBody,
          ["default", actionLabel, actionKey, actionLabel],
          [
            ["urgency", ["y", 1]],
            ["desktop-entry", ["s", LINUX_APP_NAME]],
          ],
          Math.max(0, Math.trunc(timeoutMs)),
        ],
        remaining()
      );

      this._failureCount = 0;
      this._retryAt = 0;
      this._active.set(id, { actionKey, onAction, onClose });

      return {
        id,
        close: () => {
          // Drop callbacks first, so the reason-3 NotificationClosed that follows is ignored.
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
    if (this._iface) {
      for (const id of this._active.keys()) {
        try {
          this._iface.CloseNotification(id, () => {});
        } catch {
          // Best effort during teardown.
        }
      }
    }
    this._active.clear();
    this._capabilities = null;
    this._connectPromise = null;
    this._iface = null;
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
