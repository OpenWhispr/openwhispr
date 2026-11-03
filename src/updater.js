const { autoUpdater } = require("electron-updater");

// electron-updater can only replace an AppImage on Linux; deb, rpm and tar.gz
// installs are updated by the package manager instead.
const isUpdaterSupported = process.platform !== "linux" || Boolean(process.env.APPIMAGE);

class UpdateManager {
  constructor({ getPolicy = null } = {}) {
    this.updateAvailable = false;
    this.updateDownloaded = false;
    this.lastUpdateInfo = null;
    this.isInstalling = false;
    this.isDownloading = false;
    this.isQuittingForUpdate = false;
    this.handleBeforeQuitForUpdate = null;
    this.eventListeners = [];
    this.updateCheckInterval = null;
    this.windowManager = null;
    // null until the renderer syncs the preference, so nothing downloads unasked.
    this.autoUpdatesEnabled = null;
    this.getPolicy = getPolicy;
    this.policyReady = getPolicy === null;
    this.updateMode = "user_choice";
    this.policyRevision = -1;
    this.policyEpoch = 0;
    this.checkEpoch = null;
    this.checkPromise = null;
    this.downloadEpoch = null;
    this.downloadToken = null;
    this.updateCancellationToken = null;
    this.installDeferred = false;
    this.startupCheckTimeout = null;

    this.setupAutoUpdater();
  }

  setWindowManager(windowManager) {
    this.windowManager = windowManager;
  }

  setupAutoUpdater() {
    if (process.env.NODE_ENV === "development") {
      return;
    }

    autoUpdater.setFeedURL({
      provider: "github",
      owner: "OpenWhispr",
      repo: "openwhispr",
      private: false,
    });

    // Use arch-specific update channel on macOS to prevent arm64/x64
    // from downloading mismatched artifacts. Both builds publish to the
    // same GitHub release, so without this they race on latest-mac.yml.
    // Setting channel to e.g. 'latest-arm64' makes the updater look for
    // 'latest-arm64-mac.yml' instead of the shared 'latest-mac.yml'.
    if (process.platform === "darwin") {
      let nativeArch = process.arch;

      // Detect Rosetta: if an x64 build is running on Apple Silicon,
      // sysctl.proc_translated returns "1". This self-heals users who
      // got stuck on the x64 build from older releases.
      if (process.arch === "x64") {
        try {
          const { execSync } = require("child_process");
          const translated = execSync("sysctl -n sysctl.proc_translated", {
            encoding: "utf8",
            timeout: 3000,
          }).trim();
          if (translated === "1") {
            console.log("🔄 Rosetta detected — switching update channel to arm64");
            nativeArch = "arm64";
          }
        } catch {
          // sysctl.proc_translated doesn't exist on real Intel Macs — ignore
        }
      }

      autoUpdater.channel = nativeArch === "arm64" ? "latest-arm64" : "latest-x64";
    }

    autoUpdater.autoDownload = false;
    this._syncInstallOnQuit();
    autoUpdater.logger = console;

    this.setupEventHandlers();
  }

