const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const debugLogger = require("./debugLogger");

const STATE_FILE = "zoom.json";
// Electron zoom levels are logarithmic (factor = 1.2 ^ level). Clamp to the
// same range Chromium exposes in its zoom UI (~50%..300%).
const MIN_ZOOM_LEVEL = -3;
const MAX_ZOOM_LEVEL = 3;
const ZOOM_STEP = 0.5;

/**
 * App-managed zoom shared across every window.
 *
 * Chromium tracks zoom per-host, which does not propagate to the frameless
 * popup/notification windows (they load via `file://`, so there is no shared
 * host). This manager keeps a single zoom level, applies it to every
 * registered window on load, and re-syncs all windows whenever the user zooms
 * one of them (keyboard via the menu, or Ctrl+wheel). The level is persisted so
 * it survives restarts deterministically.
 */
class ZoomManager {
  constructor() {
    this._level = 0;
    this._registered = new Set();
    this._loaded = false;
  }

  _statePath() {
    return path.join(app.getPath("userData"), STATE_FILE);
  }

  _clamp(level) {
    if (!Number.isFinite(level)) return 0;
    return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, level));
  }

  _load() {
    if (this._loaded) return;
    this._loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(this._statePath(), "utf-8"));
      if (typeof parsed.level === "number") {
        this._level = this._clamp(parsed.level);
      }
    } catch {
      // No saved zoom yet; default to 0 (100%).
    }
  }

  _persist() {
    try {
      fs.writeFileSync(this._statePath(), JSON.stringify({ level: this._level }), "utf-8");
    } catch (error) {
      debugLogger.warn("Failed to persist zoom level", { error: error?.message }, "window");
    }
  }

  getLevel() {
    this._load();
    return this._level;
  }

  // Electron/Chromium zoom factor for the current level (scale = 1.2 ^ level).
  // Fixed-size windows must multiply their dimensions by this so zoomed content
  // (which the renderer still measures in unzoomed CSS px) fits.
  getFactor() {
    this._load();
    return Math.pow(1.2, this._level);
  }

  // Invoked after the shared level changes so the owner can resize any
  // fixed-size windows that are currently open to match the new factor.
  setOnChange(fn) {
    this._onChange = fn;
  }

  /**
   * Register a window's webContents so it always reflects the shared zoom
   * level. Idempotent: registering the same webContents twice is a no-op.
   */
  register(webContents) {
    if (!webContents || webContents.isDestroyed() || this._registered.has(webContents)) {
      return;
    }
    this._load();
    this._registered.add(webContents);

    const apply = () => {
      if (webContents.isDestroyed()) return;
      try {
        webContents.setZoomLevel(this._level);
      } catch {
        // Window may have gone away mid-load.
      }
    };

    // Apply on the initial load and on any subsequent reload/navigation.
    webContents.on("did-finish-load", apply);
    if (!webContents.isLoadingMainFrame()) apply();

    // Ctrl+wheel: Chromium has already zoomed this webContents, so mirror its
    // new level onto the others without re-applying to the origin.
    webContents.on("zoom-changed", () => {
      if (webContents.isDestroyed()) return;
      this.setLevel(webContents.getZoomLevel(), webContents);
    });

    webContents.once("destroyed", () => {
      this._registered.delete(webContents);
    });
  }

  /**
   * Set the shared zoom level and propagate it to every registered window.
   * @param {number} level target zoom level
   * @param {Electron.WebContents} [origin] window already at this level (skipped)
   */
  setLevel(level, origin) {
    this._load();
    const clamped = this._clamp(level);
    const changed = clamped !== this._level;
    this._level = clamped;

    for (const wc of this._registered) {
      if (wc === origin || wc.isDestroyed()) continue;
      try {
        wc.setZoomLevel(clamped);
      } catch {
        // Skip dead windows.
      }
    }

    if (changed) {
      this._persist();
      try {
        this._onChange?.();
      } catch {
        // Resize hook is best-effort; never let it break zoom propagation.
      }
    }
  }

  /**
   * Handle a menu-driven zoom command against the focused window, using its
   * current level as the base so the shared level never drifts.
   * @param {Electron.BrowserWindow} window focused window from the menu click
   * @param {"in"|"out"|"reset"} direction
   */
  applyZoomCommand(window, direction) {
    if (!window || window.isDestroyed()) return;
    const current = window.webContents.getZoomLevel();
    const next =
      direction === "reset" ? 0 : current + (direction === "in" ? ZOOM_STEP : -ZOOM_STEP);
    this.setLevel(next);
  }
}

module.exports = ZoomManager;
