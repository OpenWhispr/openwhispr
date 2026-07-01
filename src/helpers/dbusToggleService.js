const debugLogger = require("./debugLogger");

const DBUS_SERVICE_NAME = "com.openwhispr.App";
const DBUS_OBJECT_PATH = "/com/openwhispr/App";
const DBUS_INTERFACE = "com.openwhispr.App";

let dbus = null;

function getDBus() {
  if (dbus) return dbus;
  try {
    dbus = require("dbus-next");
    return dbus;
  } catch (err) {
    debugLogger.log("[DBusToggleService] Failed to load dbus-next:", err.message);
    return null;
  }
}

// Owns the com.openwhispr.App session-bus service and its no-arg methods.
// Toggle/ToggleAgent/ToggleMeeting/ToggleVoiceAgent are momentary (tap-to-toggle)
// for compositors that only fire on key press. StartDictation/StopDictation are a
// press/release pair for push-to-talk: bind key-press → StartDictation and
// key-release → StopDictation (e.g. Sway `bindsym` + `bindsym --release`).
// Compositor-agnostic: the GNOME integration and the auto-enabled endpoint on
// wlroots Wayland (e.g. Sway) both route key events to these via dbus-send.
// Callbacks may be supplied up front to start() or attached later via the setters.
class DBusToggleService {
  constructor() {
    this.bus = null;
    this._iface = null;
  }

  async start(callbacks = {}) {
    const dbusModule = getDBus();
    if (!dbusModule) {
      return false;
    }

    try {
      this.bus = dbusModule.sessionBus();
      await this.bus.requestName(DBUS_SERVICE_NAME, 0);

      const InterfaceClass = this._createInterfaceClass(dbusModule);
      this._iface = new InterfaceClass(callbacks);
      this.bus.export(DBUS_OBJECT_PATH, this._iface);

      debugLogger.log("[DBusToggleService] D-Bus service initialized successfully");
      return true;
    } catch (err) {
      debugLogger.log("[DBusToggleService] Failed to initialize D-Bus service:", err.message);
      this.close();
      return false;
    }
  }

  setDictationCallback(callback) {
    if (this._iface) this._iface._dictationCallback = callback || null;
  }

  setAgentCallback(callback) {
    if (this._iface) this._iface._agentCallback = callback || null;
  }

  setMeetingCallback(callback) {
    if (this._iface) this._iface._meetingCallback = callback || null;
  }

  setVoiceAgentCallback(callback) {
    if (this._iface) this._iface._voiceAgentCallback = callback || null;
  }

  setStartDictationCallback(callback) {
    if (this._iface) this._iface._startDictationCallback = callback || null;
  }

  setStopDictationCallback(callback) {
    if (this._iface) this._iface._stopDictationCallback = callback || null;
  }

  _createInterfaceClass(dbusModule) {
    class OpenWhisprInterface extends dbusModule.interface.Interface {
      constructor(callbacks = {}) {
        super(DBUS_INTERFACE);
        this._dictationCallback = callbacks.dictation || null;
        this._agentCallback = callbacks.agent || null;
        this._meetingCallback = callbacks.meeting || null;
        this._voiceAgentCallback = callbacks.voiceAgent || null;
        this._startDictationCallback = callbacks.startDictation || null;
        this._stopDictationCallback = callbacks.stopDictation || null;
      }

      Toggle() {
        if (this._dictationCallback) this._dictationCallback();
      }

      ToggleAgent() {
        if (this._agentCallback) this._agentCallback();
      }

      ToggleMeeting() {
        if (this._meetingCallback) this._meetingCallback();
      }

      ToggleVoiceAgent() {
        if (this._voiceAgentCallback) this._voiceAgentCallback();
      }

      // Push-to-talk: bind key-press → StartDictation, key-release → StopDictation.
      StartDictation() {
        if (this._startDictationCallback) this._startDictationCallback();
      }

      StopDictation() {
        if (this._stopDictationCallback) this._stopDictationCallback();
      }
    }

    OpenWhisprInterface.configureMembers({
      methods: {
        Toggle: { inSignature: "", outSignature: "" },
        ToggleAgent: { inSignature: "", outSignature: "" },
        ToggleMeeting: { inSignature: "", outSignature: "" },
        ToggleVoiceAgent: { inSignature: "", outSignature: "" },
        StartDictation: { inSignature: "", outSignature: "" },
        StopDictation: { inSignature: "", outSignature: "" },
      },
    });

    return OpenWhisprInterface;
  }

  close() {
    if (this.bus) {
      this.bus.disconnect();
      this.bus = null;
    }
    this._iface = null;
  }
}

module.exports = DBusToggleService;
module.exports.DBUS_SERVICE_NAME = DBUS_SERVICE_NAME;
module.exports.DBUS_OBJECT_PATH = DBUS_OBJECT_PATH;
module.exports.DBUS_INTERFACE = DBUS_INTERFACE;