  setupEventHandlers() {
    const handlers = {
      "checking-for-update": () => {
        if (!this._eventsAllowed()) return;
        this.notifyRenderers("checking-for-update");
      },
      "update-available": (info) => {
        if (!this._eventsAllowed()) return;
        this.updateAvailable = true;
        if (info) {
          this.lastUpdateInfo = {
            version: info.version,
            releaseDate: info.releaseDate,
            releaseNotes: info.releaseNotes,
            files: info.files,
          };
        }
        this.notifyRenderers("update-available", info);
        this._autoDownloadIfEnabled();
      },
      "update-not-available": (info) => {
        if (!this._eventsAllowed()) return;
        this.updateAvailable = false;
        if (!this.updateDownloaded) {
          this.isDownloading = false;
          this.lastUpdateInfo = null;
        }
        this.notifyRenderers("update-not-available", info);
      },
      error: (err) => {
        console.error("❌ Auto-updater error:", err);
        this.isDownloading = false;
        if (this._eventsAllowed()) this.notifyRenderers("update-error", err);
      },
      "download-progress": (progressObj) => {
        if (!this._eventsAllowed()) return;
        console.log(
          `📥 Download progress: ${progressObj.percent.toFixed(2)}% (${(progressObj.transferred / 1024 / 1024).toFixed(2)}MB / ${(progressObj.total / 1024 / 1024).toFixed(2)}MB)`
        );
        this.notifyRenderers("update-download-progress", progressObj);
      },
      "update-downloaded": (info) => {
        if (!this._eventsAllowed()) return;
        console.log("✅ Update downloaded successfully:", info?.version);
        this.updateDownloaded = true;
        this.isDownloading = false;
        if (info) {
          this.lastUpdateInfo = {
            version: info.version,
            releaseDate: info.releaseDate,
            releaseNotes: info.releaseNotes,
            files: info.files,
          };
        }
        this.notifyRenderers("update-downloaded", info);
      },
    };

    Object.entries(handlers).forEach(([event, handler]) => {
      autoUpdater.on(event, handler);
      this.eventListeners.push({ event, handler });
    });

    // electron-updater and Squirrel.Mac emit this on Electron's native
    // autoUpdater (before any windows close), not on the electron-updater instance.
    this.handleBeforeQuitForUpdate = () => {
      this.isQuittingForUpdate = true;
      if (this.windowManager) {
        this.windowManager.isQuitting = true;
        this.windowManager.hotkeyManager.unregisterAll();
      }
    };
    require("electron").autoUpdater.on("before-quit-for-update", this.handleBeforeQuitForUpdate);
  }

  notifyRenderers(channel, data) {
    // Read window refs live from windowManager: cached refs go stale when the
    // control panel is created after boot (start minimized) or recreated.
    const { mainWindow, controlPanelWindow } = this.windowManager ?? {};
    for (const win of [mainWindow, controlPanelWindow]) {
      if (win && !win.isDestroyed() && win.webContents) {
        win.webContents.send(channel, data);
      }
    }
  }

  async checkForUpdates() {
    try {
      if (process.env.NODE_ENV === "development") {
        return {
          updateAvailable: false,
          message: "Update checks are disabled in development mode",
        };
      }

      if (!isUpdaterSupported) {
        return {
          updateAvailable: false,
          message: "Updates are installed through the system package manager",
        };
      }

      if (this.getPolicy) await this.refreshPolicy();
      const failure = this._policyFailure();
      if (failure) return { ...failure, updateAvailable: false };
      if (this.checkPromise) return this.checkPromise;

      const epoch = this.policyEpoch;
      this.checkEpoch = epoch;
      this.checkPromise = this._checkForUpdates(epoch);
      try {
        return await this.checkPromise;
      } finally {
        this.checkPromise = null;
        this.checkEpoch = null;
      }
    } catch (error) {
      console.error("❌ Update check error:", error);
      throw error;
    }
  }

  async _checkForUpdates(epoch) {
    console.log("🔍 Checking for updates...");
    const result = await autoUpdater.checkForUpdates();
    if (epoch !== this.policyEpoch || this._policyFailure()) {
      result?.cancellationToken?.cancel();
      return { ...(this._policyFailure() ?? this._policyChanged()), updateAvailable: false };
    }
    this.updateCancellationToken = result?.cancellationToken ?? null;
    this.checkEpoch = null;
    this._autoDownloadIfEnabled();

    if (result?.isUpdateAvailable && result?.updateInfo) {
      console.log("📋 Update available:", result.updateInfo.version);
      return {
        updateAvailable: true,
        version: result.updateInfo.version,
        releaseDate: result.updateInfo.releaseDate,
        files: result.updateInfo.files,
        releaseNotes: result.updateInfo.releaseNotes,
      };
    } else {
      console.log("✅ Already on latest version");
      return {
        updateAvailable: false,
        message: "You are running the latest version",
      };
    }
  }

