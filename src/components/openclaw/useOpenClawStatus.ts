import { useEffect, useState } from "react";

export type OpenClawStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export function useOpenClawStatus(): OpenClawStatus {
  const [status, setStatus] = useState<OpenClawStatus>("disconnected");

  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.openclaw?.status?.().then((s) => {
      if (!cancelled) setStatus(s as OpenClawStatus);
    });
    const unsubscribe = window.electronAPI?.openclaw?.onStatusChange?.((next) => {
      setStatus(next as OpenClawStatus);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  return status;
}
