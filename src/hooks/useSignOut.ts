import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { signOut } from "../lib/auth";
import { syncService } from "../services/SyncService.js";
import { stopRecording, useMeetingRecordingStore } from "../stores/meetingRecordingStore";
import type { ConfirmDialogState, AlertDialogState } from "./useDialogs";
import logger from "../utils/logger";

interface SignOutDialogs {
  showConfirmDialog: (options: Omit<ConfirmDialogState, "open">) => void;
  showAlertDialog: (options: Omit<AlertDialogState, "open">) => void;
}

/** Sign out from anywhere in the control panel, asking first when it would end a meeting recording. */
export function useSignOut({ showConfirmDialog, showAlertDialog }: SignOutDialogs): {
  requestSignOut: () => void;
  isSigningOut: boolean;
} {
  const { t } = useTranslation();
  const [isSigningOut, setIsSigningOut] = useState(false);

  const performSignOut = useCallback(async () => {
    setIsSigningOut(true);
    try {
      // End a live meeting while its note is still in scope: signing out clears
      // the account scope, and anything said after that could not be saved.
      await stopRecording();
      // Clear account-scoped renderer/session state before ending the session.
      // Workspace-owned rows remain cached behind their membership boundary.
      await syncService.purgeTeamSpacesForSignOut();
      await signOut();
      window.location.reload();
    } catch (error) {
      logger.error("Sign out failed", error, "auth");
      showAlertDialog({
        title: t("settingsPage.account.signOut.failedTitle"),
        description: t("settingsPage.account.signOut.failedDescription"),
      });
    } finally {
      setIsSigningOut(false);
    }
  }, [showAlertDialog, t]);

  const requestSignOut = useCallback(() => {
    if (!useMeetingRecordingStore.getState().isRecording) {
      void performSignOut();
      return;
    }
    showConfirmDialog({
      title: t("settingsPage.account.signOut.endMeetingTitle"),
      description: t("settingsPage.account.signOut.endMeetingDescription"),
      confirmText: t("settingsPage.account.signOut.signOut"),
      cancelText: t("common.cancel"),
      variant: "destructive",
      onConfirm: () => void performSignOut(),
    });
  }, [performSignOut, showConfirmDialog, t]);

  return { requestSignOut, isSigningOut };
}