  async downloadUpdate() {
    let started = false;
    try {
      if (process.env.NODE_ENV === "development") {
        return {
          success: false,
          message: "Update downloads are disabled in development mode",
        };
      }

      if (!isUpdaterSupported)
        return {
          success: false,
          message: "Updates are installed through the system package manager",
        };
      if (this.getPolicy) await this.refreshPolicy();
      const failure = this._policyFailure();
      if (failure) return failure;

      if (this.isDownloading) {
        return {
          success: true,
          message: "Download already in progress",
        };
      }

      if (this.updateDownloaded) {
        return {
          success: true,
          message: "Update already downloaded. Ready to install.",
        };
      }

      this.isDownloading = true;
      started = true;
      const epoch = this.policyEpoch;
      this.downloadToken = this.updateCancellationToken;
      this.downloadEpoch = epoch;
      console.log("📥 Starting update download...");
      await autoUpdater.downloadUpdate(this.downloadToken ?? undefined);
      if (epoch !== this.policyEpoch || this._policyFailure()) {
        return this._policyFailure() ?? this._policyChanged();
      }
      console.log("📥 Download initiated successfully");

      return { success: true, message: "Update download started" };
    } catch (error) {
      this.isDownloading = false;
      if (this._policyFailure()) return this._policyFailure();
      console.error("❌ Update download error:", error);
      throw error;
    } finally {
      if (started) {
        this.isDownloading = false;
        this.downloadEpoch = null;
        this.downloadToken = null;
      }
    }
  }

  async installUpdate() {
    try {
      if (process.env.NODE_ENV === "development") {
        return {
          success: false,
          message: "Update installation is disabled in development mode",
        };
      }

      if (!isUpdaterSupported)
        return {
          success: false,
          message: "Updates are installed through the system package manager",
        };
      if (this.getPolicy) await this.refreshPolicy();
      const failure = this._policyFailure();
      if (failure) return failure;

      if (!this.updateDownloaded) {
        return {
          success: false,
          message: "No update available to install",
        };
      }

      if (this.isInstalling) {
        return {
          success: false,
          message: "Update installation already in progress",
        };
      }

      this.isInstalling = true;
      console.log("🔄 Installing update and restarting...");

      const isSilent = process.platform === "win32";
      autoUpdater.quitAndInstall(isSilent, true);

      return { success: true, message: "Update installation started" };
    } catch (error) {
      this.isInstalling = false;
      console.error("❌ Update installation error:", error);
      throw error;
    }
  }

  async getAppVersion() {
    try {
      const { app } = require("electron");
      return { version: app.getVersion() };
    } catch (error) {
      console.error("❌ Error getting app version:", error);
      throw error;
    }
  }

  async getUpdateStatus() {
    try {
      return {
        updateAvailable: this._eventsAllowed() && this.updateAvailable,
        updateDownloaded: this._eventsAllowed() && this.updateDownloaded,
        updateMode: this.updateMode,
        policyReady: this.policyReady,
        effectiveAutoUpdatesEnabled: this._automaticUpdatesEnabled(),
        stagedUpdate: this.hasStagedUpdate(),
        isDevelopment: process.env.NODE_ENV === "development",
        isSupported: isUpdaterSupported,
      };
    } catch (error) {
      console.error("❌ Error getting update status:", error);
      throw error;
    }
  }

  async getUpdateInfo() {
    try {
      return this._eventsAllowed() ? this.lastUpdateInfo : null;
    } catch (error) {
      console.error("❌ Error getting update info:", error);
      throw error;
    }
  }

  _automaticUpdatesEnabled() {
    return (
      isUpdaterSupported &&
      this.policyReady &&
      this.updateMode !== "it_managed" &&
      (this.updateMode === "always_on" || this.autoUpdatesEnabled === true)
    );
  }

  _eventsAllowed() {
    return (
      this.policyReady &&
      this.updateMode !== "it_managed" &&
      (this.checkEpoch === null || this.checkEpoch === this.policyEpoch) &&
      (this.downloadEpoch === null || this.downloadEpoch === this.policyEpoch)
    );
  }

  _syncInstallOnQuit() {
    autoUpdater.autoInstallOnAppQuit =
      this.policyReady && this.updateMode !== "it_managed" && !this.installDeferred;
  }

  _policyChanged() {
    return {
      success: false,
      code: "UPDATE_POLICY_CHANGED",
      message: "Update policy changed. Check for updates again.",
    };
  }

  _policyFailure() {
    if (!this.policyReady)
      return {
        success: false,
        code: "UPDATE_POLICY_UNAVAILABLE",
        message: "Organization update policy is unavailable.",
      };
    if (this.updateMode === "it_managed")
      return {
        success: false,
        code: "UPDATES_MANAGED_BY_ORG",
        message: "Your organization manages updates.",
      };
    return null;
  }

  _notifyStatus() {
    void this.getUpdateStatus().then((status) =>
      this.notifyRenderers("update-status-changed", status)
    );
  }

