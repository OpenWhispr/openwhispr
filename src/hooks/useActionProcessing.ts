import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { ActionItem } from "../types/electron";
import {
  useActionProcessingStore,
  selectNoteActionState,
  runBackgroundAction,
  cancelAction as storeCancelAction,
  type ActionProcessingStatus,
  type RunActionOptions,
} from "../stores/actionProcessingStore";
import { getActionName } from "../stores/actionStore";

export type ActionProcessingState = ActionProcessingStatus;

/** React binding for the global actionProcessingStore, scoped to one note. */
export function useActionProcessing(noteId: number | null) {
  const { t } = useTranslation();

  const {
    status: state,
    actionName,
    progress,
  } = useActionProcessingStore(useShallow((s) => selectNoteActionState(s, noteId)));

  const runAction = useCallback(
    (action: ActionItem, noteContent: string, contentHash: string, options: RunActionOptions) => {
      if (noteId == null) return;
      // The overlay shows the run's name, so a built-in's is translated here.
      const translated = { ...action, name: getActionName(action, t) };
      runBackgroundAction(noteId, noteContent, contentHash, translated, options, {
        noModel: t("notes.actions.errors.noModel"),
        noEndpoint: t("notes.actions.errors.noEndpoint"),
        actionFailed: t("notes.actions.errors.actionFailed"),
      });
    },
    [noteId, t]
  );

  const cancel = useCallback(() => {
    if (noteId != null) storeCancelAction(noteId);
  }, [noteId]);

  return { state, actionName, progress: progress ?? null, runAction, cancel };
}
