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

export type ActionProcessingState = ActionProcessingStatus;

/**
 * Thin hook that delegates to the global actionProcessingStore.
 *
 * The store owns the async lifecycle so that actions survive component
 * unmounts and navigation. This hook just provides a React-friendly
 * interface for reading state and dispatching actions for a given note.
 */
export function useActionProcessing(noteId: number | null) {
  const { t } = useTranslation();

  const { status: state, actionName } = useActionProcessingStore(
    useShallow((s) => selectNoteActionState(s, noteId))
  );

  const runAction = useCallback(
    (
      action: ActionItem,
      noteContent: string,
      contentHash: string,
      options: RunActionOptions
    ) => {
      if (noteId == null) return;
      runBackgroundAction(
        noteId,
        noteContent,
        contentHash,
        action,
        options,
        t("notes.actions.errors.actionFailed")
      );
    },
    [noteId, t]
  );

  const cancel = useCallback(() => {
    if (noteId != null) storeCancelAction(noteId);
  }, [noteId]);

  return { state, actionName, runAction, cancel };
}
