import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../ui/useToast";
import { ToastActionButton } from "../ui/Toast";
import { syncService } from "../../services/SyncService";
import logger from "../../utils/logger";

// Recovery belongs to the committed note, so cancellation and navigation cannot
// lose it along with a discarded chat tool result. An edit made while no window
// had focus is offered once one does.
export default function AssistantNoteUndoListener() {
  const { t } = useTranslation();
  const { toast, dismiss } = useToast();
  const visible = useRef(new Map<string, string>());
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  useEffect(() => {
    let active = true;
    let request = 0;
    let scope = 0;
    const clearVisible = () => {
      for (const id of visible.current.values()) dismissRef.current(id);
      visible.current.clear();
    };
    const refresh = async () => {
      const generation = ++request;
      const startScope = scope;
      const focused = () => document.hasFocus() && document.visibilityState !== "hidden";
      // An unfocused window still drops toasts whose recovery is gone (undone
      // or replaced in another window); only a focused one offers new ones.
      if (!focused() && !visible.current.size) return;
      try {
        const edits = await window.electronAPI.getNoteUndos();
        if (!active || generation !== request) return;
        const tokens = new Set(edits.map((edit) => edit.token));
        for (const [token, id] of visible.current) {
          if (tokens.has(token)) continue;
          dismissRef.current(id);
          visible.current.delete(token);
        }
        if (!focused()) return;
        for (const edit of edits) {
          if (visible.current.has(edit.token)) continue;
          // Main hands each edit to one window once, so it is not offered again
          // in another window or after a reload.
          if (!(await window.electronAPI.claimNoteUndo(edit.token))) continue;
          if (!active || scope !== startScope) return;
          let busy = false;
          const id = toast({
            title: t("notes.assistantUndo.applied", {
              title: edit.title || t("notes.list.untitled"),
            }),
            duration: 6000,
            // Only the close button retires the recovery; a toast that timed
            // out leaves it for the editor's discard or the TTL.
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
                    // A refusal means the recovery is gone; a failed save keeps
                    // it, so the toast stays for another try.
                    const gone = result.success || result.error === "note_changed";
                    if (gone) {
                      dismissRef.current(id);
                      visible.current.delete(edit.token);
                    }
                    if (result.success) {
                      syncService.debouncedPush("note", edit.noteId);
                    } else {
                      toast({
                        description: t(
                          gone ? "notes.assistantUndo.changed" : "notes.assistantUndo.failed"
                        ),
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
      scope++;
      clearVisible();
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
    };
  }, [toast, t]);

  return null;
}
