import type { NoteItem } from "../types/electron";
import {
  addNote,
  ensureContainerLoaded,
  folderContainerKey,
  initializeNotesTree,
  navigateToContainer,
  setActiveNoteId,
  spaceContainerKey,
} from "../stores/noteStore";

interface NotificationNavigation {
  navigationId: string;
  noteId: number;
  spaceId: number;
  folderId: number | null;
}

/** Only the main process's final, live row authorizes recording. */
export async function navigateMeetingNotification(
  data: NotificationNavigation,
  isCurrent: () => boolean,
  prepareEditor: () => Promise<unknown>,
  requestRecording: (note: NoteItem) => void
): Promise<void> {
  const cancel = async () => {
    await window.electronAPI
      .confirmMeetingNoteNavigation(data.navigationId, "cancel")
      .catch(() => {});
  };
  try {
    await prepareEditor();
    if (!isCurrent()) return await cancel();
    await initializeNotesTree();
    if (!isCurrent()) return await cancel();
    await ensureContainerLoaded(
      data.folderId == null ? spaceContainerKey(data.spaceId) : folderContainerKey(data.folderId)
    );
    if (!isCurrent()) return await cancel();
    const result = await window.electronAPI.confirmMeetingNoteNavigation(
      data.navigationId,
      "ready"
    );
    if (!isCurrent()) return await cancel();
    if (result.success !== true) return;
    // No awaited loading remains between authorization and the recording request.
    const note = result.value;
    addNote(note);
    navigateToContainer(note.space_id, note.folder_id);
    setActiveNoteId(note.id);
    requestRecording(note);
  } catch {
    await cancel();
  }
}
