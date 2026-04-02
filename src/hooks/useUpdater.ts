import { useState, useEffect, useCallback, useRef } from "react";

interface UpdateStatus {
  updateAvailable: boolean;
  updateDownloaded: boolean;
  isDevelopment: boolean;
}

interface UpdateInfo {
  version?: string;
  releaseDate?: string;
  releaseNotes?: string;
  files?: any[];
}

interface UpdateState {
  status: UpdateStatus;
  info: UpdateInfo | null;
  downloadProgress: number;
  isChecking: boolean;
  isDownloading: boolean;
  isInstalling: boolean;
  error: Error | null;
}

let globalState: UpdateState = {
  status: {
    updateAvailable: false,
    updateDownloaded: false,
    isDevelopment: false,
  },
  info: null,
  downloadProgress: 0,
  isChecking: false,
  isDownloading: false,
  isInstalling: false,
  error: null,
};

const stateListeners = new Set<(state: UpdateState) => void>();
let listenersRegistered = false;
const cleanupFunctions: Array<() => void> = [];

function notifyListeners() {
  stateListeners.forEach((listener) => listener({ ...globalState }));
}

function updateGlobalState(updates: Partial<UpdateState>) {
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
    const dispose = window.electronAPI.onUpdateError((_event, error) => {
      updateGlobalState({
        isChecking: false,
        isDownloading: false,
        isInstalling: false,
        error: error instanceof Error ? error : new Error(String(error)),
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

export function useUpdater() {
  const [state, setState] = useState<UpdateState>(globalState);
  const isInstallingRef = useRef(false);

  useEffect(() => {
    stateListeners.add(setState);
    registerEventListeners();

    const initializeUpdateStatus = async () => {
      try {
        if (window.electronAPI?.getUpdateStatus) {
          const status = await window.electronAPI.getUpdateStatus();
          updateGlobalState({ status });
        }

        if (window.electronAPI?.getUpdateInfo) {
          const info = await window.electronAPI.getUpdateInfo();
          if (info) {
            updateGlobalState({ info });
          }
        }
      } catch (error) {
        console.error("Failed to initialize update status:", error);
      }
    };

    initializeUpdateStatus();

    return () => {
      stateListeners.delete(setState);
      cleanup();
    };
  }, []);

  const checkForUpdates = useCallback(async () => {
    updateGlobalState({ isChecking: true, error: null });
    try {
      const result = await window.electronAPI.checkForUpdates();
      updateGlobalState({ isChecking: false });
      return result;
    } catch (error) {
      updateGlobalState({
        isChecking: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    }
  }, []);

  const downloadUpdate = useCallback(async () => {
    if (state.status.updateDownloaded) {
      return { success: true, message: "Update already downloaded" };
    }

    updateGlobalState({ isDownloading: true, downloadProgress: 0, error: null });
    try {
      const result = await window.electronAPI.downloadUpdate();
      return result;
    } catch (error) {
      updateGlobalState({
        isDownloading: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    }
  }, [state.status.updateDownloaded]);

  const installUpdate = useCallback(async () => {
    if (!state.status.updateDownloaded) {
      throw new Error("No update available to install");
    }

    updateGlobalState({ isInstalling: true, error: null });
    isInstallingRef.current = true;

    try {
      await window.electronAPI.installUpdate();

      setTimeout(() => {
        if (isInstallingRef.current) {
          isInstallingRef.current = false;
          updateGlobalState({
            isInstalling: false,
            error: new Error(
              "Install timed out. Please restart the app manually to apply the update."
            ),
          });
        }
      }, 10000);
    } catch (error) {
      isInstallingRef.current = false;
      updateGlobalState({
        isInstalling: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
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
    error: state.error,
    checkForUpdates,
    downloadUpdate,
    installUpdate,
    getAppVersion,
  };
}
