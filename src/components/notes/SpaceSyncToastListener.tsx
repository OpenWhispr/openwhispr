import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { readPurgeDisplacedNote } from "../../stores/noteStore";
import { useToast } from "../ui/useToast";

const DEDUPE_MS = 15_000;

/**
 * Headless. Mount once inside ToastProvider so team-space access changes
 * raised by sync surface even when the user is outside the notes view.
 * Sync passes run in whichever window holds the web lock (often the always-on
 * dictation overlay), so the signals arrive via the main-process 'sync-event'
 * rebroadcast rather than window-local CustomEvents.
 * A rejected push and the following spaces-pass purge can both announce the
 * same space, so access-revoked toasts dedupe by space name; folder name
 * conflicts recur every sync pass while unresolved, so they dedupe too.
 */
export default function SpaceSyncToastListener() {
  const { t } = useTranslation();
  const { toast } = useToast();

  useEffect(() => {
    const lastRevokedAt = new Map<string, number>();
    const lastFolderConflictAt = new Map<string, number>();

    const dispose = window.electronAPI?.onSyncEvent?.(({ name, payload }) => {
      if (name === "space-revoked") {
        const { spaceName, spaceId } = (payload ?? {}) as {
          spaceName?: string | null;
          spaceId?: number | null;
        };
        if (!spaceName) return;
        const now = Date.now();
        if (now - (lastRevokedAt.get(spaceName) ?? 0) < DEDUPE_MS) return;
        lastRevokedAt.set(spaceName, now);
        // When the purge closed the note the user was reading, say which one
        // vanished instead of only naming the space.
        const displaced = spaceId != null ? readPurgeDisplacedNote(spaceId) : null;
        toast({
          title: displaced
            ? t("notes.spaces.accessRevokedActiveNote", {
                space: spaceName,
                title: displaced.title || t("notes.list.untitled"),
              })
            : t("notes.spaces.accessRevoked", { space: spaceName }),
          variant: "destructive",
        });
      } else if (name === "folder-name-taken") {
        const { name: folderName } = (payload ?? {}) as { name?: string };
        if (!folderName) return;
        const now = Date.now();
        if (now - (lastFolderConflictAt.get(folderName) ?? 0) < DEDUPE_MS) return;
        lastFolderConflictAt.set(folderName, now);
        toast({
          title: t("notes.spaces.folderNameTaken", { name: folderName }),
          variant: "destructive",
        });
      } else if (name === "note-relocated") {
        const { title, spaceName } = (payload ?? {}) as {
          title?: string | null;
          spaceName?: string | null;
        };
        if (!spaceName) return;
        toast({
          title: t("notes.spaces.movedToPersonal", {
            space: spaceName,
            title: title || t("notes.list.untitled"),
          }),
        });
      } else if (name === "note-update-denied" || name === "note-delete-denied") {
        const { title } = (payload ?? {}) as { title?: string | null };
        toast({
          title: t(
            name === "note-update-denied"
              ? "notes.spaces.updateDeniedNote"
              : "notes.spaces.deleteDeniedNote",
            { title: title || t("notes.list.untitled") }
          ),
          variant: "destructive",
        });
      } else if (name === "folder-update-denied" || name === "folder-delete-denied") {
        const { name: folderName } = (payload ?? {}) as { name?: string | null };
        if (!folderName) return;
        toast({
          title: t(
            name === "folder-update-denied"
              ? "notes.spaces.updateDeniedFolder"
              : "notes.spaces.deleteDeniedFolder",
            { name: folderName }
          ),
          variant: "destructive",
        });
      }
    });

    return () => dispose?.();
  }, [toast, t]);

  return null;
}
