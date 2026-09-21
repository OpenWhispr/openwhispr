import { useCallback, useEffect, useRef, useState } from "react";
import type { PermissionGuideId, PermissionGuideProgress } from "../../types/permissionGuide";
import { createPermissionGuideController, type GuidePermission } from "./permissionGuideController";

interface Options {
  enabled: boolean;
  progress: PermissionGuideProgress | null;
  save: (progress: PermissionGuideProgress | null) => void;
  rows: GuidePermission[];
}

export function usePermissionGuide(options: Options): {
  start: (permission?: PermissionGuideId) => Promise<void>;
  error: boolean;
} {
  const latest = useRef(options);
  latest.current = options;
  const controller = useRef<ReturnType<typeof createPermissionGuideController> | null>(null);
  const [error, setError] = useState(false);
  const eligibility = options.rows.map((row) => row.id).join(",");

  useEffect(() => {
    if (!options.enabled) return;
    const api = window.electronAPI;
    let disposed = false;
    const guide = createPermissionGuideController({
      sessionId: crypto.randomUUID(),
      rows: () => latest.current.rows,
      save: (progress) => latest.current.save(progress),
      publish: async (state) => {
        try {
          const opened = await api.openPermissionGuide?.(state);
          if (!disposed && !opened) setError(true);
          return opened ?? false;
        } catch {
          if (!disposed) setError(true);
          return false;
        }
      },
      close: () => {
        void api.closePermissionGuide?.().catch(() => {});
      },
      restart: async () => {
        if (!api.relaunchApp) throw new Error("Relaunch unavailable");
        await api.relaunchApp();
      },
    });
    controller.current = guide;
    const unsubscribe = api.onPermissionGuideAction?.((action) => {
      void guide.act(action);
    });
    const refresh = (): void => {
      void guide.refresh();
    };
    // Re-checked often enough that the overlay disappears as soon as the user
    // grants the permission — dragging the app into the list enables it, and a
    // slower loop reads as the overlay ignoring what you just did.
    const timer = window.setInterval(refresh, 750);
    window.addEventListener("focus", refresh);
    if (latest.current.progress) void guide.start(undefined, latest.current.progress);
    return () => {
      disposed = true;
      controller.current = null;
      guide.dispose();
      unsubscribe?.();
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      void api.closePermissionGuide?.().catch(() => {});
    };
  }, [options.enabled]);

  useEffect(() => {
    void controller.current?.reconcile();
  }, [eligibility]);

  const start = useCallback(async (permission?: PermissionGuideId): Promise<void> => {
    setError(false);
    await controller.current?.start(permission);
  }, []);
  return { start, error };
}
