import { useState, useEffect, useCallback } from "react";
import type { ReleaseNotes } from "../types/electron";

interface UpdateStatus {
  updateAvailable: boolean;
  updateDownloaded: boolean;
  isDevelopment: boolean;
  isSupported: boolean;
}

interface UpdateInfo {
  version?: string;
  releaseDate?: string;
  releaseNotes?: ReleaseNotes;
  files?: any[];
}

interface UpdateState {
  status: UpdateStatus;
  info: UpdateInfo | null;
  downloadProgress: number;
  isChecking: boolean;
  isDownloading: boolean;
  isInstalling: boolean;
  installStalled: boolean;
}

let globalState: UpdateState = {
  status: {
    updateAvailable: false,
    updateDownloaded: false,
    isDevelopment: false,
    isSupported: true,
  },
  info: null,
  downloadProgress: 0,
  isChecking: false,
  isDownloading: false,
  isInstalling: false,
  installStalled: false,
};
let installTimeout: ReturnType<typeof setTimeout> | null = null;

const stateListeners = new Set<(state: UpdateState) => void>();
let listenersRegistered = false;
const cleanupFunctions: Array<() => void> = [];

function notifyListeners() {
  stateListeners.forEach((listener) => listener({ ...globalState }));
}

function updateGlobalState(updates: Partial<UpdateState>) {
  if (updates.isInstalling === false && installTimeout !== null) {
    clearTimeout(installTimeout);
    installTimeout = null;
  }
  globalState = { ...globalState, ...updates };
  notifyListeners();
}

function registerEventListeners() {
  if (listenersRegistered || !window.electronAPI) {
    return;
  }

  listenersRegistered = true;

  if (window.electronAPI.onUpdateAvailable) {
    const dispose = window.electronAPI.onUpdateAvailable((_event, info) => {
      updateGlobalState({
        status: { ...globalState.status, updateAvailable: true },
        info: info || globalState.info,
      });
    });
    if (dispose) cleanupFunctions.push(dispose);
  }

  if (window.electronAPI.onUpdateNotAvailable) {
    const dispose = window.electronAPI.onUpdateNotAvailable(() => {
      // Preserve downloaded state — don't nuke a pending install
      const keepDownloaded = globalState.status.updateDownloaded;
      updateGlobalState({
        status: {
          ...globalState.status,
          updateAvailable: false,
          updateDownloaded: keepDownloaded,
        },
        info: keepDownloaded ? globalState.info : null,
        isChecking: false,
      });
    });
    if (dispose) cleanupFunctions.push(dispose);
  }

  if (window.electronAPI.onUpdateDownloaded) {
    const dispose = window.electronAPI.onUpdateDownloaded((_event, info) => {
      updateGlobalState({
        status: { ...globalState.status, updateDownloaded: true },
        info: info || globalState.info,
        downloadProgress: 100,
        isDownloading: false,
        isInstalling: false,
        installStalled: false,
      });
    });
    if (dispose) cleanupFunctions.push(dispose);
  }

  if (window.electronAPI.onUpdateDownloadProgress) {
    const dispose = window.electronAPI.onUpdateDownloadProgress((_event, progressObj) => {
      updateGlobalState({
        downloadProgress: progressObj?.percent || 0,
        isDownloading: true,
      });
    });
    if (dispose) cleanupFunctions.push(dispose);
  }

  if (window.electronAPI.onUpdateError) {
    const dispose = window.electronAPI.onUpdateError(() => {
      updateGlobalState({
        isChecking: false,
        isDownloading: false,
        isInstalling: false,
        installStalled: false,
      });
    });
    if (dispose) cleanupFunctions.push(dispose);
  }
}

function cleanup() {
  if (stateListeners.size === 0 && listenersRegistered) {
    cleanupFunctions.forEach((fn) => fn());
    cleanupFunctions.length = 0;
    listenersRegistered = false;
  }
}

function consumeInstallStall(): boolean {
  if (!globalState.installStalled) return false;
  updateGlobalState({ installStalled: false });
  return true;
}

export function useUpdater() {
  const [state, setState] = useState<UpdateState>(globalState);

  useEffect(() => {
    stateListeners.add(setState);
    registerEventListeners();
    let active = true;
    const initialStatus = globalState.status;
    const initialInfo = globalState.info;

    const initializeUpdateStatus = async () => {
      try {
        if (window.electronAPI?.getUpdateStatus) {
          const status = await window.electronAPI.getUpdateStatus();
          if (!active) return;
          if (globalState.status === initialStatus) updateGlobalState({ status });
        }

        if (window.electronAPI?.getUpdateInfo) {
          const info = await window.electronAPI.getUpdateInfo();
          if (active && info && globalState.info === initialInfo) updateGlobalState({ info });
        }
      } catch (error) {
        if (active) console.error("Failed to initialize update status:", error);
      }
    };

    void initializeUpdateStatus();

    return () => {
      active = false;
      stateListeners.delete(setState);
      cleanup();
    };
  }, []);

  const checkForUpdates = useCallback(async () => {
    updateGlobalState({ isChecking: true });
    try {
      return await window.electronAPI.checkForUpdates();
    } finally {
      updateGlobalState({ isChecking: false });
    }
  }, []);

  const downloadUpdate = useCallback(async () => {
    if (state.status.updateDownloaded) {
      return { success: true, message: "Update already downloaded" };
    }

    updateGlobalState({ isDownloading: true, downloadProgress: 0 });
    try {
      return await window.electronAPI.downloadUpdate();
    } catch (error) {
      updateGlobalState({ isDownloading: false });
      throw error;
    }
  }, [state.status.updateDownloaded]);

  const installUpdate = useCallback(async () => {
    if (!state.status.updateDownloaded) {
      throw new Error("No update available to install");
    }

    if (globalState.isInstalling) return;
    updateGlobalState({ isInstalling: true, installStalled: false });
    // One deadline serves every updater consumer, independent of locale/UI lifetime.
    const timer = setTimeout(() => {
      updateGlobalState({ isInstalling: false, installStalled: true });
    }, 10000);
    installTimeout = timer;
    try {
      await window.electronAPI.installUpdate();
    } catch (error) {
      if (installTimeout === timer) updateGlobalState({ isInstalling: false });
      throw error;
    }
  }, [state.status.updateDownloaded]);

  const getAppVersion = useCallback(async () => {
    try {
      const result = await window.electronAPI.getAppVersion();
      return result.version;
    } catch (error) {
      console.error("Failed to get app version:", error);
      return null;
    }
  }, []);

  return {
    status: state.status,
    info: state.info,
    downloadProgress: state.downloadProgress,
    isChecking: state.isChecking,
    isDownloading: state.isDownloading,
    isInstalling: state.isInstalling,
    installStalled: state.installStalled,
    consumeInstallStall,
    checkForUpdates,
    downloadUpdate,
    installUpdate,
    getAppVersion,
  };
}
