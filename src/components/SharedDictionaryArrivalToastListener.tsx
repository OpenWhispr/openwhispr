import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "./ui/useToast";
import {
  takeSharedDictionaryArrival,
  useSharedDictionaryStore,
  type SharedDictionaryArrival,
} from "../stores/sharedDictionaryStore";
import { readActiveWorkspaceId, useWorkspaceStore } from "../stores/workspaceStore";
import {
  getAuthRequestContextSnapshot,
  subscribeAuthRequestContext,
} from "../lib/authRequestContext";

interface SharedDictionaryArrivalToastListenerProps {
  onViewWords: () => void;
}

/**
 * Headless. Tells a member once, the first time their workspace's shared words
 * start applying. SyncService records the arrival once per account and
 * workspace; sync passes run in whichever window holds the web lock (often the
 * dictation overlay), and the control panel may be closed or in the tray then.
 * So the arrival is taken here only once the panel is in front of the user (on
 * mount, on focus, or when the main process's 'sync-event' rebroadcast says one
 * just arrived), and taking it marks it welcomed.
 */
export default function SharedDictionaryArrivalToastListener({
  onViewWords,
}: SharedDictionaryArrivalToastListenerProps): null {
  const { t } = useTranslation();
  const { toast } = useToast();

  useEffect(() => {
    const showArrival = ({ workspaceId, count }: SharedDictionaryArrival): void => {
      // The workspace list may not have loaded yet when sync finishes first.
      const workspaceName = useWorkspaceStore
        .getState()
        .workspaces.find((workspace) => workspace.id === workspaceId)?.name;

      toast({
        title: t("dictionary.shared.arrival.title", { count }),
        description: workspaceName
          ? t("dictionary.shared.arrival.description", { workspace: workspaceName })
          : t("dictionary.shared.arrival.descriptionNoWorkspace"),
        actions: [
          {
            label: t("dictionary.shared.arrival.viewWords"),
            onClick: () => {
              useSharedDictionaryStore.getState().setRequestedList("allShared");
              onViewWords();
            },
          },
          { label: t("common.dismiss"), onClick: () => undefined },
        ],
        // The user may be mid-dictation when sync lands, so give them time.
        duration: 15000,
      });
    };

    // backgroundThrottling is off, so a panel in the tray still reports itself
    // visible; it has no focus there, though.
    const deliver = (): void => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      const arrival = takeSharedDictionaryArrival(
        getAuthRequestContextSnapshot().sessionUserId,
        readActiveWorkspaceId()
      );
      if (arrival) showArrival(arrival);
    };

    deliver();
    document.addEventListener("visibilitychange", deliver);
    window.addEventListener("focus", deliver);
    // An arrival recorded before this window resolved the account waits for it.
    const unsubscribeAuth = subscribeAuthRequestContext(deliver);
    const unsubscribeSync = window.electronAPI?.onSyncEvent?.(({ name }) => {
      if (name === "shared-dictionary-arrived") deliver();
    });
    return () => {
      document.removeEventListener("visibilitychange", deliver);
      window.removeEventListener("focus", deliver);
      unsubscribeAuth();
      unsubscribeSync?.();
    };
  }, [toast, t, onViewWords]);

  return null;
}
