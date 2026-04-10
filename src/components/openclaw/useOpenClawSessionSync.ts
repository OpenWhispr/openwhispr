import { useEffect, useRef } from "react";
import { parseOpenClawChannel } from "../../utils/openClawChannel";
import type { OpenClawStatus } from "./useOpenClawStatus";

interface UseOpenClawSessionSyncOptions {
  status: OpenClawStatus;
  onSync: () => void;
}

export function useOpenClawSessionSync({ status, onSync }: UseOpenClawSessionSyncOptions) {
  const onSyncRef = useRef(onSync);
  onSyncRef.current = onSync;

  useEffect(() => {
    const api = window.electronAPI?.openclaw;
    if (!api) return;

    let cancelled = false;

    const sync = async () => {
      const sessions = await api.listSessions?.();
      if (cancelled || !sessions) return;
      for (const session of sessions) {
        if (!session.sessionKey) continue;
        await window.electronAPI?.upsertOpenClawConversation?.({
          remoteSessionKey: session.sessionKey,
          title: session.title,
          originChannel: session.channel ?? parseOpenClawChannel(session.sessionKey),
        });
      }
      if (!cancelled) onSyncRef.current();
    };

    if (status === "connected") {
      sync();
    }

    const unsubscribe = api.onSessionsChanged?.(() => {
      sync();
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [status]);
}