  invalidatePolicy() {
    this.policyEpoch += 1;
    this.policyRevision = -1;
    this.policyReady = false;
    this.downloadToken?.cancel();
    this.updateCancellationToken?.cancel();
    this.updateAvailable = false;
    if (!this.updateDownloaded) this.lastUpdateInfo = null;
    this._syncInstallOnQuit();
    this._notifyStatus();
  }

  updatePolicy(snapshot) {
    if (!snapshot?.success || (snapshot.managed && !snapshot.policy)) {
      if (this.policyReady) this.invalidatePolicy();
      return;
    }
    if (Number.isSafeInteger(snapshot.revision) && snapshot.revision < this.policyRevision) return;
    const mode = snapshot.managed ? snapshot.policy?.updates?.mode : "user_choice";
    const nextMode = mode === "always_on" || mode === "it_managed" ? mode : "user_choice";
    const changed = !this.policyReady || this.updateMode !== nextMode;
    if (nextMode === "it_managed" && this.updateMode !== "it_managed") {
      this.invalidatePolicy();
    }
    this.policyRevision = snapshot.revision ?? this.policyRevision;
    this.policyReady = true;
    this.updateMode = nextMode;
    this._syncInstallOnQuit();
    if (changed) {
      this._notifyStatus();
      this._autoDownloadIfEnabled();
    }
  }

  async refreshPolicy() {
    if (!this.getPolicy) return;
    const epoch = this.policyEpoch;
    try {
      const snapshot = await this.getPolicy();
      if (epoch === this.policyEpoch) this.updatePolicy(snapshot);
    } catch {
      if (epoch === this.policyEpoch) this.updatePolicy({ success: false });
    }
  }

  setAutoUpdatesEnabled(enabled) {
    this.autoUpdatesEnabled = enabled;
    // The startup check may have found an update before the renderer synced.
    this._autoDownloadIfEnabled();
    this._notifyStatus();
  }

  // NSIS and AppImage install a downloaded update from their quit handler, which would
  // replace the executable a reset relaunch starts (an AppImage even moves to a new
  // file name).
  deferInstallOnQuit() {
    this.installDeferred = true;
    this._syncInstallOnQuit();
  }

  // On macOS a finished download is handed to Squirrel.Mac, which installs it on any
  // quit from then on; MacUpdater records that hand-off in squirrelDownloadedUpdate.
  hasStagedUpdate() {
    return process.platform === "darwin" && autoUpdater.squirrelDownloadedUpdate === true;
  }

  _autoDownloadIfEnabled() {
    if (!this._automaticUpdatesEnabled() || !this.updateAvailable || this.checkEpoch !== null)
      return;
    // downloadUpdate() is a no-op while a download is in flight or complete;
    // failures surface through the shared "error" handler and the renderers.
    this.downloadUpdate().catch(() => {});
  }

  // Checks always run so the sidebar can offer a manual download when automatic
  // updates are off; a failed background check is logged and never surfaced.
  _autoCheckForUpdates(label) {
    console.log(`🔄 ${label} update check...`);
    this.checkForUpdates().catch((err) => {
      console.error(`${label} update check failed:`, err);
    });
  }

  checkForUpdatesOnStartup() {
    if (process.env.NODE_ENV !== "development" && isUpdaterSupported) {
      this.startupCheckTimeout = setTimeout(() => {
        this.startupCheckTimeout = null;
        this._autoCheckForUpdates("Startup");
      }, 3000);

      const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
      this.updateCheckInterval = setInterval(() => {
        this._autoCheckForUpdates("Periodic");
      }, FOUR_HOURS_MS);
    }
  }

  cleanup() {
    if (this.startupCheckTimeout) {
      clearTimeout(this.startupCheckTimeout);
      this.startupCheckTimeout = null;
    }
    this.downloadToken?.cancel();
    this.updateCancellationToken?.cancel();
    if (this.updateCheckInterval) {
      clearInterval(this.updateCheckInterval);
      this.updateCheckInterval = null;
    }
    this.eventListeners.forEach(({ event, handler }) => {
      autoUpdater.removeListener(event, handler);
    });
    this.eventListeners = [];
    if (this.handleBeforeQuitForUpdate) {
      require("electron").autoUpdater.removeListener(
        "before-quit-for-update",
        this.handleBeforeQuitForUpdate
      );
      this.handleBeforeQuitForUpdate = null;
    }
  }
}

module.exports = UpdateManager;
