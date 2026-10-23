const path = require("path");

/**
 * The app a voice command was spoken over, where the assistant panel's Paste into app goes.
 *
 * Each recording started while the panel is closed captures the app in front. The panel takes
 * that capture only for the voice command it answers, and lets it go when it closes, so a
 * paste never lands in an app from an older dictation. A panel opened another way (the tray,
 * the pill menu) has none, and neither does one opened over OpenWhispr itself: the panel
 * offers Copy only there.
 */
class AssistantPasteTarget {
  constructor({
    textEditMonitor,
    selectionManager,
    platform = process.platform,
    ownPid = process.pid,
    ownExeName = path.basename(process.execPath),
  }) {
    this.textEditMonitor = textEditMonitor;
    this.selectionManager = selectionManager;
    this.platform = platform;
    this.ownPid = ownPid;
    this.ownExeName = ownExeName;
    this._recorded = null;
    this._adopted = null;
  }

  /** A recording started with the panel closed: capture the app it was started over. */
  noteRecordingStart() {
    // A failed capture is a missing target, never a rejected promise someone awaits later.
    this._recorded = this._capture().catch(() => null);
  }

  /** The panel answers a voice command: its paste goes to that command's app. */
  async adopt() {
    this._adopted = this._recorded;
    this._recorded = null;
    return (await this.current()) !== null;
  }

  clear() {
    this._adopted = null;
  }

  /** The adopted app, or null when there is none or it is OpenWhispr. */
  async current() {
    const target = await this._adopted;
    if (!target) return null;
    if (this.platform === "darwin") return target.pid && target.pid !== this.ownPid ? target : null;
    if (this.platform === "win32") {
      // Unlike dictation, which may paste into a note in OpenWhispr's own window, a command's
      // paste never goes to one of OpenWhispr's windows.
      const exeName = String(target.window.exeName || "").toLowerCase();
      return target.window.id && exeName !== this.ownExeName.toLowerCase() ? target : null;
    }
    const pid = await Promise.resolve(
      this.selectionManager?._linuxTargetPid?.(target.window)
    ).catch(() => null);
    return pid != null && String(pid) === String(this.ownPid) ? null : target;
  }

  /** Linux pastes into whatever has focus, so the paste first checks focus is back on the app. */
  async isFocused(target) {
    const focused = await Promise.resolve(this.selectionManager?._getLinuxTarget?.()).catch(
      () => null
    );
    return Boolean(this.selectionManager?._sameTarget?.(target.window, focused));
  }

  async _capture() {
    if (this.platform === "darwin") {
      const pid = await this.textEditMonitor?.captureTargetPid?.();
      return pid ? { pid } : null;
    }
    await this.selectionManager?.captureTarget?.();
    const window = this.selectionManager?.lastTarget ?? null;
    if (!window) return null;
    return this.platform === "win32" && window.kind !== "win-hwnd" ? null : { window };
  }
}

module.exports = { AssistantPasteTarget };
