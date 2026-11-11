const { autoUpdater } = require("electron-updater");
const UpdateHttpExecutor = require("./helpers/updateHttpExecutor");

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
    this.handleNativeUpdateDownloaded = null;
    this.eventListeners = [];
    this.updateCheckInterval = null;
    this.windowManager = null;
    // null until the renderer syncs the preference, so nothing downloads unasked.
    this.autoUpdatesEnabled = null;
    this.getPolicy = getPolicy;
    // Whether new activity has the current credential's verdict.
    this.policyReady = getPolicy === null;
    // Its lookup failed with nothing held, so only a retry can resolve it.
    this.policyUnavailable = false;
    // A check the policy refused for want of a verdict runs once one lands.
    this.checkAwaitingPolicy = false;
    // The verdict running work follows: the current one or, after
    // invalidatePolicy, the previous one until the next lands. null while
    // nothing allows updates.
    this.updateMode = getPolicy === null ? "user_choice" : null;
    this.policyRevision = -1;
    // Bumped by invalidatePolicy, so a lookup for the previous credential never lands.
    this.lookupEpoch = 0;
    // Bumped when the policy ends running work, so its results never land.
    this.workEpoch = 0;
    this.checkEpoch = null;
    this.checkPromise = null;
    this.downloadEpoch = null;
    this.downloadPromise = null;
    this.requestCleanup = null;
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

    this.httpExecutor = new UpdateHttpExecutor((info, callback) =>
      autoUpdater.emit("login", info, callback)
    );
    autoUpdater.httpExecutor = this.httpExecutor;

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
    const nativeUpdater = require("electron").autoUpdater;
    nativeUpdater.on("before-quit-for-update", this.handleBeforeQuitForUpdate);
    if (process.platform === "darwin") {
      this.handleNativeUpdateDownloaded = () => this._notifyStatus();
      nativeUpdater.on("update-downloaded", this.handleNativeUpdateDownloaded);
    }
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
      if (this.getPolicy) await this.refreshPolicy();
      if (!this._policyFailure() && this.requestCleanup) await this.requestCleanup;
      const failure = this._policyFailure();
      if (failure) {
        if (!this.policyReady) this.checkAwaitingPolicy = true;
        return { ...failure, updateAvailable: false };
      }
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

      if (this.checkPromise) return this.checkPromise;

      this.httpExecutor.resumeRequests();
      const epoch = this.workEpoch;
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
    const result = await autoUpdater.checkForUpdates().catch((error) => {
      if (epoch !== this.workEpoch) return null;
      throw error;
    });
    if (epoch !== this.workEpoch) {
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
      if (!this._policyFailure() && this.requestCleanup) await this.requestCleanup;
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
      this.httpExecutor.resumeRequests();
      const epoch = this.workEpoch;
      this.downloadEpoch = epoch;
      console.log("📥 Starting update download...");
      this.downloadPromise = autoUpdater.downloadUpdate(this.updateCancellationToken ?? undefined);
      await this.downloadPromise;
      if (epoch !== this.workEpoch) return this._policyFailure() ?? this._policyChanged();
      console.log("📥 Download initiated successfully");

      return { success: true, message: "Update download started" };
    } catch (error) {
      this.isDownloading = false;
      if (started && this.downloadEpoch !== this.workEpoch) {
        return this._policyFailure() ?? this._policyChanged();
      }
      console.error("❌ Update download error:", error);
      throw error;
    } finally {
      if (started) {
        this.isDownloading = false;
        this.downloadEpoch = null;
        this.downloadPromise = null;
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
        policyUnavailable: this.policyUnavailable,
        effectiveAutoUpdatesEnabled: this._automaticUpdatesSelected(),
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

  // What the toggle shows: the organization's choice, else the member's.
  _automaticUpdatesSelected() {
    return (
      isUpdaterSupported &&
      this.updateMode !== "it_managed" &&
      (this.updateMode === "always_on" || this.autoUpdatesEnabled === true)
    );
  }

  _automaticUpdatesEnabled() {
    return this.policyReady && this._automaticUpdatesSelected();
  }

  _eventsAllowed() {
    return (
      this.updateMode !== null &&
      this.updateMode !== "it_managed" &&
      (this.checkEpoch === null || this.checkEpoch === this.workEpoch) &&
      (this.downloadEpoch === null || this.downloadEpoch === this.workEpoch)
    );
  }

  // electron-updater reads this once, as a download completes, so it follows the
  // verdict running work follows: a pending lookup must not turn it off.
  _syncInstallOnQuit() {
    autoUpdater.autoInstallOnAppQuit =
      this.updateMode !== null && this.updateMode !== "it_managed" && !this.installDeferred;
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

  // Ends the check or download running and the update they found.
  _abortWork() {
    this.workEpoch += 1;
    this.updateCancellationToken?.cancel();
    // The next download must not start on a cancelled token.
    this.updateCancellationToken = null;
    if (this.checkPromise || this.downloadPromise) {
      // Cancelling the updater promise alone leaves its download request open.
      this.httpExecutor.abortRequests();
      const cleanup = Promise.allSettled([this.checkPromise, this.downloadPromise]).then(() => {
        if (this.requestCleanup === cleanup) this.requestCleanup = null;
      });
      this.requestCleanup = cleanup;
    }
    this.updateAvailable = false;
    if (!this.updateDownloaded) this.lastUpdateInfo = null;
  }

  // The credential or scope changed. New activity waits for its verdict, while
  // a running check or download and the update it found keep the previous one
  // until the next lands: only an IT-managed verdict ends them.
  invalidatePolicy() {
    this.lookupEpoch += 1;
    this.policyRevision = -1;
    this.policyReady = false;
    this.policyUnavailable = false;
    this._notifyStatus();
  }

  updatePolicy(snapshot) {
    if (!snapshot?.success || (snapshot.managed && !snapshot.policy)) {
      // A failed lookup says nothing new; an unreadable policy revokes.
      if (snapshot?.success || snapshot?.code === "POLICY_UNRESOLVABLE") {
        this._abortWork();
        this.updateMode = null;
        this.policyReady = false;
        this.policyUnavailable = true;
        this._syncInstallOnQuit();
        this._notifyStatus();
      } else if (!this.policyReady && !this.policyUnavailable) {
        this.policyUnavailable = true;
        this._notifyStatus();
      }
      return;
    }
    if (Number.isSafeInteger(snapshot.revision) && snapshot.revision < this.policyRevision) return;
    const mode = snapshot.managed ? snapshot.policy?.updates?.mode : "user_choice";
    const nextMode = mode === "always_on" || mode === "it_managed" ? mode : "user_choice";
    const wasReady = this.policyReady;
    const changed = !wasReady || this.updateMode !== nextMode;
    if (nextMode === "it_managed" && this.updateMode !== "it_managed") this._abortWork();
    this.policyRevision = snapshot.revision ?? this.policyRevision;
    this.policyReady = true;
    this.policyUnavailable = false;
    this.updateMode = nextMode;
    this._syncInstallOnQuit();
    if (changed) {
      this._notifyStatus();
      this._autoDownloadIfEnabled();
    }
    if (!wasReady && this.checkAwaitingPolicy) {
      this.checkAwaitingPolicy = false;
      this._autoCheckForUpdates("Deferred");
    }
  }

  // A held verdict answers at once and the network refreshes it behind, so
  // nothing waits on a slow lookup; only a credential with none held waits.
  async refreshPolicy() {
    if (!this.getPolicy) return;
    const epoch = this.lookupEpoch;
    if (!this.policyReady) await this._lookupPolicy({ held: true });
    if (epoch !== this.lookupEpoch) return;
    if (this.policyReady) void this._lookupPolicy();
    else await this._lookupPolicy();
  }

  async _lookupPolicy(options) {
    const epoch = this.lookupEpoch;
    let snapshot;
    try {
      snapshot = await this.getPolicy(options);
    } catch {
      snapshot = { success: false };
    }
    // With nothing held, the network lookup decides.
    if (epoch === this.lookupEpoch && (snapshot?.success || !options?.held)) {
      this.updatePolicy(snapshot);
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
    this.updateCancellationToken?.cancel();
    this.httpExecutor?.abortRequests();
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
    if (this.handleNativeUpdateDownloaded) {
      require("electron").autoUpdater.removeListener(
        "update-downloaded",
        this.handleNativeUpdateDownloaded
      );
      this.handleNativeUpdateDownloaded = null;
    }
  }
}

module.exports = UpdateManager;
