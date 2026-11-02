const path = require("path");

/**
 * The app a voice command was spoken over, where the assistant panel's Paste into app goes.
 *
 * Each recording captures the app in front, so the capture a voice command adopts is always
 * its own recording's, never an older dictation's. A new command takes its app; a follow-up
 * takes the app it was spoken over when that is another app, and otherwise keeps the one the
 * conversation had. The panel lets it go when it closes. A panel opened another way (the tray,
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

  /** A recording started: capture the app it was started over. */
  noteRecordingStart() {
    // A failed capture is a missing target, never a rejected promise someone awaits later.
    this._recorded = this._capture().catch(() => null);
  }

  /** The panel answers a voice command: its paste goes to the app that command was spoken over. */
  async adopt() {
    const recorded = this._recorded;
    const previous = this._adopted;
    this._recorded = null;
    // Spoken with OpenWhispr in front (the panel itself), it keeps the conversation's app. Set
    // at once, so a close that clears it meanwhile isn't undone when the capture settles.
    this._adopted = this._usable(recorded).then((target) => target ?? this._usable(previous));
    return (await this.current()) !== null;
  }

  clear() {
    this._adopted = null;
  }

  /** The adopted app, or null when there is none or it is OpenWhispr. */
  current() {
    return this._usable(this._adopted);
  }

  async _usable(capture) {
    const target = await capture;
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

  /**
   * Windows and Linux paste into whatever is in front, so the paste first makes sure that is the
   * command's app: Windows brings its window forward and checks it came, Linux checks focus came
   * back to it.
   */
  async isInFront(target) {
    if (this.platform === "win32") {
      return Boolean(
        await Promise.resolve(this.selectionManager?.restoreWinTarget?.(target.window)).catch(
          () => false
        )
      );
    }
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
