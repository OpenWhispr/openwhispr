import type { StoreApi, UseBoundStore } from 'zustand';
import { notesRepository, spacesRepository } from '@/data';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { createNotesStore, type NotesStore } from '@/store/createNotesStore';
import { androidMeetingLifecycle } from './meetingLifecycle';

const currentPrivateFolderId = (): number | null => {
  const folders = notesRepository.getPrivateFolders();
  return (folders.find((folder) => folder.isDefault) ?? folders[0])?.id ?? null;
};

const currentFolderId = (id: number): number | null =>
  notesRepository.getFolders().some((folder) => folder.id === id) ? id : currentPrivateFolderId();

export function createAndroidNotesStore() {
  return createNotesStore(androidMeetingLifecycle, (set, get) => ({
    reset: () =>
      set({
        folders: [],
        spaceFolders: [],
        folderCounts: {},
        notes: [],
        spaces: [],
        voiceProfiles: [],
        meetingSpeakerEmbeddingsByNoteId: {},
        activeNoteId: null,
        activeFolderId: null,
        activeSpaceId: null,
        isInitialized: false,
        searchQuery: '',
        isSearching: false,
        transcriptRevision: 0,
      }),

    setActiveFolderId: (id) => {
      const targetId = id == null ? null : currentFolderId(id);
      if (get().isInitialized && get().activeFolderId === targetId && get().activeSpaceId == null)
        return;
      set({
        activeFolderId: targetId,
        activeSpaceId: null,
        activeNoteId: null,
        searchQuery: '',
        isSearching: false,
      });
      if (targetId != null) {
        set({ notes: notesRepository.getNotesByFolder(targetId) });
      } else {
        set({ notes: notesRepository.getAllNotes() });
      }
    },

    setActiveSpaceId: (id) => {
      if (id != null && !spacesRepository.listSpaces().some((space) => space.id === id)) {
        get().setActiveFolderId(currentPrivateFolderId());
        return;
      }
      if (get().isInitialized && get().activeSpaceId === id && get().activeFolderId == null) return;
      set({
        activeSpaceId: id,
        activeFolderId: null,
        activeNoteId: null,
        searchQuery: '',
        isSearching: false,
      });
      set({
        spaceFolders: id != null ? notesRepository.getFoldersBySpace(id) : [],
        notes:
          id != null
            ? notesRepository.getSpaceNotesWithoutFolder(id)
            : notesRepository.getAllNotes(),
      });
    },

    createNote: (title = 'Untitled', content = '', folderId) => {
      let { activeFolderId, activeSpaceId } = get();
      const requestedFolderId = folderId ?? activeFolderId;
      if (folderId == null && activeSpaceId != null) {
        get().setActiveSpaceId(activeSpaceId);
        ({ activeFolderId, activeSpaceId } = get());
      } else {
        const targetId =
          requestedFolderId == null ? currentPrivateFolderId() : currentFolderId(requestedFolderId);
        if (targetId !== requestedFolderId) get().setActiveFolderId(targetId);
        folderId = targetId ?? undefined;
        activeFolderId = targetId;
        activeSpaceId = null;
      }
      // Browsing a space (mutually exclusive with browsing a folder): the note
      // belongs to that space, not to the personal default folder.
      const note =
        folderId == null && activeSpaceId != null
          ? notesRepository.createNote(title, content, undefined, activeSpaceId)
          : notesRepository.createNote(title, content, folderId ?? activeFolderId ?? undefined);

      if (useProcessingModeStore.getState().activeMode === 'private') {
        notesRepository.setNotePrivacy(note.id, true);
      }

      get().loadNotes();
      get().loadFolders();
      return note;
    },
  })) as UseBoundStore<StoreApi<NotesStore & { reset(): void }>>;
}
