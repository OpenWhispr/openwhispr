import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../ui/useToast";
import { ToastActionButton } from "../ui/Toast";
import { syncService } from "../../services/SyncService";
import logger from "../../utils/logger";

// Recovery belongs to the committed note, so cancellation, navigation and a
// renderer restart cannot lose it along with a discarded chat tool result.
export default function AssistantNoteUndoListener() {
  const { t } = useTranslation();
  const { toast, dismiss } = useToast();
  const shown = useRef(new Set<string>());
  const visible = useRef(new Map<string, string>());
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  useEffect(() => {
    const shownTokens = shown.current;
    let active = true;
    let request = 0;
    const clearVisible = () => {
      for (const id of visible.current.values()) dismissRef.current(id);
      visible.current.clear();
    };
    const refresh = async () => {
      const generation = ++request;
      if (!document.hasFocus() || document.visibilityState === "hidden") return;
      try {
        const edits = await window.electronAPI.getNoteUndos();
        if (!active || generation !== request || !document.hasFocus()) return;
        const tokens = new Set(edits.map((edit) => edit.token));
        for (const [token, id] of visible.current) {
          if (tokens.has(token)) continue;
          dismissRef.current(id);
          visible.current.delete(token);
        }
        for (const edit of edits) {
          if (shownTokens.has(edit.token)) continue;
          shownTokens.add(edit.token);
          let busy = false;
          const id = toast({
            title: t("notes.assistantUndo.applied", { title: edit.title }),
            duration: 6000,
            // Timeout hides the toast; the latest recovery stays available on
            // reopen until dismissed, undone, or invalidated by another edit.
            onClose: () => {
              void window.electronAPI.discardNoteUndo(edit.noteId, edit.token);
              visible.current.delete(edit.token);
            },
            action: (
              <ToastActionButton
                onClick={async () => {
                  if (busy) return;
                  busy = true;
                  try {
                    const result = await window.electronAPI.undoNoteUpdate(edit.token);
                    if (!active) return;
                    if (result.success) {
                      syncService.debouncedPush("note", edit.noteId);
                      dismissRef.current(id);
                      visible.current.delete(edit.token);
                    } else {
                      toast({
                        description: t("notes.assistantUndo.changed"),
                        variant: "destructive",
                      });
                    }
                  } catch {
                    if (active)
                      toast({
                        description: t("notes.assistantUndo.failed"),
                        variant: "destructive",
                      });
                  } finally {
                    busy = false;
                  }
                }}
              >
                {t("app.toasts.undo")}
              </ToastActionButton>
            ),
          });
          visible.current.set(edit.token, id);
        }
      } catch (error) {
        logger.warn("Failed to load note Undo", { error: String(error) }, "notes");
      }
    };
    const resetScope = () => {
      request++;
      clearVisible();
      shownTokens.clear();
      void refresh();
    };
    void refresh();
    window.addEventListener("focus", refresh);
    const removeNoteListener = window.electronAPI.onNoteUpdated?.(refresh);
    const removeScopeListener = window.electronAPI.onActiveAccountScopeChanged?.(resetScope);
    return () => {
      active = false;
      request++;
      window.removeEventListener("focus", refresh);
      removeNoteListener?.();
      removeScopeListener?.();
      clearVisible();
      shownTokens.clear();
    };
  }, [toast, t]);

  return null;
}
