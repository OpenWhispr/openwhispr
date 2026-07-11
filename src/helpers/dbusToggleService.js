const debugLogger = require("./debugLogger");

const DBUS_SERVICE_NAME = "com.openwhispr.App";
const DBUS_OBJECT_PATH = "/com/openwhispr/App";
const DBUS_INTERFACE = "com.openwhispr.App";

// @homebridge/dbus-native is a lower-level binding than dbus-next and does not
// export named enums, so use the numeric RequestName flags/replies from the
// D-Bus spec directly.
// https://dbus.freedesktop.org/doc/dbus-specification.html#bus-messages-request-name
const DBUS_NAME_FLAG_DO_NOT_QUEUE = 0x4;
const DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER = 1;
const DBUS_REQUEST_NAME_REPLY_ALREADY_OWNER = 4;

let dbus = null;

function getDBus() {
  if (dbus) return dbus;
  try {
    dbus = require("@homebridge/dbus-native");
    return dbus;
  } catch (err) {
    debugLogger.log("[DBusToggleService] Failed to load dbus-native:", err.message);
    return null;
  }
}

// Owns the com.openwhispr.App session-bus service and its no-arg methods.
// Toggle/ToggleAgent/ToggleMeeting/ToggleVoiceAgent/ToggleTranslation are momentary
// (tap-to-toggle) for compositors that only fire on key press.
// Compositor-agnostic: the GNOME integration and the auto-enabled endpoint on
// wlroots Wayland (e.g. Sway) both route key events to these via dbus-send.
// Callbacks may be supplied up front to start() or attached later via the setters;
// the exported methods read them live, so a setter takes effect immediately.
class DBusToggleService {
  constructor() {
    this.bus = null;
    this._callbacks = {
      dictation: null,
      agent: null,
      meeting: null,
      voiceAgent: null,
      translation: null,
    };
  }

  async start(callbacks = {}) {
    const dbusModule = getDBus();
    if (!dbusModule) {
      return false;
    }

    Object.assign(this._callbacks, callbacks);

    try {
      this.bus = dbusModule.sessionBus();
      // Without a listener, async socket errors (e.g. a stale
      // DBUS_SESSION_BUS_ADDRESS) crash the process as an unhandled "error"
      // event — sessionBus() returns before connecting.
      this.bus.connection.on("error", (err) => {
        debugLogger.log("[DBusToggleService] D-Bus connection error:", err.message);
      });

      // DO_NOT_QUEUE so a losing request fails fast instead of silently sitting
      // in the queue and reporting success. Anything other than becoming (or
      // already being) the primary owner means another instance holds the name.
      const reply = await this._requestName();
      if (
        reply !== DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER &&
        reply !== DBUS_REQUEST_NAME_REPLY_ALREADY_OWNER
      ) {
        debugLogger.log(
          `[DBusToggleService] Could not claim ${DBUS_SERVICE_NAME} (reply ${reply}); falling back to normal detection`
        );
        this.close();
        return false;
      }

      this.bus.exportInterface(this._buildImpl(), DBUS_OBJECT_PATH, this._interfaceDesc());

      debugLogger.log("[DBusToggleService] D-Bus service initialized successfully");
      return true;
    } catch (err) {
      debugLogger.log("[DBusToggleService] Failed to initialize D-Bus service:", err.message);
      this.close();
      return false;
    }
  }

  _requestName() {
    return new Promise((resolve, reject) => {
      this.bus.requestName(DBUS_SERVICE_NAME, DBUS_NAME_FLAG_DO_NOT_QUEUE, (err, retCode) => {
        if (err) reject(err);
        else resolve(retCode);
      });
    });
  }

  _buildImpl() {
    return {
      Toggle: () => {
        if (this._callbacks.dictation) this._callbacks.dictation();
      },
      ToggleAgent: () => {
        if (this._callbacks.agent) this._callbacks.agent();
      },
      ToggleMeeting: () => {
        if (this._callbacks.meeting) this._callbacks.meeting();
      },
      ToggleVoiceAgent: () => {
        if (this._callbacks.voiceAgent) this._callbacks.voiceAgent();
      },
      ToggleTranslation: () => {
        if (this._callbacks.translation) this._callbacks.translation();
      },
    };
  }

  _interfaceDesc() {
    return {
      name: DBUS_INTERFACE,
      methods: {
        Toggle: ["", ""],
        ToggleAgent: ["", ""],
        ToggleMeeting: ["", ""],
        ToggleVoiceAgent: ["", ""],
        ToggleTranslation: ["", ""],
      },
    };
  }

  setDictationCallback(callback) {
    this._callbacks.dictation = callback || null;
  }

  setAgentCallback(callback) {
    this._callbacks.agent = callback || null;
  }

  setMeetingCallback(callback) {
    this._callbacks.meeting = callback || null;
  }

  setVoiceAgentCallback(callback) {
    this._callbacks.voiceAgent = callback || null;
  }

  setTranslationCallback(callback) {
    this._callbacks.translation = callback || null;
  }

  close() {
    if (this.bus) {
      try {
        this.bus.connection.end();
      } catch {
        // Connection already gone.
      }
      this.bus = null;
    }
  }
}

module.exports = DBusToggleService;
module.exports.DBUS_SERVICE_NAME = DBUS_SERVICE_NAME;
module.exports.DBUS_OBJECT_PATH = DBUS_OBJECT_PATH;
module.exports.DBUS_INTERFACE = DBUS_INTERFACE;
