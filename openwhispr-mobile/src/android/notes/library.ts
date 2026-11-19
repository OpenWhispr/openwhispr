import { useCallback, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { create } from 'zustand';
import { notesRepository } from '@/data';
import { spacesRepository } from '@/data/spacesRepository';
import type { Folder, Note } from '@/data';
import type { Space } from '@/data/spacesTypes';
import { useNotesStore } from '@/store/useNotesStore';
import { useHiddenNoteIds } from './pendingDeletes';

/**
 * Which space Notes shows (Figma L3): every space (the default, L1), Private only, or one
 * teamspace. Only people in a teamspace ever see the switcher.
 */
export type NotesScope = { kind: 'all' } | { kind: 'private' } | { kind: 'team'; spaceId: number };

export const useNotesScope = create<{ scope: NotesScope }>(() => ({ scope: { kind: 'all' } }));

export function setNotesScope(scope: NotesScope) {
  useNotesScope.setState({ scope });
}

export function privateSpaceId(): number | null {
  try {
    return spacesRepository.getPrivateSpace().id;
  } catch {
    return null;
  }
}

export function isPrivateNote(note: Pick<Note, 'spaceId'>, privateId: number | null): boolean {
  return note.spaceId == null || note.spaceId === privateId;
}

/**
 * Re-reads whatever the list is built from when the screen comes back into view and whenever
 * the notes store changes (a sync pass, a new note, a move), so rows never go stale.
 */
export function useLibraryRevision(): number {
  const [focusRevision, setFocusRevision] = useState(0);
  useFocusEffect(useCallback(() => setFocusRevision((value) => value + 1), []));
  const folderCounts = useNotesStore((state) => state.folderCounts);
  const notes = useNotesStore((state) => state.notes);
  const spaces = useNotesStore((state) => state.spaces);
  const transcriptRevision = useNotesStore((state) => state.transcriptRevision);
  const counter = useRef(0);
  return useMemo(
    () => ++counter.current,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [focusRevision, folderCounts, notes, spaces, transcriptRevision],
  );
}

/** Every visible note, newest first, minus the ones waiting out their Undo. */
export function useAllNotes(revision: number): Note[] {
  const hidden = useHiddenNoteIds();
  return useMemo(
    () =>
      notesRepository.getAllNotes().filter((note) => !hidden.includes(note.id) && !note.leftTeam),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [revision, hidden],
  );
}

export function notesInScope(notes: Note[], scope: NotesScope, privateId: number | null): Note[] {
  if (scope.kind === 'all') return notes;
  if (scope.kind === 'private') return notes.filter((note) => isPrivateNote(note, privateId));
  return notes.filter((note) => note.spaceId === scope.spaceId);
}

export function teamSpaces(spaces: Space[]): Space[] {
  return spaces.filter((space) => space.kind === 'team');
}

export function spaceFoldersOf(spaceId: number): Folder[] {
  return useNotesStore.getState().getSpaceFolders(spaceId);
}

/** Where a new note goes from a screen: the folder, else the space's default folder. */
export function defaultFolderFor(scope: NotesScope, folders: Folder[]): number | undefined {
  if (scope.kind === 'team') {
    const own = spaceFoldersOf(scope.spaceId);
    return (own.find((folder) => folder.isDefault) ?? own[0])?.id;
  }
  return (folders.find((folder) => folder.isDefault) ?? folders[0])?.id;
}
