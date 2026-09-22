import { useEffect, useState } from "react";

export interface UseWindowControlsReturn {
  isMaximized: boolean;
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Shared state and handlers for the custom window-control buttons that
 * frameless windows render on Windows and Linux (macOS windows keep their
 * native traffic lights, so callers skip rendering there).
 */
export const useWindowControls = (): UseWindowControlsReturn => {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let mounted = true;
    const syncIsMaximized = async (): Promise<void> => {
      try {
        const maximized = await window.electronAPI?.windowIsMaximized?.();
        if (mounted) setIsMaximized(Boolean(maximized));
      } catch {}
    };

    void syncIsMaximized();
    // Polled because maximize can also happen outside these buttons (Windows
    // snap, double-clicking the drag band) and no renderer event reports it.
    const intervalId = window.setInterval(syncIsMaximized, 1000);
    return () => {
      mounted = false;
      window.clearInterval(intervalId);
    };
  }, []);

  const minimize = async (): Promise<void> => {
    try {
      await window.electronAPI?.windowMinimize?.();
    } catch {}
  };

  const toggleMaximize = async (): Promise<void> => {
    try {
      await window.electronAPI?.windowMaximize?.();
      const maximized = await window.electronAPI?.windowIsMaximized?.();
      setIsMaximized(Boolean(maximized));
    } catch {}
  };

  const close = async (): Promise<void> => {
    try {
      await window.electronAPI?.windowClose?.();
    } catch {}
  };

  return { isMaximized, minimize, toggleMaximize, close };
};
