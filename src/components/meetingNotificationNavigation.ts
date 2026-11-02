import type { NoteItem } from "../types/electron";
import {
  addNote,
  ensureContainerLoaded,
  folderContainerKey,
  initializeNotes,
  initializeNotesTree,
  loadContainerNotes,
  navigateToContainer,
  setActiveFolderId,
  setActiveNoteId,
  spaceContainerKey,
} from "../stores/noteStore";

interface NotificationNavigation {
  navigationId: string;
  noteId: number;
  spaceId: number;
  folderId: number | null;
}

export function navigateMeetingNote(
  noteId: number,
  spaceId: number | undefined,
  folderId: number | null
): void {
  if (spaceId != null) navigateToContainer(spaceId, folderId);
  else setActiveFolderId(folderId);
  setActiveNoteId(noteId);
}

export function navigateAndLoadMeetingNote(
  noteId: number,
  spaceId: number | undefined,
  folderId: number | null
): Promise<NoteItem[]> {
  // Start the refresh first so navigation can reuse it even for a cold root.
  const loading =
    spaceId == null
      ? initializeNotes(null, 50, folderId)
      : loadContainerNotes(
          folderId == null ? spaceContainerKey(spaceId) : folderContainerKey(folderId)
        );
  navigateMeetingNote(noteId, spaceId, folderId);
  return loading;
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
    navigateMeetingNote(note.id, note.space_id, note.folder_id);
    requestRecording(note);
  } catch {
    await cancel();
  }
}
